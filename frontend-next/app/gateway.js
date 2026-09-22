/* ============================================================================
   生产网关通路 —— 从本站自己的 Cloudflare Worker 读取「最近一次扫描」的结果
   ----------------------------------------------------------------------------
   这条路只读、不发扫描：站点页面没有订阅输入框，也没有开始按钮（触发由页面之外发起）。
   所以这里做三件事，一件都不多：
     1. GET /api/scans/latest —— 问 Worker「最近一次扫描是哪一次、产物在不在」；
     2. 拿它给的签名地址直连 blob 取回 ZIP 字节（Worker 不搬字节，见
        implemented/architecture/2026-09-21-artifact-bytes-delegated-to-browser.md）；
     3. 交给 app/artifact/reader.js 逐个字节校验（身份、SHA-256、CRC、manifest 交叉核对），
        再把 result.json 原样返回——它的形状和本机 loopback 的 ?job= 导出完全一样，
        于是 records.js / render.js 一行都不用改。

   为什么错误文案分得这么细：这条路上「没扫过」「产物过期」「还没跑完」「跑挂了」
   「产物坏了」「浏览器拦了跨源」在页面上都表现为「没有数据」。一句笼统的
   「加载失败」会让人以为是自己网断了，于是反复刷新——所以每种成因都留一句真话，
   并且连标题也分开：标题说「是哪种情况」，正文说「接下来会怎样」。
   ========================================================================== */

import { readArtifact } from "./artifact/reader.js";

const LATEST_PATH = "/api/scans/latest";
const LATEST_TIMEOUT_MS = 30_000;
const ARTIFACT_TIMEOUT_MS = 30_000;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
// 传输截断是唯一值得重来的失败：换一张新的签名地址再取一次通常就好了（旧前端同样只对这种情况重取）。
const ARTIFACT_ATTEMPTS = 3;
// 与 worker/github.js 的 ARTIFACT_HOST_SUFFIX 一致：产物地址只认 GitHub 自己的 blob 主机。
// Worker 已经筛过一遍，这里是第二遍——一个被改写过的响应不该把浏览器带去别的主机。
const ARTIFACT_HOST_SUFFIX = ".blob.core.windows.net";

// 上游（Worker）状态 → 人话：标题 + 一句「接下来会怎样」。键名与 worker/latest.js 的
// status 取值一一对应；认不得的状态走兜底那条，宁可不解释也不编原因。
const STATUS_REPORT = {
  none: {
    title: "本站还没有跑过扫描",
    text: "扫描不在这个页面上发起（由 Actions 的 workflow_dispatch 或脚本发起），跑完之后这里会显示结果。",
  },
  artifact_expired: {
    title: "最近一次扫描的产物已经过期",
    text: "GitHub 上的扫描产物只保留 1 天，过期后只剩这条记录：结果要在扫完的当天来看。",
  },
  running: {
    title: "最近一次扫描还在进行",
    text: "结果还没生成：最近一次扫描还在跑，跑完后刷新这个页面即可看到。",
  },
  queued: {
    title: "最近一次扫描还在排队",
    text: "结果还没生成：最近一次扫描还在排队，跑完后刷新这个页面即可看到。",
  },
  failed: {
    title: "最近一次扫描没有成功",
    text: "最近一次扫描没有成功，没有可读的结果。",
  },
  cancelled: {
    title: "最近一次扫描被取消了",
    text: "最近一次扫描被取消了，没有可读的结果。",
  },
};

const UNKNOWN_STATUS = { title: "没有读到真实扫描结果", text: "网关没有说明原因。" };

function error(code, message, cause, title) {
  const failure = Object.assign(new Error(message, cause ? { cause } : undefined), { code });
  if (title) failure.title = title;
  return failure;
}

function reasonOf(cause) {
  return cause && cause.name ? cause.name : "未知错误";
}

function statusReport(status) {
  if (typeof status !== "string" || !status) return UNKNOWN_STATUS;
  return STATUS_REPORT[status] || {
    title: "没有读到真实扫描结果",
    text: `网关返回了无法处理的状态（${status}）。`,
  };
}

// 没有超时的话，Worker 侧卡在 GitHub API 上时这个 promise 永不 settle：页面会一直停在
// 「正在读取」，既没有报错也没有重试入口。
function timeoutSignal(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * 签名产物地址只允许 https + GitHub 产物主机；不符合就抛错而不是硬取。
 * 空值也算错：artifact_ready 为 true 却没有地址，是网关自相矛盾的响应。
 */
function artifactUrlOf(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ""));
  } catch {
    throw error("artifact_url_invalid", "网关返回的产物地址无效");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(ARTIFACT_HOST_SUFFIX)) {
    throw error("artifact_url_invalid", `网关返回的产物地址不是 GitHub 产物主机：${parsed.hostname || "(空)"}`);
  }
  return parsed.toString();
}

function httpTextFor(status) {
  if (status === 401) return "登录已过期：请重新用访问密码登录本站。";
  if (status === 403) return "本站拒绝了这次读取（403）：会话与请求来源不匹配。";
  if (status === 503) return "本站的扫描网关尚未配置完成（503）。";
  return `本站的扫描网关返回 HTTP ${status}`;
}

/** 取回并校验 GET /api/scans/latest 的响应；形状不对就当网关坏了，不猜。 */
async function fetchLatestState(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(LATEST_PATH, {
      method: "GET",
      // 同源 + 带会话 cookie：这条路径的门就是站点的访问密码。
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: timeoutSignal(LATEST_TIMEOUT_MS),
    });
  } catch (cause) {
    if (cause && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw error("gateway_timeout", `本站的扫描网关 ${LATEST_TIMEOUT_MS / 1000} 秒内没有响应`, cause);
    }
    throw error("gateway_unreachable", `读不到本站的扫描网关（${reasonOf(cause)}）`, cause);
  }
  if (!response.ok) throw error("gateway_http", httpTextFor(response.status));

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw error("gateway_json", "扫描网关返回的不是 JSON", cause);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw error("gateway_shape", "扫描网关返回的结构无效");
  }
  if (payload.artifact_ready !== true) {
    // 没有产物时只信 status 那句话；此时 run/artifact 字段一律不读，避免用半个身份拼出一行数据。
    const report = statusReport(payload.status);
    throw error(typeof payload.status === "string" && payload.status ? payload.status : "gateway_status",
      report.text, undefined, report.title);
  }
  const { request_id: requestId, run } = payload;
  const runId = run?.id;
  const runAttempt = run?.run_attempt;
  if (typeof requestId !== "string" || !requestId
    || !Number.isInteger(runId) || runId < 1
    || !Number.isInteger(runAttempt) || runAttempt < 1) {
    throw error("gateway_shape", "扫描网关说产物就绪，却没给全扫描身份（request_id / run_id / run_attempt）");
  }
  return { requestId, runId, runAttempt, url: artifactUrlOf(payload.artifact_url) };
}

/** 直连签名地址取字节。CORS 直连是刻意的：Worker 出口到 blob 主机不可靠（见 github.js 注释）。 */
async function downloadArtifact(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      // 不带凭据、不带自定义头：Azure 侧回 Access-Control-Allow-Origin: *，一旦带上
      // cookie 或自定义头就会变成预检请求，反而取不到字节。
      credentials: "omit",
      cache: "no-store",
      signal: timeoutSignal(ARTIFACT_TIMEOUT_MS),
    });
  } catch (cause) {
    if (cause && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw error("artifact_timeout", `产物地址 ${ARTIFACT_TIMEOUT_MS / 1000} 秒内没有返回字节`, cause);
    }
    throw error("artifact_blocked", `浏览器没能取到产物字节（${reasonOf(cause)}）：产物主机拒绝了这次跨源请求`, cause);
  }
  if (!response.ok) throw error("artifact_http", `产物地址返回 HTTP ${response.status}`);

  let buffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (cause) {
    throw error("artifact_truncated", `产物字节没有读完（${reasonOf(cause)}）`, cause);
  }
  if (buffer.byteLength === 0) throw error("artifact_truncated", "产物地址返回了空响应（0 字节）");
  if (buffer.byteLength > MAX_ARTIFACT_BYTES) {
    throw error("artifact_too_large", `产物 ${buffer.byteLength} 字节，超过 ${MAX_ARTIFACT_BYTES} 字节上限`);
  }
  return buffer;
}

/**
 * 读一次「最近一次扫描」，返回与 ?job= 本地导出同形的 payload。
 * 任何一步不成立都抛错（带 code 与可选 title），由 main.js 决定显示哪一种空状态。
 *
 * @returns {Promise<{id: string, status: string, results: object[], manifest: object}>}
 */
export async function fetchLatestScan({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw error("no_fetch", "当前环境没有可用的 fetch");
  for (let attempt = 1; attempt <= ARTIFACT_ATTEMPTS; attempt += 1) {
    // 每一轮都重新问一次 /api/scans/latest 而不是复用上一轮那个地址：签名地址有有效期，
    // 重试要用新的那一张，否则第二次必然还是拿同一份坏字节。
    const latest = await fetchLatestState(fetchImpl);
    let bytes;
    try {
      bytes = await downloadArtifact(latest.url, fetchImpl);
    } catch (cause) {
      // 只有「字节没读完」值得重来：取不到（跨源被拦 / 404 / 超时）重试一次也不会变好，
      // 只会让用户多等一轮才看到那句真话。
      if (cause?.code !== "artifact_truncated") throw cause;
      if (attempt === ARTIFACT_ATTEMPTS) {
        throw error("artifact_truncated", `产物字节连续 ${ARTIFACT_ATTEMPTS} 次都没有读完`, cause);
      }
      // 字节没读完、且还有重试机会：丢掉这一份，下一轮重新问地址再取一次。
      continue;
    }
    try {
      return (await readArtifact(bytes, {
        requestId: latest.requestId,
        runId: latest.runId,
        runAttempt: latest.runAttempt,
      })).result;
    } catch (cause) {
      // 校验失败不是「没有数据」：产物要么被改动过，要么和这次运行对不上，必须说出来。
      // 这里不重试：字节已经完整到手，内容不对是确定的结论。
      throw error("artifact_invalid", `扫描产物校验失败：${cause.message}`, cause);
    }
  }
  // 循环只可能 return 或 throw；走到这里说明上面的分支被改坏了——宁可报「没读完」，
  // 也不要静默返回 undefined 让调用方以为数据到手。
  throw error("artifact_truncated", `产物字节连续 ${ARTIFACT_ATTEMPTS} 次都没有读完`);
}

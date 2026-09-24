/* ============================================================================
   扫描触发通路 —— 在页面上发起一次真实扫描，并把它盯到出结果
   ----------------------------------------------------------------------------
   整条链路都在同源底下，所以生产 CSP 一个字都不用放宽：
     1. 用 ./scan-public.pem 的公钥把订阅地址封装成信封（app/scan-crypto.js），
        POST /api/scans 交给 Worker —— 明文订阅地址从不离开浏览器；
     2. Worker 用 GitHub App token 触发 scan.yml（worker/scans.js 的 createScan），
        回 202 { request_id, scan_token, dispatched_at }；token 走 X-Best-IP-Scan-Token
        头，只存在内存里；
     3. GET /api/scans/<request_id> 轮询执行进度（排队 / 执行中 / 完成 / 失败 / 取消）；
     4. 执行成功且产物就绪时 GET /api/scans/<request_id>/artifact 拿签名地址，浏览器直连
        blob 取字节，交给 app/artifact/reader.js 逐个字节校验。
        第 4 步与「读最近一次扫描」共用 app/gateway.js 的 readArtifactFrom —— 一份实现。

   为什么 token 只放内存：它是一张两小时有效、只对本次 request_id 生效的凭证
   （worker/auth.js 的 signScanToken）。放进 localStorage/sessionStorage 等于给页面引入
   一处可被读走的长效凭证；而刷新一页的代价很小——刷新后 /api/scans/latest 依然会如实
   说「最近一次扫描还在进行」。这条限制记在笔记里，不靠提示文案遮掩。

   为什么轮询有上限：scan.yml 是 timeout-minutes: 30，排队也可能永远排不上。沿用旧前端的
   口径——从没跑起来超过 13 分钟、跑起来超过 31 分钟就停止等待，并如实说「任务可能仍在
   后台运行」，而不是无限转圈；发出停止请求后 2 分钟还没落地也停止等待，说明「尚未确认
   停止」。这些都是「不再刷这条请求」，不是「任务已被停掉」。
   ========================================================================== */

import { encryptSubscriptionUrl, requestId } from "./scan-crypto.js";
import { readArtifactFrom, artifactUrlOf } from "./gateway.js";
import { failure, gatewayStatusText } from "./failure.js";
import { fetchWithTimeout, isTimeoutError, timeoutPair } from "./net.js";

const SCANS_PATH = "/api/scans";
const TOKEN_HEADER = "X-Best-IP-Scan-Token";
const START_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 30_000;
// 取加密公钥打的是本站同源的一份 ~1KB PEM，与别的请求同量级；它比别处更该有上限——挂住时
// 页面停在「正在加密订阅地址并交给扫描网关…」，连一个可以点的按钮都没有。
const PUBLIC_KEY_TIMEOUT_MS = 15_000;
const QUEUE_DEADLINE_MS = 13 * 60_000;
const RUN_DEADLINE_MS = 31 * 60_000;
const CANCEL_DEADLINE_MS = 2 * 60_000;

// 轮询节奏与旧前端 scan-controller 一致：第一次 2 秒，之后每次 ×1.5，上限 10 秒。
// 一次扫描要跑几十秒到几分钟，固定 2 秒轮询只会白刷几十次请求。
export const SCAN_POLL_FIRST_MS = 2_000;
export const SCAN_POLL_MAX_MS = 10_000;

// worker/scans.js 的 runStatus() 取值 → 页面上的一句话。说「正在做什么」，不说「加载中」。
const RUN_LABEL = {
  queued: "已排队，等待执行",
  running: "扫描执行中",
  completed: "扫描执行已完成",
  cancelled: "扫描已取消",
  failed: "扫描执行失败",
};

// 失败对象与状态码文案来自 app/failure.js：原先本文件的 failure() 与 gateway.js 的 error()
// 同形（都挂 code、可选 title），401/403/503 三句也各写一份。见该文件头部。

/**
 * 提交前的快检查，与 frontend/src/transport/http.js 的 validateSubscriptionUrl 同文案。
 * 这不是多余的一份：加密模块内部也会校验，但那一步已经生成了 AES 密钥、可能还取了公钥，
 * 而地址最常见的手误（漏了 https:// 、粘成了带账号密码的内网地址）不值得先清空表格再报错。
 */
export function validateSubscriptionUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw failure("subscription_url_invalid", "订阅地址格式无效：需要一条完整的 http 或 https 链接");
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password) {
    throw failure("subscription_url_invalid", "订阅地址必须是公开 HTTP/HTTPS 地址，且不能携带认证信息");
  }
  return url.toString();
}

/**
 * 给 scan-crypto.js 注入的 fetchImpl 套上超时。
 * 那条取公钥的请求（importPublicKey 里的 fetchImpl(url, { cache: "no-store" })）原本没有超时，
 * 挂住的话页面会永久停在「正在加密订阅地址并交给扫描网关…」。scan-crypto.js 不能改（它与
 * frontend/src/crypto.js 是人工同步的副本），但 fetchImpl 是注入的，所以在注入点补上。
 */
function withPublicKeyTimeout(fetchImpl) {
  return (input, init) => fetchWithTimeout(fetchImpl, input, init, PUBLIC_KEY_TIMEOUT_MS);
}

/**
 * 一次同源 JSON 请求。非 2xx 时优先用 Worker 自己给的那句话（worker/responses.js 的形状是
 * { error, detail }）——「扫描公钥指纹不匹配」比一句通用的「请求失败」有用得多。
 */
async function requestJson(fetchImpl, path, { method = "GET", body = null, token = "", timeout = POLL_TIMEOUT_MS } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== null) headers["Content-Type"] = "application/json";
  // 只有发了扫描请求才带这张凭证；它是自定义头，只在同源请求里出现。
  if (token) headers[TOKEN_HEADER] = token;

  // 超时信号走 app/net.js：在没有原生超时能力的环境里它退化成 AbortController + setTimeout，
  // 而不是像原先那样返回 undefined（那等于超时静默消失，promise 可以永不 settle）。
  // 这里不用 fetchWithTimeout 是因为 init 要由本函数自己拼，release() 也只能在这里收口。
  const { signal, release } = timeoutPair(timeout);
  let response;
  try {
    response = await fetchImpl(path, {
      method,
      // 同源 + 带会话 cookie：这条路径的门就是站点的访问密码（与读最近一次扫描同一道门）。
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      // signal 可能是 undefined（环境里连 AbortController 都没有）：那就是「没有取消能力」，
      // 不会挤掉上面任何一项初始化参数。
      signal,
    });
  } catch (cause) {
    if (isTimeoutError(cause)) {
      throw failure("gateway_timeout", `本站的扫描网关 ${Math.round(timeout / 1000)} 秒内没有响应`, { retryable: true });
    }
    throw failure("gateway_unreachable", `连不上本站的扫描网关（${cause?.name || "网络错误"}）`, { retryable: true });
  } finally {
    // 必须在 finally 里 release：退化分支用的是 setTimeout，不清掉会拖着页面（见 app/net.js）。
    release();
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // 网关在极少数路径上会回非 JSON（例如边缘的 5xx HTML 页），此时下面按状态码说话。
    payload = null;
  }

  if (!response.ok) {
    const detail = payload && typeof payload.detail === "string" ? payload.detail : "";
    const code = payload && typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    throw failure(code || `http_${response.status}`, detail || httpMessage(response.status), {
      // 只有服务端故障与限流值得重试；4xx 是确定答复。
      retryable: response.status >= 500 || response.status === 429,
    });
  }
  // 200 却不是 JSON 是边缘/5xx-HTML 那种瞬时形态（注释在上面那条 catch 里说明），值得重试一次；
  // 一次性定终态会把一次边缘抖动说成「这次扫描没成」。
  if (payload === null) throw failure("gateway_json", "扫描网关返回的不是 JSON", { retryable: true });
  return payload;
}

// 401/403/503 三句与 gateway.js 共用 app/failure.js 的表（原先两边各抄一份，只差一两个词）；
// 这里只留这张扫描路独有的那几条状态码，兜底句也保持本文件原来的说法。
function httpMessage(status) {
  if (status === 404) return "本站不认识这个扫描任务（404）。";
  if (status === 409) return "这次扫描的状态与请求对不上（409）。";
  if (status === 413) return "加密后的订阅地址超过本站上限（413）。";
  if (status === 429) return "本站正在限流（429）：稍等一会儿再发起扫描。";
  return gatewayStatusText(status, {
    sessionTail: "后再发起扫描",
    action: "请求",
    detail: "：缺少 GitHub Actions 相关的密钥",
    fallback: (value) => `扫描网关返回 HTTP ${value}`,
  });
}

function scanQuery(session) {
  const query = new URLSearchParams();
  if (session.runId) query.set("run_id", String(session.runId));
  if (session.runAttempt) query.set("run_attempt", String(session.runAttempt));
  return query;
}

function scanPath(session) {
  const query = scanQuery(session);
  const base = `${SCANS_PATH}/${encodeURIComponent(session.id)}`;
  return query.size ? `${base}?${query}` : base;
}

/**
 * 产物地址端点：`/artifact` 是路径的一段，必须拼在查询串**之前**。
 * 拼到后面（`/api/scans/<id>?run_id=…/artifact`）会把请求打到状态端点上，
 * 拿回一个没有 artifact_url 的响应——页面只会看到「产物地址无效」。
 */
function artifactPath(session) {
  const query = scanQuery(session);
  const base = `${SCANS_PATH}/${encodeURIComponent(session.id)}/artifact`;
  return query.size ? `${base}?${query}` : base;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * 把这一轮响应里的 run 身份绑到 session 上。
 * 身份变了（换了 run、换了 attempt）说明「你盯的这次」已经不是服务端在答的那一次，
 * 继续拿它的产物画表就是把 A 的结果记到 B 的头上。
 */
function bindRun(session, run) {
  const runId = positiveInteger(run?.id);
  const attempt = positiveInteger(run?.run_attempt);
  if (!runId || !attempt) throw failure("run_identity_invalid", "扫描运行身份无效");
  if ((session.runId && session.runId !== runId) || (session.runAttempt && session.runAttempt !== attempt)) {
    throw failure("run_identity_mismatch", "扫描运行与本次请求对不上：请重新发起扫描");
  }
  session.runId = runId;
  session.runAttempt = attempt;
}

function runStatusOf(run) {
  const status = String(run?.status || "unknown");
  if (status === "completed") {
    if (run?.conclusion === "success") return "completed";
    if (run?.conclusion === "cancelled") return "cancelled";
    return "failed";
  }
  if (["queued", "waiting", "pending", "requested"].includes(status)) return "queued";
  if (status === "in_progress") return "running";
  return status;
}

// 时长写法照抄旧前端 scan-view.js 的 formatDuration：一小时以内给「分秒」，超过给「小时分」。
function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}小时${minutes}分`;
  if (minutes) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function elapsedOf(run, session, now) {
  const started = Date.parse(String(run?.started_at || run?.created_at || ""));
  const from = Number.isFinite(started) ? started : session.dispatchedAt;
  return now() - from;
}

/** 进度正文：能从 Actions 的 jobs/steps 里读出「当前在哪一步」就说出来，读不到就说读不到。 */
function progressDetail(run, remote, session, now) {
  const parts = [];
  const elapsed = elapsedOf(run, session, now);
  // 0–999 毫秒时 formatDuration 给的是「0秒」，读起来像卡住了；这一档直接说「不到 1 秒」。
  parts.push(`已用时 ${elapsed < 1000 ? "不到 1 秒" : formatDuration(elapsed)}`);
  if (remote.jobs_available === false) {
    parts.push("这一步的明细暂时读不到");
    return parts.join(" · ");
  }
  const jobs = Array.isArray(remote.jobs) ? remote.jobs : [];
  const total = Number.isInteger(remote.jobs_total_count) ? remote.jobs_total_count : jobs.length;
  if (total > 1) parts.push(`任务 ${jobs.filter((job) => job?.status === "completed").length}/${total}`);
  const running = jobs.find((job) => job?.status === "in_progress") || null;
  const steps = Array.isArray(running?.steps) ? running.steps : [];
  const current = steps.find((step) => step?.status === "in_progress") || null;
  if (current && current.name) parts.push(`当前步骤：${current.name}`);
  else if (steps.length) parts.push(`步骤 ${steps.filter((step) => step?.status === "completed").length}/${steps.length}`);
  return parts.join(" · ");
}

/**
 * 等待上限：发出停止请求后 2 分钟、从没跑起来 13 分钟、跑起来 31 分钟。
 * 与旧前端 checkDeadline 同口径（那边写的是 2 / 13 / 31 分钟）。超过就停止轮询并说明真话。
 */
function assertWithinDeadline(session, now) {
  const current = now();
  if (session.cancelRequestedAt) {
    if (current - session.cancelRequestedAt <= CANCEL_DEADLINE_MS) return;
    throw failure("cancel_timeout", "取消等待超过 2 分钟，尚未确认任务停止；请再点一次「停止」。");
  }
  // 已经拿到 run 身份就走「运行」上限，不只是观察到 running 才算：queued → completed 这种
  // 中间没被轮询看到 running 的运行，用排队上限去衡量会把它误判成「排队超过 13 分钟没开始」。
  const running = Boolean(session.hasRun) || ["running", "completed", "failed", "cancelled"].includes(session.status);
  const limit = running ? RUN_DEADLINE_MS : QUEUE_DEADLINE_MS;
  if (current - session.dispatchedAt <= limit) return;
  throw failure("scan_deadline", running
    ? `扫描超过 ${RUN_DEADLINE_MS / 60_000} 分钟仍未结束，已停止等待；任务可能仍在后台运行。`
    : `扫描排队超过 ${QUEUE_DEADLINE_MS / 60_000} 分钟仍没有开始，已停止等待；任务可能仍在排队。`);
}

/**
 * 发起一次扫描。
 * @returns {Promise<object>} 只存在内存里的会话：后续 pollScan / cancelScan 都靠它。
 */
export async function startScan(subscriptionUrl, config, { fetchImpl = globalThis.fetch, baseURI = globalThis.document?.baseURI, now = Date.now } = {}) {
  if (typeof fetchImpl !== "function") throw failure("no_fetch", "当前环境没有可用的 fetch");
  const id = requestId();
  // 公钥指纹在这一步被核对（importPublicKey 拿 PEM 的 DER SHA-256 比 config.keyId）：
  // 与 Worker 的 SCAN_KEY_ID 不是同一把时当场失败，不发出一个必然被 400 拒掉的请求。
  // 公钥指纹在这一步被核对（importPublicKey 拿 PEM 的 DER SHA-256 比 config.keyId）：
  // 与 Worker 的 SCAN_KEY_ID 不是同一把时当场失败，不发出一个必然被 400 拒掉的请求。
  // 只有这一步需要单独收口：scan-crypto.js 自己只会为「没配 / 格式无效 / 指纹不符」给文案，
  // 它那条取公钥的请求没有超时，超时错误得在这里翻译成一句能看懂的话。
  let envelope;
  try {
    envelope = await encryptSubscriptionUrl(subscriptionUrl, id, config, {
      fetchImpl: withPublicKeyTimeout(fetchImpl),
      baseURI,
    });
  } catch (cause) {
    if (!isTimeoutError(cause)) throw cause;
    throw failure("public_key_timeout",
      `GitHub Actions 加密公钥 ${PUBLIC_KEY_TIMEOUT_MS / 1000} 秒内没有返回`, { retryable: true });
  }
  const payload = await requestJson(fetchImpl, SCANS_PATH, {
    method: "POST",
    body: { request_id: id, key_id: String(config.keyId), envelope },
    timeout: START_TIMEOUT_MS,
  });
  if (!payload || typeof payload !== "object" || payload.request_id !== id
    || typeof payload.scan_token !== "string" || !payload.scan_token) {
    throw failure("start_shape", "扫描网关没有返回有效的任务身份或 token");
  }
  return {
    id,
    token: payload.scan_token,
    runId: positiveInteger(payload.run_id),
    runAttempt: 0,
    dispatchedAt: Number.isSafeInteger(payload.dispatched_at) ? payload.dispatched_at : now(),
    status: "queued",
    hasRun: false,
    cancelRequestedAt: 0,
  };
}

/**
 * 问一次进度。
 * @returns {Promise<{status:string,label:string,detail:string,done:boolean,payload?:object,failure?:string}>}
 *   done 为 true 时：有 payload 就是这一轮的扫描结果（与 ?job= 导出同形），有 failure 就是这次扫描没成。
 *   传输/形状类错误直接抛（带 retryable），由调用方决定重试还是收口。
 */
export async function pollScan(session, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const remote = await requestJson(fetchImpl, scanPath(session), { token: session.token });
  const run = remote?.run;
  if (!run) {
    assertWithinDeadline(session, now);
    return {
      status: "queued",
      label: "等待创建扫描任务",
      detail: "扫描请求已经交给 GitHub Actions，等待它创建这次运行。",
      done: false,
    };
  }
  bindRun(session, run);
  session.status = runStatusOf(run);
  if (session.status === "running") session.hasRun = true;
  assertWithinDeadline(session, now);

  const detail = progressDetail(run, remote, session, now);
  if (run.status !== "completed") {
    return { status: session.status, label: RUN_LABEL[session.status] || "扫描执行中", detail, done: false };
  }
  if (run.conclusion !== "success") {
    return {
      status: session.status,
      label: RUN_LABEL[session.status] || "扫描执行失败",
      detail,
      done: true,
      failure: `扫描执行结束：${run.conclusion || "unknown"}`,
    };
  }
  if (remote.artifact_ready !== true) {
    return {
      status: "completed",
      label: "执行已完成，等待终态结果",
      detail: `${detail} · GitHub 还在发布这次运行的产物`,
      done: false,
    };
  }

  // 每一轮都重新问一次签名地址：地址有有效期，重试必须用新的一张（readArtifactFrom 负责重试
  // 「字节没读完」那一种，其余失败一次定终态）。
  const payload = await readArtifactFrom(async () => {
    const artifact = await requestJson(fetchImpl, artifactPath(session), { token: session.token });
    return {
      url: artifactUrlOf(artifact?.artifact_url),
      requestId: session.id,
      runId: session.runId,
      runAttempt: session.runAttempt,
    };
  }, { fetchImpl });
  return { status: "completed", label: "扫描已完成", detail, done: true, payload };
}

/**
 * 请求停止这次扫描。
 * 只是「请求」：Worker 把取消转给 GitHub Actions 就返回 202，运行要等它自己走到 cancelled。
 * 运行还没建立时返回 { requested: false }，由调用方在下一轮轮询里再发一次。
 */
export async function cancelScan(session, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== "function") throw failure("no_fetch", "当前环境没有可用的 fetch");
  if (!session.runId) {
    const remote = await requestJson(fetchImpl, scanPath(session), { token: session.token });
    const run = remote?.run;
    if (!run) {
      session.cancelRequestedAt = now();
      return { requested: false, confirmed: false };
    }
    bindRun(session, run);
  }
  await requestJson(fetchImpl, scanPath(session), { method: "DELETE", token: session.token });
  session.cancelRequestedAt = now();
  return { requested: true, confirmed: false };
}

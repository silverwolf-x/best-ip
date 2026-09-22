/* ============================================================================
   真实数据通路 —— 从本机 loopback 读取一次真实扫描的导出结果
   ----------------------------------------------------------------------------
   只做三件事：决定「读哪个任务、用哪个 API」，把这一次导出取回来，把明显不对的响应
   挡在渲染之前。字段映射在 records.js，页面接线在 main.js。

   为什么 base 只允许 http:// + 127.0.0.1/localhost/::1 + 显式端口：
   地址可以来自 URL 参数，任何人构造一个链接就能把页面指向别处。这里照抄
   frontend/src/transport/local.js 的严格性（只把 hostname 放宽到 localhost 与 ::1），
   带路径 / 查询 / 凭据或非 http 的 origin 一律拒掉。放宽校验不会换来能力，只会造出
   一个「地址看着合法、请求被本地 CORS 拒掉」的死链接。

   为什么选任务只走 URL 参数（?job=）：
   任务身份属于地址而不是页面状态——刷新、转发、多开标签页都会落在同一个任务上，
   也不需要引入「当前任务」这块与渲染无关的状态和一个新控件。

   为什么启动路径的错误做成返回值而不是抛异常：
   这个模块在页面启动时被调用，模块顶层抛异常会让整页连表头都不渲染——一个拼错的
   地址参数换来一屏白页，代价太大。所以 resolveTarget 把失败当成返回值，由 main.js
   决定显示哪种提示；真正发请求的 fetchExport 仍旧抛错，让调用方用 try/catch 收口。
   ========================================================================== */

export const DEFAULT_API_BASE = "http://127.0.0.1:8000";

// IPv6 字面量在 URL 里带方括号，hostname 拿到的是 "[::1]"，两种写法都收。
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const JOB_ID_MAX = 200;
const EXPORT_TIMEOUT_MS = 15_000;

/** 校验并归一化本机 API origin；不合法就抛 Error（中文原因，可直接显示给用户）。 */
export function validateApiBase(raw) {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  if (!candidate) throw new Error("本地扫描服务地址为空");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`本地扫描服务地址无效：${candidate}`);
  }
  const pathOk = parsed.pathname === "" || parsed.pathname === "/";
  if (
    parsed.protocol !== "http:"
    || !ALLOWED_HOSTNAMES.has(parsed.hostname)
    || !parsed.port
    || parsed.username
    || parsed.password
    || !pathOk
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("本地扫描服务地址必须是带端口的 127.0.0.1 / localhost / ::1 HTTP origin");
  }
  return parsed.origin;
}

function queryParams(search) {
  // 传进来的可能是 "?a=1" 也可能是 "a=1"；URLSearchParams 两种都能吃。
  return new URLSearchParams(typeof search === "string" ? search : "");
}

function readParam(search, name) {
  const value = queryParams(search).get(name);
  return value === null ? "" : value.trim();
}

/**
 * 任务 ID 里出现分隔符或控制字符说明它根本不是后端给的那个 ID，早点报错好过发一个畸形请求。
 * 「只有点」（`.` / `..`）也要挡：URL 解析器会把 `…/scans/../export` 折叠成 `/api/export`，
 * 于是页面会去打本机另一个 JSON 接口，再用它的响应冒充导出结果。
 */
function jobIdError(jobId) {
  if (!jobId) return "URL 参数 ?job= 是空的";
  if (jobId.length > JOB_ID_MAX) return "URL 参数 ?job= 太长了";
  if (/^\.+$/u.test(jobId)) return "URL 参数 ?job= 不是有效的任务 ID";
  if (/[\\/?#\u0000-\u001f]/u.test(jobId)) return "URL 参数 ?job= 含有不合法字符";
  return "";
}

/**
 * 解析这次打开页面用哪个数据源。
 * @returns {{jobId: string, apiBase: string, error: string}} jobId 为空表示演示路径。
 */
export function resolveTarget({ search = "", config = null } = {}) {
  const jobId = readParam(search, "job");
  // 「没写 ?job=」与「写了 ?job= 但是空的」必须分开：后者多半是个没替换成功的模板链接，
  // 当成演示路径处理就会给出一条满屏合成 IP、零提示的深链——正是真实通路最该防的错。
  if (!jobId) {
    const wroteJob = queryParams(search).has("job");
    if (!wroteJob) return Object.freeze({ jobId: "", apiBase: "", error: "" });
    return Object.freeze({ jobId: "", apiBase: "", error: "URL 参数 ?job= 是空的" });
  }

  const invalid = jobIdError(jobId);
  if (invalid) return Object.freeze({ jobId, apiBase: "", error: invalid });

  try {
    return Object.freeze({ jobId, apiBase: resolveApiBase({ search, config }), error: "" });
  } catch (cause) {
    return Object.freeze({ jobId, apiBase: "", error: cause.message });
  }
}

/**
 * API base 的优先级：dev 服务器注入的 site-config（window.BEST_IP_CONFIG.apiBase）
 * → `?api=` → 默认 8000。注入值优先于查询参数，因为它来自应用自己的配置而不是
 * 一条可以被随意转发/篡改的链接。
 */
export function resolveApiBase({ search = "", config = null } = {}) {
  const injected = config && typeof config.apiBase === "string" ? config.apiBase.trim() : "";
  return validateApiBase(injected || readParam(search, "api") || DEFAULT_API_BASE);
}

function httpError(status) {
  if (status === 409) return "该任务还没有生成导出";
  if (status === 404) return "本地没有这个任务";
  if (status === 0) return "浏览器拦截了这次请求：本地服务只放行 127.0.0.1 页面的跨源请求";
  return `本地扫描服务返回 HTTP ${status}`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 读取一次导出。
 * 请求形状是刻意的：只有 GET、不带自定义头（本地 CORS 只放行 Accept/Content-Type）、
 * credentials 显式 omit（本机服务不需要任何凭据，带上反而等于把 cookie 送到一个由
 * URL 参数指定的地址）。
 *
 * @returns {Promise<{id:string,status:string,created_at:string|null,finished_at:string|null,
 *   execution_mode:string|null,manifest_ready:boolean,cleanup_confirmed:boolean,
 *   manifest:object,counts:object,results:object[]}>}
 */
export async function fetchExport(apiBase, jobId, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("当前环境没有可用的 fetch");
  const url = `${apiBase}/api/scans/${encodeURIComponent(jobId)}/export`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json" },
      // 没有超时的话，后端活着但导出卡住时这个 promise 永不 settle，页面会永久停在
      // 「正在读取」的空表上——既没有报错也没有重试入口，只能重新加载页面。
      signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(EXPORT_TIMEOUT_MS) : undefined,
    });
  } catch (cause) {
    if (cause && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw new Error(`本地扫描服务 ${EXPORT_TIMEOUT_MS / 1000} 秒内没有返回导出结果`, { cause });
    }
    throw new Error(`连不上本地扫描服务 ${apiBase}：请先启动 backend（npm run dev）`, { cause });
  }

  if (!response.ok) throw new Error(httpError(response.status));

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new Error("本地扫描服务返回的不是 JSON", { cause });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("本地扫描服务返回的导出结果不是对象");
  }

  // 最小校验，只挡「渲染不动」的情况。刻意不复刻浏览器生产通路那套 ZIP/manifest
  // 逐字节校验：那是生产网关路径的职责（载荷在 worker 侧验完才交给前端），本地 loopback
  // 的载荷来自同一台机器上的同一个后端，重复校验只会把本地调试卡死。
  if (payload.status !== "completed") {
    throw new Error(`该任务未完成（status=${String(payload.status) || "未知"}），没有可读的导出`);
  }
  if (payload.manifest_ready !== true) throw new Error("该任务的导出结果尚未就绪（manifest_ready）");
  if (!Array.isArray(payload.results)) throw new Error("导出结果缺少 results 列表");
  if (!payload.manifest || typeof payload.manifest !== "object" || Array.isArray(payload.manifest)) {
    throw new Error("导出结果缺少 manifest");
  }

  const manifest = payload.manifest;
  const manifestCounts = manifest.counts && typeof manifest.counts === "object" ? manifest.counts : {};
  // counts 是给调用方看的一处口径：顶层 success_count/partial_count/failed_count 与
  // manifest.counts 理论上同源，缺一个也能拼出来。
  const counts = Object.freeze({
    total: numberOrNull(payload.total) ?? numberOrNull(manifest.total) ?? payload.results.length,
    completed: numberOrNull(payload.completed) ?? payload.results.length,
    success: numberOrNull(payload.success_count) ?? numberOrNull(manifestCounts.success),
    partial: numberOrNull(payload.partial_count) ?? numberOrNull(manifestCounts.partial),
    failed: numberOrNull(payload.failed_count) ?? numberOrNull(manifestCounts.failed),
    skipped: numberOrNull(payload.skipped) ?? 0,
  });

  return Object.freeze({
    id: typeof payload.id === "string" && payload.id ? payload.id : jobId,
    status: "completed",
    created_at: typeof payload.created_at === "string" ? payload.created_at : null,
    finished_at: typeof payload.finished_at === "string" ? payload.finished_at : null,
    execution_mode: typeof payload.execution_mode === "string" ? payload.execution_mode : null,
    manifest_ready: true,
    cleanup_confirmed: payload.cleanup_confirmed === true,
    manifest,
    counts,
    results: payload.results,
  });
}

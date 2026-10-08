import { HttpError, json } from "./responses.js";
import { REQUEST_ID_PATTERN, isRecord, positiveInteger } from "./config.js";
import { assertRelayConfigured, assertRelayToken } from "./relay.js";

// 扫描进行中的实时进度：runner 每隔几秒把「已完成几个节点、各几个成功/部分/失败」报给 Worker，
// 页面轮询时由 Worker 一并交回。为什么要这条通道：GitHub 在 job 结束前读不到日志（实测 404），
// Actions API 只给得出步骤名，于是一次几十秒到几分钟的扫描在页面上只有一句「Run production scan」。
//
// 它只是**过程中的读数**，不是结果：只有计数与阶段，不带节点名、出口 IP 或任何订阅内容；
// 表格仍然只认终态 artifact（逐字节校验之后）。进度写坏了、丢了、Durable Object 不可用，
// 都只会让页面退回「只显示步骤名」，绝不会让扫描或结果本身失败。
export const SCAN_PROGRESS_PATH = "/api/scan-progress";

const MAX_REPORT_CHARS = 2048;
const MAX_COUNT = 100_000;
// 一条进度只在扫描期间有意义：scan.yml 是 timeout-minutes: 30，artifact 只留 1 天。
// 6 小时后整条清掉，存储里不留历史。
const RETENTION_MS = 6 * 60 * 60 * 1000;
const READ_TIMEOUT_MS = 3_000;
// 阶段只往前走：同一次运行里晚到的旧报告不能把「打包中」打回「扫描中」。
const PHASES = ["subscription", "scanning", "packaging", "done"];

function invalidReport() {
  return new HttpError(400, "扫描进度报告无效", "invalid_request");
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null;
}

/** 校验并规整 runner 的一条报告；任何一项不合规都整条拒收，不做部分采信。 */
export function normalizeReport(payload) {
  if (!isRecord(payload)) throw invalidReport();
  const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
  const runId = positiveInteger(payload.run_id);
  const runAttempt = positiveInteger(payload.run_attempt);
  const phase = typeof payload.phase === "string" ? payload.phase : "";
  if (!REQUEST_ID_PATTERN.test(requestId) || !runId || !runAttempt || !PHASES.includes(phase)) {
    throw invalidReport();
  }
  const total = count(payload.total);
  const completed = count(payload.completed);
  const success = count(payload.success);
  const partial = count(payload.partial);
  const failed = count(payload.failed);
  if ([total, completed, success, partial, failed].includes(null)) throw invalidReport();
  if (completed > total || success + partial + failed !== completed) throw invalidReport();
  return {
    request_id: requestId,
    run_id: runId,
    run_attempt: runAttempt,
    phase,
    total,
    completed,
    success,
    partial,
    failed,
  };
}

async function readReport(request) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REPORT_CHARS * 4) throw invalidReport();
  let raw;
  try {
    raw = await request.text();
  } catch {
    throw invalidReport();
  }
  if (raw.length > MAX_REPORT_CHARS) throw invalidReport();
  try {
    return JSON.parse(raw);
  } catch {
    throw invalidReport();
  }
}

function progressStub(env, requestId) {
  const namespace = env.SCAN_PROGRESS;
  if (!namespace?.idFromName || !namespace?.get) return null;
  return namespace.get(namespace.idFromName(requestId));
}

/** POST /api/scan-progress：runner → Worker。与订阅中继同一把 runner 凭证，不经过站点密码门。 */
export async function scanProgressReport(request, env) {
  try {
    if (request.method !== "POST") throw new HttpError(405, "请求方法不支持", "method_not_allowed");
    assertRelayToken(request, assertRelayConfigured(env));
    const report = normalizeReport(await readReport(request));
    const stub = progressStub(env, report.request_id);
    if (!stub) throw new HttpError(503, "扫描进度存储尚未绑定", "worker_not_configured");
    const stored = await stub.fetch("https://scan-progress/report", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    if (!stored.ok) throw new HttpError(502, "扫描进度没有写入", "progress_unavailable");
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.code }, error.status, { "Cache-Control": "no-store" });
    }
    throw error;
  }
}

/**
 * 给页面的进度读数。只交回与这一次运行（run_id + attempt）对得上的那一条：重跑同一个
 * request_id 时，上一次 attempt 的计数不能被当成这一次的。读不到、超时、绑定缺失一律返回 null。
 */
export async function readScanProgress(env, requestId, run) {
  const runId = positiveInteger(run?.id);
  const runAttempt = positiveInteger(run?.run_attempt);
  if (!runId || !runAttempt || !REQUEST_ID_PATTERN.test(String(requestId || ""))) return null;
  const stub = progressStub(env, requestId);
  if (!stub) return null;
  let timer;
  try {
    const response = await Promise.race([
      stub.fetch("https://scan-progress/report", { method: "GET" }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS); }),
    ]);
    if (!response?.ok) return null;
    const stored = await response.json();
    if (!isRecord(stored) || stored.run_id !== runId || stored.run_attempt !== runAttempt) return null;
    return {
      phase: stored.phase,
      total: stored.total,
      completed: stored.completed,
      success: stored.success,
      partial: stored.partial,
      failed: stored.failed,
      updated_at: typeof stored.updated_at === "string" ? stored.updated_at : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 同一次运行里，新报告不能比已存的那条「更早」：阶段不倒退，同阶段完成数不减少。 */
function isStale(stored, incoming) {
  if (!isRecord(stored) || stored.run_id !== incoming.run_id || stored.run_attempt !== incoming.run_attempt) {
    return false;
  }
  const storedRank = PHASES.indexOf(stored.phase);
  const incomingRank = PHASES.indexOf(incoming.phase);
  if (incomingRank !== storedRank) return incomingRank < storedRank;
  return incoming.completed < stored.completed;
}

/**
 * 每个 request_id 一个实例，只存一条最新报告。存储是 Worker 已经校验过的规整对象，
 * 这里不再信任调用方之外的任何输入（只有本 Worker 能拿到这个 namespace）。
 */
export class ScanProgress {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method === "GET") {
      const stored = await this.state.storage.get("report");
      return Response.json(stored ?? null);
    }
    if (request.method !== "PUT") return new Response(null, { status: 405 });
    let incoming;
    try {
      incoming = normalizeReport(await request.json());
    } catch {
      return new Response(null, { status: 400 });
    }
    const stored = await this.state.storage.get("report");
    if (!isStale(stored, incoming)) {
      await this.state.storage.put("report", { ...incoming, updated_at: new Date().toISOString() });
    }
    if (!(await this.state.storage.getAlarm())) {
      await this.state.storage.setAlarm(Date.now() + RETENTION_MS);
    }
    return new Response(null, { status: 204 });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

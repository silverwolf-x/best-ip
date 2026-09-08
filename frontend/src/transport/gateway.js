import { createHttp } from "./http.js";
import { encryptSubscriptionUrl, requestId } from "../crypto.js";
import { readArtifact } from "../artifact/reader.js";
import { buildActionProgress, normalizedRunStatus, positiveInteger } from "./action-progress.js";
import { snapshot, assertSession, checkDeadline } from "./snapshot.js";

function displayProgress(run, remote) {
  const action = buildActionProgress(run, { available: remote.jobs_available !== false, jobs: Array.isArray(remote.jobs) ? remote.jobs : [], totalCount: remote.jobs_total_count ?? null, warning: remote.jobs_warning || null });
  return {
    source: "steps",
    label: action.jobs_state === "unavailable" ? "步骤暂不可读，保留上次进度" : action.jobs_state === "waiting" ? "等待创建扫描任务" : action.run_status === "completed" ? "扫描执行已完成" : "扫描步骤进行中",
    jobs: { total: remote.jobs_total_count == null ? null : action.jobs_total, current: action.current_job_index, completed: action.jobs_completed },
    steps: { total: action.steps_total, current: action.current_step_index, completed: action.steps_completed },
    currentStep: action.current_step?.name || "等待扫描步骤",
    elapsedMs: action.elapsed_ms,
    stepElapsedMs: action.current_step?.elapsed_ms ?? null,
    warning: action.warning,
  };
}

function bindRun(data, run) {
  const runId = positiveInteger(run.id);
  const attempt = positiveInteger(run.run_attempt);
  if (!runId || !attempt || (data.runId && data.runId !== runId) || (data.attempt && data.attempt !== attempt)) throw Object.assign(new Error("扫描运行身份无效"), { retryable: false });
  data.runId = runId;
  data.attempt = attempt;
  return { runId, attempt };
}

export function createGatewayTransport(config, { fetchImpl = globalThis.fetch, now = Date.now, baseURI = globalThis.document?.baseURI } = {}) {
  const http = createHttp({ credentials: "same-origin", serviceName: "扫描网关", fetchImpl });
  const sessions = new WeakMap();
  return Object.freeze({
    async health() {
      const health = await http.json("/api/health");
      return { ready: health.status === "ok", label: "个人网关就绪", hint: "个人网关模式：会话负责访问控制，订阅地址在浏览器内加密后发送；校验终态结果后展示节点。" };
    },
    async start(subscriptionUrl) {
      const id = requestId();
      const envelope = await encryptSubscriptionUrl(subscriptionUrl, id, config, { fetchImpl, baseURI });
      const payload = await http.json("/api/scans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: id, key_id: String(config.keyId), envelope }) });
      if (!payload?.scan_token || payload.request_id !== id) throw new Error("扫描网关未返回有效任务身份或 token");
      const session = Object.freeze({});
      sessions.set(session, { id, token: String(payload.scan_token), runId: positiveInteger(payload.run_id), attempt: null, dispatchedAt: Number.isSafeInteger(payload.dispatched_at) ? payload.dispatched_at : now(), status: "queued", terminal: null, progress: null });
      return session;
    },
    async poll(session) {
      const data = assertSession(sessions, session);
      if (data.terminal) return data.terminal;
      checkDeadline(data, data.status, false, now());
      const query = new URLSearchParams();
      if (data.runId) query.set("run_id", String(data.runId));
      if (data.attempt) query.set("run_attempt", String(data.attempt));
      const path = `/api/scans/${encodeURIComponent(data.id)}`;
      const remote = await http.json(path + (query.size ? `?${query}` : ""), {}, data.token);
      const run = remote?.run;
      if (!run) return snapshot({ progress: { source: "steps", label: "等待创建扫描任务", currentStep: "等待扫描步骤" } });
      const { runId, attempt } = bindRun(data, run);
      data.status = normalizedRunStatus(run);
      data.hasRun ||= data.status === "running";
      const nextProgress = displayProgress(run, remote);
      const progress = remote.jobs_available === false && data.progress ? { ...data.progress, label: nextProgress.label, warning: nextProgress.warning } : nextProgress;
      data.progress = progress;
      if (run.status !== "completed") return snapshot({ execution: data.status, phase: "collect", progress, error: progress.warning });
      if (run.conclusion !== "success") {
        data.token = "";
        data.terminal = snapshot({ execution: data.status, phase: "cleanup", progress, done: true, error: `扫描执行结束：${run.conclusion || "unknown"}` });
        return data.terminal;
      }
      if (!remote.artifact_ready) return snapshot({ execution: "completed", phase: "validate", progress: { ...progress, label: "执行已完成，等待终态结果" } });
      let archive;
      try {
        archive = await http.artifact(`${path}/artifact?run_id=${runId}&run_attempt=${attempt}`, data.token);
      } catch (error) {
        if (error.code !== "invalid_artifact") throw error;
        data.terminal = snapshot({ execution: "completed", phase: "validate", progress, error, invalid: true, done: true });
        data.token = "";
        return data.terminal;
      }
      try {
        const payload = await readArtifact(archive, { requestId: data.id, runId, runAttempt: attempt });
        data.terminal = snapshot({ execution: "completed", phase: "validate", progress, result: payload.result, done: true });
      } catch (error) {
        data.terminal = snapshot({ execution: "completed", phase: "validate", progress, error, invalid: true, done: true });
      }
      data.token = "";
      return data.terminal;
    },
    async cancel(session) {
      const data = assertSession(sessions, session);
      if (!data.runId) {
        const remote = await http.json(`/api/scans/${encodeURIComponent(data.id)}`, {}, data.token);
        if (!remote?.run) {
          data.cancelRequestedAt ??= now();
          return { requested: false, confirmed: false };
        }
        bindRun(data, remote.run);
      }
      await http.json(`/api/scans/${encodeURIComponent(data.id)}?run_id=${data.runId}`, { method: "DELETE" }, data.token);
      data.cancelRequestedAt = now();
      return { requested: true, confirmed: false };
    },
  });
}

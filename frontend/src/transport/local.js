import { createHttp, validateSubscriptionUrl } from "./http.js";
import { validateExport } from "../artifact/reader.js";
import { snapshot, nodeCounts, assertSession, checkDeadline, safeError } from "./snapshot.js";

function localApiBase(raw) {
  let parsed;
  try { parsed = new URL(String(raw || "").trim()); } catch { throw new Error("本地后端 API 地址无效"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password || !["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash) throw new Error("本地后端 API 必须是带端口的 127.0.0.1 HTTP origin");
  return parsed.origin;
}

export function createLocalTransport(config, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const http = createHttp({ base: localApiBase(config.apiBase), credentials: "omit", serviceName: "本地扫描服务", fetchImpl });
  const sessions = new WeakMap();
  return Object.freeze({
    async health() {
      const health = await http.json("/api/health");
      return { ready: health.status === "ok" && health.mihomo_ready === true, label: health.mihomo_ready ? "本地 Mihomo 就绪" : "本地 Mihomo 未安装", hint: "本地调试模式：订阅只发送到 127.0.0.1，由本机 Mihomo 执行真实扫描。" };
    },
    async start(subscriptionUrl) {
      validateSubscriptionUrl(subscriptionUrl);
      const id = `req-${globalThis.crypto.randomUUID()}`;
      const job = await http.json("/api/scans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription_url: subscriptionUrl, request_id: id }) });
      if (typeof job?.id !== "string" || !job.id) throw new Error("本地扫描服务未返回任务身份");
      const session = Object.freeze({});
      sessions.set(session, { id: job.id, dispatchedAt: now(), status: "queued", terminal: null });
      return session;
    },
    async poll(session) {
      const data = assertSession(sessions, session);
      if (data.terminal) return data.terminal;
      checkDeadline(data, data.status, true, now());
      const path = `/api/scans/${encodeURIComponent(data.id)}`;
      const job = await http.json(path);
      data.status = job.status;
      const execution = job.status === "preparing" ? "running" : job.status;
      const done = ["completed", "failed", "cancelled"].includes(execution);
      const progress = { source: "nodes", label: ({ queued: "等待本地扫描资源", running: "本地扫描进行中", completed: "本地扫描已完成", cancelled: "本地扫描已取消", failed: "本地扫描失败" })[execution] || "正在准备扫描", currentStep: job.message || "", elapsedMs: Date.parse(job.finished_at || new Date(now()).toISOString()) - Date.parse(job.created_at) };
      const error = safeError(job.error_details && typeof job.error_details === "object" && !Array.isArray(job.error_details) ? job.error_details : job.error, job.status === "preparing" ? "start" : done ? "cleanup" : "collect");
      const phase = error?.phase || (job.status === "preparing" ? "start" : done ? "cleanup" : "collect");
      let result = null;
      if (execution === "completed") {
        const exported = job.manifest_ready === true ? await http.json(`${path}/export`) : null;
        try {
          if (job.manifest_ready !== true) throw new Error("扫描执行完成但结果 manifest 不可用");
          result = validateExport(exported, data.id);
        } catch (error) {
          data.terminal = snapshot({ execution, phase: "validate", progress, error, invalid: true, done: true });
          return data.terminal;
        }
      }
      const value = snapshot({ execution, phase, progress, nodes: nodeCounts(job), result, error, done, cleanupConfirmed: job.cleanup_confirmed === true });
      if (done) data.terminal = value;
      return value;
    },
    async cancel(session) {
      const data = assertSession(sessions, session);
      const job = await http.json(`/api/scans/${encodeURIComponent(data.id)}`, { method: "DELETE" });
      data.cancelRequestedAt = now();
      return { requested: true, confirmed: job.status === "cancelled" && job.cleanup_confirmed === true };
    },
  });
}

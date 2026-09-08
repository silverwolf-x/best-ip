export function unknownNodes() {
  return { total: null, completed: null, success_count: null, partial_count: null, failed_count: null };
}

export function nodeCounts(job) {
  return Object.fromEntries(Object.keys(unknownNodes()).map(key => [key, Number.isInteger(job?.[key]) ? job[key] : null]));
}

export function safeError(error, phase = "collect") {
  if (!error) return null;
  return { code: typeof error.code === "string" ? error.code : "scan_error", phase: typeof error.phase === "string" ? error.phase : phase, message: typeof error === "string" ? error : String(error.message || "扫描失败"), retryable: error.retryable === true };
}

export function snapshot({ execution = "queued", phase = "start", progress = null, nodes = unknownNodes(), result = null, error = null, invalid = false, done = false, cleanupConfirmed = false } = {}) {
  const counts = result?.manifest?.counts;
  const availability = invalid ? "invalid" : !result ? "unavailable" : counts.success + counts.partial > 0 ? "verified" : "all_failed";
  return { execution, phase, progress, nodes: result ? nodeCounts(result) : nodes, result: { availability, fullyScored: counts ? counts.partial === 0 && counts.failed === 0 : null, hasExitNodes: counts ? counts.success + counts.partial > 0 : false, export: result }, error: safeError(error, phase), done, cleanupConfirmed: result?.cleanup_confirmed === true || cleanupConfirmed, retryAfterMs: 2000 };
}

export function assertSession(sessions, session) {
  const data = sessions.get(session);
  if (!data) throw new Error("扫描会话无效");
  return data;
}

export function checkDeadline(data, execution, local = false, now = Date.now()) {
  if (data.cancelRequestedAt != null) {
    if (now - data.cancelRequestedAt <= 2 * 60 * 1000) return;
    throw Object.assign(new Error("取消等待超过 2 分钟，尚未确认任务停止；请再次尝试停止扫描。"), { retryable: false });
  }
  const running = local || execution === "running" || data.hasRun;
  if (now - data.dispatchedAt > (running ? 31 : 13) * 60 * 1000) {
    const error = new Error(running ? "扫描超过 31 分钟，已停止等待；任务仍可能在后台运行。" : "扫描排队超过 13 分钟，已停止等待；任务仍可能在后台排队。");
    error.retryable = false;
    throw error;
  }
}

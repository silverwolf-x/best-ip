export function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function parseTime(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function elapsedMs(startedAt, completedAt, now = Date.now()) {
  const started = parseTime(startedAt);
  if (started === null) return null;
  const completed = completedAt ? parseTime(completedAt) : now;
  if (completed === null || completed < started) return null;
  return completed - started;
}

export function stepState(status) {
  if (["queued", "waiting", "requested", "pending"].includes(status)) return "queued";
  if (status === "in_progress") return "running";
  if (status === "completed") return "completed";
  return "unknown";
}

export function normalizeStep(step, now = Date.now()) {
  const status = typeof step?.status === "string" ? step.status : "unknown";
  return {
    number: positiveInteger(step?.number),
    name: String(step?.name || "未命名步骤"),
    status,
    state: stepState(status),
    conclusion: step?.conclusion ?? null,
    started_at: step?.started_at || null,
    completed_at: step?.completed_at || null,
    elapsed_ms: elapsedMs(step?.started_at, step?.completed_at, now),
  };
}

export function normalizeJob(job, now = Date.now()) {
  const steps = Array.isArray(job?.steps) ? job.steps.map((step) => normalizeStep(step, now)) : [];
  const activeIndex = steps.findIndex((step) => step.state === "running" || step.state === "queued");
  const displayIndex = activeIndex >= 0 ? activeIndex : steps.length ? steps.length - 1 : -1;
  const status = typeof job?.status === "string" ? job.status : "unknown";
  return {
    id: positiveInteger(job?.id),
    name: String(job?.name || "未命名 job"),
    status,
    state: stepState(status),
    conclusion: job?.conclusion ?? null,
    run_attempt: positiveInteger(job?.run_attempt),
    created_at: job?.created_at || null,
    started_at: job?.started_at || null,
    completed_at: job?.completed_at || null,
    elapsed_ms: elapsedMs(job?.started_at, job?.completed_at, now),
    steps,
    steps_total: steps.length,
    steps_completed: steps.filter((step) => step.status === "completed").length,
    current_step_index: displayIndex >= 0 ? displayIndex + 1 : null,
    current_step: displayIndex >= 0 ? steps[displayIndex] : null,
  };
}

export function normalizedRunStatus(run) {
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

export function buildActionProgress(run, jobsResult, now = Date.now()) {
  const normalizedJobs = (jobsResult?.jobs || []).map((job) => normalizeJob(job, now));
  const jobsAvailable = jobsResult?.available !== false;
  const jobsState = !jobsAvailable
    ? "unavailable"
    : normalizedJobs.length
      ? "available"
      : run?.status === "completed" ? "empty" : "waiting";
  const activeJobIndex = normalizedJobs.findIndex((job) => job.state === "running" || job.state === "queued");
  const displayJobIndex = activeJobIndex >= 0 ? activeJobIndex : normalizedJobs.length ? normalizedJobs.length - 1 : -1;
  const currentJob = displayJobIndex >= 0 ? normalizedJobs[displayJobIndex] : null;
  const jobsTotal = jobsResult?.totalCount !== null && jobsResult?.totalCount !== undefined && Number.isSafeInteger(Number(jobsResult.totalCount))
    ? Number(jobsResult.totalCount)
    : normalizedJobs.length;
  return {
    source: "github-actions",
    request_id: null,
    run_id: positiveInteger(run?.id),
    run_attempt: positiveInteger(run?.run_attempt),
    run_status: normalizedRunStatus(run),
    raw_run_status: run?.status || "unknown",
    conclusion: run?.conclusion ?? null,
    jobs_state: jobsState,
    jobs_total: jobsTotal,
    jobs_completed: normalizedJobs.filter((job) => job.status === "completed").length,
    current_job_index: displayJobIndex >= 0 ? displayJobIndex + 1 : null,
    current_job: currentJob,
    current_step_index: currentJob?.current_step_index || null,
    steps_total: currentJob?.steps_total || null,
    steps_completed: currentJob?.steps_completed || 0,
    current_step: currentJob?.current_step || null,
    jobs: normalizedJobs,
    run_started_at: run?.started_at || run?.created_at || null,
    run_completed_at: run?.completed_at || null,
    elapsed_ms: elapsedMs(run?.started_at || run?.created_at, run?.completed_at, now),
    updated_at: new Date(now).toISOString(),
    warning: jobsResult?.warning || null,
    run_url: run?.html_url || null,
  };
}

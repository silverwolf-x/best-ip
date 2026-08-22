(() => {
  const config = window.BEST_IP_CONFIG || {};
  const GITHUB_API = "https://api.github.com";
  const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
  const MAX_POLL_DELAY_MS = 10_000;
  const MAX_JOB_PAGES = 10;

  function isPagesMode() {
    if (config.mode === "local") return false;
    if (config.mode === "github-pages") return true;
    const host = window.location.hostname.toLowerCase();
    return host.endsWith(".github.io") || host === "github.io";
  }

  function repositoryPath() {
    const owner = String(config.owner || "").trim();
    const repository = String(config.repository || "").trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error("GitHub 仓库配置无效");
    }
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  }

  function workflowPath() {
    const workflow = String(config.workflowFile || "").trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(workflow)) throw new Error("扫描 workflow 配置无效");
    return `${repositoryPath()}/actions/workflows/${encodeURIComponent(workflow)}`;
  }

  function validatePat(pat) {
    if (!pat || pat.length < 20 || pat.length > 512 || /[\r\n]/.test(pat)) {
      throw new Error("请输入当前仓库 Actions Read and write 的临时 Fine-grained PAT");
    }
    return pat;
  }

  function requestId() {
    if (window.crypto?.randomUUID) return `req-${window.crypto.randomUUID()}`;
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return `req-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  }

  function base64Url(bytes) {
    const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    let binary = "";
    for (const value of data) binary += String.fromCharCode(value);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  }

  function fromBase64(value) {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  async function sha256Hex(bytes) {
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function importPublicKey() {
    const path = String(config.publicKeyPath || "").trim();
    const configuredKeyId = String(config.keyId || "").trim().toLowerCase();
    if (!path || !/^[a-f0-9]{64}$/u.test(configuredKeyId)) {
      throw new Error("GitHub Actions 加密公钥尚未配置");
    }
    const response = await fetch(new URL(path, document.baseURI), { cache: "no-store" });
    if (!response.ok) throw new Error("无法加载 GitHub Actions 加密公钥");
    const pem = await response.text();
    const body = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/gu, "");
    if (!body || body.length > 20_000) throw new Error("GitHub Actions 加密公钥格式无效");
    const der = fromBase64(body);
    if (await sha256Hex(der) !== configuredKeyId) {
      throw new Error("GitHub Actions 加密公钥指纹不匹配");
    }
    return window.crypto.subtle.importKey(
      "spki",
      der,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
  }

  async function encryptSubscriptionUrl(subscriptionUrl, id) {
    let parsed;
    try {
      parsed = new URL(subscriptionUrl);
    } catch {
      throw new Error("订阅地址格式无效");
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("订阅地址必须是公开 HTTP/HTTPS 地址，且不能携带认证信息");
    }
    const now = Math.floor(Date.now() / 1000);
    const expires = now + 900;
    const aes = await window.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const rawAes = await window.crypto.subtle.exportKey("raw", aes);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(subscriptionUrl);
    const additionalData = new TextEncoder().encode(`${id}:${config.keyId}:${expires}`);
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData },
      aes,
      plaintext,
    );
    const publicKey = await importPublicKey();
    const wrappedKey = await window.crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      publicKey,
      rawAes,
    );
    return {
      v: 1,
      kid: String(config.keyId),
      alg: "RSA-OAEP-3072-SHA256+AES-256-GCM",
      request_id: id,
      issued_at: now,
      expires_at: expires,
      ek: base64Url(wrappedKey),
      iv: base64Url(iv),
      aad: base64Url(additionalData),
      ct: base64Url(ciphertext),
    };
  }

  async function responseError(response) {
    if (response.status === 401 || response.status === 403) {
      return new Error(`GitHub API 权限不足（HTTP ${response.status}，请检查 PAT 的 Actions 权限）`);
    }
    if (response.status === 429) return new Error("GitHub API 触发限流，请稍后重试");
    if (response.status === 404) return new Error("GitHub workflow 或运行记录不存在");
    return new Error(`GitHub API 请求失败（HTTP ${response.status}）`);
  }

  async function githubJson(pat, path, options = {}) {
    validatePat(pat);
    const response = await fetch(`${GITHUB_API}${path}`, {
      ...options,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": config.apiVersion || "2022-11-28",
        Authorization: `Bearer ${pat}`,
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new Error("GitHub API 返回格式无效");
    }
  }

  async function githubArtifactZip(pat, artifactId) {
    validatePat(pat);
    if (!Number.isSafeInteger(Number(artifactId)) || Number(artifactId) < 1) {
      throw new Error("GitHub artifact ID 无效");
    }
    const response = await fetch(
      `${GITHUB_API}${repositoryPath()}/actions/artifacts/${Number(artifactId)}/zip`,
      {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": config.apiVersion || "2022-11-28",
          Authorization: `Bearer ${pat}`,
        },
      },
    );
    if (!response.ok) throw await responseError(response);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("扫描 artifact 超出浏览器安全大小限制");
    return bytes;
  }

  function positiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function parseTime(value) {
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function elapsedMs(startedAt, completedAt, now = Date.now()) {
    const started = parseTime(startedAt);
    if (started === null) return null;
    const completed = completedAt ? parseTime(completedAt) : now;
    if (completed === null || completed < started) return null;
    return completed - started;
  }

  function stepState(status) {
    if (["queued", "waiting", "requested", "pending"].includes(status)) return "queued";
    if (status === "in_progress") return "running";
    if (status === "completed") return "completed";
    return "unknown";
  }

  function normalizeStep(step, now = Date.now()) {
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

  function normalizeJob(job, now = Date.now()) {
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

  async function listRunJobs(pat, run) {
    const runId = positiveInteger(run?.id);
    const runAttempt = positiveInteger(run?.run_attempt);
    if (!runId || !runAttempt) throw new Error("GitHub Actions 运行版本无效");

    const jobs = [];
    const seen = new Set();
    let totalCount = null;
    let warning = null;
    for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
      const payload = await githubJson(
        pat,
        `${repositoryPath()}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
        { cache: "no-store" },
      );
      const pageJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      if (Number.isSafeInteger(Number(payload?.total_count)) && Number(payload.total_count) >= 0) {
        totalCount = Number(payload.total_count);
      }
      for (const job of pageJobs) {
        const jobAttempt = job?.run_attempt == null ? runAttempt : Number(job.run_attempt);
        const jobId = positiveInteger(job?.id);
        if (jobAttempt !== runAttempt || !jobId || seen.has(jobId)) continue;
        seen.add(jobId);
        jobs.push(job);
      }
      if (!pageJobs.length || pageJobs.length < 100 || (totalCount !== null && jobs.length >= totalCount)) break;
      if (page === MAX_JOB_PAGES) warning = "Actions job 分页达到安全上限，进度可能不完整";
    }
    return { available: true, jobs, totalCount, warning };
  }

  function normalizedRunStatus(run) {
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

  function buildActionProgress(run, jobsResult, now = Date.now()) {
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
    const jobsTotal = Number.isSafeInteger(Number(jobsResult?.totalCount))
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

  function waitingNodeProgress(phase = "waiting_artifact") {
    return {
      source: "artifact",
      phase,
      total: null,
      completed: null,
      success_count: null,
      partial_count: null,
      failed_count: null,
      usable: null,
    };
  }

  function terminalNodeProgress(status, result) {
    const counts = result?.manifest?.counts || {};
    return {
      source: "artifact",
      phase: "terminal",
      total: Number.isInteger(result?.total) ? result.total : null,
      completed: Number.isInteger(result?.completed) ? result.completed : null,
      success_count: Number.isInteger(result?.success_count) ? result.success_count : null,
      partial_count: Number.isInteger(result?.partial_count) ? result.partial_count : Number.isInteger(counts.partial) ? counts.partial : null,
      failed_count: Number.isInteger(result?.failed_count) ? result.failed_count : Number.isInteger(counts.failed) ? counts.failed : null,
      usable: typeof status?.usable === "boolean" ? status.usable : null,
    };
  }

  async function dispatch(pat, subscriptionUrl) {
    const id = requestId();
    const dispatchedAt = Date.now();
    const envelope = await encryptSubscriptionUrl(subscriptionUrl, id);
    const payload = await githubJson(pat, `${workflowPath()}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: String(config.defaultBranch || "main"),
        inputs: {
          request_id: id,
          key_id: String(config.keyId),
          encrypted_subscription_url: JSON.stringify(envelope),
        },
      }),
    });
    const runId = payload && (payload.workflow_run_id || payload.run_id || payload.id);
    const numericRunId = Number(runId);
    return {
      requestId: id,
      runId: Number.isSafeInteger(numericRunId) && numericRunId > 0 ? numericRunId : null,
      dispatchedAt,
    };
  }

  function expectedRunTitle(id) {
    return `Best IP scan ${id}`;
  }

  function isExactRun(run, requestIdValue, dispatchedAt) {
    if (!run || (run.display_title !== expectedRunTitle(requestIdValue) && run.name !== expectedRunTitle(requestIdValue))) {
      return false;
    }
    const created = Date.parse(run.created_at || "");
    const earliest = (dispatchedAt || Date.now()) - 60_000;
    return (
      run.event === "workflow_dispatch" &&
      run.head_branch === String(config.defaultBranch || "main") &&
      Number.isSafeInteger(Number(run.id)) &&
      Number.isFinite(created) &&
      created >= earliest
    );
  }

  async function resolveRun(pat, requestIdValue, runId, dispatchedAt) {
    if (runId) {
      const run = await githubJson(pat, `${repositoryPath()}/actions/runs/${runId}`);
      if (!isExactRun(run, requestIdValue, dispatchedAt)) {
        throw new Error("GitHub Actions 运行与本次请求无法精确关联");
      }
      return run;
    }
    const query = new URLSearchParams({
      event: "workflow_dispatch",
      branch: String(config.defaultBranch || "main"),
      per_page: "20",
    });
    const data = await githubJson(pat, `${workflowPath()}/runs?${query}`);
    const matches = (data?.workflow_runs || []).filter((run) =>
      isExactRun(run, requestIdValue, dispatchedAt)
    );
    if (matches.length > 1) throw new Error("无法唯一关联本次 GitHub Actions 运行");
    return matches[0] || null;
  }

  async function poll(pat, requestIdValue, runId, dispatchedAt) {
    const run = await resolveRun(pat, requestIdValue, runId, dispatchedAt);
    if (!run) {
      return {
        status: "dispatching",
        requestId: requestIdValue,
        runId: null,
        action_progress: {
          source: "github-actions",
          request_id: requestIdValue,
          run_id: null,
          run_attempt: null,
          run_status: "dispatching",
          raw_run_status: "dispatching",
          conclusion: null,
          jobs_state: "waiting",
          jobs_total: null,
          jobs_completed: 0,
          current_job_index: null,
          current_job: null,
          current_step_index: null,
          steps_total: null,
          steps_completed: 0,
          current_step: null,
          jobs: [],
          elapsed_ms: null,
          updated_at: new Date().toISOString(),
          warning: null,
          run_url: null,
        },
        node_progress: waitingNodeProgress(),
        total: null,
        completed: null,
        results: [],
        manifest_ready: false,
      };
    }

    let jobsResult;
    try {
      jobsResult = await listRunJobs(pat, run);
    } catch (error) {
      jobsResult = { available: false, jobs: [], totalCount: null, warning: error.message };
    }
    const actionProgress = buildActionProgress(run, jobsResult);
    actionProgress.request_id = requestIdValue;

    if (run.status !== "completed") {
      return {
        status: normalizedRunStatus(run),
        requestId: requestIdValue,
        runId: run.id,
        run,
        action_progress: actionProgress,
        node_progress: waitingNodeProgress(),
        total: null,
        completed: null,
        results: [],
        manifest_ready: false,
        error: actionProgress.warning || null,
      };
    }
    if (run.conclusion !== "success") {
      return {
        status: normalizedRunStatus(run),
        requestId: requestIdValue,
        runId: run.id,
        run,
        action_progress: actionProgress,
        node_progress: waitingNodeProgress("unavailable"),
        total: null,
        completed: null,
        results: [],
        manifest_ready: false,
        error: `GitHub Actions 运行结束：${run.conclusion || "unknown"}`,
      };
    }

    let artifacts;
    try {
      artifacts = await githubJson(pat, `${repositoryPath()}/actions/runs/${run.id}/artifacts?per_page=100`);
    } catch (error) {
      error.actionProgress = actionProgress;
      error.nodeProgress = waitingNodeProgress();
      throw error;
    }
    const prefix = `${String(config.artifactPrefix || "best-ip-result")}-${requestIdValue}-${run.id}-${run.run_attempt}`;
    const matches = (artifacts?.artifacts || []).filter((artifact) => artifact.name === prefix && !artifact.expired);
    if (matches.length !== 1) {
      return {
        status: "artifact_pending",
        requestId: requestIdValue,
        runId: run.id,
        run,
        action_progress: { ...actionProgress, run_status: "artifact_pending" },
        node_progress: waitingNodeProgress(),
        total: null,
        completed: null,
        results: [],
        manifest_ready: false,
        error: "Actions 已完成，正在等待扫描结果 artifact 发布",
      };
    }

    let archive;
    let payload;
    try {
      archive = await githubArtifactZip(pat, matches[0].id);
      payload = await window.BestIpZip.readArtifact(archive, {
        requestId: requestIdValue,
        runId: run.id,
        runAttempt: run.run_attempt,
      });
    } catch (error) {
      error.actionProgress = actionProgress;
      error.nodeProgress = waitingNodeProgress();
      throw error;
    }
    return {
      ...payload.result,
      status: payload.status.status === "completed" ? "completed" : "failed",
      requestId: requestIdValue,
      runId: run.id,
      run,
      action_progress: actionProgress,
      node_progress: terminalNodeProgress(payload.status, payload.result),
      action_status: payload.status,
      action_result: payload.result,
      manifest_ready: payload.status.status === "completed" && payload.result.manifest_ready !== false,
    };
  }

  async function cancel(pat, runId) {
    if (!runId) throw new Error("GitHub Actions 运行尚未建立");
    await githubJson(pat, `${repositoryPath()}/actions/runs/${runId}/cancel`, { method: "POST" });
  }

  window.BestIpAction = Object.freeze({
    MAX_POLL_DELAY_MS,
    isPagesMode,
    dispatch,
    poll,
    cancel,
  });
})();

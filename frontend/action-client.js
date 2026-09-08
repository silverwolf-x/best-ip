(() => {
  const config = window.BEST_IP_CONFIG || {};
  const mode = config.mode === "local" ? "local" : "gateway";
  const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
  const MAX_POLL_DELAY_MS = 10_000;
  const TEXT_ENCODER = new TextEncoder();

  function localApiBase() {
    if (mode !== "local") return "";
    const raw = String(config.apiBase || "").trim();
    if (!raw) throw new Error("本地后端 API 地址未配置");
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("本地后端 API 地址无效");
    }
    if (
      parsed.protocol !== "http:"
      || parsed.hostname !== "127.0.0.1"
      || !parsed.port
      || parsed.username
      || parsed.password
      || !["", "/"].includes(parsed.pathname)
      || parsed.search
      || parsed.hash
    ) {
      throw new Error("本地后端 API 必须是带端口的 127.0.0.1 HTTP origin");
    }
    return parsed.origin;
  }

  const apiBase = localApiBase();

  function apiUrl(path) {
    if (typeof path !== "string" || !path.startsWith("/api/")) {
      throw new Error("API path 无效");
    }
    return apiBase ? new URL(path, `${apiBase}/`).toString() : path;
  }

  function apiCredentials() {
    return apiBase ? "omit" : "same-origin";
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
    const plaintext = TEXT_ENCODER.encode(subscriptionUrl);
    const additionalData = TEXT_ENCODER.encode(`${id}:${config.keyId}:${expires}`);
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

  async function responseError(response, serviceName = "扫描网关") {
    if (response.status === 401 || response.status === 403) {
      return new Error(response.status === 401 ? "Cloudflare Access 登录已过期，请刷新页面" : "当前账号没有扫描权限");
    }
    if (response.status === 429) return new Error("扫描网关触发限流，请稍后重试");
    if (response.status === 404) return new Error("扫描任务或结果不存在");
    try {
      const payload = await response.clone().json();
      return new Error(payload.detail || `${serviceName}请求失败（HTTP ${response.status}）`);
    } catch {
      return new Error(`${serviceName}请求失败（HTTP ${response.status}）`);
    }
  }

  async function gatewayJson(scanToken, path, options = {}, serviceName = "扫描网关") {
    const response = await fetch(apiUrl(path), {
      ...options,
      cache: "no-store",
      credentials: apiCredentials(),
      headers: {
        Accept: "application/json",
        ...(scanToken ? { "X-Best-IP-Scan-Token": scanToken } : {}),
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw await responseError(response, serviceName);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new Error("扫描网关返回格式无效");
    }
  }

  async function gatewayArtifactZip(scanToken, requestIdValue, runId, runAttempt) {
    const numericRunId = Number(runId);
    const numericAttempt = Number(runAttempt);
    if (!requestIdValue || !Number.isSafeInteger(numericRunId) || numericRunId < 1 || !Number.isSafeInteger(numericAttempt) || numericAttempt < 1) {
      throw new Error("扫描运行身份无效");
    }
    const response = await fetch(
      apiUrl(`/api/scans/${encodeURIComponent(requestIdValue)}/artifact?run_id=${numericRunId}&run_attempt=${numericAttempt}`),
      {
        cache: "no-store",
        credentials: apiCredentials(),
        headers: scanToken ? { "X-Best-IP-Scan-Token": scanToken } : {},
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

  function localActionProgress(job, now = Date.now()) {
    const rawStatus = String(job?.status || "queued");
    const runStatus = ["preparing", "running"].includes(rawStatus) ? "running" : rawStatus;
    const terminal = ["completed", "failed", "cancelled"].includes(runStatus);
    const conclusion = runStatus === "completed" ? "success" : terminal ? runStatus : null;
    const step = {
      number: 1,
      name: String(job?.message || "等待本地扫描任务"),
      status: terminal ? "completed" : runStatus === "running" ? "in_progress" : "queued",
      state: terminal ? "completed" : runStatus === "running" ? "running" : "queued",
      conclusion,
      started_at: job?.created_at || null,
      completed_at: job?.finished_at || null,
      elapsed_ms: elapsedMs(job?.created_at, job?.finished_at, now),
    };
    return {
      source: "local",
      request_id: job?.id || null,
      run_id: null,
      run_attempt: null,
      run_status: runStatus,
      raw_run_status: rawStatus,
      conclusion,
      jobs_state: "available",
      jobs_total: 1,
      jobs_completed: terminal ? 1 : 0,
      current_job_index: 1,
      current_job: null,
      current_step_index: 1,
      steps_total: 1,
      steps_completed: terminal ? 1 : 0,
      current_step: step,
      jobs: [],
      run_started_at: job?.created_at || null,
      run_completed_at: job?.finished_at || null,
      elapsed_ms: step.elapsed_ms,
      updated_at: job?.updated_at || new Date(now).toISOString(),
      warning: null,
      run_url: null,
    };
  }

  function localNodeProgress(job) {
    const terminal = ["completed", "failed", "cancelled"].includes(job?.status);
    const partial = Number.isInteger(job?.partial_count) ? job.partial_count : null;
    const failed = Number.isInteger(job?.failed_count) ? job.failed_count : null;
    return {
      source: "local",
      phase: terminal ? "terminal" : String(job?.status || "queued"),
      total: Number.isInteger(job?.total) ? job.total : null,
      completed: Number.isInteger(job?.completed) ? job.completed : null,
      success_count: Number.isInteger(job?.success_count) ? job.success_count : null,
      partial_count: partial,
      failed_count: failed,
      usable: job?.status === "completed" && partial !== null && failed !== null
        ? partial === 0 && failed === 0
        : null,
    };
  }

  async function localDispatch(subscriptionUrl) {
    let parsed;
    try {
      parsed = new URL(subscriptionUrl);
    } catch {
      throw new Error("订阅地址格式无效");
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("订阅地址必须是公开 HTTP/HTTPS 地址，且不能携带认证信息");
    }
    const id = requestId();
    const dispatchedAt = Date.now();
    const payload = await gatewayJson("", "/api/scans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription_url: subscriptionUrl, request_id: id }),
    }, "本地扫描服务");
    return {
      requestId: String(payload?.id || id),
      runId: null,
      dispatchedAt,
      scanToken: "",
    };
  }

  async function localPoll(_scanToken, requestIdValue) {
    const path = `/api/scans/${encodeURIComponent(requestIdValue)}`;
    const job = await gatewayJson("", path, {}, "本地扫描服务");
    const actionProgress = localActionProgress(job);
    const nodeProgress = localNodeProgress(job);
    if (job?.status === "completed" && job?.manifest_ready === true) {
      const result = await gatewayJson("", `${path}/export`, {}, "本地扫描服务");
      const usable = nodeProgress.usable === true;
      return {
        ...result,
        status: "completed",
        requestId: requestIdValue,
        runId: null,
        action_progress: actionProgress,
        node_progress: nodeProgress,
        action_status: { status: "completed", usable, source: "local" },
        action_result: result,
        manifest_ready: true,
        cleanup_confirmed: result?.cleanup_confirmed === true,
      };
    }
    return {
      status: String(job?.status || "queued"),
      requestId: requestIdValue,
      runId: null,
      action_progress: actionProgress,
      node_progress: nodeProgress,
      total: nodeProgress.total,
      completed: nodeProgress.completed,
      results: [],
      manifest_ready: false,
      cleanup_confirmed: job?.cleanup_confirmed === true,
      error: job?.error || null,
    };
  }

  async function localCancel(_scanToken, requestIdValue) {
    await gatewayJson(
      "",
      `/api/scans/${encodeURIComponent(requestIdValue)}`,
      { method: "DELETE" },
      "本地扫描服务",
    );
  }

  async function gatewayDispatch(subscriptionUrl) {
    const id = requestId();
    const dispatchedAt = Date.now();
    const envelope = await encryptSubscriptionUrl(subscriptionUrl, id);
    const payload = await gatewayJson("", "/api/scans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: id, key_id: String(config.keyId), envelope }),
    });
    const runId = Number(payload?.run_id || payload?.workflow_run_id || payload?.id);
    const scanToken = String(payload?.scan_token || "");
    if (!scanToken) throw new Error("扫描网关未返回有效任务 token");
    return {
      requestId: String(payload?.request_id || id),
      runId: Number.isSafeInteger(runId) && runId > 0 ? runId : null,
      dispatchedAt: Number.isSafeInteger(Number(payload?.dispatched_at)) ? Number(payload.dispatched_at) : dispatchedAt,
      scanToken,
    };
  }

  function dispatchingProgress(requestIdValue) {
    return {
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
    };
  }

  async function gatewayPoll(scanToken, requestIdValue, runId) {
    const query = new URLSearchParams();
    if (runId) query.set("run_id", String(runId));
    const suffix = query.size ? `?${query.toString()}` : "";
    const remote = await gatewayJson(scanToken, `/api/scans/${encodeURIComponent(requestIdValue)}${suffix}`);
    const run = remote?.run || null;
    if (!run) {
      return {
        status: "dispatching",
        requestId: requestIdValue,
        runId: null,
        action_progress: dispatchingProgress(requestIdValue),
        node_progress: waitingNodeProgress(),
        total: null,
        completed: null,
        results: [],
        manifest_ready: false,
      };
    }

    const jobsResult = {
      available: remote?.jobs_available !== false,
      jobs: Array.isArray(remote?.jobs) ? remote.jobs : [],
      totalCount: Number.isSafeInteger(Number(remote?.jobs_total_count)) ? Number(remote.jobs_total_count) : null,
      warning: remote?.jobs_warning || null,
    };
    const actionProgress = buildActionProgress(run, jobsResult);
    actionProgress.request_id = requestIdValue;

    if (remote?.status === "artifact_pending" || (run.status === "completed" && run.conclusion === "success" && !remote?.artifact_ready)) {
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
    if (run.status !== "completed") {
      return {
        status: remote?.status || normalizedRunStatus(run),
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
        status: remote?.status || normalizedRunStatus(run),
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

    let archive;
    let payload;
    try {
      archive = await gatewayArtifactZip(scanToken, requestIdValue, run.id, run.run_attempt);
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

  async function gatewayCancel(scanToken, requestIdValue, runId) {
    if (!runId) throw new Error("GitHub Actions 运行尚未建立");
    await gatewayJson(
      scanToken,
      `/api/scans/${encodeURIComponent(requestIdValue)}?run_id=${Number(runId)}`,
      { method: "DELETE" },
    );
  }

  window.BestIpAction = Object.freeze({
    MODE: mode,
    API_BASE: apiBase,
    MAX_POLL_DELAY_MS,
    apiUrl,
    dispatch: mode === "local" ? localDispatch : gatewayDispatch,
    poll: mode === "local" ? localPoll : gatewayPoll,
    cancel: mode === "local" ? localCancel : gatewayCancel,
  });
})();

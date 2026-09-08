import {
  SignJWT,
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
} from "jose";

const GITHUB_API = "https://api.github.com";
const GITHUB_OWNER = "silverwolf-x";
const GITHUB_REPOSITORY = "best-ip";
const GITHUB_WORKFLOW = "scan.yml";
const GITHUB_WORKFLOW_PATH = ".github/workflows/scan.yml";
const GITHUB_REF = "main";
const ARTIFACT_PREFIX = "best-ip-result";
const MAX_REQUEST_BYTES = 70 * 1024;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const SCAN_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const ENVELOPE_TTL_SECONDS = 15 * 60;
const MAX_JOB_PAGES = 10;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const KEY_ID_PATTERN = /^[a-f0-9]{64}$/iu;
const APP_ID_PATTERN = /^[0-9]+$/u;
const INSTALLATION_ID_PATTERN = /^[0-9]+$/u;

let installationTokenCache = null;
const accessJwksCache = new Map();
const hmacKeyCache = new Map();

class HttpError extends Error {
  constructor(status, message, code = "request_failed") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class GitHubError extends HttpError {
  constructor(status, message, code = "github_request_failed") {
    super(status, message, code);
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function secureResponse(response, { noStore = false } = {}) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (noStore) headers.set("Cache-Control", "no-store");
  if (headers.get("Content-Type")?.includes("text/html")) {
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function fail(error) {
  if (error instanceof HttpError) {
    return json({ error: error.code, detail: error.message }, error.status, { "Cache-Control": "no-store" });
  }
  return json({ error: "internal_error", detail: "Worker 内部错误" }, 500, { "Cache-Control": "no-store" });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new HttpError(401, "扫描 token 无效", "invalid_scan_token");
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new HttpError(401, "扫描 token 无效", "invalid_scan_token");
  }
}

function text(value) {
  return new TextEncoder().encode(String(value));
}

async function hmacKey(secret) {
  const normalized = String(secret || "");
  if (!normalized) throw new HttpError(503, "Worker scan token 尚未配置", "worker_not_configured");
  if (!hmacKeyCache.has(normalized)) {
    hmacKeyCache.set(
      normalized,
      crypto.subtle.importKey(
        "raw",
        text(normalized),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    );
  }
  return hmacKeyCache.get(normalized);
}

async function signScanToken(env, requestId, dispatchedAt) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    request_id: requestId,
    dispatched_at: dispatchedAt,
    expires_at: now + SCAN_TOKEN_TTL_SECONDS,
  };
  const encoded = base64UrlEncode(text(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env.SCAN_TOKEN_SECRET), text(encoded));
  return `${encoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyScanToken(env, token, requestId) {
  if (typeof token !== "string" || token.length > 4096) {
    throw new HttpError(401, "扫描 token 无效", "invalid_scan_token");
  }
  const parts = token.split(".");
  if (parts.length !== 2) throw new HttpError(401, "扫描 token 无效", "invalid_scan_token");
  const [encoded, encodedSignature] = parts;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(env.SCAN_TOKEN_SECRET),
    base64UrlDecode(encodedSignature),
    text(encoded),
  );
  if (!valid) throw new HttpError(401, "扫描 token 无效", "invalid_scan_token");
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
  } catch {
    throw new HttpError(401, "扫描 token 无效", "invalid_scan_token");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    !isRecord(payload) ||
    payload.v !== 1 ||
    payload.request_id !== requestId ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    !Number.isSafeInteger(payload.dispatched_at) ||
    !Number.isSafeInteger(payload.expires_at) ||
    payload.expires_at <= now
  ) {
    throw new HttpError(401, "扫描 token 无效或已过期", "invalid_scan_token");
  }
  return payload;
}

function normalizeTeamDomain(value) {
  const domain = String(value || "").trim().replace(/\/+$/u, "");
  if (!/^https:\/\/[^/]+$/u.test(domain)) return "";
  return domain;
}

async function authenticate(request, env, ctx) {
  const url = new URL(request.url);
  if (env.DEV_ALLOW_UNAUTHENTICATED === "1" && ["localhost", "127.0.0.1"].includes(url.hostname)) {
    return { email: "development" };
  }
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const audience = String(env.ACCESS_POLICY_AUD || "").trim();
  const allowedEmail = String(env.ACCESS_ALLOWED_EMAIL || "").trim().toLowerCase();

  if (ctx?.access) {
    try {
      if (!allowedEmail) {
        throw new HttpError(503, "Cloudflare Access 尚未配置允许邮箱", "worker_not_configured");
      }
      const nativeAudience = String(ctx.access.aud || "").trim();
      if (!nativeAudience || (audience && nativeAudience !== audience)) {
        throw new HttpError(401, "Cloudflare Access 应用身份无效", "access_invalid");
      }
      const identity = await ctx.access.getIdentity();
      const email = String(identity?.email || "").trim().toLowerCase();
      if (!email) throw new HttpError(401, "Cloudflare Access 身份无效", "access_invalid");
      if (email !== allowedEmail) {
        throw new HttpError(403, "当前账号没有使用权限", "access_forbidden");
      }
      return { email };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(401, "Cloudflare Access 身份无效", "access_invalid");
    }
  }

  if (!teamDomain || !audience || !allowedEmail) {
    throw new HttpError(503, "Cloudflare Access 尚未配置", "worker_not_configured");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new HttpError(401, "需要 Cloudflare Access 登录", "access_required");
  let jwks = accessJwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    accessJwksCache.set(teamDomain, jwks);
  }
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience,
      algorithms: ["RS256"],
    });
    const email = String(result.payload.email || "").trim().toLowerCase();
    if (!email || email !== allowedEmail) {
      throw new HttpError(403, "当前账号没有使用权限", "access_forbidden");
    }
    return { email };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Cloudflare Access 身份无效", "access_invalid");
  }
}

function assertSameOrigin(request) {
  if (!["POST", "DELETE"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) {
    throw new HttpError(403, "拒绝跨站状态变更请求", "csrf_rejected");
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    throw new HttpError(403, "拒绝跨站状态变更请求", "csrf_rejected");
  }
}

function assertWorkerConfigured(env) {
  if (
    !KEY_ID_PATTERN.test(String(env.SCAN_KEY_ID || "").trim()) ||
    !String(env.SCAN_TOKEN_SECRET || "").trim() ||
    !APP_ID_PATTERN.test(String(env.GITHUB_APP_ID || "").trim()) ||
    !INSTALLATION_ID_PATTERN.test(String(env.GITHUB_APP_INSTALLATION_ID || env.GITHUB_INSTALLATION_ID || "").trim()) ||
    !String(env.GITHUB_APP_PRIVATE_KEY || "").trim()
  ) {
    throw new HttpError(503, "Worker 扫描 secrets 尚未完整配置", "worker_not_configured");
  }
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "请求体超过安全上限", "request_too_large");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "请求体超过安全上限", "request_too_large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "请求 JSON 无效", "invalid_json");
  }
}

function validateEnvelope(body, env) {
  if (!isRecord(body)) throw new HttpError(400, "请求结构无效", "invalid_request");
  const requestId = String(body.request_id || "");
  const keyId = String(body.key_id || "").toLowerCase();
  const configuredKeyId = String(env.SCAN_KEY_ID || "").trim().toLowerCase();
  const envelope = body.envelope;
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new HttpError(400, "request_id 无效", "invalid_request");
  if (!KEY_ID_PATTERN.test(keyId) || !configuredKeyId || keyId !== configuredKeyId) {
    throw new HttpError(400, "扫描公钥指纹不匹配", "invalid_key_id");
  }
  if (!isRecord(envelope) || envelope.request_id !== requestId || String(envelope.kid || "").toLowerCase() !== keyId) {
    throw new HttpError(400, "订阅密文 envelope 无效", "invalid_envelope");
  }
  if (envelope.v !== 1 || envelope.alg !== "RSA-OAEP-3072-SHA256+AES-256-GCM") {
    throw new HttpError(400, "订阅密文算法无效", "invalid_envelope");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(envelope.issued_at) ||
    !Number.isSafeInteger(envelope.expires_at) ||
    envelope.expires_at <= now ||
    envelope.expires_at - envelope.issued_at !== ENVELOPE_TTL_SECONDS ||
    envelope.issued_at > now + 60
  ) {
    throw new HttpError(400, "订阅密文已过期或时间无效", "expired_envelope");
  }
  for (const field of ["ek", "iv", "aad", "ct"]) {
    if (typeof envelope[field] !== "string" || envelope[field].length < 1 || envelope[field].length > 65535) {
      throw new HttpError(400, "订阅密文字段无效", "invalid_envelope");
    }
  }
  const serialized = JSON.stringify(envelope);
  if (serialized.length > 65535) throw new HttpError(413, "订阅密文超过安全上限", "envelope_too_large");
  return { requestId, keyId, envelope, serialized };
}

async function appJwt(env) {
  const appId = String(env.GITHUB_APP_ID || "").trim();
  const privateKey = normalizePrivateKey(String(env.GITHUB_APP_PRIVATE_KEY || "").replaceAll("\\n", "\n"));
  if (!APP_ID_PATTERN.test(appId) || !privateKey) {
    throw new HttpError(503, "GitHub App 尚未配置", "worker_not_configured");
  }
  let key;
  try {
    key = await importPKCS8(privateKey, "RS256");
  } catch {
    throw new HttpError(503, "GitHub App 私钥无效", "worker_not_configured");
  }
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .setIssuer(appId)
    .sign(key);
}

function derLength(length) {
  if (length < 128) return Uint8Array.of(length);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function derField(tag, value) {
  const length = derLength(value.length);
  const result = new Uint8Array(1 + length.length + value.length);
  result[0] = tag;
  result.set(length, 1);
  result.set(value, 1 + length.length);
  return result;
}

function joinBytes(...parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function pemBytes(pem, label) {
  const body = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/gu, "");
  if (!body) return null;
  try {
    const binary = atob(body);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function normalizePrivateKey(pem) {
  if (pem.includes("-----BEGIN PRIVATE KEY-----")) return pem;
  if (!pem.includes("-----BEGIN RSA PRIVATE KEY-----")) return pem;
  const pkcs1 = pemBytes(pem, "RSA PRIVATE KEY");
  if (!pkcs1) return pem;
  const algorithm = derField(0x30, joinBytes(
    derField(0x06, Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01])),
    derField(0x05, new Uint8Array()),
  ));
  const privateKeyInfo = derField(0x30, joinBytes(
    derField(0x02, Uint8Array.of(0)),
    algorithm,
    derField(0x04, pkcs1),
  ));
  let encoded = "";
  for (const byte of privateKeyInfo) encoded += String.fromCharCode(byte);
  const body = btoa(encoded).match(/.{1,64}/gu)?.join("\n") || "";
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

async function installationToken(env, forceRefresh = false) {
  const installationId = String(env.GITHUB_APP_INSTALLATION_ID || env.GITHUB_INSTALLATION_ID || "").trim();
  if (!INSTALLATION_ID_PATTERN.test(installationId)) {
    throw new HttpError(503, "GitHub App installation 尚未配置", "worker_not_configured");
  }
  const now = Date.now();
  if (!forceRefresh && installationTokenCache && installationTokenCache.expiresAt - now > 5 * 60 * 1000) {
    return installationTokenCache.token;
  }
  const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${await appJwt(env)}`,
      "User-Agent": "best-ip-cloudflare-worker",
    },
    body: JSON.stringify({ repositories: [GITHUB_REPOSITORY] }),
  });
  if (!response.ok) throw new HttpError(502, "无法取得 GitHub App installation token", "github_auth_failed");
  const payload = await response.json().catch(() => null);
  if (!isRecord(payload) || typeof payload.token !== "string") {
    throw new HttpError(502, "GitHub App token 返回格式无效", "github_auth_failed");
  }
  const expiresAt = Date.parse(String(payload.expires_at || ""));
  installationTokenCache = {
    token: payload.token,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 50 * 60 * 1000,
  };
  return payload.token;
}

function githubUrl(path, query = {}) {
  const url = new URL(`${GITHUB_API}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

async function githubJson(env, path, options = {}, retry = true) {
  const token = await installationToken(env);
  const response = await fetch(githubUrl(path, options.query), {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "best-ip-cloudflare-worker",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    body: options.body,
    redirect: "manual",
  });
  if (response.status === 401 && retry) {
    installationTokenCache = null;
    return githubJson(env, path, options, false);
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const status = response.status === 403 ? 502 : response.status === 404 ? 404 : 502;
    throw new GitHubError(status, status === 404 ? "GitHub 资源不存在" : "GitHub API 请求失败");
  }
  return payload;
}

async function githubRawArtifact(env, artifactId) {
  const token = await installationToken(env);
  const response = await fetch(githubUrl(`/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`), {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "best-ip-cloudflare-worker",
      Authorization: `Bearer ${token}`,
    },
    redirect: "manual",
  });
  if (response.status === 401) return githubRawArtifactAfterRefresh(env, artifactId);
  if (response.status === 200) {
    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_ARTIFACT_BYTES) {
      throw new HttpError(413, "扫描 artifact 超出安全上限", "artifact_too_large");
    }
    return response;
  }
  if (response.status < 300 || response.status >= 400) {
    throw new GitHubError(502, "GitHub artifact 下载失败");
  }
  const location = response.headers.get("Location");
  if (!location) throw new GitHubError(502, "GitHub artifact 下载地址缺失");
  const archive = await fetch(location, { redirect: "follow" });
  if (!archive.ok) throw new GitHubError(502, "GitHub artifact 下载失败");
  const contentLength = Number(archive.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ARTIFACT_BYTES) {
    throw new HttpError(413, "扫描 artifact 超出安全上限", "artifact_too_large");
  }
  return archive;
}

async function githubRawArtifactAfterRefresh(env, artifactId) {
  installationTokenCache = null;
  return githubRawArtifact(env, artifactId);
}

function expectedRunTitle(requestId) {
  return `Best IP scan ${requestId}`;
}

function exactRun(run, requestId, dispatchedAt) {
  if (!isRecord(run)) return false;
  if (run.path !== GITHUB_WORKFLOW_PATH || run.display_title !== expectedRunTitle(requestId)) return false;
  if (run.event !== "workflow_dispatch" || run.head_branch !== GITHUB_REF) return false;
  const id = positiveInteger(run.id);
  const created = Date.parse(String(run.created_at || ""));
  if (!id || !Number.isFinite(created)) return false;
  return created >= dispatchedAt - 120_000 && created <= Date.now() + 120_000;
}

async function resolveRun(env, requestId, runId, dispatchedAt) {
  if (runId) {
    const run = await githubJson(env, `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/runs/${runId}`);
    if (!exactRun(run, requestId, dispatchedAt)) {
      throw new HttpError(409, "GitHub Actions 运行与本次请求无法精确关联", "run_identity_mismatch");
    }
    return run;
  }
  const payload = await githubJson(
    env,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/workflows/${encodeURIComponent(GITHUB_WORKFLOW)}/runs`,
    { query: { event: "workflow_dispatch", branch: GITHUB_REF, per_page: 20 } },
  );
  const matches = Array.isArray(payload?.workflow_runs)
    ? payload.workflow_runs.filter((run) => exactRun(run, requestId, dispatchedAt))
    : [];
  if (matches.length > 1) throw new HttpError(409, "无法唯一关联本次 GitHub Actions 运行", "run_identity_ambiguous");
  return matches[0] || null;
}

async function listRunJobs(env, run) {
  const runId = positiveInteger(run?.id);
  const attempt = positiveInteger(run?.run_attempt);
  if (!runId || !attempt) throw new HttpError(502, "GitHub Actions 运行版本无效", "github_run_invalid");
  const jobs = [];
  const seen = new Set();
  let totalCount = null;
  let warning = null;
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const payload = await githubJson(
      env,
      `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs`,
      { query: { per_page: 100, page } },
    );
    const pageJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    if (Number.isSafeInteger(Number(payload?.total_count)) && Number(payload.total_count) >= 0) {
      totalCount = Number(payload.total_count);
    }
    for (const job of pageJobs) {
      const jobAttempt = job?.run_attempt == null ? attempt : Number(job.run_attempt);
      const jobId = positiveInteger(job?.id);
      if (jobAttempt !== attempt || !jobId || seen.has(jobId)) continue;
      seen.add(jobId);
      jobs.push(job);
    }
    if (!pageJobs.length || pageJobs.length < 100 || (totalCount !== null && jobs.length >= totalCount)) break;
    if (page === MAX_JOB_PAGES) warning = "Actions job 分页达到安全上限，进度可能不完整";
  }
  return { available: true, jobs, totalCount, warning };
}

async function findArtifact(env, run, requestId) {
  const runId = positiveInteger(run?.id);
  const attempt = positiveInteger(run?.run_attempt);
  if (!runId || !attempt) throw new HttpError(502, "GitHub Actions 运行版本无效", "github_run_invalid");
  const payload = await githubJson(
    env,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/runs/${runId}/artifacts`,
    { query: { per_page: 100 } },
  );
  const expected = `${ARTIFACT_PREFIX}-${requestId}-${runId}-${attempt}`;
  const matches = (Array.isArray(payload?.artifacts) ? payload.artifacts : [])
    .filter((artifact) => artifact?.name === expected && artifact?.expired !== true);
  if (matches.length > 1) throw new HttpError(409, "扫描 artifact 无法唯一匹配", "artifact_ambiguous");
  return matches[0] || null;
}

function limitStream(stream, maxBytes = MAX_ARTIFACT_BYTES) {
  let received = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const length = chunk?.byteLength;
      if (!Number.isSafeInteger(length) || length < 0) {
        controller.error(new Error("扫描 artifact 响应块无效"));
        return;
      }
      received += length;
      if (received > maxBytes) {
        controller.error(new Error("扫描 artifact 超出安全上限"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

function runStatus(run) {
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

async function readScanContext(request, env, requestId) {
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new HttpError(400, "request_id 无效", "invalid_request");
  const token = request.headers.get("X-Best-IP-Scan-Token");
  const payload = await verifyScanToken(env, token, requestId);
  const url = new URL(request.url);
  const runId = url.searchParams.get("run_id") ? positiveInteger(url.searchParams.get("run_id")) : null;
  const attempt = url.searchParams.get("run_attempt") ? positiveInteger(url.searchParams.get("run_attempt")) : null;
  if (url.searchParams.has("run_id") && !runId) throw new HttpError(400, "run_id 无效", "invalid_request");
  if (url.searchParams.has("run_attempt") && !attempt) throw new HttpError(400, "run_attempt 无效", "invalid_request");
  return { payload, runId, attempt };
}

function assertRunAttempt(run, expectedAttempt) {
  if (expectedAttempt && positiveInteger(run?.run_attempt) !== expectedAttempt) {
    throw new HttpError(409, "GitHub Actions 运行 attempt 与本次请求不匹配", "run_identity_mismatch");
  }
}

async function createScan(request, env) {
  assertSameOrigin(request);
  assertWorkerConfigured(env);
  const body = await readJsonBody(request);
  const { requestId, keyId, serialized } = validateEnvelope(body, env);
  const dispatchedAt = Date.now();
  await githubJson(
    env,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/workflows/${encodeURIComponent(GITHUB_WORKFLOW)}/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: GITHUB_REF,
        inputs: {
          request_id: requestId,
          key_id: keyId,
          encrypted_subscription_url: serialized,
        },
      }),
    },
  );
  return json(
    {
      request_id: requestId,
      run_id: null,
      dispatched_at: dispatchedAt,
      scan_token: await signScanToken(env, requestId, dispatchedAt),
    },
    202,
    { "Cache-Control": "no-store" },
  );
}

async function scanState(request, env, requestId) {
  const context = await readScanContext(request, env, requestId);
  const run = await resolveRun(env, requestId, context.runId, context.payload.dispatched_at);
  if (run) assertRunAttempt(run, context.attempt);
  if (!run) {
    return json(
      {
        request_id: requestId,
        status: "dispatching",
        run: null,
        jobs: [],
        jobs_available: true,
        jobs_total_count: null,
        jobs_warning: null,
        artifact_ready: false,
      },
      200,
      { "Cache-Control": "no-store" },
    );
  }
  let jobsResult = { available: false, jobs: [], totalCount: null, warning: null };
  try {
    jobsResult = await listRunJobs(env, run);
  } catch (error) {
    jobsResult.warning = error instanceof HttpError ? error.message : "读取 Actions job 失败";
  }
  let artifact = null;
  if (run.status === "completed" && run.conclusion === "success") artifact = await findArtifact(env, run, requestId);
  const status = run.status === "completed" && run.conclusion === "success" && !artifact
    ? "artifact_pending"
    : runStatus(run);
  return json(
    {
      request_id: requestId,
      status,
      run,
      jobs: jobsResult.jobs,
      jobs_available: jobsResult.available,
      jobs_total_count: jobsResult.totalCount,
      jobs_warning: jobsResult.warning,
      artifact_ready: Boolean(artifact),
      artifact_id: artifact?.id || null,
      artifact_name: artifact?.name || null,
    },
    200,
    { "Cache-Control": "no-store" },
  );
}

async function downloadArtifact(request, env, requestId) {
  const context = await readScanContext(request, env, requestId);
  const run = await resolveRun(env, requestId, context.runId, context.payload.dispatched_at);
  if (run) assertRunAttempt(run, context.attempt);
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    throw new HttpError(409, "扫描尚未完成，artifact 不可用", "artifact_pending");
  }
  const artifact = await findArtifact(env, run, requestId);
  if (!artifact || !positiveInteger(artifact.id)) {
    throw new HttpError(409, "扫描结果 artifact 尚未发布", "artifact_pending");
  }
  const archive = await githubRawArtifact(env, artifact.id);
  if (!archive.body) throw new GitHubError(502, "GitHub artifact 响应为空");
  return secureResponse(
    new Response(limitStream(archive.body), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${ARTIFACT_PREFIX}-${requestId}.zip"`,
        "Cache-Control": "no-store",
      },
    }),
    { noStore: true },
  );
}

async function cancelScan(request, env, requestId) {
  assertSameOrigin(request);
  const context = await readScanContext(request, env, requestId);
  const run = await resolveRun(env, requestId, context.runId, context.payload.dispatched_at);
  if (run) assertRunAttempt(run, context.attempt);
  if (!run) throw new HttpError(409, "GitHub Actions 运行尚未建立", "run_pending");
  await githubJson(env, `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/runs/${run.id}/cancel`, { method: "POST" });
  return json({ request_id: requestId, run_id: run.id, status: "cancelled" }, 202, { "Cache-Control": "no-store" });
}

async function api(request, env, auth) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") {
    assertWorkerConfigured(env);
    return json({ status: "ok", mode: "github-actions-gateway", authenticated_email: auth.email }, 200, { "Cache-Control": "no-store" });
  }
  if (url.pathname === "/api/scans" && request.method === "POST") return createScan(request, env);
  const match = url.pathname.match(/^\/api\/scans\/([^/]+)(\/artifact)?$/u);
  if (!match) throw new HttpError(404, "API 路径不存在", "not_found");
  let requestId;
  try {
    requestId = decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(400, "request_id 无效", "invalid_request");
  }
  if (match[2] === "/artifact" && request.method === "GET") return downloadArtifact(request, env, requestId);
  if (!match[2] && request.method === "GET") return scanState(request, env, requestId);
  if (!match[2] && request.method === "DELETE") return cancelScan(request, env, requestId);
  throw new HttpError(405, "请求方法不支持", "method_not_allowed");
}

async function fetchHandler(request, env, ctx) {
  const auth = await authenticate(request, env, ctx);
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    assertSameOrigin(request);
    return secureResponse(await api(request, env, auth), { noStore: true });
  }
  if (url.pathname === "/site-config.js") {
    if (!KEY_ID_PATTERN.test(String(env.SCAN_KEY_ID || "").trim())) {
      throw new HttpError(503, "扫描公钥指纹尚未配置", "worker_not_configured");
    }
    return secureResponse(
      new Response(
        `window.BEST_IP_CONFIG = Object.freeze(${JSON.stringify({
          mode: "gateway",
          publicKeyPath: "./scan-public.pem",
          keyId: String(env.SCAN_KEY_ID).trim().toLowerCase(),
        })});`,
        { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" } },
      ),
      { noStore: true },
    );
  }
  if (!env.ASSETS?.fetch) throw new HttpError(503, "Worker 静态资源尚未绑定", "worker_not_configured");
  return secureResponse(await env.ASSETS.fetch(request));
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await fetchHandler(request, env, ctx);
    } catch (error) {
      return secureResponse(fail(error), { noStore: true });
    }
  },
};

export const internals = {
  assertSameOrigin,
  assertRunAttempt,
  assertWorkerConfigured,
  authenticate,
  exactRun,
  findArtifact,
  limitStream,
  listRunJobs,
  signScanToken,
  verifyScanToken,
  validateEnvelope,
};

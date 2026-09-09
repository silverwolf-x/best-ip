import { base64UrlEncode, text } from "./auth.js";
import { HttpError, GitHubError } from "./responses.js";
import { GITHUB_API, GITHUB_OWNER, GITHUB_REPOSITORY, APP_ID_PATTERN, INSTALLATION_ID_PATTERN, MAX_ARTIFACT_BYTES, isRecord } from "./config.js";

let installationTokenCache = null;

export async function appJwt(env) {
  const appId = String(env.GITHUB_APP_ID || "").trim();
  const privateKey = normalizePrivateKey(String(env.GITHUB_APP_PRIVATE_KEY || "").replaceAll("\\n", "\n"));
  if (!APP_ID_PATTERN.test(appId) || !privateKey) {
    throw new HttpError(503, "GitHub App 尚未配置", "worker_not_configured");
  }
  let key;
  try {
    key = await crypto.subtle.importKey("pkcs8", pemBytes(privateKey, "PRIVATE KEY"),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new HttpError(503, "GitHub App 私钥无效", "worker_not_configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(text(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64UrlEncode(text(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })));
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, text(unsigned));
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export function derLength(length) {
  if (length < 128) return Uint8Array.of(length);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

export function derField(tag, value) {
  const length = derLength(value.length);
  const result = new Uint8Array(1 + length.length + value.length);
  result[0] = tag;
  result.set(length, 1);
  result.set(value, 1 + length.length);
  return result;
}

export function joinBytes(...parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function pemBytes(pem, label) {
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

export function normalizePrivateKey(pem) {
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

export async function installationToken(env, forceRefresh = false) {
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

export function githubUrl(path, query = {}) {
  const url = new URL(`${GITHUB_API}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

export async function githubJson(env, path, options = {}, retry = true) {
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

export async function githubRawArtifact(env, artifactId, retry = true) {
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
  if (response.status === 401 && retry) {
    installationTokenCache = null;
    return githubRawArtifact(env, artifactId, false);
  }
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

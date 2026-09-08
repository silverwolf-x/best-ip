import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "./responses.js";
import { SCAN_TOKEN_TTL_SECONDS, REQUEST_ID_PATTERN, isRecord } from "./config.js";

const accessJwksCache = new Map();
const hmacKeyCache = new Map();

export function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value) {
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

export function text(value) {
  return new TextEncoder().encode(String(value));
}

export async function hmacKey(secret) {
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

export async function signScanToken(env, requestId, dispatchedAt) {
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

export async function verifyScanToken(env, token, requestId) {
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

export function normalizeTeamDomain(value) {
  const domain = String(value || "").trim().replace(/\/+$/u, "");
  if (!/^https:\/\/[^/]+$/u.test(domain)) return "";
  return domain;
}

export async function authenticate(request, env, ctx) {
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

export function assertSameOrigin(request) {
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

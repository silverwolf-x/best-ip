import { HttpError, json, secureResponse } from "./responses.js";
import { KEY_ID_PATTERN, assertWorkerConfigured } from "./config.js";
import { authenticate, assertSameOrigin } from "./auth.js";
import { createScan, scanState, cancelScan, resolveScanRun } from "./scans.js";
import { downloadArtifact } from "./artifacts.js";
import { loginRoute, loginRedirect } from "./login.js";

export async function api(request, env, auth) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") {
    assertWorkerConfigured(env);
    return json({ status: "ok", mode: "github-actions-gateway", authentication: auth.method }, 200, { "Cache-Control": "no-store" });
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
  if (match[2] === "/artifact" && request.method === "GET") {
    const run = await resolveScanRun(request, env, requestId);
    return downloadArtifact(env, run, requestId);
  }
  if (!match[2] && request.method === "GET") return scanState(request, env, requestId);
  if (!match[2] && request.method === "DELETE") return cancelScan(request, env, requestId);
  throw new HttpError(405, "请求方法不支持", "method_not_allowed");
}

export async function fetchHandler(request, env, ctx) {
  const url = new URL(request.url);
  const login = await loginRoute(request, env);
  if (login) return secureResponse(login, { noStore: true });
  let auth;
  try {
    auth = await authenticate(request, env, ctx);
  } catch (error) {
    if (error.status === 401 && request.method === "GET" &&
        !url.pathname.startsWith("/api/") && request.headers.get("Accept")?.includes("text/html")) {
      return secureResponse(loginRedirect(), { noStore: true });
    }
    throw error;
  }
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
  return secureResponse(await env.ASSETS.fetch(request), { noStore: true });
}

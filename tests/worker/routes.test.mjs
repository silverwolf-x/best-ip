import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import worker from "../../worker/index.js";
import { signScanToken, verifyScanToken } from "../../worker/auth.js";

const origin = "https://best-ip.example.workers.dev";
const requestId = "route-request";
const keyId = "a".repeat(64);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  SCAN_KEY_ID: keyId, SCAN_TOKEN_SECRET: "route-test-secret",
  GITHUB_APP_ID: "12345", GITHUB_APP_INSTALLATION_ID: "67890",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
  ACCESS_ALLOWED_EMAIL: "me@example.com", ACCESS_POLICY_AUD: "route-audience",
  ACCESS_TEAM_DOMAIN: "https://access.example",
};
const context = { access: { aud: env.ACCESS_POLICY_AUD, getIdentity: async () => ({ email: env.ACCESS_ALLOWED_EMAIL }) } };
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

function request(path, { method = "GET", token, body, headers = {} } = {}) {
  return new Request(origin + path, {
    method,
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", ...(token ? { "X-Best-IP-Scan-Token": token } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("fetch routes preserve dispatch, identity, cancellation and artifact delivery", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const dispatchedAt = Date.now();
  const token = await signScanToken(env, requestId, dispatchedAt);
  const path = "/api/scans/" + requestId;
  let run = { id: 81, run_attempt: 2, path: ".github/workflows/scan.yml", display_title: "Best IP scan " + requestId, event: "workflow_dispatch", head_branch: "main", created_at: new Date(dispatchedAt).toISOString(), status: "completed", conclusion: "success" };
  const artifacts = [{ id: 93, name: "best-ip-result-" + requestId + "-81-2", expired: false }];
  let rejectApi = 0;
  let rejectArchive = 0;
  let oversized = false;
  let jobsUnavailable = false;
  let redirectArchive = false;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url);
    calls.push({ url: target, ...options });
    if (target.pathname === "/app/installations/67890/access_tokens") {
      assert.deepEqual(JSON.parse(options.body), { repositories: ["best-ip"] });
      return json({ token: "route-installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (target.hostname === "archive.example") {
      assert.equal(options.headers, undefined);
      return new Response(Uint8Array.of(80, 75, 3, 4));
    }
    assert.equal(target.hostname, "api.github.com");
    assert.equal(options.headers.Authorization, "Bearer route-installation-token");
    if (rejectApi-- > 0) return json({}, 401);
    if (target.pathname.endsWith("/dispatches")) return new Response(null, { status: 204 });
    if (target.pathname.endsWith("/cancel")) return new Response(null, { status: 202 });
    if (target.pathname.endsWith("/artifacts/93/zip")) {
      if (rejectArchive-- > 0) return json({}, 401);
      if (redirectArchive) return new Response(null, { status: 302, headers: { Location: "https://archive.example/result.zip" } });
      return new Response(Uint8Array.of(80, 75, 3, 4), { headers: oversized ? { "Content-Length": String(50 * 1024 * 1024 + 1) } : {} });
    }
    if (target.pathname.endsWith("/artifacts")) return json({ artifacts });
    if (target.pathname.endsWith("/attempts/2/jobs")) return json({ jobs: [{ id: 90, run_attempt: 2 }], total_count: 1 }, jobsUnavailable ? 503 : 200);
    if (target.pathname.endsWith("/actions/runs/81")) return json(run);
    if (target.pathname.endsWith("/workflows/scan.yml/runs")) return json({ workflow_runs: run ? [run] : [] });
    throw new Error("Unexpected GitHub route: " + target);
  };
  try {
    const now = Math.floor(Date.now() / 1000);
    const envelope = { v: 1, kid: keyId, alg: "RSA-OAEP-3072-SHA256+AES-256-GCM", request_id: requestId, issued_at: now, expires_at: now + 900, ek: "ek", iv: "iv", aad: "aad", ct: "ct" };
    const response = await worker.fetch(request("/api/scans", { method: "POST", body: { request_id: requestId, key_id: keyId, envelope } }), env, context);
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.equal(result.run_id, null);
    assert.equal((await verifyScanToken(env, result.scan_token, requestId)).dispatched_at, result.dispatched_at);
    const dispatch = calls.find((call) => call.url.pathname.endsWith("/dispatches"));
    assert.equal(dispatch.url.pathname, "/repos/silverwolf-x/best-ip/actions/workflows/scan.yml/dispatches");
    assert.deepEqual(JSON.parse(dispatch.body), { ref: "main", inputs: { request_id: requestId, key_id: keyId, encrypted_subscription_url: JSON.stringify(envelope) } });
    const before = calls.filter((call) => call.url.pathname.endsWith("/access_tokens")).length;
    rejectApi = 1;
    const stateResponse = await worker.fetch(request(path + "?run_id=81&run_attempt=2", { token }), env, context);
    const state = await stateResponse.json();
    assert.equal(stateResponse.status, 200);
    assert.equal(state.status, "completed");
    assert.equal(state.artifact_id, 93);
    assert.equal(state.jobs_total_count, 1);
    assert.equal(calls.filter((call) => call.url.pathname.endsWith("/access_tokens")).length, before + 1);
    assert.equal((await worker.fetch(request(path + "?run_id=81&run_attempt=1", { token }), env, context)).status, 409);
    run = { ...run, head_branch: "other" };
    assert.equal((await worker.fetch(request(path + "?run_id=81", { token }), env, context)).status, 409);
    run = { ...run, head_branch: "main" };
    jobsUnavailable = true;
    const degraded = await (await worker.fetch(request(path + "?run_id=81", { token }), env, context)).json();
    assert.equal(degraded.jobs_available, false);
    assert.equal(degraded.artifact_ready, true);
    jobsUnavailable = false;

    const cancellation = await worker.fetch(request(path + "?run_id=81", { token, method: "DELETE" }), env, context);
    assert.equal(cancellation.status, 202);
    assert.deepEqual(await cancellation.json(), { request_id: requestId, run_id: 81, status: "cancelled" });
    assert.equal(calls.at(-1).url.pathname, "/repos/silverwolf-x/best-ip/actions/runs/81/cancel");
    assert.equal(calls.at(-1).method, "POST");
    assert.equal((await worker.fetch(request(path, { token, method: "DELETE", headers: { Origin: "https://evil.example" } }), env, context)).status, 403);

    const artifactPath = path + "/artifact?run_id=81&run_attempt=2";
    const archive = await worker.fetch(request(artifactPath, { token }), env, context);
    assert.equal(archive.headers.get("Content-Type"), "application/zip");
    assert.equal(archive.headers.get("Cache-Control"), "no-store");
    assert.deepEqual([...new Uint8Array(await archive.arrayBuffer())], [80, 75, 3, 4]);
    artifacts.push({ ...artifacts[0], id: 94 });
    assert.equal((await worker.fetch(request(artifactPath, { token }), env, context)).status, 409);
    artifacts.pop();
    oversized = true;
    assert.equal((await worker.fetch(request(artifactPath, { token }), env, context)).status, 413);
    oversized = false;
    rejectArchive = 2;
    assert.equal((await worker.fetch(request(artifactPath, { token }), env, context)).status, 502);
    rejectArchive = 1;
    redirectArchive = true;
    assert.equal((await worker.fetch(request(artifactPath, { token }), env, context)).status, 200);
    redirectArchive = false;
    assert.equal((await worker.fetch(request(path + "/artifact?run_id=81&run_attempt=1", { token }), env, context)).status, 409);

    run = null;
    const unresolved = await (await worker.fetch(request(path, { token }), env, context)).json();
    assert.equal(unresolved.status, "dispatching");
    assert.equal(unresolved.jobs_total_count, null);
    assert.equal((await worker.fetch(request(path, { token, method: "DELETE" }), env, context)).status, 409);
    assert.equal((await worker.fetch(request(path + "/artifact", { token }), env, context)).status, 409);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("all static, module, config and API entrypoints remain behind Access", async () => {
  let assetCalls = 0;
  const assetEnv = { ...env, ASSETS: { fetch: async (incoming) => {
    assetCalls += 1;
    return new Response(new URL(incoming.url).pathname, { headers: { "Content-Type": incoming.url.endsWith(".js") ? "application/javascript" : "text/html" } });
  } } };
  for (const path of ["/", "/src/main.js", "/scan-public.pem", "/site-config.js", "/api/health"]) {
    const denied = await worker.fetch(request(path), assetEnv, {});
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("Cache-Control"), "no-store");
    const wrongAccount = { access: { aud: env.ACCESS_POLICY_AUD, getIdentity: async () => ({ email: "other@example.com" }) } };
    assert.equal((await worker.fetch(request(path), assetEnv, wrongAccount)).status, 403);
  }
  assert.equal(assetCalls, 0);
  const config = await worker.fetch(request("/site-config.js"), assetEnv, context);
  assert.match(await config.text(), /"mode":"gateway"/u);
  assert.equal(config.headers.get("Cache-Control"), "no-store");
  assert.equal(assetCalls, 0);
  const asset = await worker.fetch(request("/src/main.js"), assetEnv, context);
  assert.equal(await asset.text(), "/src/main.js");
  assert.equal(asset.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(assetCalls, 1);
  const html = await worker.fetch(request("/"), assetEnv, context);
  assert.match(html.headers.get("Content-Security-Policy"), /script-src 'self'/u);
  assert.equal((await worker.fetch(request("/api/health"), assetEnv, context)).status, 200);
  assert.equal((await worker.fetch(request("/api/health"), { ...assetEnv, SCAN_TOKEN_SECRET: "" }, context)).status, 503);
  assert.equal((await worker.fetch(request("/site-config.js"), { ...assetEnv, SCAN_KEY_ID: "" }, context)).status, 503);
  assert.equal((await worker.fetch(request("/api/scans/route-request"), assetEnv, context)).status, 401);
  assert.equal((await worker.fetch(request("/api/scans/route-request", { token: "forged.token" }), assetEnv, context)).status, 401);
  assert.equal((await worker.fetch(request("/"), { ...assetEnv, DEV_ALLOW_UNAUTHENTICATED: "1" }, {})).status, 401);
});

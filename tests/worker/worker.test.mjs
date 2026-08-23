import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHmac } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import { internals } from "../../worker/index.js";

const keyId = "a".repeat(64);
const baseEnv = { SCAN_KEY_ID: keyId, SCAN_TOKEN_SECRET: "test-only-random-scan-token-secret" };

function envelope(requestId, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    kid: keyId,
    alg: "RSA-OAEP-3072-SHA256+AES-256-GCM",
    request_id: requestId,
    issued_at: now,
    expires_at: now + 900,
    ek: "aGVsbG8",
    iv: "aXY",
    aad: "YWFk",
    ct: "Y3Q",
    ...overrides,
  };
}

test("validateEnvelope accepts the browser envelope and rejects boundary violations", () => {
  const requestId = "req-worker-1";
  const valid = internals.validateEnvelope({ request_id: requestId, key_id: keyId, envelope: envelope(requestId) }, baseEnv);
  assert.equal(valid.requestId, requestId);
  assert.equal(valid.keyId, keyId);
  assert.throws(() => internals.validateEnvelope({ request_id: requestId, key_id: "b".repeat(64), envelope: envelope(requestId) }, baseEnv), /指纹/);
  assert.throws(() => internals.validateEnvelope({ request_id: requestId, key_id: keyId, envelope: envelope(requestId, { expires_at: Math.floor(Date.now() / 1000) }) }, baseEnv), /过期/);
  assert.throws(() => internals.validateEnvelope({ request_id: requestId, key_id: keyId, envelope: envelope(requestId, { ct: "" }) }, baseEnv), /字段/);
});

test("state-changing requests require same-origin metadata", () => {
  const sameOrigin = new Request("https://best-ip.example.workers.dev/api/scans", { method: "POST", headers: { Origin: "https://best-ip.example.workers.dev", "Sec-Fetch-Site": "same-origin" } });
  assert.doesNotThrow(() => internals.assertSameOrigin(sameOrigin));
  const crossOrigin = new Request("https://best-ip.example.workers.dev/api/scans", { method: "POST", headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
  assert.throws(() => internals.assertSameOrigin(crossOrigin), (error) => error.status === 403 && error.code === "csrf_rejected");
});

test("health configuration is fail-closed", () => {
  assert.throws(() => internals.assertWorkerConfigured({}), (error) => error.status === 503 && error.code === "worker_not_configured");
  assert.doesNotThrow(() => internals.assertWorkerConfigured({ SCAN_KEY_ID: keyId, SCAN_TOKEN_SECRET: "secret", GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY: "pem" }));
});

test("scan token is bound to request identity and cannot be forged or expired", async () => {
  const requestId = "req-token-1";
  const token = await internals.signScanToken(baseEnv, requestId, Date.now());
  const payload = await internals.verifyScanToken(baseEnv, token, requestId);
  assert.equal(payload.request_id, requestId);
  await assert.rejects(internals.verifyScanToken(baseEnv, `${token}x`, requestId), /无效/);
  await assert.rejects(internals.verifyScanToken(baseEnv, token, "req-other"), /无效/);

  const [encoded] = token.split(".");
  const expiredPayload = Buffer.from(JSON.stringify({ v: 1, request_id: requestId, dispatched_at: Date.now(), expires_at: Math.floor(Date.now() / 1000) - 1 })).toString("base64url");
  const signature = createHmac("sha256", baseEnv.SCAN_TOKEN_SECRET).update(expiredPayload).digest("base64url");
  await assert.rejects(internals.verifyScanToken(baseEnv, `${expiredPayload}.${signature}`, requestId), /过期|无效/);
  assert.notEqual(encoded, expiredPayload);
});

test("Access authentication fails closed and enforces the configured email", async () => {
  const request = new Request("https://best-ip.example.workers.dev/");
  await assert.rejects(internals.authenticate(request, {}), (error) => error.status === 503);
  const nativeEnv = { ACCESS_ALLOWED_EMAIL: "me@example.com" };
  const nativeContext = {
    access: {
      aud: "native-aud",
      getIdentity: async () => ({ email: "me@example.com" }),
    },
  };
  const nativeAccepted = await internals.authenticate(request, nativeEnv, nativeContext);
  assert.equal(nativeAccepted.email, "me@example.com");
  const env = { ACCESS_TEAM_DOMAIN: "https://access.example", ACCESS_POLICY_AUD: "aud-1", ACCESS_ALLOWED_EMAIL: "me@example.com" };
  await assert.rejects(internals.authenticate(request, env), (error) => error.status === 401);

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "access-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
    throw new Error(`unexpected Access fetch ${url}`);
  };
  try {
    const forged = await new SignJWT({ email: "other@example.com" }).setProtectedHeader({ alg: "RS256", kid: "access-key" }).setIssuer(env.ACCESS_TEAM_DOMAIN).setAudience(env.ACCESS_POLICY_AUD).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const denied = new Request(request, { headers: { "cf-access-jwt-assertion": forged } });
    await assert.rejects(internals.authenticate(denied, env), (error) => error.status === 403);
    const configuredNativeContext = {
      access: {
        aud: env.ACCESS_POLICY_AUD,
        getIdentity: async () => ({ email: "me@example.com" }),
      },
    };
    const configuredNativeAccepted = await internals.authenticate(request, env, configuredNativeContext);
    assert.equal(configuredNativeAccepted.email, "me@example.com");
    await assert.rejects(
      internals.authenticate(request, env, {
        access: { aud: "other-audience", getIdentity: configuredNativeContext.access.getIdentity },
      }),
      (error) => error.status === 401,
    );
    const wrongAlgorithm = await new SignJWT({ email: "me@example.com" }).setProtectedHeader({ alg: "RS384", kid: "access-key" }).setIssuer(env.ACCESS_TEAM_DOMAIN).setAudience(env.ACCESS_POLICY_AUD).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    await assert.rejects(
      internals.authenticate(new Request(request, { headers: { "cf-access-jwt-assertion": wrongAlgorithm } }), env),
      (error) => error.status === 401,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exactRun binds request title, dispatch event, branch and time window", () => {
  const requestId = "req-run-1";
  const dispatchedAt = Date.now() - 1000;
  const run = { id: 10, path: ".github/workflows/scan.yml", display_title: `Best IP scan ${requestId}`, name: "Scan subscription", event: "workflow_dispatch", head_branch: "main", created_at: new Date(dispatchedAt + 100).toISOString() };
  assert.equal(internals.exactRun(run, requestId, dispatchedAt), true);
  assert.equal(internals.exactRun({ ...run, path: ".github/workflows/unrelated.yml" }, requestId, dispatchedAt), false);
  assert.equal(internals.exactRun({ ...run, display_title: "other" }, requestId, dispatchedAt), false);
  assert.equal(internals.exactRun({ ...run, path: undefined }, requestId, dispatchedAt), false);
});

test("GitHub App installation token is used for paginated, attempt-filtered jobs", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    ...baseEnv,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_INSTALLATION_ID: "67890",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }),
  };
  const originalFetch = globalThis.fetch;
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, run_attempt: 2, status: "completed", steps: [] }));
  const secondPage = [{ id: 101, run_attempt: 2, status: "in_progress", steps: [{ number: 1, name: "scan", status: "in_progress" }] }];
  const urls = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url); urls.push(value);
    if (value.endsWith("/app/installations/67890/access_tokens")) return new Response(JSON.stringify({ token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
    if (value.includes("/attempts/2/jobs") && value.endsWith("page=1")) return new Response(JSON.stringify({ total_count: 101, jobs: firstPage }), { status: 200 });
    if (value.includes("/attempts/2/jobs") && value.endsWith("page=2")) return new Response(JSON.stringify({ total_count: 101, jobs: secondPage }), { status: 200 });
    throw new Error(`unexpected GitHub fetch ${value}`);
  };
  try {
    const result = await internals.listRunJobs(env, { id: 55, run_attempt: 2 });
    assert.equal(result.jobs.length, 101);
    assert.equal(result.jobs.every((job) => job.run_attempt === 2), true);
    assert.equal(urls.filter((url) => url.includes("/jobs?")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("artifact matching rejects ambiguous names and accepts one exact artifact", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = { ...baseEnv, GITHUB_APP_ID: "12345", GITHUB_APP_INSTALLATION_ID: "67890", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const originalFetch = globalThis.fetch;
  let duplicate = false;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/app/installations/67890/access_tokens")) return new Response(JSON.stringify({ token: "artifact-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
    const artifacts = [{ id: 1, name: "best-ip-result-req-art-8-1", expired: false }];
    if (duplicate) artifacts.push({ id: 2, name: "best-ip-result-req-art-8-1", expired: false });
    return new Response(JSON.stringify({ artifacts }), { status: 200 });
  };
  try {
    const artifact = await internals.findArtifact(env, { id: 8, run_attempt: 1 }, "req-art");
    assert.equal(artifact.id, 1);
    duplicate = true;
    await assert.rejects(internals.findArtifact(env, { id: 8, run_attempt: 1 }, "req-art"), /唯一/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

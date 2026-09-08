import test from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes, webcrypto } from "node:crypto";

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readArtifact, validateExport } from "../frontend/src/artifact/reader.js";
import { createTransport } from "../frontend/src/transport/index.js";
import { zip, artifactFiles, artifactBuffer, toBuffer, resultFixture } from "./frontend-fixtures.mjs";

test("ZIP reader validates stored and deflated sanitized artifacts", async () => {
  for (const method of [0, 8]) {
    const payload = await readArtifact(artifactBuffer({ method }), { requestId: "req-test-1", runId: 42, runAttempt: 1 });
    assert.equal(payload.result.results[0].status, "failed");
  }
});

test("ZIP reader rejects digest mismatches, CRC, duplicate paths, traversal and wrong identity", async () => {
  const identity = { requestId: "req-test-1", runId: 42, runAttempt: 1 };
  await assert.rejects(readArtifact(artifactBuffer({ tamperDigest: true }), identity), /摘要/);
  await assert.rejects(readArtifact(artifactBuffer(), { ...identity, runAttempt: 2 }), /身份/);
  const files = artifactFiles();
  const entries = [{ name: "status.json", content: files.statusBytes }, { name: "result.json", content: files.resultBytes }];
  await assert.rejects(readArtifact(toBuffer(zip([...entries, entries[0]])), identity), /不允许/);
  await assert.rejects(readArtifact(toBuffer(zip([entries[0], { ...entries[1], name: "../result.json" }])), identity), /不允许/);
  const bytes = zip(entries);
  bytes[42] ^= 1;
  await assert.rejects(readArtifact(toBuffer(bytes), identity), /CRC/);
});

test("local JSON and ZIP reject forged failed IP, proxy evidence, retries and completion", async () => {
  for (const mutate of [
    result => { result.results[0].exit_ip = "203.0.113.1"; },
    result => { result.results[0].error = ""; },
    result => { result.cleanup_confirmed = false; },
    result => { result.manifest.complete = false; },
  ]) {
    const result = resultFixture();
    mutate(result);
    assert.throws(() => validateExport(result));
    await assert.rejects(readArtifact(artifactBuffer({ result }), { requestId: "req-test-1", runId: 42, runAttempt: 1 }));
  }
  for (const mutate of [
    record => { record.proxy_evidence = {}; },
    record => { record.proxy_evidence.trust_env = true; },
    record => { record.proxy_evidence.direct_fallback = true; },
    record => { record.completeness.checks.lookup_matches_trace = false; },
    record => { record.exit_ip = "999.1.2.3"; },
    record => { record.attempt_count = 2; record.retry_count = 0; },
  ]) {
    const result = resultFixture("req-test-1", "success");
    mutate(result.results[0]);
    assert.throws(() => validateExport(result));
  }
});

test("local health/start/poll/cancel preserve loopback protocol and hide session identity", async () => {
  const requests = [];
  let completed = false;
  const transport = createTransport({ mode: "local", apiBase: "http://127.0.0.1:8000" }, { fetchImpl: async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (url.endsWith("/health")) return Response.json({ status: "ok", mihomo_ready: true });
    if (options.method === "POST") return Response.json({ id: "req-local", status: "queued" }, { status: 202 });
    if (options.method === "DELETE") return Response.json({ status: "cancelled", cleanup_confirmed: true });
    if (url.endsWith("/export")) return Response.json(resultFixture("req-local", "partial"));
    return Response.json(completed ? { status: "completed", manifest_ready: true } : { status: "running", message: "正在检测节点", total: 2, completed: 1, success_count: 1, partial_count: 0, failed_count: 0 });
  } });
  assert.equal((await transport.health()).ready, true);
  const url = "https://subscription.example/config?token=local-secret";
  const session = await transport.start(url);
  assert.deepEqual(session, {});
  assert.equal(Object.isFrozen(session), true);
  const running = await transport.poll(session);
  assert.equal(running.execution, "running");
  assert.equal(running.progress.currentStep, "正在检测节点");
  assert.equal(running.nodes.completed, 1);
  completed = true;
  const terminal = await transport.poll(session);
  assert.equal(terminal.result.availability, "verified");
  assert.equal(terminal.result.hasExitNodes, true);
  assert.equal(terminal.result.fullyScored, false);
  assert.equal((await transport.cancel(session)).confirmed, true);
  const request = requests.find(item => item.options.method === "POST");
  assert.equal(JSON.parse(request.options.body).subscription_url, url);
  for (const request of requests) {
    assert.match(request.url, /^http:\/\/127\.0\.0\.1:8000\/api\//u);
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.headers["X-Best-IP-Scan-Token"], undefined);
  }
  await assert.rejects(transport.poll({}), /会话/);
});

test("local rejects non-loopback base and completed invalid export", async () => {
  assert.throws(() => createTransport({ mode: "local", apiBase: "https://collector.example" }), /127\.0\.0\.1/);
  const transport = createTransport({ mode: "local", apiBase: "http://127.0.0.1:8000" }, { fetchImpl: async (_url, options = {}) => Response.json(options.method === "POST" ? { id: "local-invalid" } : { status: "completed", manifest_ready: false }) });
  const session = await transport.start("https://subscription.example/config");
  const result = await transport.poll(session);
  assert.equal(result.execution, "completed");
  assert.equal(result.result.availability, "invalid");
  assert.equal(result.result.export, null);
});

test("local snapshots read structured task errors without inferring phases from messages", async () => {
  const details = { code: "cleanup_failed", phase: "cleanup", retryable: false, message: "清理未确认" };
  const transport = createTransport({ mode: "local", apiBase: "http://127.0.0.1:8000" }, { fetchImpl: async (_url, options = {}) => Response.json(options.method === "POST" ? { id: "local-error" } : { status: "cancelling", error: "兼容文案", error_details: details }) });
  const value = await transport.poll(await transport.start("https://subscription.example/config"));
  assert.equal(value.phase, "cleanup");
  assert.deepEqual(value.error, details);
  assert.equal(value.done, false);
  assert.equal(value.cleanupConfirmed, false);
});

const gatewayKeys = generateKeyPairSync("rsa", { modulusLength: 3072 });

test("transient local export download failure remains retryable, not an invalid result", async () => {
  let unavailable = true;
  const transport = createTransport({ mode: "local", apiBase: "http://127.0.0.1:8000" }, { fetchImpl: async (url, options = {}) => {
    if (options.method === "POST") return Response.json({ id: "req-export" });
    if (url.endsWith("/export")) {
      if (unavailable) throw new TypeError("network unavailable");
      return Response.json(resultFixture("req-export", "success"));
    }
    return Response.json({ status: "completed", manifest_ready: true });
  } });
  const session = await transport.start("https://subscription.example/config");
  await assert.rejects(transport.poll(session), /network unavailable/);
  unavailable = false;
  assert.equal((await transport.poll(session)).result.availability, "verified");
});
const publicDer = gatewayKeys.publicKey.export({ type: "spki", format: "der" });
const keyId = createHash("sha256").update(publicDer).digest("hex");
function gatewayFixture({ completed = false, outcome = "success", artifactReady = true, status = "partial", jobsAvailable = true, tamperDigest = false } = {}) {
  const requests = [];
  let id;
  const transport = createTransport({ keyId, publicKeyPath: "./scan-public.pem" }, { baseURI: "https://best-ip.example/", fetchImpl: async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("scan-public.pem")) return new Response(gatewayKeys.publicKey.export({ type: "spki", format: "pem" }));
    if (String(url).endsWith("/health")) return Response.json({ status: "ok" });
    if (options.method === "POST") { id = JSON.parse(options.body).request_id; return Response.json({ request_id: id, scan_token: "signed-token", run_id: null, dispatched_at: Date.now() }, { status: 202 }); }
    if (options.method === "DELETE") return Response.json({ status: "cancelled" }, { status: 202 });
    if (String(url).includes("/artifact?")) return new Response(artifactBuffer({ requestId: id, status, tamperDigest }));
    return Response.json({ status: completed ? "completed" : "running", run: { id: 42, run_attempt: 1, status: completed ? "completed" : "in_progress", conclusion: completed ? outcome : null }, jobs_available: jobsAvailable, jobs_total_count: jobsAvailable ? 1 : null, jobs: [{ id: 9, name: "scan", status: "in_progress", steps: [{ number: 1, name: "Verify", status: "in_progress" }] }], artifact_ready: artifactReady });
  } });
  return { transport, requests };
}

test("gateway encrypts submission, owns token/run internally and returns normalized progress", async () => {
  const { transport, requests } = gatewayFixture();
  assert.equal((await transport.health()).ready, true);
  const url = "https://subscription.example/config?token=secret-value";
  const session = await transport.start(url);
  assert.deepEqual(session, {});
  const progress = await transport.poll(session);
  assert.equal(progress.execution, "running");
  assert.equal(progress.progress.currentStep, "Verify");
  assert.equal(progress.nodes.total, null);
  assert.doesNotMatch(JSON.stringify(progress), /signed-token|run_id|request_id|run_attempt|dispatched_at/);
  const submit = requests.find(item => item.options.method === "POST");
  const body = JSON.parse(submit.options.body);
  assert.equal(body.key_id, keyId);
  assert.equal(body.envelope.request_id, body.request_id);
  assert.equal(submit.options.body.includes(url), false);
  assert.equal(submit.options.headers.Authorization, undefined);
  assert.equal(submit.options.headers["X-Best-IP-Scan-Token"], undefined);
  const cancellation = await transport.cancel(session);
  assert.deepEqual(cancellation, { requested: true, confirmed: false });
  assert.match(requests.at(-1).url, /\?run_id=42$/);
  assert.equal(requests.at(-1).options.headers["X-Best-IP-Scan-Token"], "signed-token");
  assert.equal(requests.at(-1).options.credentials, "same-origin");
  await transport.poll(session);
  assert.match(requests.at(-1).url, /run_id=42&run_attempt=1/);
});

test("gateway distinguishes execution completion, full scores, partial, all failed and invalid artifact", async () => {
  for (const [options, availability, fullyScored, done] of [
    [{ completed: true, artifactReady: false }, "unavailable", null, false],
    [{ completed: true, status: "success" }, "verified", true, true],
    [{ completed: true, status: "partial" }, "verified", false, true],
    [{ completed: true, status: "failed" }, "all_failed", false, true],
    [{ completed: true, tamperDigest: true }, "invalid", null, true],
  ]) {
    const { transport } = gatewayFixture(options);
    const value = await transport.poll(await transport.start("https://subscription.example/config"));
    assert.equal(value.execution, "completed");
    assert.equal(value.result.availability, availability);
    assert.equal(value.result.fullyScored, fullyScored);
    assert.equal(value.done, done);
  }
});

test("gateway unknown job totals stay unknown and failed execution has no invented records", async () => {
  const missing = gatewayFixture({ jobsAvailable: false });
  const progress = await missing.transport.poll(await missing.transport.start("https://subscription.example/config"));
  assert.equal(progress.progress.jobs.total, null);
  const failed = gatewayFixture({ completed: true, outcome: "failure" });
  const value = await failed.transport.poll(await failed.transport.start("https://subscription.example/config"));
  assert.equal(value.execution, "failed");
  assert.equal(value.result.availability, "unavailable");
  assert.equal(value.nodes.total, null);
});

test("decrypt script enforces canonical AAD and never prints plaintext on failure", () => {
  const directory = mkdtempSync(join(process.env.TEMP || ".", "best-ip-decrypt-test-"));
  try {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const requestId = "req-decrypt-1"; const keyId = "b".repeat(64); const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const aesKey = randomBytes(32); const iv = randomBytes(12); const aad = Buffer.from(`${requestId}:${keyId}:${expiresAt}`);
    const cipher = createCipheriv("aes-256-gcm", aesKey, iv); cipher.setAAD(aad);
    const plaintext = "https://subscription.example/config?token=secret-value";
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    const base64Url = (value) => value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    const envelope = { v: 1, kid: keyId, alg: "RSA-OAEP-3072-SHA256+AES-256-GCM", request_id: requestId, issued_at: expiresAt - 300, expires_at: expiresAt, ek: base64Url(publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey)), iv: base64Url(iv), aad: base64Url(aad), ct: base64Url(ciphertext) };
    const privateKeyPath = join(directory, "private.pem"); const outputPath = join(directory, "url");
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    const run = (payload, output) => spawnSync(process.execPath, ["scripts/decrypt_subscription.mjs", "--private-key", privateKeyPath, "--output", output, "--request-id", requestId, "--key-id", keyId], { encoding: "utf8", env: { ...process.env, BEST_IP_ENVELOPE: JSON.stringify(payload) } });
    const success = run(envelope, outputPath); assert.equal(success.status, 0, success.stderr); assert.equal(readFileSync(outputPath, "utf8"), `${plaintext}\n`);
    const failure = run({ ...envelope, aad: base64Url(Buffer.from("wrong-aad")) }, join(directory, "bad-url"));
    assert.equal(failure.status, 1); assert.equal(failure.stderr, "订阅密文校验失败\n"); assert.equal(failure.stderr.includes(plaintext), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

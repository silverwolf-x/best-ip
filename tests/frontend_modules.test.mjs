import test from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes, webcrypto } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, content, method = 0 } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(content);
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(Buffer.concat([local, nameBytes, compressed]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes]));
    offset += locals.at(-1).length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function artifactFiles({ tamperDigest = false } = {}) {
  const requestId = "req-test-1";
  const record = { schema_version: 1, job_id: requestId, node_index: 0, node: "node-a", type: "ss", status: "failed", error: "connection failed", completeness: { complete: false }, proxy_evidence: {} };
  const summaryKeys = ["node_index", "node", "type", "selected_proxy", "status", "error", "transport_error", "attempt_count", "retry_count", "attempt_errors", "exit_ip", "cidr", "rdns", "ai_verdict", "location", "isp", "score", "is_residential", "is_datacenter", "is_native", "native_status", "native_detail", "is_bogon", "bogon_status", "bogon_reason", "rpki_status", "asn_kind", "asn_kind_display", "abuse_level", "honeypot_status", "traffic_profile", "company_type", "is_vpn", "is_proxy", "is_tor", "is_crawler", "is_abuser", "security_status", "threat_tags", "asn", "as_org", "global_ping", "port_scan", "ping_check", "gpt_check", "related_domains", "elapsed_ms", "started_at", "finished_at", "completeness", "proxy_evidence"];
  const summary = Object.fromEntries(summaryKeys.map((key) => [key, record[key] ?? null]));
  const manifest = { schema_version: 1, job_id: requestId, status: "completed", total: 1, completed: 1, all_records_present: true, complete: true, counts: { success: 0, partial: 0, failed: 1, complete: 0 }, records: [{ index: 0, file: "0000.json", summary }] };
  const result = { id: requestId, status: "completed", total: 1, completed: 1, success_count: 0, partial_count: 0, failed_count: 1, manifest_ready: true, cleanup_confirmed: true, results: [record], manifest };
  const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8");
  const status = { schema_version: 1, sanitized: true, request_id: requestId, run_id: 42, run_attempt: 1, status: "completed", usable: false, total: 1, completed: 1, counts: manifest.counts, result_sha256: tamperDigest ? "0".repeat(64) : createHash("sha256").update(resultBytes).digest("hex") };
  return { requestId, statusBytes: Buffer.from(JSON.stringify(status)), resultBytes };
}

function loadScript(filename, windowValues, globals = {}) {
  const window = { ...windowValues };
  const context = { window, console, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, Blob, Response, DecompressionStream, URL, URLSearchParams, crypto: webcrypto, atob, btoa, ...globals };
  runInNewContext(readFileSync(filename, "utf8"), context, { filename });
  return window;
}

test("ZIP reader validates stored and deflated sanitized artifacts", async () => {
  const files = artifactFiles();
  for (const method of [0, 8]) {
    const archive = zip([{ name: "status.json", content: files.statusBytes, method }, { name: "result.json", content: files.resultBytes, method }]);
    const window = loadScript("frontend/zip-reader.js", { crypto: webcrypto });
    const payload = await window.BestIpZip.readArtifact(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength), { requestId: files.requestId, runId: 42, runAttempt: 1 });
    assert.equal(payload.status.request_id, files.requestId);
    assert.equal(payload.result.results[0].status, "failed");
  }
});

test("ZIP reader rejects digest mismatches and path traversal", async () => {
  const files = artifactFiles({ tamperDigest: true });
  const archive = zip([{ name: "status.json", content: files.statusBytes }, { name: "result.json", content: files.resultBytes }]);
  const window = loadScript("frontend/zip-reader.js", { crypto: webcrypto });
  await assert.rejects(window.BestIpZip.readArtifact(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength), { requestId: files.requestId, runId: 42, runAttempt: 1 }), /摘要校验/);
  const traversal = zip([{ name: "status.json", content: files.statusBytes }, { name: "../result.json", content: files.resultBytes }]);
  await assert.rejects(window.BestIpZip.readArtifact(traversal.buffer.slice(traversal.byteOffset, traversal.byteOffset + traversal.byteLength), { requestId: files.requestId, runId: 42, runAttempt: 1 }), /不允许的文件/);
});

function gatewayWindow(fetch, extra = {}) {
  return loadScript("frontend/action-client.js", {
    crypto: webcrypto,
    BEST_IP_CONFIG: { publicKeyPath: "./scan-public.pem", keyId: extra.keyId || "a".repeat(64) },
    location: { hostname: "best-ip.example.workers.dev" },
    BestIpZip: extra.BestIpZip,
  }, { fetch, document: { baseURI: "https://best-ip.example.workers.dev/" } });
}

function localWindow(fetch) {
  return loadScript("frontend/action-client.js", {
    crypto: webcrypto,
    BEST_IP_CONFIG: { mode: "local", apiBase: "http://127.0.0.1:8000" },
    location: { hostname: "127.0.0.1" },
  }, { fetch, document: { baseURI: "http://127.0.0.1:5173/" } });
}

test("local dispatch sends the subscription only to the configured loopback API", async () => {
  const requests = [];
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return { ok: true, status: 202, json: async () => ({ id: "req-local", status: "queued" }) };
  };
  const window = localWindow(fakeFetch);
  const subscriptionUrl = "https://subscription.example/config?token=local-secret";

  const dispatched = await window.BestIpAction.dispatch(subscriptionUrl);

  assert.equal(window.BestIpAction.MODE, "local");
  assert.deepEqual(
    { requestId: dispatched.requestId, runId: dispatched.runId, scanToken: dispatched.scanToken },
    { requestId: "req-local", runId: null, scanToken: "" },
  );
  assert.equal(requests[0].url, "http://127.0.0.1:8000/api/scans");
  assert.equal(JSON.parse(requests[0].options.body).subscription_url, subscriptionUrl);
  assert.equal(requests[0].options.credentials, "omit");
});

test("local polling exposes live counts then fetches the verified full export", async () => {
  const requestId = "req-local-poll";
  let completed = false;
  const record = { node_index: 0, node: "local-node", status: "success" };
  const fakeFetch = async (url) => {
    if (String(url) === `http://127.0.0.1:8000/api/scans/${requestId}`) {
      return {
        ok: true,
        status: 200,
        json: async () => completed
          ? { id: requestId, status: "completed", message: "扫描完成", total: 1, completed: 1, success_count: 1, partial_count: 0, failed_count: 0, manifest_ready: true, cleanup_confirmed: true }
          : { id: requestId, status: "running", message: "正在检测 local-node", total: 2, completed: 1, success_count: 1, partial_count: 0, failed_count: 0, manifest_ready: false, cleanup_confirmed: false },
      };
    }
    if (String(url) === `http://127.0.0.1:8000/api/scans/${requestId}/export`) {
      return { ok: true, status: 200, json: async () => ({ id: requestId, status: "completed", total: 1, completed: 1, success_count: 1, partial_count: 0, failed_count: 0, manifest_ready: true, cleanup_confirmed: true, results: [record], manifest: { complete: true } }) };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const window = localWindow(fakeFetch);

  const running = await window.BestIpAction.poll("", requestId, null);
  assert.equal(running.status, "running");
  assert.equal(running.action_progress.source, "local");
  assert.equal(running.action_progress.current_step.name, "正在检测 local-node");
  assert.equal(running.node_progress.completed, 1);

  completed = true;
  const terminal = await window.BestIpAction.poll("", requestId, null);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.action_status.usable, true);
  assert.equal(terminal.action_result.results[0].node, "local-node");
  assert.equal(terminal.manifest_ready, true);
});

test("local cancellation uses the FastAPI job endpoint without gateway identity", async () => {
  const calls = [];
  const window = localWindow(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({ status: "cancelled" }) };
  });

  await window.BestIpAction.cancel("", "req-local-cancel", null);

  assert.equal(calls[0].url, "http://127.0.0.1:8000/api/scans/req-local-cancel");
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.headers["X-Best-IP-Scan-Token"], undefined);
});

test("local mode rejects a non-loopback API base before sending subscriptions", () => {
  assert.throws(
    () => loadScript("frontend/action-client.js", {
      crypto: webcrypto,
      BEST_IP_CONFIG: { mode: "local", apiBase: "https://collector.example" },
    }, { fetch: async () => {}, document: { baseURI: "http://127.0.0.1:5173/" } }),
    /127\.0\.0\.1/u,
  );
});

test("gateway dispatch encrypts the URL and sends no browser credential", async () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const keyId = createHash("sha256").update(der).digest("hex");
  const pem = `-----BEGIN PUBLIC KEY-----\n${der.toString("base64")}\n-----END PUBLIC KEY-----\n`;
  const requests = [];
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/scan-public.pem")) return { ok: true, status: 200, text: async () => pem };
    if (String(url) === "/api/scans") return { ok: true, status: 202, json: async () => ({ request_id: "req-gateway", dispatched_at: Date.now(), run_id: null, scan_token: "signed-token" }) };
    throw new Error(`unexpected URL ${url}`);
  };
  const window = gatewayWindow(fakeFetch, { keyId });
  const subscriptionUrl = "https://subscription.example/config?token=secret-value";
  const dispatched = await window.BestIpAction.dispatch(subscriptionUrl);
  assert.equal(dispatched.scanToken, "signed-token");
  const request = requests.find(({ url }) => url === "/api/scans");
  const body = JSON.parse(request.options.body);
  assert.equal(body.key_id, keyId);
  assert.equal(body.envelope.request_id, body.request_id);
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.headers["X-Best-IP-Scan-Token"], undefined);
  assert.equal(request.options.body.includes(subscriptionUrl), false);
});

test("gateway polling uses normalized same-origin run and job state", async () => {
  const requestId = "req-running";
  const requests = [];
  const run = { id: 42, status: "in_progress", conclusion: null, run_attempt: 2, created_at: new Date(Date.now() - 1000).toISOString(), started_at: new Date(Date.now() - 800).toISOString(), html_url: "https://github.com/silverwolf-x/best-ip/actions/runs/42" };
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).startsWith(`/api/scans/${requestId}?`)) return { ok: true, status: 200, json: async () => ({ request_id: requestId, status: "running", run, jobs_available: true, jobs_total_count: 1, jobs: [{ id: 9, name: "scan", status: "in_progress", run_attempt: 2, steps: [{ number: 1, name: "Verify", status: "in_progress" }] }] }) };
    throw new Error(`unexpected URL ${url}`);
  };
  const window = gatewayWindow(fakeFetch);
  const remote = await window.BestIpAction.poll("signed-token", requestId, 42);
  assert.equal(remote.status, "running");
  assert.equal(remote.action_progress.current_step.name, "Verify");
  assert.equal(remote.node_progress.total, null);
  assert.equal(requests[0].options.headers["X-Best-IP-Scan-Token"], "signed-token");
  assert.equal(requests[0].options.credentials, "same-origin");
});

test("gateway waits for artifact then validates terminal payload", async () => {
  const requestId = "req-terminal";
  const run = { id: 71, status: "completed", conclusion: "success", run_attempt: 1, created_at: new Date(Date.now() - 1000).toISOString() };
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith(`/api/scans/${requestId}?`)) return { ok: true, status: 200, json: async () => ({ status: "completed", run, jobs_available: true, jobs_total_count: 1, jobs: [], artifact_ready: true }) };
    if (String(url).startsWith(`/api/scans/${requestId}/artifact?`)) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    throw new Error(`unexpected URL ${url}`);
  };
  const window = gatewayWindow(fakeFetch, { BestIpZip: { readArtifact: async () => ({ status: { status: "completed", usable: true }, result: { total: 3, completed: 3, success_count: 2, partial_count: 1, failed_count: 0, manifest_ready: true, results: [], manifest: { counts: { partial: 1, failed: 0 } } } }) } });
  const remote = await window.BestIpAction.poll("signed-token", requestId, 71);
  assert.equal(remote.status, "completed");
  assert.equal(remote.manifest_ready, true);
  assert.equal(remote.node_progress.partial_count, 1);
  assert.match(calls[1].url, /run_id=71&run_attempt=1/u);
  assert.equal(calls[1].options.headers["X-Best-IP-Scan-Token"], "signed-token");
});

test("gateway cancellation sends only the in-memory scan token header", async () => {
  const calls = [];
  const window = gatewayWindow(async (url, options = {}) => { calls.push({ url: String(url), options }); return { ok: true, status: 202, json: async () => ({}) }; });
  await window.BestIpAction.cancel("signed-token", "req-cancel", 99);
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.headers["X-Best-IP-Scan-Token"], "signed-token");
  assert.match(calls[0].url, /^\/api\/scans\/req-cancel\?run_id=99$/u);
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

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { readArtifact } from "../frontend/src/artifact/reader.js";
import worker, { internals } from "../worker/index.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/contracts/records.json", import.meta.url), "utf8"));
const lifecycle = JSON.parse(readFileSync(new URL("./fixtures/contracts/lifecycle.json", import.meta.url), "utf8"));
const summaryKeys = ["node_index", "node", "type", "selected_proxy", "status", "error", "transport_error", "attempt_count", "retry_count", "attempt_errors", "exit_ip", "cidr", "rdns", "ai_verdict", "location", "isp", "score", "is_residential", "is_datacenter", "is_native", "native_status", "native_detail", "is_bogon", "bogon_status", "bogon_reason", "rpki_status", "asn_kind", "asn_kind_display", "abuse_level", "honeypot_status", "traffic_profile", "company_type", "is_vpn", "is_proxy", "is_tor", "is_crawler", "is_abuser", "security_status", "threat_tags", "asn", "as_org", "global_ping", "port_scan", "ping_check", "gpt_check", "related_domains", "elapsed_ms", "started_at", "finished_at", "completeness", "proxy_evidence"];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function archive(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(Buffer.concat([local, nameBytes, raw]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes]));
    offset += locals.at(-1).length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...locals, directory, end]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
}

function artifact(record, corruptDigest = false) {
  const counts = { success: 0, partial: 0, failed: 0, complete: Number(record.completeness.complete === true) };
  counts[record.status] += 1;
  const summary = Object.fromEntries(summaryKeys.map((key) => [key, record[key] ?? null]));
  const manifest = { schema_version: 1, job_id: fixtures.identity.requestId, status: "completed", total: 1, completed: 1, complete: true, all_records_present: true, counts, records: [{ index: 0, file: "0000.json", summary }] };
  const result = { id: fixtures.identity.requestId, status: "completed", manifest_ready: true, cleanup_confirmed: true, total: 1, completed: 1, success_count: counts.success, partial_count: counts.partial, failed_count: counts.failed, results: [record], manifest };
  const raw = JSON.stringify(result);
  const status = { schema_version: 1, sanitized: true, request_id: fixtures.identity.requestId, run_id: fixtures.identity.runId, run_attempt: fixtures.identity.runAttempt, status: "completed", usable: counts.failed === 0 && counts.partial === 0, total: 1, completed: 1, counts, result_sha256: corruptDigest ? lifecycle.invalid_artifact.value : createHash("sha256").update(raw).digest("hex") };
  return archive({ "status.json": JSON.stringify(status), "result.json": raw });
}

function reader() { return readArtifact; }

for (const fixture of fixtures.cases) {
  test(`shared node contract: ${fixture.name}`, async () => {
    const record = { ...structuredClone(fixtures.base), ...fixture.patch };
    const operation = reader()(artifact(record), fixtures.identity);
    if (!fixture.javascript_valid) await assert.rejects(operation);
    else {
      const payload = await operation;
      assert.equal(payload.result.results[0].status, record.status);
      assert.equal(payload.status.usable, record.status === "success");
    }
  });
}

test("invalid artifact digest is rejected by the real ZIP reader", async () => {
  await assert.rejects(reader()(artifact(fixtures.base, true), fixtures.identity), /摘要/);
});

test("Worker dispatch, title and artifact identity match scan.yml", async () => {
  const workflow = readFileSync(".github/workflows/scan.yml", "utf8");
  const requestId = fixtures.identity.requestId;
  const keyId = "a".repeat(64);
  const now = Math.floor(Date.now() / 1000);
  const envelope = { v: 1, kid: keyId, alg: "RSA-OAEP-3072-SHA256+AES-256-GCM", request_id: requestId, issued_at: now, expires_at: now + 900, ek: "aGVsbG8", iv: "aXY", aad: "YWFk", ct: "Y3Q" };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = { SCAN_KEY_ID: keyId, SCAN_TOKEN_SECRET: "contract-only-signing-material", GITHUB_APP_ID: "45678", GITHUB_APP_INSTALLATION_ID: "98765", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }), ACCESS_ALLOWED_EMAIL: "fixture@example.test" };
  const request = new Request("https://fixture.example.test/api/scans", { method: "POST", headers: { Origin: "https://fixture.example.test", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify({ request_id: requestId, key_id: keyId, envelope }) });
  const originalFetch = globalThis.fetch;
  let dispatched;
  const artifactName = `best-ip-result-${requestId}-42-1`;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/access_tokens")) return Response.json({ token: "fixture-installation", expires_at: new Date(Date.now() + 3600000).toISOString() });
    if (String(url).endsWith("/dispatches")) {
      assert.equal(String(url), "https://api.github.com/repos/silverwolf-x/best-ip/actions/workflows/scan.yml/dispatches");
      dispatched = JSON.parse(options.body);
      return new Response(null, { status: 204 });
    }
    if (String(url).includes("/artifacts")) return Response.json({ artifacts: [{ id: 1, name: artifactName, expired: false }] });
    throw new Error(`Unexpected network call ${url}`);
  };
  try {
    const response = await worker.fetch(request, env, { access: { aud: "fixture", getIdentity: async () => ({ email: env.ACCESS_ALLOWED_EMAIL }) } });
    assert.equal(response.status, 202);
    assert.equal(dispatched.ref, "main");
    assert.deepEqual(Object.keys(dispatched.inputs).sort(), ["encrypted_subscription_url", "key_id", "request_id"]);
    for (const input of Object.keys(dispatched.inputs)) assert.match(workflow, new RegExp(`^      ${input}:`, "m"));
    assert.equal(dispatched.inputs.request_id, requestId);
    assert.equal(dispatched.inputs.key_id, keyId);
    assert.deepEqual(JSON.parse(dispatched.inputs.encrypted_subscription_url), envelope);
    const title = workflow.match(/^run-name: (.+)$/m)[1].replace("${{ inputs.request_id }}", requestId);
    assert.equal(internals.exactRun({ id: 42, path: ".github/workflows/scan.yml", display_title: title, event: "workflow_dispatch", head_branch: "main", created_at: new Date().toISOString() }, requestId, Date.now()), true);
    const declaredName = workflow.match(/^          name: (best-ip-result-.+)$/m)[1].replace("${{ inputs.request_id }}", requestId).replace("${{ github.run_id }}", "42").replace("${{ github.run_attempt }}", "1");
    assert.equal(declaredName, artifactName);
    assert.equal((await internals.findArtifact(env, { id: 42, run_attempt: 1 }, requestId)).name, declaredName);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

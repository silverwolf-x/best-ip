import test from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes, webcrypto } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";

const { subtle } = webcrypto;
const decoder = new TextDecoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
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
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([local, nameBytes, compressed]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes]));
    offset += locals.at(-1).length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

const summaryKeys = [
  "node_index", "node", "type", "selected_proxy", "status", "error",
  "transport_error", "attempt_count", "retry_count", "attempt_errors", "exit_ip",
  "cidr", "rdns", "ai_verdict", "location", "isp", "score", "is_residential",
  "is_datacenter", "is_native", "native_status", "native_detail", "is_bogon",
  "bogon_status", "bogon_reason", "rpki_status", "asn_kind", "asn_kind_display",
  "abuse_level", "honeypot_status", "traffic_profile", "company_type", "is_vpn",
  "is_proxy", "is_tor", "is_crawler", "is_abuser", "security_status", "threat_tags",
  "asn", "as_org", "global_ping", "port_scan", "ping_check", "gpt_check",
  "related_domains", "elapsed_ms", "started_at", "finished_at", "completeness",
  "proxy_evidence",
];

function resultSummary(record) {
  return Object.fromEntries(summaryKeys.map((key) => [key, record[key] ?? null]));
}

function artifactFiles({ tamperDigest = false } = {}) {
  const requestId = "req-test-1";
  const record = {
    schema_version: 1,
    job_id: requestId,
    node_index: 0,
    node: "node-a",
    type: "ss",
    status: "failed",
    error: "connection failed",
    transport_error: null,
    selected_proxy: null,
    exit_ip: null,
    completeness: { complete: false },
    proxy_evidence: {},
  };
  const manifest = {
    schema_version: 1,
    job_id: requestId,
    status: "completed",
    total: 1,
    completed: 1,
    all_records_present: true,
    complete: true,
    counts: { success: 0, partial: 0, failed: 1, complete: 0 },
    records: [{ index: 0, file: "0000.json", summary: resultSummary(record) }],
  };
  const result = {
    id: requestId,
    status: "completed",
    total: 1,
    completed: 1,
    success_count: 0,
    partial_count: 0,
    failed_count: 1,
    manifest_ready: true,
    cleanup_confirmed: true,
    results: [record],
    manifest,
  };
  const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8");
  const digest = createHash("sha256").update(resultBytes).digest("hex");
  const status = {
    schema_version: 1,
    sanitized: true,
    request_id: requestId,
    run_id: 42,
    run_attempt: 1,
    status: "completed",
    usable: false,
    total: 1,
    completed: 1,
    counts: manifest.counts,
    result_sha256: tamperDigest ? "0".repeat(64) : digest,
  };
  return {
    requestId,
    statusBytes: Buffer.from(JSON.stringify(status), "utf8"),
    resultBytes,
  };
}

function loadScript(filename, windowValues, globals = {}) {
  const window = { ...windowValues };
  const context = {
    window,
    console,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Blob,
    Response,
    DecompressionStream,
    URL,
    URLSearchParams,
    crypto: webcrypto,
    atob,
    btoa,
    ...globals,
  };
  runInNewContext(readFileSync(filename, "utf8"), context, { filename });
  return window;
}

test("ZIP reader validates stored and deflated sanitized artifacts", async () => {
  const files = artifactFiles();
  for (const method of [0, 8]) {
    const archive = zip([
      { name: "status.json", content: files.statusBytes, method },
      { name: "result.json", content: files.resultBytes, method },
    ]);
    const window = loadScript("frontend/zip-reader.js", { crypto: webcrypto });
    const payload = await window.BestIpZip.readArtifact(
      archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
      { requestId: files.requestId, runId: 42, runAttempt: 1 },
    );
    assert.equal(payload.status.request_id, files.requestId);
    assert.equal(payload.result.results[0].status, "failed");
  }
});

test("ZIP reader rejects digest mismatches and path traversal", async () => {
  const files = artifactFiles({ tamperDigest: true });
  const archive = zip([
    { name: "status.json", content: files.statusBytes },
    { name: "result.json", content: files.resultBytes },
  ]);
  const window = loadScript("frontend/zip-reader.js", { crypto: webcrypto });
  await assert.rejects(
    window.BestIpZip.readArtifact(
      archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
      { requestId: files.requestId, runId: 42, runAttempt: 1 },
    ),
    /摘要校验/,
  );

  const traversal = zip([
    { name: "status.json", content: files.statusBytes },
    { name: "../result.json", content: files.resultBytes },
  ]);
  await assert.rejects(
    window.BestIpZip.readArtifact(
      traversal.buffer.slice(traversal.byteOffset, traversal.byteOffset + traversal.byteLength),
      { requestId: files.requestId, runId: 42, runAttempt: 1 },
    ),
    /不允许的文件/,
  );
});

test("Pages dispatch encrypts the URL and sends only correlation inputs", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const keyId = createHash("sha256").update(der).digest("hex");
  const pem = `-----BEGIN PUBLIC KEY-----\n${der.toString("base64")}\n-----END PUBLIC KEY-----\n`;
  const requests = [];
  const fakeFetch = async (url, options = {}) => {
    const urlText = String(url);
    requests.push({ url: urlText, options });
    if (urlText.endsWith("/scan-public.pem")) {
      return { ok: true, status: 200, text: async () => pem };
    }
    if (urlText.endsWith("/dispatches")) {
      return { ok: true, status: 204, json: async () => null };
    }
    throw new Error(`unexpected URL ${urlText}`);
  };
  const window = loadScript(
    "frontend/action-client.js",
    {
      BEST_IP_CONFIG: {
        mode: "github-pages",
        owner: "owner",
        repository: "repo",
        workflowFile: "scan.yml",
        defaultBranch: "main",
        publicKeyPath: "./scan-public.pem",
        keyId,
      },
      crypto: webcrypto,
      location: { hostname: "owner.github.io" },
    },
    {
      fetch: fakeFetch,
      document: { baseURI: "https://owner.github.io/best-ip/" },
    },
  );
  const pat = `github_pat_${"a".repeat(40)}`;
  const subscriptionUrl = "https://subscription.example/config?token=secret-value";
  const dispatched = await window.BestIpAction.dispatch(pat, subscriptionUrl);
  assert.equal(window.BestIpAction.isPagesMode(), true);
  assert.match(dispatched.requestId, /^req-/);
  assert.equal(dispatched.runId, null);
  const dispatchRequest = requests.find(({ url }) => url.endsWith("/dispatches"));
  assert.ok(dispatchRequest);
  const body = JSON.parse(dispatchRequest.options.body);
  assert.deepEqual(Object.keys(body.inputs).sort(), [
    "encrypted_subscription_url", "key_id", "request_id",
  ]);
  assert.equal(body.ref, "main");
  assert.equal(body.inputs.key_id, keyId);
  assert.equal(body.inputs.encrypted_subscription_url.includes(subscriptionUrl), false);
  assert.equal(dispatchRequest.options.headers.Authorization, `Bearer ${pat}`);
  assert.equal(dispatchRequest.options.body.includes(pat), false);
  assert.equal(privateKey.asymmetricKeyType, "rsa");
});

test("decrypt script enforces canonical AAD and never prints plaintext on failure", () => {
  const directory = mkdtempSync(join(process.env.TEMP || ".", "best-ip-decrypt-test-"));
  try {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const requestId = "req-decrypt-1";
    const keyId = "b".repeat(64);
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const aesKey = randomBytes(32);
    const iv = randomBytes(12);
    const aad = Buffer.from(`${requestId}:${keyId}:${expiresAt}`, "utf8");
    const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
    cipher.setAAD(aad);
    const plaintext = "https://subscription.example/config?token=secret-value";
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const base64Url = (value) => value.toString("base64")
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    const envelope = {
      v: 1,
      kid: keyId,
      alg: "RSA-OAEP-3072-SHA256+AES-256-GCM",
      request_id: requestId,
      issued_at: expiresAt - 300,
      expires_at: expiresAt,
      ek: base64Url(publicEncrypt({
        key: publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      }, aesKey)),
      iv: base64Url(iv),
      aad: base64Url(aad),
      ct: base64Url(ciphertext),
    };
    const privateKeyPath = join(directory, "private.pem");
    const outputPath = join(directory, "url");
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    const run = (payload, output) => spawnSync(
      process.execPath,
      [
        "scripts/decrypt_subscription.mjs",
        "--private-key", privateKeyPath,
        "--output", output,
        "--request-id", requestId,
        "--key-id", keyId,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, BEST_IP_ENVELOPE: JSON.stringify(payload) },
      },
    );

    const success = run(envelope, outputPath);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(readFileSync(outputPath, "utf8"), `${plaintext}\n`);

    const badOutput = join(directory, "bad-url");
    const failure = run({ ...envelope, aad: base64Url(Buffer.from("wrong-aad")) }, badOutput);
    assert.equal(failure.status, 1);
    assert.equal(failure.stderr, "订阅密文校验失败\n");
    assert.equal(failure.stderr.includes(plaintext), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

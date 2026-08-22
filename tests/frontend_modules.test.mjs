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
  assert.equal(dispatchRequest.options.headers["Content-Type"], "application/json");
  assert.equal(dispatchRequest.options.body.includes(pat), false);
  assert.equal(privateKey.asymmetricKeyType, "rsa");
});

test("Pages polling uses the documented single-run endpoint", async () => {
  const requestId = "req-run-test";
  const requests = [];
  const run = {
    id: 42,
    display_title: `Best IP scan ${requestId}`,
    name: `Best IP scan ${requestId}`,
    event: "workflow_dispatch",
    head_branch: "main",
    created_at: new Date(Date.now() - 1000).toISOString(),
    status: "queued",
    conclusion: null,
    run_attempt: 1,
  };
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/actions/runs/42")) {
      return { ok: true, status: 200, json: async () => run };
    }
    if (String(url).includes("/actions/runs/42/attempts/1/jobs?")) {
      return { ok: true, status: 200, json: async () => ({ total_count: 0, jobs: [] }) };
    }
    throw new Error(`unexpected URL ${url}`);
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
        keyId: "a".repeat(64),
      },
      location: { hostname: "owner.github.io" },
    },
    {
      fetch: fakeFetch,
      document: { baseURI: "https://owner.github.io/best-ip/" },
    },
  );
  const remote = await window.BestIpAction.poll(
    `github_pat_${"b".repeat(40)}`,
    requestId,
    42,
    Date.now() - 5000,
  );
  assert.equal(remote.status, "queued");
  assert.equal(remote.runId, 42);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.github.com/repos/owner/repo/actions/runs/42");
  assert.match(requests[1].url, /\/actions\/runs\/42\/attempts\/1\/jobs\?per_page=100&page=1$/u);
  assert.equal(requests[1].options.cache, "no-store");
  assert.equal(requests.some(({ url }) => url.includes("/actions/workflows/scan.yml/runs/42")), false);
});

test("Pages polling reads exact attempt job pages and preserves running step state", async () => {
  const requestId = "req-jobs-pages";
  const now = Date.now();
  const requests = [];
  const run = {
    id: 99,
    display_title: `Best IP scan ${requestId}`,
    name: `Best IP scan ${requestId}`,
    event: "workflow_dispatch",
    head_branch: "main",
    created_at: new Date(now - 1000).toISOString(),
    started_at: new Date(now - 800).toISOString(),
    status: "in_progress",
    conclusion: null,
    run_attempt: 2,
  };
  const firstPage = Array.from({ length: 100 }, (_, index) => {
    const running = index === 99;
    return {
      id: index + 1,
      name: running ? "scan" : `setup-${index + 1}`,
      status: running ? "in_progress" : "completed",
      conclusion: running ? null : "success",
      run_attempt: 2,
      started_at: new Date(now - 700).toISOString(),
      steps: running
        ? [
          { number: 1, name: "Prepare", status: "completed", conclusion: "success", started_at: new Date(now - 700).toISOString(), completed_at: new Date(now - 600).toISOString() },
          { number: 2, name: "Run <strict> verifier", status: "in_progress", conclusion: null, started_at: new Date(now - 500).toISOString(), completed_at: null },
          { number: 3, name: "Upload", status: "queued", conclusion: null, started_at: null, completed_at: null },
        ]
        : [{ number: 1, name: "Complete", status: "completed", conclusion: "success", started_at: new Date(now - 700).toISOString(), completed_at: new Date(now - 600).toISOString() }],
    };
  });
  const secondPage = [{
    id: 101,
    name: "post-scan",
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
    steps: [{ number: 1, name: "Post", status: "completed", conclusion: "success" }],
  }];
  const fakeFetch = async (url, options = {}) => {
    const text = String(url);
    requests.push({ url: text, options });
    if (text.endsWith("/actions/runs/99")) return { ok: true, status: 200, json: async () => run };
    if (text.includes("/actions/runs/99/attempts/2/jobs?per_page=100&page=1")) {
      return { ok: true, status: 200, json: async () => ({ total_count: 101, jobs: firstPage }) };
    }
    if (text.includes("/actions/runs/99/attempts/2/jobs?per_page=100&page=2")) {
      return { ok: true, status: 200, json: async () => ({ total_count: 101, jobs: secondPage }) };
    }
    throw new Error(`unexpected URL ${url}`);
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
        keyId: "a".repeat(64),
      },
      location: { hostname: "owner.github.io" },
    },
    { fetch: fakeFetch },
  );

  const remote = await window.BestIpAction.poll(
    `github_pat_${"f".repeat(40)}`,
    requestId,
    99,
    now - 5000,
  );

  assert.equal(remote.status, "running");
  assert.equal(remote.total, null);
  assert.equal(remote.completed, null);
  assert.equal(remote.node_progress.total, null);
  assert.equal(remote.action_progress.jobs_total, 101);
  assert.equal(remote.action_progress.jobs_completed, 100);
  assert.equal(remote.action_progress.current_job_index, 100);
  assert.equal(remote.action_progress.current_step_index, 2);
  assert.equal(remote.action_progress.steps_total, 3);
  assert.equal(remote.action_progress.steps_completed, 1);
  assert.equal(remote.action_progress.current_step.status, "in_progress");
  assert.equal(remote.action_progress.current_step.conclusion, null);
  assert.equal(requests.filter(({ url }) => url.includes("/attempts/2/jobs?")).length, 2);
  assert.equal(requests.every(({ options }) => options.cache === "no-store"), true);
});

test("Pages preserves empty queued jobs and maps failed or cancelled runs", async () => {
  for (const [id, conclusion, expectedStatus] of [[60, "failure", "failed"], [61, "cancelled", "cancelled"]]) {
    const requestId = `req-${id}`;
    const run = {
      id,
      display_title: `Best IP scan ${requestId}`,
      name: `Best IP scan ${requestId}`,
      event: "workflow_dispatch",
      head_branch: "main",
      created_at: new Date(Date.now() - 1000).toISOString(),
      completed_at: new Date().toISOString(),
      status: "completed",
      conclusion,
      run_attempt: 1,
    };
    const fakeFetch = async (url) => {
      const text = String(url);
      if (text.endsWith(`/actions/runs/${id}`)) return { ok: true, status: 200, json: async () => run };
      if (text.includes(`/actions/runs/${id}/attempts/1/jobs?`)) {
        return { ok: true, status: 200, json: async () => ({ total_count: 0, jobs: [] }) };
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const window = loadScript(
      "frontend/action-client.js",
      {
        BEST_IP_CONFIG: { mode: "github-pages", owner: "owner", repository: "repo", workflowFile: "scan.yml", defaultBranch: "main", keyId: "a".repeat(64) },
        location: { hostname: "owner.github.io" },
      },
      { fetch: fakeFetch },
    );
    const remote = await window.BestIpAction.poll(`github_pat_${"g".repeat(40)}`, requestId, id, Date.now() - 5000);
    assert.equal(remote.status, expectedStatus);
    assert.equal(remote.action_progress.jobs_state, "empty");
    assert.equal(remote.action_progress.conclusion, conclusion);
    assert.equal(remote.node_progress.phase, "unavailable");
    assert.equal(remote.node_progress.total, null);
  }
});

test("Pages waits for a result artifact after successful Actions completion", async () => {
  const requestId = "req-artifact-pending";
  const run = {
    id: 70,
    display_title: `Best IP scan ${requestId}`,
    name: `Best IP scan ${requestId}`,
    event: "workflow_dispatch",
    head_branch: "main",
    created_at: new Date(Date.now() - 1000).toISOString(),
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  };
  const fakeFetch = async (url) => {
    const text = String(url);
    if (text.endsWith("/actions/runs/70")) return { ok: true, status: 200, json: async () => run };
    if (text.includes("/actions/runs/70/attempts/1/jobs?")) return { ok: true, status: 200, json: async () => ({ total_count: 0, jobs: [] }) };
    if (text.endsWith("/actions/runs/70/artifacts?per_page=100")) return { ok: true, status: 200, json: async () => ({ artifacts: [] }) };
    throw new Error(`unexpected URL ${url}`);
  };
  const window = loadScript(
    "frontend/action-client.js",
    {
      BEST_IP_CONFIG: { mode: "github-pages", owner: "owner", repository: "repo", workflowFile: "scan.yml", defaultBranch: "main", keyId: "a".repeat(64) },
      location: { hostname: "owner.github.io" },
    },
    { fetch: fakeFetch },
  );
  const remote = await window.BestIpAction.poll(`github_pat_${"h".repeat(40)}`, requestId, 70, Date.now() - 5000);
  assert.equal(remote.status, "artifact_pending");
  assert.equal(remote.runId, 70);
  assert.equal(remote.action_progress.run_status, "artifact_pending");
  assert.equal(remote.node_progress.total, null);
  assert.match(remote.error, /artifact/);
});

test("Pages exposes verified terminal artifact node progress", async () => {
  const requestId = "req-terminal-progress";
  const run = {
    id: 71,
    display_title: `Best IP scan ${requestId}`,
    name: `Best IP scan ${requestId}`,
    event: "workflow_dispatch",
    head_branch: "main",
    created_at: new Date(Date.now() - 1000).toISOString(),
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  };
  const fakeFetch = async (url) => {
    const text = String(url);
    if (text.endsWith("/actions/runs/71")) return { ok: true, status: 200, json: async () => run };
    if (text.includes("/actions/runs/71/attempts/1/jobs?")) {
      return { ok: true, status: 200, json: async () => ({ total_count: 1, jobs: [{ id: 801, name: "scan", status: "completed", conclusion: "success", run_attempt: 1, steps: [] }] }) };
    }
    if (text.endsWith("/actions/runs/71/artifacts?per_page=100")) {
      return { ok: true, status: 200, json: async () => ({ artifacts: [{ id: 901, name: `best-ip-result-${requestId}-71-1`, expired: false }] }) };
    }
    if (text.endsWith("/actions/artifacts/901/zip")) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    throw new Error(`unexpected URL ${url}`);
  };
  const window = loadScript(
    "frontend/action-client.js",
    {
      BEST_IP_CONFIG: { mode: "github-pages", owner: "owner", repository: "repo", workflowFile: "scan.yml", defaultBranch: "main", keyId: "a".repeat(64) },
      BestIpZip: {
        readArtifact: async () => ({
          status: { status: "completed", usable: true },
          result: {
            total: 3,
            completed: 3,
            success_count: 2,
            partial_count: 1,
            failed_count: 0,
            manifest_ready: true,
            results: [],
            manifest: { counts: { success: 2, partial: 1, failed: 0 } },
          },
        }),
      },
      location: { hostname: "owner.github.io" },
    },
    { fetch: fakeFetch },
  );
  const remote = await window.BestIpAction.poll(`github_pat_${"i".repeat(40)}`, requestId, 71, Date.now() - 5000);
  assert.equal(remote.status, "completed");
  assert.equal(remote.manifest_ready, true);
  assert.equal(remote.node_progress.phase, "terminal");
  assert.equal(remote.node_progress.total, 3);
  assert.equal(remote.node_progress.completed, 3);
  assert.equal(remote.node_progress.success_count, 2);
  assert.equal(remote.node_progress.partial_count, 1);
  assert.equal(remote.node_progress.usable, true);
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

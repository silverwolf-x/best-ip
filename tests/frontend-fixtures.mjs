import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
const summaryKeys = ["node_index", "node", "type", "selected_proxy", "status", "error", "transport_error", "attempt_count", "retry_count", "attempt_errors", "exit_ip", "cidr", "rdns", "ai_verdict", "location", "isp", "score", "is_residential", "is_datacenter", "is_native", "native_status", "native_detail", "is_bogon", "bogon_status", "bogon_reason", "rpki_status", "asn_kind", "asn_kind_display", "abuse_level", "honeypot_status", "traffic_profile", "company_type", "is_vpn", "is_proxy", "is_tor", "is_crawler", "is_abuser", "security_status", "threat_tags", "asn", "as_org", "global_ping", "port_scan", "ping_check", "gpt_check", "related_domains", "elapsed_ms", "started_at", "finished_at", "completeness", "proxy_evidence"];
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
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/contracts/records.json', import.meta.url), 'utf8'));
export function resultFixture(requestId = 'req-test-1', status = 'failed') {
 const fixture = fixtures.cases.find(item => item.name === (status === 'failed' ? 'all_failed' : status));
 const record = { ...structuredClone(fixtures.base), ...structuredClone(fixture.patch), job_id: requestId };
 const counts = { success: 0, partial: 0, failed: 0, complete: Number(record.completeness.complete === true) };
 counts[record.status] += 1;
 const summary = Object.fromEntries(summaryKeys.map(key => [key, record[key] ?? null]));
 const manifest = { schema_version: 1, job_id: requestId, status: 'completed', total: 1, completed: 1, all_records_present: true, complete: true, counts, records: [{ index: 0, file: '0000.json', summary }] };
 return { id: requestId, status: 'completed', total: 1, completed: 1, success_count: counts.success, partial_count: counts.partial, failed_count: counts.failed, manifest_ready: true, cleanup_confirmed: true, results: [record], manifest };
}
export function artifactFiles({ tamperDigest = false, requestId = 'req-test-1', runId = 42, runAttempt = 1, status = 'failed', result = resultFixture(requestId, status) } = {}) {
 const resultBytes = Buffer.from(JSON.stringify(result), 'utf8');
 const statusObject = { schema_version: 1, sanitized: true, request_id: requestId, run_id: runId, run_attempt: runAttempt, status: 'completed', usable: result.partial_count === 0 && result.failed_count === 0, total: result.total, completed: result.completed, counts: result.manifest.counts, result_sha256: tamperDigest ? '0'.repeat(64) : createHash('sha256').update(resultBytes).digest('hex') };
 return { requestId, statusBytes: Buffer.from(JSON.stringify(statusObject)), resultBytes };
}
export function artifactBuffer(options = {}) {
 const files = artifactFiles(options);
 const bytes = zip([{ name: 'status.json', content: files.statusBytes, method: options.method || 0 }, { name: 'result.json', content: files.resultBytes, method: options.method || 0 }]);
 return toBuffer(bytes);
}
export function toBuffer(bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
export { zip };

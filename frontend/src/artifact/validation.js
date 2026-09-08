const required = 'schema_version job_id node_index node type selected_proxy status error transport_error started_at finished_at exit_ip elapsed_ms proxy_evidence completeness requests coffee'.split(' ');
const optional = 'requested_proxy coffee_page_url phase attempt_count retry_count attempt_errors cidr rdns ai_verdict location isp score coffee_score ipure_scores is_residential is_datacenter is_native native_status native_detail is_bogon bogon_status bogon_reason rpki_status asn_kind asn_kind_display abuse_level honeypot_status traffic_profile company_type is_vpn is_proxy is_tor is_crawler is_abuser security_status threat_tags asn as_org global_ping port_scan ping_check gpt_check related_domains pages'.split(' ');
const allowed = new Set([...required, ...optional]);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validIp(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value) return false;
  if (!value.includes(':')) return /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/u.test(value) && value.split('.').every(part => Number(part) <= 255);
  try { return new URL('http://[' + value + ']/').hostname.startsWith('['); } catch { return false; }
}
export function validateRecord(record, jobId, index) {
  if (!isObject(record) || required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !allowed.has(key))) throw new Error('节点记录字段集合无效');
  if (record.schema_version !== 1 || record.job_id !== jobId || record.node_index !== index || typeof record.node !== 'string' || !record.node || typeof record.type !== 'string' || !record.type || !Number.isInteger(record.elapsed_ms) || record.elapsed_ms < 0) throw new Error('节点记录结构或身份无效');
  for (const key of ['proxy_evidence', 'completeness', 'requests', 'coffee']) if (!isObject(record[key])) throw new Error('节点记录结构无效');
  const evidence = record.proxy_evidence;
  if ([record.attempt_count, record.retry_count, record.attempt_errors].some(value => value != null)) {
    const expected = record.status === 'failed' ? record.attempt_count : record.retry_count;
    if (!Number.isInteger(record.attempt_count) || record.attempt_count < 1 || !Number.isInteger(record.retry_count) || record.retry_count !== record.attempt_count - 1 || !Array.isArray(record.attempt_errors) || record.attempt_errors.length !== expected || record.attempt_errors.some(error => typeof error !== 'string' || !error.trim()) || evidence.fresh_mihomo_per_attempt !== true || !Number.isInteger(evidence.max_attempts) || evidence.max_attempts < record.attempt_count) throw new Error('节点重试证据无效');
  }
  if (['success', 'partial'].includes(record.status)) {
    let proxy;
    try { proxy = new URL(evidence.proxy_url); } catch { throw new Error('成功节点记录的代理证据无效'); }
    const checks = record.completeness.checks;
    if (record.selected_proxy !== record.node || evidence.selection_confirmed !== true || evidence.selected_proxy !== record.node || evidence.transport !== 'workspace_mihomo_mixed_port' || evidence.target_origin !== 'https://ip.net.coffee' || typeof evidence.mihomo_instance !== 'string' || !evidence.mihomo_instance || proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !/^http:\/\/127\.0\.0\.1:\d+(?:\/)?$/u.test(evidence.proxy_url) || proxy.search || proxy.hash || proxy.username || proxy.password || evidence.trust_env !== false || evidence.direct_fallback !== false || !isObject(checks) || ['page_received', 'trace_received', 'exit_ip_valid', 'lookup_received', 'lookup_matches_trace'].some(key => checks[key] !== true)) throw new Error('成功节点记录的采集或代理证据无效');
    if (!validIp(record.exit_ip)) throw new Error('成功节点缺少合法出口 IP');
  } else if (record.status === 'failed') {
    if (record.exit_ip !== null) throw new Error('失败节点不能保存伪造的出口 IP');
    if (!String(record.error || '').trim()) throw new Error('失败节点缺少错误原因');
  } else throw new Error('节点记录状态无效');
}

const resultSearchIndex = new WeakMap();
const IPURE_SCORE_LABELS = [
  ["ai", "AI"],
  ["streaming", "流媒体"],
  ["ecommerce", "电商"],
  ["email", "邮件"],
];
const statusLabels = { success: "完整", partial: "部分", failed: "失败" };
export function normalizeImportedResult(raw, index, source) {
  if (!isRecord(raw)) throw new Error(`第 ${index + 1} 个节点结果不是对象。`);
  const result = { ...raw };
  result.node = normalizeDisplayText(firstImportedValue(raw.node, raw.node_name, raw.name));
  if (!result.node) throw new Error(`第 ${index + 1} 个节点结果缺少节点名称。`);
  result.type = normalizeDisplayText(firstImportedValue(raw.type, raw.protocol)) || "未知";
  for (const key of ["location", "isp", "as_org", "rdns", "native_status", "native_detail", "company_type", "traffic_profile", "security_status", "abuse_level", "honeypot_status"]) {
    if (result[key] !== null && result[key] !== undefined) result[key] = normalizeDisplayText(result[key]);
  }
  result.asn = parseImportedAsn(raw.asn);
  result.status = normalizeImportedStatus(raw.status, raw.exit_ip);
  result._index = raw.node_index ?? raw.index ?? index;
  result.node_index = raw.node_index ?? result._index;
  result._source = source;
  if (result.score !== null && result.score !== undefined && result.score !== "") {
    result.score = parseImportedNumber(result.score);
  }
  result.ipure_scores = normalizeIpureScores(result.ipure_scores, result.score);
  if (result.coffee_score !== null && result.coffee_score !== undefined && result.coffee_score !== "") {
    result.coffee_score = parseImportedNumber(result.coffee_score);
  }
  if (result.elapsed_ms !== null && result.elapsed_ms !== undefined && result.elapsed_ms !== "") {
    result.elapsed_ms = parseImportedNumber(result.elapsed_ms) ?? 0;
  }
  for (const key of ["global_ping", "gpt_check"]) {
    result[key] = Array.isArray(raw[key]) ? raw[key].filter(isRecord).map((item) => ({
      ...item,
      name: normalizeDisplayText(item.name),
      code: normalizeDisplayText(item.code),
      text: normalizeDisplayText(item.text),
      status: normalizeDisplayText(item.status),
      elapsed_ms: parseImportedNumber(item.elapsed_ms),
      ok: parseImportedBoolean(item.ok),
    })) : [];
  }
  return result;
}

export function normalizeImportedStatus(value, exitIp) {
  const status = String(value ?? "").trim().toLocaleLowerCase("zh-CN");
  if (["success", "completed", "complete", "成功", "完整"].includes(status)) return "success";
  if (["partial", "部分", "partially_complete"].includes(status)) return "partial";
  if (["failed", "failure", "error", "失败"].includes(status)) return "failed";
  return exitIp ? "partial" : "failed";
}

export function parseImportedBoolean(value) {
  const normalized = String(value ?? "").trim().toLocaleLowerCase("zh-CN");
  if (["是", "yes", "true", "1", "bogon"].includes(normalized)) return true;
  if (["否", "no", "false", "0", "公网可达", "public"].includes(normalized)) return false;
  return Boolean(normalized && !["未知", "unknown", "-"].includes(normalized));
}

export function parseImportedAsn(value) {
  const normalized = normalizeDisplayText(value).replace(/^(?:AS\s*)+/i, "");
  if (!normalized) return null;
  if (!/^\d+$/u.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) && number > 0 && number <= 4_294_967_295 ? number : null;
}

export function formatAsn(value) {
  const asn = parseImportedAsn(value);
  return asn == null ? "" : `AS${asn}`;
}

export function normalizeDisplayText(value) {
  const namedEntities = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"', tab: " " };
  return String(value ?? "")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/giu, (match, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      try { return Number.isInteger(codePoint) ? String.fromCodePoint(codePoint) : match; }
      catch { return match; }
    })
    .replace(/&(amp|apos|gt|lt|nbsp|quot|tab);/giu, (_match, name) => namedEntities[name.toLowerCase()])
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseImportedNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

export function parseImportedIpureScores(value, total) {
  const scores = { total: parseImportedNumber(total) };
  const text = String(value || "");
  IPURE_SCORE_LABELS.forEach(([key, label]) => {
    const match = text.match(new RegExp(`${label}\\s*[:：]\\s*(\\d+(?:\\.\\d+)?)`, "u"));
    scores[key] = match ? parseImportedNumber(match[1]) : null;
  });
  return scores;
}

export function normalizeIpureScores(value, total) {
  const source = isRecord(value) ? value : {};
  return {
    total: parseImportedNumber(source.total ?? total),
    ...Object.fromEntries(IPURE_SCORE_LABELS.map(([key]) => [key, parseImportedNumber(source[key])])),
  };
}

export function formatIpureScores(value) {
  const scores = normalizeIpureScores(value, null);
  return IPURE_SCORE_LABELS
    .filter(([key]) => scores[key] != null)
    .map(([key, label]) => `${label}:${scores[key]}`)
    .join(" | ");
}

export function firstImportedValue(...values) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim() !== "");
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function searchableResultText(result) {
  const cached = resultSearchIndex.get(result);
  if (cached) return cached;
  const text = [
    result.node,
    result.type,
    result.exit_ip,
    result.location,
    result.isp,
    result.as_org,
    result.error,
    result.security_status,
    result.rpki_status,
    result.rdns,
    result.bogon_status,
    result.company_type,
    result.traffic_profile,
    result.abuse_level,
    result.honeypot_status,
    result.gpt_check?.map((item) => `${item.name || ""} ${item.text || ""} ${item.elapsed_ms ?? ""}ms`).join(" "),
    result.global_ping?.map((item) => `${item.name || ""} ${item.code || ""} ${item.elapsed_ms ?? ""} ${item.status || ""}`).join(" "),
    result.asn ? `AS${result.asn}` : "",
    result.asn_kind_display,
    result.native_status,
    formatIpureScores(result.ipure_scores),
  ].map((value) => String(value || "")).join("\n").toLocaleLowerCase("zh-CN");
  resultSearchIndex.set(result, text);
  return text;
}
export function compareResults(left, right, sortKey = "score", sortDirection = "desc") {
  const direction = sortDirection === "asc" ? 1 : -1;
  const leftValue = left[sortKey];
  const rightValue = right[sortKey];
  if (typeof leftValue === "number" || typeof rightValue === "number") return ((leftValue ?? -1) - (rightValue ?? -1)) * direction;
  return String(leftValue || "").localeCompare(String(rightValue || ""), "zh-CN", { numeric: true, sensitivity: "base" }) * direction;
}
export function normalizeUnavailableLatencyStatus(value, fallback) {
  const status = String(value || fallback).replace(/\s*\(?-1ms\)?\s*$/u, "").trim();
  return status || fallback;
}
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}
export function filterResults(results, { query = "", status = "all", columnFilters = {}, sortKey = "score", sortDirection = "desc" } = {}) {
 const globalStatus = status;
 const cf = columnFilters;
 query = query.trim().toLocaleLowerCase("zh-CN");
  return results
    .filter((result) => globalStatus === "all" || result.status === globalStatus)
    .filter((result) => {      if (query && !searchableResultText(result).includes(query)) return false;

      // 列筛选 1: 节点名称
      if (cf.node && !String(result.node || "").toLocaleLowerCase("zh-CN").includes(cf.node.toLocaleLowerCase("zh-CN"))) {
        return false;
      }

      // 列筛选 2: 评分
      if (cf.score) {
        const s = result.score;
        if (s == null) return false;
        if (cf.score === "high" && s < 75) return false;
        if (cf.score === "mid" && (s < 45 || s >= 75)) return false;
        if (cf.score === "low" && s >= 45) return false;
      }

      // 列筛选 3: 状态
      if (cf.status && result.status !== cf.status) {
        return false;
      }

      // 列筛选 4: 出口 IP
      if (cf.exit_ip && !String(result.exit_ip || "").toLowerCase().includes(cf.exit_ip.toLowerCase())) {
        return false;
      }

      // 列筛选 5: 服务商 / ISP
      if (cf.isp) {
        const ispStr = `${result.isp || ""} ${result.as_org || ""}`.toLocaleLowerCase("zh-CN");
        if (!ispStr.includes(cf.isp.toLocaleLowerCase("zh-CN"))) return false;
      }

      // 列筛选 6: ASN / 原生性
      if (cf.native) {
        if (cf.native === "native" && result.is_native !== true) return false;
        if (cf.native === "broadcast" && result.is_native !== false) return false;
        if (cf.native === "residential" && result.is_residential !== true) return false;
        if (cf.native === "datacenter" && result.is_datacenter !== true) return false;
      }

      // 列筛选 7: 安全指标
      if (cf.security) {
        if (cf.security === "clean" && (!result.security_status || !result.security_status.includes("纯净"))) return false;
        if (cf.security === "threat" && (result.security_status && result.security_status.includes("纯净"))) return false;
        if (cf.security === "vpn" && !result.is_vpn) return false;
        if (cf.security === "proxy" && !result.is_proxy) return false;
        if (cf.security === "tor" && !result.is_tor) return false;
      }

      // 列筛选 8: GPT · Codex 延迟检测
      if (cf.gpt) {
        const gptFilter = cf.gpt.toLowerCase();
        const gpts = result.gpt_check || [];
        const matchesGpt = gpts.some((g) =>
          String(g.name || "").toLowerCase().includes(gptFilter) ||
          String(g.text || "").toLowerCase().includes(gptFilter) ||
          String(g.elapsed_ms || "").includes(gptFilter) ||
          String(g.status || "").toLowerCase().includes(gptFilter)
        );
        if (!matchesGpt) return false;
      }

      // 列筛选 9: Coffee 全球 Ping
      if (cf.ping) {
        const pingFilter = cf.ping.toLowerCase();
        const pings = result.global_ping || [];
        const matchesPing = pings.some((p) =>
          String(p.name || "").toLowerCase().includes(pingFilter) ||
          String(p.code || "").toLowerCase().includes(pingFilter) ||
          String(p.elapsed_ms || "").includes(pingFilter) ||
          String(p.status || "").toLowerCase().includes(pingFilter)
        );
        if (!matchesPing) return false;
      }

      return true;
    })
    .sort((left, right) => compareResults(left, right, sortKey, sortDirection));
}
export { IPURE_SCORE_LABELS, statusLabels };

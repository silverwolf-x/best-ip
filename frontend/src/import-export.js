import { normalizeImportedResult, normalizeImportedStatus, parseImportedBoolean, parseImportedAsn, parseImportedNumber, parseImportedIpureScores, isRecord, formatAsn, formatIpureScores, statusLabels } from "./results.js";
export async function readImportText(file) {
  if (typeof file.arrayBuffer === "function") {
    const buffer = await file.arrayBuffer();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    return decoder.decode(buffer).replace(/^﻿/, "");
  }
  if (typeof file.text === "function") {
    return (await file.text()).replace(/^﻿/, "");
  }
  throw new Error("无法读取文件内容");
}

export function parseImportedJson(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("JSON 语法无效，请确认文件未损坏。");
  }
  if (!Array.isArray(payload) && !isRecord(payload)) {
    throw new Error("JSON 顶层必须是结果数组或导出结果对象。");
  }

  const manifest = isRecord(payload) && isRecord(payload.manifest) ? payload.manifest : null;
  const candidates = extractJsonResults(payload, manifest);
  if (!candidates.length) {
    throw new Error("JSON 中没有可导入的节点结果（需要 results 或 manifest.records）。");
  }
  const results = candidates.map((item, index) => normalizeImportedResult(item, index, "json"));
  const metadata = isRecord(payload) ? payload : {};
  return { results, manifest, metadata };
}

export function extractJsonResults(payload, manifest) {
  const container = isRecord(payload) ? payload : {};
  let source = Array.isArray(payload)
    ? payload
    : [container.results, container.scan_results, container.scan?.results, container.data?.results]
      .find((items) => Array.isArray(items) && items.length) || [];

  if (!source.length && Array.isArray(manifest?.records)) {
    source = manifest.records.map((entry) => {
      if (!isRecord(entry)) return entry;
      return isRecord(entry.summary) ? entry.summary : entry;
    });
  }
  if (!source.length && Array.isArray(container.details)) source = container.details;

  const rootDetails = container.details || container.scan_details || container.data?.details;
  return source.map((item, index) => {
    const base = unwrapJsonResult(item);
    const key = base.node_index ?? base.index ?? index;
    const external = unwrapJsonResult(findImportedDetail(rootDetails, key, base.node));
    return { ...base, ...external };
  });
}

export function unwrapJsonResult(value) {
  if (!isRecord(value)) return {};
  const nested = isRecord(value.result) ? value.result : isRecord(value.detail) ? value.detail : null;
  const summary = isRecord(value.summary) ? value.summary : null;
  if (!nested && !summary) return { ...value };
  const direct = { ...value };
  delete direct.result;
  delete direct.detail;
  delete direct.summary;
  delete direct.details;
  return { ...(summary || {}), ...direct, ...(nested || {}) };
}

export function findImportedDetail(details, key, node) {
  if (Array.isArray(details)) {
    return details.find((item, index) => {
      if (!isRecord(item)) return index === key;
      return (item.node_index ?? item.index ?? index) === key || (node && item.node === node);
    }) || {};
  }
  if (!isRecord(details)) return {};
  return details[String(key)] || details[key] || (node ? details[node] : {}) || {};
}

export function parseImportedCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error("CSV 至少需要一行表头和一行节点结果。");

  const headers = rows.shift().map((header, index) => {
    const value = String(header ?? "").replace(/^﻿/, "").trim();
    return value || `未命名列${index + 1}`;
  });
  const columns = mapCsvColumns(headers);
  if (columns.node < 0 || columns.known < 2) {
    throw new Error("CSV 表头无法识别，请使用本页面导出的 CSV 文件。");
  }

  const results = rows.map((row, rowIndex) => {
    const value = (key) => columns[key] >= 0 ? String(row[columns[key]] ?? "").trim() : "";
    const node = value("node");
    if (!node) throw new Error(`CSV 第 ${rowIndex + 2} 行缺少节点名称。`);

    const status = normalizeImportedStatus(value("status"), value("exit_ip"));
    const nativeStatus = value("native") || "未知";
    const securityStatus = value("security") || "";
    const asnRaw = value("asn");
    const isNative = /原生|native/i.test(nativeStatus) && !/非原生|广播|broadcast/i.test(nativeStatus)
      ? true
      : /广播|非原生|broadcast/i.test(nativeStatus) ? false : null;
    const isBogon = parseImportedBoolean(value("bogon"));

    // 解析导入的 GPT 字段
    const chatgptText = value("gpt_chatgpt");
    const codexText = value("gpt_codex");
    const gpt_check = [];
    if (chatgptText) {
      const match = chatgptText.match(/(\d+)\s*ms/i);
      const ms = match ? Number(match[1]) : -1;
      gpt_check.push({
        name: "chatgpt.com",
        status: ms >= 0 ? (ms < 250 ? "normal" : ms < 500 ? "good" : "slow") : "failed",
        text: ms >= 0 ? (ms < 250 ? "正常" : ms < 500 ? "良好" : "较慢") : chatgptText,
        elapsed_ms: ms,
        ok: ms >= 0,
      });
    }
    if (codexText) {
      const match = codexText.match(/(\d+)\s*ms/i);
      const ms = match ? Number(match[1]) : -1;
      gpt_check.push({
        name: "api.openai.com",
        status: ms >= 0 ? (ms < 250 ? "normal" : ms < 500 ? "good" : "slow") : "failed",
        text: ms >= 0 ? (ms < 250 ? "正常" : ms < 500 ? "良好" : "较慢") : codexText,
        elapsed_ms: ms,
        ok: ms >= 0,
      });
    }

    const result = {
      node,
      type: value("type") || "未知",
      status,
      exit_ip: value("exit_ip") || null,
      location: value("location") || "",
      isp: value("isp") || "",
      as_org: value("isp") || "",
      asn: parseImportedAsn(asnRaw),
      asn_kind_display: value("asn_kind"),
      native_status: nativeStatus,
      is_native: isNative,
      is_residential: /住宅/i.test(value("company_type") || "") || /住宅/i.test(nativeStatus),
      is_datacenter: /机房|托管/i.test(value("company_type") || "") || /机房|托管/i.test(value("asn_kind") || ""),
      is_bogon: isBogon,
      bogon_status: value("bogon") || (isBogon ? "是" : "否（公网可达）"),
      rpki_status: value("rpki") || "",
      rdns: value("rdns") || "-",
      company_type: value("company_type") || "未知",
      traffic_profile: value("traffic_profile") || "未知",
      security_status: securityStatus,
      abuse_level: value("abuse_level") || "",
      honeypot_status: value("honeypot_status") || "",
      score: parseImportedNumber(value("score")),
      ipure_scores: parseImportedIpureScores(value("ipure_scores"), value("score")),
      coffee_score: parseImportedNumber(value("coffee_score")),
      elapsed_ms: parseImportedNumber(value("elapsed_ms")) ?? 0,
      is_vpn: /vpn/i.test(securityStatus),
      is_proxy: /proxy|代理/i.test(securityStatus),
      is_tor: /tor/i.test(securityStatus),
      is_crawler: /爬虫/i.test(securityStatus) || /爬虫/i.test(value("traffic_profile") || ""),
      is_abuser: /滥用/i.test(securityStatus) || /滥用/i.test(value("abuse_level") || ""),
      gpt_check: gpt_check.length ? gpt_check : [],
      global_ping: [],
      node_index: rowIndex,
      _index: rowIndex,
      _source: "csv",
    };
    return normalizeImportedResult(result, rowIndex, "csv");
  });

  return { results, manifest: null, metadata: { source_format: "csv" } };
}

export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      if (next === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((item) => String(item ?? "").trim() !== ""));
}

export function mapCsvColumns(headers) {
  const aliases = {
    node: ["节点名称", "节点", "node", "name", "nodename"],
    type: ["协议", "节点类型", "type", "protocol"],
    status: ["状态", "status"],
    exit_ip: ["出口ip", "出口_ip", "ip", "exit_ip", "exitip"],
    location: ["位置", "归属地", "地理位置", "location", "geo"],
    isp: ["服务商/isp", "服务商", "isp", "运营商", "as_org", "asorganization"],
    asn: ["asn", "as号", "as"],
    asn_kind: ["asn自报类型", "自报类型", "asn_kind", "asn_kind_display"],
    native: ["ip原生性", "原生性", "native", "native_status", "is_native"],
    bogon: ["bogon", "bogon广播", "bogon_status", "is_bogon"],
    rpki: ["rpki", "rpki状态", "rpki_status"],
    rdns: ["反向dns", "rdns", "反向解析"],
    company_type: ["运营商类型", "场景", "company_type"],
    traffic_profile: ["人机流量", "人机画像", "traffic_profile"],
    security: ["安全状态", "安全/威胁指标", "安全指标", "threat", "security_status"],
    abuse_level: ["滥用等级", "abuse_level"],
    honeypot_status: ["蜜罐状态", "honeypot_status"],
    gpt_chatgpt: ["gpt_chatgpt", "chatgpt", "chatgpt.com"],
    gpt_codex: ["gpt_codex", "codex", "api.openai.com"],
    score: ["ipure总分", "总分", "评分", "score"],
    ipure_scores: ["ipure四项评分", "四项评分", "ipure_scores"],
    coffee_score: ["coffee评分", "coffee_score", "trustscore", "trust_score"],
    elapsed_ms: ["耗时(ms)", "耗时", "elapsed_ms", "duration"],
  };

  const normalized = headers.map(normalizeCsvHeader);
  const columns = { known: 0 };
  Object.entries(aliases).forEach(([key, list]) => {
    const indices = list.map(normalizeCsvHeader);
    columns[key] = normalized.findIndex((header) => indices.includes(header));
    if (columns[key] >= 0) columns.known += 1;
  });
  return columns;
}

export function normalizeCsvHeader(value) {
  return String(value ?? "").replace(/[\s﻿]/g, "").toLocaleLowerCase("en-US");
}

export function cloneImportedForExport(result) {
  return JSON.parse(JSON.stringify(result, (key, value) => {
    if (key === "_index" || key === "_source") return undefined;
    return value;
  }));
}
export function csv(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

export function downloadBlob(content, filename, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
export function buildCsvExport(results) {
  const headers = ["节点名称", "协议", "状态", "出口IP", "位置", "服务商/ISP", "ASN", "ASN自报类型", "IP原生性", "Bogon", "RPKI", "反向DNS", "运营商类型", "人机流量", "安全状态", "滥用等级", "蜜罐状态", "GPT_ChatGPT", "GPT_Codex", "IPure总分", "IPure四项评分", "Coffee评分", "耗时(ms)"];
  const rows = results.map((result) => {
    const gptList = result.gpt_check || [];
    const chatgptItem = gptList.find((g) => g.name === "chatgpt.com");
    const codexItem = gptList.find((g) => g.name === "api.openai.com");
    return [
      csv(result.node),
      csv(result.type),
      csv(statusLabels[result.status] || result.status),
      csv(result.exit_ip || ""),
      csv(result.location || ""),
      csv(result.isp || result.as_org || ""),
      csv(formatAsn(result.asn)),
      csv(result.asn_kind_display || ""),
      csv(result.native_status || (result.is_native === true ? "原生" : result.is_native === false ? "广播" : "未知")),
      csv(result.bogon_status || (result.is_bogon ? "是" : "否")),
      csv(result.rpki_status || ""),
      csv(result.rdns || ""),
      csv(result.company_type || ""),
      csv(result.traffic_profile || ""),
      csv(result.security_status || ""),
      csv(result.abuse_level || ""),
      csv(result.honeypot_status || ""),
      csv(chatgptItem ? `${chatgptItem.text || ""}${chatgptItem.elapsed_ms >= 0 ? ` ${chatgptItem.elapsed_ms}ms` : ""}` : ""),
      csv(codexItem ? `${codexItem.text || ""}${codexItem.elapsed_ms >= 0 ? ` ${codexItem.elapsed_ms}ms` : ""}` : ""),
      result.score ?? "",
      csv(formatIpureScores(result.ipure_scores)),
      result.coffee_score ?? "",
      result.elapsed_ms ?? "",
    ];
  });
  return "﻿" + [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
}
export function buildJsonExport(state) {
  if (!state.imported) return { ...state.job, results: state.results.map(cloneImportedForExport) };
  const data = {
    id: state.job.id,
    status: "completed",
    message: state.job.message,
    created_at: state.job.created_at,
    finished_at: state.job.finished_at,
    total: state.results.length,
    skipped: 0,
    completed: state.results.length,
    success_count: state.job.success_count,
    partial_count: state.job.partial_count,
    failed_count: state.job.failed_count,
    current_node: null,
    manifest_ready: true,
    cleanup_confirmed: state.job.cleanup_confirmed === true,
    execution_mode: state.job.execution_mode,
    error: null,
    import_source: state.importSource,
    results: state.results.map((result) => cloneImportedForExport(result)),
  };
  if (isRecord(state.job.manifest)) data.manifest = state.job.manifest;
  return data;
}

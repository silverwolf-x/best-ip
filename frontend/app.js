const configuredApiBase = document.querySelector('meta[name="api-base"]')?.content?.replace(/\/$/, "") || "";

const state = {
  job: null,
  results: [],
  imported: false,
  importSource: "",
  sortKey: "score",
  sortDirection: "desc",
  pollTimer: null,
  pollGeneration: 0,
  activeDetailResult: null,
  detailGeneration: 0,
  columnFilters: {
    node: "",
    score: "",
    status: "",
    exit_ip: "",
    isp: "",
    native: "",
    security: "",
    gpt: "",
    ping: "",
  },
};

const elements = {
  form: document.querySelector("#scanForm"),
  subscriptionUrl: document.querySelector("#subscriptionUrl"),
  revealButton: document.querySelector("#revealButton"),
  startButton: document.querySelector("#startButton"),
  cancelButton: document.querySelector("#cancelButton"),
  healthStatus: document.querySelector("#healthStatus"),
  themeButton: document.querySelector("#themeButton"),
  scanStatusBadge: document.querySelector("#scanStatusBadge"),
  scanStatusText: document.querySelector("#scanStatusText"),
  scanProgressCount: document.querySelector("#scanProgressCount"),
  errorMessage: document.querySelector("#errorMessage"),
  totalStat: document.querySelector("#totalStat"),
  completedStat: document.querySelector("#completedStat"),
  successStat: document.querySelector("#successStat"),
  issueStat: document.querySelector("#issueStat"),
  resultSearch: document.querySelector("#resultSearch"),
  statusFilter: document.querySelector("#statusFilter"),
  exportCsvBtn: document.querySelector("#exportCsvBtn"),
  exportJsonBtn: document.querySelector("#exportJsonBtn"),
  importResultsBtn: document.querySelector("#importResultsBtn"),
  importFileInput: document.querySelector("#importFileInput"),
  resultsToolbar: document.querySelector("#resultsToolbar"),
  resultBody: document.querySelector("#resultBody"),
  emptyResults: document.querySelector("#emptyResults"),
  detailDialog: document.querySelector("#detailDialog"),
  detailTitle: document.querySelector("#detailTitle"),
  detailSubtitle: document.querySelector("#detailSubtitle"),
  detailContent: document.querySelector("#detailContent"),
  copyJsonBtn: document.querySelector("#copyJsonBtn"),
  closeDialog: document.querySelector("#closeDialog"),
};

const statusLabels = { success: "完整", partial: "部分", failed: "失败" };

function apiUrl(path) {
  return `${configuredApiBase}${path}`;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("best-ip-theme", theme);
  elements.themeButton.title = theme === "dark" ? "浅色模式" : "暗黑模式";
}

applyTheme(localStorage.getItem("best-ip-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
elements.themeButton.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

elements.revealButton.addEventListener("click", () => {
  const revealing = elements.subscriptionUrl.type === "password";
  elements.subscriptionUrl.type = revealing ? "url" : "password";
  elements.revealButton.textContent = revealing ? "🔒" : "👁️";
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const subscriptionUrl = elements.subscriptionUrl.value.trim();
  if (!subscriptionUrl) return;
  clearTimeout(state.pollTimer);
  const generation = ++state.pollGeneration;
  state.job = null;
  state.results = [];
  state.imported = false;
  state.importSource = "";
  state.activeDetailResult = null;
  state.detailGeneration += 1;
  if (elements.detailDialog.open) elements.detailDialog.close();
  setScanning(true);
  showError("");
  elements.scanStatusBadge.hidden = false;
  elements.scanStatusText.textContent = "创建任务";
  elements.scanProgressCount.textContent = "0/0";
  renderRows();

  try {
    const response = await fetch(apiUrl("/api/scans"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription_url: subscriptionUrl }),
    });
    const created = await readResponse(response);
    state.job = created;
    await pollJob(created.id, generation);
  } catch (error) {
    if (generation === state.pollGeneration) showFatalError(error.message);
  }
});

elements.cancelButton.addEventListener("click", async () => {
  if (!state.job?.id) return;
  elements.cancelButton.disabled = true;
  try {
    const response = await fetch(apiUrl(`/api/scans/${state.job.id}`), { method: "DELETE" });
    state.job = await readResponse(response);
    renderProgress(state.job);
    setScanning(false);
  } catch (error) {
    elements.cancelButton.disabled = false;
    showInlineError(`停止失败：${error.message}`);
  }
});

elements.importResultsBtn.addEventListener("click", () => elements.importFileInput.click());
elements.importFileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  event.target.value = "";
  if (file) await importResultsFile(file);
});

["dragenter", "dragover"].forEach((eventName) => {
  elements.resultsToolbar?.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    elements.resultsToolbar.classList.add("import-drag-active");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  elements.resultsToolbar?.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    elements.resultsToolbar.classList.remove("import-drag-active");
  });
});
elements.resultsToolbar?.addEventListener("drop", async (event) => {
  const [file] = event.dataTransfer?.files || [];
  if (file) await importResultsFile(file);
});

elements.resultSearch.addEventListener("input", renderRows);
elements.statusFilter.addEventListener("change", renderRows);

document.querySelectorAll(".th-filter").forEach((input) => {
  const col = input.dataset.col;
  if (!col) return;
  const eventName = input.tagName === "SELECT" ? "change" : "input";
  input.addEventListener(eventName, (e) => {
    state.columnFilters[col] = e.target.value.trim();
    renderRows();
  });
});

elements.closeDialog.addEventListener("click", () => elements.detailDialog.close());
elements.detailDialog.addEventListener("close", () => {
  state.detailGeneration += 1;
  state.activeDetailResult = null;
});
elements.detailDialog.addEventListener("click", (event) => {
  if (event.target === elements.detailDialog) elements.detailDialog.close();
});
elements.copyJsonBtn.addEventListener("click", async () => {
  if (!state.activeDetailResult) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.activeDetailResult, null, 2));
    elements.copyJsonBtn.textContent = "已复制";
    setTimeout(() => { elements.copyJsonBtn.textContent = "复制 JSON"; }, 2000);
  } catch {
    alert("复制失败，请手动选择复制。");
  }
});

elements.exportCsvBtn.addEventListener("click", () => {
  if (!canExportResults()) return;
  const headers = ["节点名称", "协议", "状态", "出口IP", "位置", "服务商/ISP", "ASN", "ASN自报类型", "IP原生性", "Bogon", "RPKI", "反向DNS", "运营商类型", "人机流量", "安全状态", "滥用等级", "蜜罐状态", "GPT_ChatGPT", "GPT_Codex", "评分", "耗时(ms)"];
  const rows = state.results.map((result) => {
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
      csv(result.asn ? `AS${result.asn}` : ""),
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
      result.elapsed_ms ?? "",
    ];
  });
  downloadBlob("﻿" + [headers.join(","), ...rows.map((row) => row.join(","))].join("\n"), `best-ip-results-${dateStamp()}.csv`, "text/csv;charset=utf-8;");
});

elements.exportJsonBtn.addEventListener("click", async () => {
  if (!canExportResults()) return;
  if (state.imported) {
    try {
      downloadBlob(
        JSON.stringify(buildImportedJsonExport(), null, 2),
        `best-ip-results-${dateStamp()}.json`,
        "application/json;charset=utf-8;",
      );
    } catch (error) {
      showInlineError(`导出 JSON 失败：${error.message}`);
    }
    return;
  }

  elements.exportJsonBtn.disabled = true;
  try {
    const response = await fetch(apiUrl(`/api/scans/${state.job.id}/export`), { cache: "no-store" });
    const data = await readResponse(response);
    downloadBlob(JSON.stringify(data, null, 2), `best-ip-results-${dateStamp()}.json`, "application/json");
  } catch (error) {
    showInlineError(`导出 JSON 失败：${error.message}`);
  } finally {
    setScanning(false);
  }
});

function csv(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function downloadBlob(content, filename, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importResultsFile(file) {
  const filename = String(file?.name || "").trim();
  const extension = filename.toLocaleLowerCase("en-US").split(".").pop();
  if (!filename || !["json", "csv"].includes(extension)) {
    showInlineError("导入失败：请选择之前导出的 .json 或 .csv 文件。");
    return;
  }

  try {
    const text = await readImportText(file);
    const parsed = extension === "json" ? parseImportedJson(text) : parseImportedCsv(text);
    applyImportedResults(parsed, extension, filename);
  } catch (error) {
    showInlineError(`导入失败：${error.message || "文件格式无法识别"}`);
  }
}

async function readImportText(file) {
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

function parseImportedJson(text) {
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

function extractJsonResults(payload, manifest) {
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

function unwrapJsonResult(value) {
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

function findImportedDetail(details, key, node) {
  if (Array.isArray(details)) {
    return details.find((item, index) => {
      if (!isRecord(item)) return index === key;
      return (item.node_index ?? item.index ?? index) === key || (node && item.node === node);
    }) || {};
  }
  if (!isRecord(details)) return {};
  return details[String(key)] || details[key] || (node ? details[node] : {}) || {};
}

function parseImportedCsv(text) {
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

function parseCsvRows(text) {
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

function mapCsvColumns(headers) {
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
    score: ["评分", "trustscore", "score", "trust_score"],
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

function normalizeCsvHeader(value) {
  return String(value ?? "").replace(/[\s﻿]/g, "").toLocaleLowerCase("en-US");
}

function normalizeImportedResult(raw, index, source) {
  if (!isRecord(raw)) throw new Error(`第 ${index + 1} 个节点结果不是对象。`);
  const result = { ...raw };
  result.node = firstImportedValue(raw.node, raw.node_name, raw.name);
  if (!result.node) throw new Error(`第 ${index + 1} 个节点结果缺少节点名称。`);
  result.type = firstImportedValue(raw.type, raw.protocol) || "未知";
  result.status = normalizeImportedStatus(raw.status, raw.exit_ip);
  result._index = raw.node_index ?? raw.index ?? index;
  result.node_index = raw.node_index ?? result._index;
  result._source = source;
  if (result.score !== null && result.score !== undefined && result.score !== "") {
    result.score = parseImportedNumber(result.score);
  }
  if (result.elapsed_ms !== null && result.elapsed_ms !== undefined && result.elapsed_ms !== "") {
    result.elapsed_ms = parseImportedNumber(result.elapsed_ms) ?? 0;
  }
  if (!Array.isArray(result.global_ping)) result.global_ping = [];
  if (!Array.isArray(result.gpt_check)) result.gpt_check = [];
  return result;
}

function normalizeImportedStatus(value, exitIp) {
  const status = String(value ?? "").trim().toLocaleLowerCase("zh-CN");
  if (["success", "completed", "complete", "成功", "完整"].includes(status)) return "success";
  if (["partial", "部分", "partially_complete"].includes(status)) return "partial";
  if (["failed", "failure", "error", "失败"].includes(status)) return "failed";
  return exitIp ? "partial" : "failed";
}

function parseImportedBoolean(value) {
  const normalized = String(value ?? "").trim().toLocaleLowerCase("zh-CN");
  if (["是", "yes", "true", "1", "bogon"].includes(normalized)) return true;
  if (["否", "no", "false", "0", "公网可达", "public"].includes(normalized)) return false;
  return Boolean(normalized && !["未知", "unknown", "-"].includes(normalized));
}

function parseImportedAsn(value) {
  const normalized = String(value ?? "").trim().replace(/^AS/i, "");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : normalized;
}

function parseImportedNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function firstImportedValue(...values) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim() !== "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function applyImportedResults(parsed, source, filename) {
  clearTimeout(state.pollTimer);
  state.pollGeneration += 1;
  state.detailGeneration += 1;
  state.activeDetailResult = null;
  if (elements.detailDialog.open) elements.detailDialog.close();

  const results = parsed.results;
  const counts = results.reduce((summary, result) => {
    if (result.status === "success") summary.success += 1;
    else if (result.status === "partial") summary.partial += 1;
    else summary.failed += 1;
    return summary;
  }, { success: 0, partial: 0, failed: 0 });
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
  const manifest = isRecord(parsed.manifest) ? parsed.manifest : null;
  state.imported = true;
  state.importSource = source;
  state.results = results;
  state.job = {
    id: `imported-${Date.now()}`,
    status: "completed",
    message: `已导入 ${filename}`,
    created_at: metadata.created_at || manifest?.created_at || null,
    finished_at: metadata.finished_at || manifest?.finished_at || null,
    total: results.length,
    skipped: 0,
    completed: results.length,
    success_count: counts.success,
    partial_count: counts.partial,
    failed_count: counts.failed,
    current_node: null,
    manifest_ready: true,
    cleanup_confirmed: true,
    execution_mode: metadata.execution_mode || manifest?.execution_mode || "imported",
    error: null,
    results,
    manifest,
    imported: true,
    import_source: source,
  };
  renderProgress(state.job);
  setScanning(false);
  elements.scanStatusBadge.hidden = false;
  elements.scanStatusText.textContent = `已导入结果（${results.length}个节点）`;
  elements.scanProgressCount.textContent = `${results.length}/${results.length}`;
  showError("");
  renderRows();
}

function canExportResults() {
  return Boolean(state.results.length && state.job?.status === "completed" && state.job?.manifest_ready);
}

function buildImportedJsonExport() {
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
    cleanup_confirmed: true,
    execution_mode: state.job.execution_mode,
    error: null,
    import_source: state.importSource,
    results: state.results.map((result) => cloneImportedForExport(result)),
  };
  if (isRecord(state.job.manifest)) data.manifest = state.job.manifest;
  return data;
}

function cloneImportedForExport(result) {
  return JSON.parse(JSON.stringify(result, (key, value) => {
    if (key === "_index" || key === "_source") return undefined;
    return value;
  }));
}

async function pollJob(jobId, generation) {
  if (!jobId || generation !== state.pollGeneration) return;
  try {
    const response = await fetch(apiUrl(`/api/scans/${jobId}`), { cache: "no-store" });
    const job = await readResponse(response);
    if (generation !== state.pollGeneration) return;
    state.job = job;
    renderProgress(job);
    state.results = Array.isArray(job.results)
      ? job.results.map((item, index) => ({ ...item, _index: item.node_index ?? index }))
      : [];
    renderRows();
    if (job.status === "completed" && job.manifest_ready) {
      setScanning(false);
      return;
    }
    if (["failed", "cancelled"].includes(job.status)) {
      setScanning(false);
      return;
    }
    state.pollTimer = setTimeout(() => pollJob(jobId, generation), 1000);
  } catch (error) {
    if (generation !== state.pollGeneration) return;
    showInlineError(`读取进度失败，重试中：${error.message}`);
    state.pollTimer = setTimeout(() => pollJob(jobId, generation), 2000);
  }
}

function renderProgress(job) {
  const total = Number(job.total || 0);
  const completed = Number(job.completed || 0);
  elements.scanProgressCount.textContent = `${completed}/${total}`;
  elements.scanStatusText.textContent = job.status === "running" && job.current_node
    ? `检测中 · ${job.current_node}`
    : jobTitle(job.status);
  elements.totalStat.textContent = String(total);
  elements.completedStat.textContent = String(completed);
  elements.successStat.textContent = String(job.success_count || 0);
  elements.issueStat.textContent = String((job.partial_count || 0) + (job.failed_count || 0));
  showError(job.error || "");
}

function renderRows() {
  const query = elements.resultSearch.value.trim().toLocaleLowerCase("zh-CN");
  const globalStatus = elements.statusFilter.value;
  const cf = state.columnFilters;

  const rows = state.results
    .filter((result) => globalStatus === "all" || result.status === globalStatus)
    .filter((result) => {
      // 顶部全局搜索框
      if (query) {
        const matchesGlobal = [
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
          result.gpt_check?.map((g) => `${g.name || ""} ${g.text || ""} ${g.elapsed_ms ?? ""}ms`).join(" "),
          result.global_ping?.map((ping) => `${ping.name || ""} ${ping.code || ""} ${ping.elapsed_ms ?? ""} ${ping.status || ""}`).join(" "),
          result.asn ? `AS${result.asn}` : "",
          result.asn_kind_display,
          result.native_status,
          result._importedFields ? Object.values(result._importedFields).join(" ") : "",
        ].some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(query));
        if (!matchesGlobal) return false;
      }

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
    .sort(compareResults);

  const fragment = document.createDocumentFragment();
  rows.forEach((result) => fragment.append(createResultRow(result)));
  elements.resultBody.replaceChildren(fragment);
  elements.emptyResults.hidden = rows.length > 0;
  const emptyTitle = elements.emptyResults.querySelector(".empty-title");
  const emptyDesc = elements.emptyResults.querySelector(".empty-desc");
  if (state.results.length && !rows.length) {
    emptyTitle.textContent = "没有匹配的节点";
    emptyDesc.textContent = "请调整搜索条件或列筛选。";
  } else if (state.imported) {
    emptyTitle.textContent = "导入结果为空";
    emptyDesc.textContent = "请选择包含节点结果的 JSON 或 CSV 文件。";
  } else {
    emptyTitle.textContent = "等待首个节点结果";
    emptyDesc.textContent = "每个节点完成并原子暂存后会立即显示；全部节点结束后生成最终 manifest，并开放详情与导出。";
  }
}

function createResultRow(result) {
  const row = document.createElement("tr");

  // 1. 节点名称（自适应宽度）
  appendTextCell(row, "", (cell) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "node-name-btn";
    button.textContent = result.node || "未命名";
    button.title = `${result.node || "未命名"} (${result.type || "未知"}) - 点击查看完整画像`;
    button.addEventListener("click", () => openDetails(result));
    cell.replaceChildren(button);
  });

  // 2. 评分 (第2列，默认降序排)
  appendTextCell(row, "", (cell) => {
    if (result.score == null) {
      cell.innerHTML = '<span class="score-pill score-none">—</span>';
    } else {
      const score = Number(result.score);
      const scoreCls = score >= 75 ? "score-great" : score >= 45 ? "score-good" : "score-bad";
      cell.innerHTML = `<span class="score-pill ${scoreCls}">${score}</span>`;
    }
  });

  // 3. 状态
  appendTextCell(row, "", (cell) => {
    const badge = document.createElement("span");
    badge.className = `status-badge ${result.status || "failed"}`;
    badge.textContent = statusLabels[result.status] || result.status || "失败";
    if (result.error) {
      badge.title = result.error;
    }
    cell.replaceChildren(badge);
  });

  // 4. 出口 IP
  appendTextCell(row, "", (cell) => {
    if (result.exit_ip) {
      const ipWrap = document.createElement("div");
      ipWrap.className = "ip-cell";
      const code = document.createElement("code");
      code.textContent = result.exit_ip;
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "mini-copy";
      copyBtn.textContent = "复制";
      copyBtn.title = "复制出口 IP";
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(result.exit_ip);
          copyBtn.textContent = "已复制";
          setTimeout(() => { copyBtn.textContent = "复制"; }, 1500);
        } catch {
          alert("复制失败");
        }
      });
      ipWrap.append(code, copyBtn);
      cell.replaceChildren(ipWrap);
    } else {
      cell.innerHTML = '<span class="failure-reason">' + escapeHtml(result.error || "连接失败") + '</span>';
    }
  });

  // 5. 服务商 / ISP（药丸胶囊风格，严格左对齐并展示完整信息）
  appendTextCell(row, "", (cell) => {
    const ispText = result.isp || result.as_org || "";
    if (ispText) {
      const span = document.createElement("span");
      span.className = "chip chip-isp";
      span.textContent = ispText;
      span.title = ispText;
      cell.replaceChildren(span);
    } else {
      cell.textContent = "—";
    }
  });

  // 6. ASN / 原生性 / 运营商类型 / 人机流量（全部药丸形状）
  appendTextCell(row, "", (cell) => {
    if (result.status === "failed" && !result.asn && !result.is_native && !result.company_type) {
      cell.textContent = "—";
      return;
    }
    const container = document.createElement("div");
    container.className = "tag-chips";

    // ASN 药丸
    if (result.asn) {
      const asnChip = document.createElement("span");
      asnChip.className = "chip chip-asn";
      asnChip.textContent = `AS${result.asn}`;
      if (result.asn_kind_display && result.asn_kind_display !== "未知") {
        asnChip.title = `自报类型: ${result.asn_kind_display}`;
      }
      container.append(asnChip);
    }

    // IP 原生性 药丸
    if (result.native_status && result.native_status !== "未知") {
      const natChip = document.createElement("span");
      const isNative = result.is_native === true;
      natChip.className = `chip ${isNative ? "chip-ok" : "chip-warn"}`;
      natChip.textContent = result.native_status;
      if (result.native_detail) {
        natChip.title = result.native_detail;
      }
      container.append(natChip);
    }

    // 运营商类型 药丸 (原生性标记人机流量等全做成药丸)
    if (result.company_type && result.company_type !== "未知") {
      const compChip = document.createElement("span");
      compChip.className = `chip ${result.is_residential ? "chip-ok" : "chip-info"}`;
      compChip.textContent = result.company_type;
      container.append(compChip);
    }

    // 人机流量 药丸
    if (result.traffic_profile && result.traffic_profile !== "未知") {
      const trafChip = document.createElement("span");
      const isHuman = result.traffic_profile.includes("人类");
      const isBad = result.traffic_profile.includes("爬虫") || result.traffic_profile.includes("机器");
      trafChip.className = `chip ${isHuman ? "chip-ok" : isBad ? "chip-warn" : "chip-asn"}`;
      trafChip.textContent = result.traffic_profile;
      container.append(trafChip);
    }

    cell.replaceChildren(container.children.length ? container : document.createTextNode("—"));
  });

  // 7. 安全 / 威胁指标（药丸）
  appendTextCell(row, "", (cell) => {
    if (result.status === "failed") {
      cell.textContent = "—";
      return;
    }
    const container = document.createElement("div");
    container.className = "tag-chips";

    const riskFlags = [];
    if (result.is_vpn) riskFlags.push({ label: "VPN", cls: "chip-warn" });
    if (result.is_proxy) riskFlags.push({ label: "Proxy", cls: "chip-warn" });
    if (result.is_tor) riskFlags.push({ label: "Tor", cls: "chip-bad" });
    if (result.is_crawler) riskFlags.push({ label: "爬虫", cls: "chip-info" });
    if (result.is_abuser) riskFlags.push({ label: "历史滥用", cls: "chip-bad" });

    if (riskFlags.length > 0) {
      riskFlags.forEach((item) => {
        const span = document.createElement("span");
        span.className = `chip ${item.cls}`;
        span.textContent = item.label;
        container.append(span);
      });
    } else {
      const cleanChip = document.createElement("span");
      cleanChip.className = "chip chip-ok";
      cleanChip.textContent = "🛡️ 纯净 (无威胁)";
      container.append(cleanChip);
    }

    if (result.abuse_level && result.abuse_level !== "纯净" && result.abuse_level !== "未知") {
      const abuseChip = document.createElement("span");
      abuseChip.className = "chip chip-warn";
      abuseChip.textContent = `滥用: ${result.abuse_level}`;
      container.append(abuseChip);
    }

    cell.replaceChildren(container);
  });

  // 8. GPT · Codex 延迟检测 (与 Coffee 全球 Ping 微型条完全一致的高审美延迟条)
  appendTextCell(row, "", (cell) => {
    cell.replaceChildren(createMiniGptBar(result.gpt_check));
  });

  // 9. Coffee 全球 Ping
  appendTextCell(row, "", (cell) => {
    cell.replaceChildren(createMiniPingBar(result.global_ping));
  });

  // 10. 耗时
  appendTextCell(row, result.elapsed_ms ? `${(result.elapsed_ms / 1000).toFixed(1)}s` : "—");

  return row;
}

// 构建 GPT · Codex 延迟条（与 Coffee 全球 Ping 一致）
function createMiniGptBar(gptChecks) {
  if (!Array.isArray(gptChecks) || !gptChecks.length) {
    const span = document.createElement("span");
    span.className = "p-timeout p-gray";
    span.textContent = "-1ms";
    return span;
  }
  const bar = document.createElement("div");
  bar.className = "mini-gpt-bar";
  gptChecks.forEach((item) => {
    const node = document.createElement("span");
    node.className = "mini-gpt-node";
    const name = String(item.name || "").toLowerCase();
    const shortLabel = name.includes("api.openai") ? "Codex" : "ChatGPT";
    const ms = typeof item.elapsed_ms === "number" ? item.elapsed_ms : -1;
    const isRestricted = item.status === "restricted";

    if (item.ok && ms >= 0) {
      const speedCls = ms < 250 ? "p-fast" : ms < 500 ? "p-mid" : "p-slow";
      node.classList.add(speedCls);
      node.innerHTML = `<span class="p-dot"></span><span class="p-code">${escapeHtml(shortLabel)}</span><span class="p-ms">${ms}ms</span>`;
      node.title = `${item.name}: 正常 ${ms}ms`;
    } else if (isRestricted) {
      node.classList.add("node-restricted");
      node.innerHTML = `<span class="p-dot"></span><span class="p-code">${escapeHtml(shortLabel)}</span><span class="p-ms">受限</span>`;
      node.title = `${item.name}: 受限地区不可访问`;
    } else {
      node.classList.add("node-timeout");
      node.innerHTML = `<span class="p-dot"></span><span class="p-code">${escapeHtml(shortLabel)}</span><span class="p-ms p-timeout">-1ms</span>`;
      node.title = `${item.name}: ${item.text || "不可访问 (-1ms)"}`;
    }
    bar.append(node);
  });
  return bar;
}

function createMiniPingBar(pings) {
  if (!Array.isArray(pings) || !pings.length) {
    const span = document.createElement("span");
    span.className = "p-timeout p-gray";
    span.textContent = "-1ms";
    return span;
  }
  const bar = document.createElement("div");
  bar.className = "mini-ping-bar";
  pings.forEach((ping) => {
    const node = document.createElement("span");
    node.className = "mini-ping-node";
    const code = String(ping.code || "").toUpperCase();
    const ms = typeof ping.elapsed_ms === "number" ? ping.elapsed_ms : -1;
    if (ping.ok && ms >= 0) {
      const speedCls = ms < 80 ? "p-fast" : ms < 200 ? "p-mid" : "p-slow";
      node.classList.add(speedCls);
      node.innerHTML = `<span class="p-dot"></span><span class="p-code">${escapeHtml(code)}</span><span class="p-ms">${ms}ms</span>`;
      node.title = `${ping.name || code}: ${ms}ms`;
    } else {
      node.classList.add("node-timeout");
      node.innerHTML = `<span class="p-dot p-dot-gray"></span><span class="p-code">${escapeHtml(code)}</span><span class="p-ms p-timeout p-gray">-1ms</span>`;
      node.title = `${ping.name || code}: ${ping.status || "未检测/超时 (-1ms)"}`;
    }
    bar.append(node);
  });
  return bar;
}

function appendTextCell(row, text, configure) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (configure) configure(cell);
  row.append(cell);
}

function compareResults(left, right) {
  const direction = state.sortDirection === "asc" ? 1 : -1;
  const leftValue = left[state.sortKey];
  const rightValue = right[state.sortKey];
  if (typeof leftValue === "number" || typeof rightValue === "number") return ((leftValue ?? -1) - (rightValue ?? -1)) * direction;
  return String(leftValue || "").localeCompare(String(rightValue || ""), "zh-CN", { numeric: true, sensitivity: "base" }) * direction;
}

document.querySelectorAll(".sort-btn").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.sort;
    if (state.sortKey === key) {
      state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDirection = key === "node" || key === "location" ? "asc" : "desc";
    }
    document.querySelectorAll(".sort-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.sort === state.sortKey);
      btn.classList.toggle("asc", btn.dataset.sort === state.sortKey && state.sortDirection === "asc");
    });
    renderRows();
  });
});

async function openDetails(summary) {
  if (state.imported) {
    state.detailGeneration += 1;
    state.activeDetailResult = summary;
    elements.detailTitle.textContent = `${summary.node || "节点"} (${summary.type || "未知"})`;
    elements.detailSubtitle.textContent = `已导入 ${state.importSource.toUpperCase()} · 出口：${summary.exit_ip || "未知"} · ${summary.location || "位置未知"}`;
    renderDetails(summary);
    elements.detailDialog.showModal();
    return;
  }
  if (state.job?.status !== "completed" || !state.job.manifest_ready) {
    showInlineError("完整 manifest 生成后才能读取节点详情");
    return;
  }
  const generation = ++state.detailGeneration;
  elements.detailTitle.textContent = `${summary.node || "节点"} (${summary.type || "未知"})`;
  elements.detailSubtitle.textContent = `出口：${summary.exit_ip || "未知"} · ${summary.location || "位置未知"}`;
  elements.detailContent.innerHTML = '<p class="text-muted">正在读取已暂存的完整 Coffee 结果...</p>';
  elements.detailDialog.showModal();
  try {
    const response = await fetch(apiUrl(`/api/scans/${state.job.id}/results/${summary._index}`), { cache: "no-store" });
    const result = await readResponse(response);
    if (generation !== state.detailGeneration) return;
    state.activeDetailResult = result;
    renderDetails(result);
  } catch (error) {
    if (generation === state.detailGeneration) elements.detailContent.innerHTML = `<p class="error-box">读取详情失败：${escapeHtml(error.message)}</p>`;
  }
}

function renderDetails(result) {
  const lookup = result.coffee?.lookup || {};
  const intel = lookup.intelligence || {};
  const pings = result.global_ping || [];
  const gpts = result.gpt_check || [];
  const ports = result.coffee?.port_scan?.ports || result.port_scan || {};

  const content = document.createDocumentFragment();

  // 1. 顶部评分与核心概要大卡片
  const headSection = document.createElement("section");
  headSection.className = "merged-card-section";
  const scoreVal = result.score != null ? Number(result.score) : null;
  const scoreBadgeCls = scoreVal == null ? "score-none" : scoreVal >= 75 ? "score-great" : scoreVal >= 45 ? "score-good" : "score-bad";

  headSection.innerHTML = `
    <div class="modal-hero">
      <div class="modal-hero-main">
        <div class="modal-ip-title">
          <code>${escapeHtml(result.exit_ip || "—")}</code>
          <span class="modal-loc-text">${escapeHtml(result.location || "未知位置")} · ${escapeHtml(result.as_org || "未知服务商")}</span>
        </div>
        <div class="modal-tag-row">
          <span class="chip ${result.is_residential ? "chip-ok" : "chip-warn"}">${result.is_residential ? "家庭住宅IP" : "机房/托管IP"}</span>
          <span class="chip ${result.is_native === true ? "chip-ok" : result.is_native === false ? "chip-warn" : "chip-asn"}">${escapeHtml(result.native_status || "原生性未知")}</span>
          <span class="chip chip-asn">AS${escapeHtml(String(result.asn || "—"))} ${escapeHtml(result.asn_kind_display || "")}</span>
          <span class="chip ${result.is_bogon ? "chip-bad" : "chip-ok"}">${result.is_bogon ? "Bogon 广播" : "公网可达"}</span>
          <span class="chip ${String(result.rpki_status || "").includes("Valid") ? "chip-ok" : "chip-bad"}">RPKI: ${escapeHtml(result.rpki_status || "未知")}</span>
        </div>
      </div>
      <div class="modal-score-box ${scoreBadgeCls}">
        <span class="modal-score-lbl">IP 评分</span>
        <strong class="modal-score-num">${scoreVal != null ? scoreVal : "—"}</strong>
      </div>
    </div>
  `;
  content.append(headSection);

  // 2. 网络属性与 ASN 详表
  const gridSection = document.createElement("div");
  gridSection.className = "detail-grid-layout";

  // 左侧卡片：使用场景与网络属性
  const typeCard = document.createElement("div");
  typeCard.className = "card sub-card";
  typeCard.innerHTML = `
    <h3>使用场景 / 类型</h3>
    <div class="kv"><span class="k">IP 原生性</span><span class="v"><span class="chip ${result.is_native === true ? "chip-ok" : result.is_native === false ? "chip-warn" : "chip-asn"}">${escapeHtml(result.native_status || "未知")}</span><span class="tip-wrap">ⓘ<span class="tip-text">${escapeHtml(result.native_detail || "比较 IP 注册地与实际归属地")}</span></span></span></div>
    <div class="kv"><span class="k">标记</span><span class="v">${renderDetailFlags(result)}</span></div>
    <div class="kv"><span class="k">运营商类型</span><span class="v"><strong>${escapeHtml(result.company_type || "未知")}</strong></span></div>
    <div class="kv"><span class="k">人机流量</span><span class="v">${escapeHtml(result.traffic_profile || "未知")}</span></div>
    <div class="kv"><span class="k">服务商 / ISP</span><span class="v" title="${escapeHtml(result.as_org || "—")}"><span class="cell-truncate">${escapeHtml(result.as_org || "—")}</span></span></div>
  `;

  // 右侧卡片：技术指标 (Bogon / rDNS / 端口)
  const sysCard = document.createElement("div");
  sysCard.className = "card sub-card";
  sysCard.innerHTML = `
    <h3>技术指标</h3>
    <div class="kv"><span class="k">Bogon / 广播<span class="tip-wrap">ⓘ<span class="tip-text">Bogon 指不应出现在公网路由上的 IP。公网 IP 显示否（公网可达）即可。</span></span></span><span class="v"><span class="chip ${result.is_bogon ? "chip-bad" : "chip-ok"}">${result.is_bogon ? "是" : "否（公网可达）"}</span></span></div>
    <div class="kv"><span class="k">反向 DNS</span><span class="v" title="${escapeHtml(result.rdns || "-")}"><span class="cell-truncate">${escapeHtml(result.rdns || "-")}</span></span></div>
    <div class="kv"><span class="k">开放端口<span class="tip-wrap">ⓘ<span class="tip-text">常见端口探测结果</span></span></span><span class="v">${renderOpenPortsHtml(ports)}</span></div>
    <div class="kv"><span class="k">RPKI 状态<span class="tip-wrap">ⓘ<span class="tip-text">RPKI 是 BGP 路由起源验证机制，Valid 表示路由合法。</span></span></span><span class="v"><span class="chip ${String(result.rpki_status || "").includes("Valid") ? "chip-ok" : "chip-bad"}">${escapeHtml(result.rpki_status || "未知")}</span></span></div>
    <div class="kv"><span class="k">CIDR 网段</span><span class="v"><code>${escapeHtml(result.cidr || lookup.cidr || "-")}</code></span></div>
  `;

  gridSection.append(typeCard, sysCard);
  content.append(gridSection);

  // 3. IP 情报（威胁指标）与 风险深度检测
  const threatSection = document.createElement("div");
  threatSection.className = "detail-grid-layout";

  const intelCard = document.createElement("div");
  intelCard.className = "card sub-card";
  intelCard.innerHTML = `
    <h3>IP 情报（威胁指标）</h3>
    <div class="kv"><span class="k">风险标记</span><span class="v">${renderThreatChips(result, intel)}</span></div>
    <div class="kv"><span class="k">滥用等级</span><span class="v"><span class="chip ${result.abuse_level === "纯净" ? "chip-ok" : "chip-warn"}">${escapeHtml(result.abuse_level || "纯净")}</span></span></div>
    <div class="kv"><span class="k">HTTP 蜜罐黑名单<span class="tip-wrap">ⓘ<span class="tip-text">基于诱骗蜜罐技术捕获的恶意威胁行为。</span></span></span><span class="v"><span class="chip ${result.honeypot_status === "纯净" ? "chip-ok" : "chip-warn"}">${escapeHtml(result.honeypot_status || "纯净")}</span></span></div>
  `;

  const deepRiskCard = document.createElement("div");
  deepRiskCard.className = "card sub-card";
  deepRiskCard.innerHTML = `
    <h3>风险深度检测</h3>
    <div class="kv"><span class="k">VPN</span><span class="v"><span class="chip ${result.is_vpn ? "chip-warn" : "chip-ok"}">${result.is_vpn ? "已检测到" : "未检测到"}</span></span></div>
    <div class="kv"><span class="k">代理 (Proxy)<span class="tip-wrap">ⓘ<span class="tip-text">商业/匿名代理出口检测</span></span></span><span class="v"><span class="chip ${result.is_proxy ? "chip-warn" : "chip-ok"}">${result.is_proxy ? "已检测到" : "未检测到"}</span></span></div>
    <div class="kv"><span class="k">Tor<span class="tip-wrap">ⓘ<span class="tip-text">洋葱路由匿名网络出口</span></span></span><span class="v"><span class="chip ${result.is_tor ? "chip-bad" : "chip-ok"}">${result.is_tor ? "已检测到" : "未检测到"}</span></span></div>
    <div class="kv"><span class="k">爬虫/机器人</span><span class="v"><span class="chip ${result.is_crawler ? "chip-info" : "chip-ok"}">${result.is_crawler ? "已检测到" : "未检测到"}</span></span></div>
  `;

  threatSection.append(intelCard, deepRiskCard);
  content.append(threatSection);

  // 4. GPT · Codex 可用检测卡片
  if (Array.isArray(gpts) && gpts.length) {
    const gptCard = document.createElement("section");
    gptCard.className = "card sub-card";
    const cells = gpts.map((g) => {
      const ms = g.ok && typeof g.elapsed_ms === "number" ? `${g.elapsed_ms} ms` : (g.text || "不可访问");
      const speedCls = g.ok && g.elapsed_ms < 250 ? "p-fast" : g.ok && g.elapsed_ms < 500 ? "p-mid" : "p-slow";
      const isCodex = g.name.includes("api.openai");
      const tipText = isCodex ? "Codex / API 走的独立链路，与网页认证链路不同" : "ChatGPT 网页及用户认证链路";
      return `
        <div class="gp-cell">
          <span class="gp-head"><span class="gp-city">${escapeHtml(g.name)}<span class="tip-wrap">ⓘ<span class="tip-text">${tipText}</span></span></span></span>
          <span class="gp-val ${speedCls}">${escapeHtml(ms)}</span>
        </div>
      `;
    }).join("");
    gptCard.innerHTML = `
      <h3>GPT · Codex 可用与延迟检测</h3>
      <div class="gp-grid">${cells}</div>
    `;
    content.append(gptCard);
  }

  // 5. Coffee 全球 Ping 卡片
  if (Array.isArray(pings) && pings.length) {
    const pingCard = document.createElement("section");
    pingCard.className = "card sub-card";
    const cells = pings.map((p) => {
      const ms = p.ok && typeof p.elapsed_ms === "number" ? `${p.elapsed_ms} ms` : (p.status || "超时");
      const speedCls = p.ok && p.elapsed_ms < 80 ? "p-fast" : p.ok && p.elapsed_ms < 200 ? "p-mid" : "p-slow";
      return `
        <div class="gp-cell">
          <span class="gp-head"><span class="gp-city">${escapeHtml(p.name || p.code)}</span></span>
          <span class="gp-val ${speedCls}">${escapeHtml(ms)}</span>
        </div>
      `;
    }).join("");
    pingCard.innerHTML = `
      <h3>全球主要地区延迟测试 (Coffee 全球 Ping)</h3>
      <div class="gp-grid">${cells}</div>
    `;
    content.append(pingCard);
  }

  // 6. 原始暂存与代理证据
  const raw = document.createElement("details");
  raw.innerHTML = `<summary>查看完整结构化 JSON</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
  content.append(raw);

  elements.detailContent.replaceChildren(content);
}

function renderDetailFlags(result) {
  const flags = [];
  if (result.is_residential) flags.push('<span class="chip chip-ok">家庭住宅IP</span>');
  else if (result.is_datacenter) flags.push('<span class="chip chip-warn">机房IP</span>');
  if (result.is_vpn) flags.push('<span class="chip chip-warn">VPN</span>');
  if (result.is_proxy) flags.push('<span class="chip chip-warn">Proxy</span>');
  if (result.is_tor) flags.push('<span class="chip chip-bad">Tor</span>');
  if (result.is_crawler) flags.push('<span class="chip chip-info">Crawler</span>');
  if (result.is_abuser) flags.push('<span class="chip chip-bad">历史滥用</span>');
  return flags.join(" ") || '<span class="chip chip-ok">无特殊标记</span>';
}

function renderThreatChips(result, intel) {
  const threats = intel.threats || [];
  if (!threats.length && !result.is_abuser && !result.is_tor) {
    return '<span class="chip chip-ok">未发现明显威胁</span>';
  }
  const chips = threats.map((t) => {
    const cls = t.severity === "bad" ? "chip-bad" : t.severity === "warn" ? "chip-warn" : "chip-info";
    return `<span class="chip ${cls}">${escapeHtml(t.label || "威胁")}</span>`;
  });
  return chips.join(" ") || '<span class="chip chip-warn">存在风险标记</span>';
}

function renderOpenPortsHtml(ports) {
  if (!ports || typeof ports !== "object" || !Object.keys(ports).length) {
    return '<span class="chip chip-ok">未发现常见端口开放</span>';
  }
  const open = Object.keys(ports).filter((k) => ports[k] === "open" || ports[k] === true);
  if (!open.length) return '<span class="chip chip-ok">未发现常见端口开放</span>';
  return open.map((p) => `<span class="chip chip-warn">端口 ${escapeHtml(p)} 开放</span>`).join(" ");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function setScanning(scanning) {
  const ready = !scanning && state.job?.status === "completed" && state.job?.manifest_ready === true;
  elements.startButton.disabled = scanning;
  elements.startButton.textContent = scanning ? "检测中..." : "开始检测";
  elements.cancelButton.hidden = !scanning;
  elements.cancelButton.disabled = false;
  elements.exportCsvBtn.disabled = !ready;
  elements.exportJsonBtn.disabled = !ready;
}

function showError(message) {
  elements.errorMessage.hidden = !message;
  elements.errorMessage.textContent = message;
}

function showInlineError(message) { showError(message); }
function showFatalError(message) { setScanning(false); elements.scanStatusBadge.hidden = true; showError(message); }
function jobTitle(status) { return ({ queued: "排队中", preparing: "准备中", running: "扫描中", completed: "已完成", failed: "失败", cancelled: "已停止" }[status] || status || "准备中"); }

async function readResponse(response) {
  let data;
  try { data = await response.json(); }
  catch { const error = new Error(`后端异常 (HTTP ${response.status})`); error.status = response.status; throw error; }
  if (!response.ok) { const error = new Error(data.detail || `请求失败 (HTTP ${response.status})`); error.status = response.status; throw error; }
  return data;
}

async function checkHealth() {
  try {
    const data = await readResponse(await fetch(apiUrl("/api/health"), { cache: "no-store" }));
    if (!data.mihomo_ready) throw new Error("Mihomo 未就绪");
    elements.healthStatus.textContent = "后端就绪";
    elements.healthStatus.className = "health ready";
  } catch (error) {
    elements.healthStatus.textContent = error.message;
    elements.healthStatus.className = "health error";
  }
}

setScanning(false);
checkHealth();

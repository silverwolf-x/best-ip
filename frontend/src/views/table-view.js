import { filterResults, normalizeIpureScores, IPURE_SCORE_LABELS, statusLabels, formatAsn, escapeHtml, normalizeUnavailableLatencyStatus } from "../results.js";
export function createTableView(state, elements, document) {
let renderFrame = null;
function renderRows() {
  const query = elements.resultSearch.value.trim().toLocaleLowerCase("zh-CN");
  const globalStatus = elements.statusFilter.value;
  const cf = state.columnFilters;
 const rows = filterResults(state.results, { query, status: globalStatus, columnFilters: cf, sortKey: state.sortKey, sortDirection: state.sortDirection });
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
 emptyTitle.textContent = "等待扫描结果";
 emptyDesc.textContent = "扫描完成并通过结果校验后展示节点结果。";
  }
}

function scheduleRenderRows() {
  if (renderFrame !== null) return;
  const schedule = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (callback) => setTimeout(callback, 0);
  renderFrame = schedule(() => {
    renderFrame = null;
    renderRows();
  });
}
function createResultRow(result) {
  const row = document.createElement("tr");
  row._bestIpResult = result;

  // 1. 节点名称（自适应宽度）
  appendTextCell(row, "", (cell) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "node-name-btn";
    button.textContent = result.node || "未命名";
    button.title = `${result.node || "未命名"} (${result.type || "未知"}) - 点击查看完整画像`;
    cell.replaceChildren(button);
  });
  appendTextCell(row, "", (cell) => {
    if (result.score == null) {
      const unavailable = result.requests?.ipure?.error_type === "EnrichmentUnavailable";
      const label = unavailable ? "不可用" : "—";
      const title = unavailable ? (result.requests?.ipure?.error || "IPure 查询暂不可用") : "暂无评分";
      const badge = document.createElement("span");
      badge.className = "score-pill score-none";
      badge.title = title;
      badge.textContent = label;
      cell.replaceChildren(badge);
    } else {
      const score = Number(result.score);
      const scoreCls = score >= 75 ? "score-great" : score >= 45 ? "score-good" : "score-bad";
      cell.innerHTML = `<span class="score-pill ${scoreCls}">${score}</span>`;
    }
  });
  appendTextCell(row, "", (cell) => {
    const scores = normalizeIpureScores(result.ipure_scores, result.score);
    const container = document.createElement("div");
    container.className = "tag-chips";
    IPURE_SCORE_LABELS.forEach(([key, label]) => {
      if (scores[key] == null) return;
      const chip = document.createElement("span");
      const scoreClass = scores[key] >= 75 ? "chip-ok" : scores[key] >= 45 ? "chip-info" : "chip-warn";
      chip.className = `chip ${scoreClass}`;
      chip.textContent = `${label} ${scores[key]}`;
      container.append(chip);
    });
    if (!container.children.length && result.requests?.ipure?.error_type === "EnrichmentUnavailable") {
      const chip = document.createElement("span");
      chip.className = "chip chip-info";
      chip.textContent = "查询不可用";
      container.append(chip);
    }
    cell.replaceChildren(container.children.length ? container : document.createTextNode("—"));
  });
  appendTextCell(row, "", (cell) => {
    const score = result.coffee_score;
    const badge = document.createElement("span");
    const scoreClass = !Number.isFinite(score) ? "score-none" : score >= 75 ? "score-great" : score >= 45 ? "score-good" : "score-bad";
    badge.className = `score-pill ${scoreClass}`;
    badge.textContent = Number.isFinite(score) ? String(score) : "—";
    badge.title = Number.isFinite(score) ? "Coffee 评分" : "暂无 Coffee 评分";
    cell.replaceChildren(badge);
  });
  appendTextCell(row, "", (cell) => {
    const badge = document.createElement("span");
    badge.className = `status-badge ${result.status || "failed"}`;
    badge.textContent = statusLabels[result.status] || result.status || "失败";
    if (result.error) {
      badge.title = result.error;
    }
    cell.replaceChildren(badge);
  });  appendTextCell(row, "", (cell) => {
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
      ipWrap.append(code, copyBtn);
      cell.replaceChildren(ipWrap);
    } else {
      cell.innerHTML = '<span class="failure-reason">' + escapeHtml(result.error || "连接失败") + '</span>';
    }
  });  appendTextCell(row, "", (cell) => {
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
  });  appendTextCell(row, "", (cell) => {
    if (result.status === "failed" && !result.asn && !result.is_native && !result.company_type) {
      cell.textContent = "—";
      return;
    }
    const container = document.createElement("div");
    container.className = "tag-chips";

    // ASN 药丸
    const formattedAsn = formatAsn(result.asn);
    if (formattedAsn) {
      const asnChip = document.createElement("span");
      asnChip.className = "chip chip-asn";
      asnChip.textContent = formattedAsn;
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
  });  appendTextCell(row, "", (cell) => {
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
      const hasRiskEvidence = ["is_vpn", "is_proxy", "is_tor", "is_crawler", "is_abuser"]
        .every((key) => typeof result[key] === "boolean");
      const securityText = result.security_status || (hasRiskEvidence ? "🛡️ 纯净 (无威胁)" : "检测数据不足");
      cleanChip.className = `chip ${hasRiskEvidence ? "chip-ok" : "chip-info"}`;
      cleanChip.textContent = securityText;
      container.append(cleanChip);
    }

    if (result.abuse_level && result.abuse_level !== "纯净" && result.abuse_level !== "未知") {
      const abuseChip = document.createElement("span");
      abuseChip.className = "chip chip-warn";
      abuseChip.textContent = `滥用: ${result.abuse_level}`;
      container.append(abuseChip);
    }

    cell.replaceChildren(container);
  });  appendTextCell(row, "", (cell) => {
    cell.replaceChildren(createMiniGptBar(result.gpt_check));
  });  appendTextCell(row, "", (cell) => {
    cell.replaceChildren(createMiniPingBar(result.global_ping));
  });  appendTextCell(row, result.elapsed_ms ? `${(result.elapsed_ms / 1000).toFixed(1)}s` : "—");

  return row;
}

// 构建 GPT · Codex 延迟条（与 Coffee 全球 Ping 一致）
function createMiniGptBar(gptChecks) {
  if (!Array.isArray(gptChecks) || !gptChecks.length) {
    const span = document.createElement("span");
    span.className = "p-timeout p-gray";
    span.textContent = "未检测";
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
      node.innerHTML = `<span class="p-dot"></span><span class="p-code">${escapeHtml(shortLabel)}</span><span class="p-ms p-timeout">不可用</span>`;
      node.title = `${item.name}: ${item.text || "不可访问"}${item.status_code ? ` (HTTP ${item.status_code})` : ""}`;
    }
    bar.append(node);
  });
  return bar;
}

function createMiniPingBar(pings) {
  if (!Array.isArray(pings) || !pings.length) {
    const span = document.createElement("span");
    span.className = "p-timeout p-gray";
    span.textContent = "未检测";
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
      const status = normalizeUnavailableLatencyStatus(ping.status, "未检测/超时");
      node.innerHTML = `<span class="p-dot p-dot-gray"></span><span class="p-code">${escapeHtml(code)}</span><span class="p-ms p-timeout p-gray">${escapeHtml(status)}</span>`;
      node.title = `${ping.name || code}: ${status}`;
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
return { renderRows, scheduleRenderRows, createResultRow, createMiniGptBar, createMiniPingBar };
}

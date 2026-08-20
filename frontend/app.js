const configuredApiBase = document.querySelector('meta[name="api-base"]')?.content || "";
const apiBase = configuredApiBase || (location.port === "5173" ? "http://127.0.0.1:8000" : "");

// 客户端本地指纹与环境信息
const clientEnv = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "未知",
  language: navigator.language || "zh-CN",
  platform: navigator.platform || "Windows",
  cookie: navigator.cookieEnabled ? "已启用" : "已禁用",
};

const state = {
  job: null,
  results: [],
  sortKey: "node",
  sortDirection: "asc",
  pollTimer: null,
  pollFailures: 0,
  currentTag: "all",
  activeDetailResult: null,
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
  quickTags: document.querySelector("#quickTags"),
  exportCsvBtn: document.querySelector("#exportCsvBtn"),
  exportJsonBtn: document.querySelector("#exportJsonBtn"),
  resultBody: document.querySelector("#resultBody"),
  emptyResults: document.querySelector("#emptyResults"),
  detailDialog: document.querySelector("#detailDialog"),
  detailTitle: document.querySelector("#detailTitle"),
  detailSubtitle: document.querySelector("#detailSubtitle"),
  detailContent: document.querySelector("#detailContent"),
  copyJsonBtn: document.querySelector("#copyJsonBtn"),
  closeDialog: document.querySelector("#closeDialog"),
};

const statusLabels = {
  success: "完整",
  partial: "部分",
  failed: "失败",
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("best-ip-theme", theme);
  elements.themeButton.title = theme === "dark" ? "浅色主题" : "深色主题";
}

const savedTheme = localStorage.getItem("best-ip-theme");
applyTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

elements.themeButton.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

elements.revealButton.addEventListener("click", () => {
  const revealing = elements.subscriptionUrl.type === "password";
  elements.subscriptionUrl.type = revealing ? "url" : "password";
  elements.revealButton.textContent = revealing ? "🔒" : "👁️";
});

// Quick Tags Filter
elements.quickTags?.addEventListener("click", (event) => {
  const btn = event.target.closest(".tag-btn");
  if (!btn) return;
  elements.quickTags.querySelectorAll(".tag-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.currentTag = btn.dataset.tag;
  renderRows();
});

// Export CSV
elements.exportCsvBtn?.addEventListener("click", () => {
  if (!state.results.length) return;
  const headers = ["节点名称", "协议", "状态", "出口IP", "地理位置", "ASN", "网络属性", "IP原生性", "安全纯净度", "人机画像", "综合评分", "GPT状态", "Claude状态", "耗时(ms)"];
  const rows = state.results.map((r) => [
    `"${(r.node || "").replace(/"/g, '""')}"`,
    `"${(r.type || "").replace(/"/g, '""')}"`,
    `"${r.status || ""}"`,
    `"${r.exit_ip || ""}"`,
    `"${(r.location || "").replace(/"/g, '""')}"`,
    `"AS${r.asn || ""} ${r.as_org || ""}"`,
    `"${r.is_residential ? "住宅宽带" : r.is_datacenter ? "机房/托管" : "未知"}"`,
    `"${r.is_native ? "原生 IP" : "非原生/广播"}"`,
    `"${(r.security_status || "").replace(/"/g, '""')}"`,
    `"${r.traffic_profile || "未知"}"`,
    unifiedScore(r),
    `"${(r.gpt_access || "").replace(/"/g, '""')}"`,
    `"${(r.claude_access || "").replace(/"/g, '""')}"`,
    r.elapsed_ms ?? "",
  ]);
  const csvContent = "﻿" + [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
  downloadBlob(csvContent, `best-ip-results-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv;charset=utf-8;");
});

// Export JSON
elements.exportJsonBtn?.addEventListener("click", () => {
  if (!state.results.length) return;
  const jsonContent = JSON.stringify(state.results, null, 2);
  downloadBlob(jsonContent, `best-ip-results-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
});

function downloadBlob(content, filename, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const subscriptionUrl = elements.subscriptionUrl.value.trim();
  if (!subscriptionUrl) return;

  clearTimeout(state.pollTimer);
  state.job = null;
  state.results = [];
  state.pollFailures = 0;
  setScanning(true);
  elements.errorMessage.hidden = true;
  elements.scanStatusBadge.hidden = false;
  elements.scanStatusText.textContent = "创建任务";
  elements.scanProgressCount.textContent = "0/0";

  try {
    const response = await fetch(`${apiBase}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription_url: subscriptionUrl }),
    });
    const data = await readResponse(response);
    state.job = data;
    await pollJob();
  } catch (error) {
    showFatalError(error.message);
  }
});

elements.cancelButton.addEventListener("click", async () => {
  if (!state.job?.id) return;
  elements.cancelButton.disabled = true;
  try {
    await fetch(`${apiBase}/api/scans/${state.job.id}`, { method: "DELETE" });
    elements.scanStatusText.textContent = "停止中";
  } catch (error) {
    showInlineError(`停止失败：${error.message}`);
  }
});

elements.resultSearch.addEventListener("input", renderRows);
elements.statusFilter.addEventListener("change", renderRows);

document.querySelectorAll(".sort-btn").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.sort;
    if (state.sortKey === key) {
      state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDirection = (key === "node" || key === "location") ? "asc" : "desc";
    }
    document.querySelectorAll(".sort-btn").forEach((item) => {
      const active = item.dataset.sort === state.sortKey;
      item.classList.toggle("active", active);
      item.classList.toggle("asc", active && state.sortDirection === "asc");
      item.closest("th")?.setAttribute(
        "aria-sort",
        active ? (state.sortDirection === "asc" ? "ascending" : "descending") : "none",
      );
    });
    renderRows();
  });
});

elements.closeDialog.addEventListener("click", () => elements.detailDialog.close());
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

async function pollJob() {
  if (!state.job?.id) return;
  try {
    const response = await fetch(`${apiBase}/api/scans/${state.job.id}`, { cache: "no-store" });
    const job = await readResponse(response);
    state.job = job;
    state.results = (job.results || []).map((result, index) => ({ ...result, _index: index }));
    state.pollFailures = 0;
    renderJob(job);

    if (["completed", "failed", "cancelled"].includes(job.status)) {
      setScanning(false);
      return;
    }
    state.pollTimer = setTimeout(pollJob, 1000);
  } catch (error) {
    state.pollFailures += 1;
    showInlineError(`读取进度失败，重试中：${error.message}`);
    if (state.pollFailures >= 5) {
      setScanning(false);
      return;
    }
    state.pollTimer = setTimeout(pollJob, 1800);
  }
}

function renderJob(job) {
  const total = Number(job.total || 0);
  const completed = Number(job.completed || 0);
  elements.scanProgressCount.textContent = `${completed}/${total}`;
  elements.scanStatusText.textContent = job.status === "running" ? `检测中 (${job.current_node || ""})` : (jobTitle(job.status));
  elements.errorMessage.hidden = !job.error;
  elements.errorMessage.textContent = job.error || "";

  elements.totalStat.textContent = String(total);
  elements.completedStat.textContent = String(completed);
  const successes = state.results.filter((item) => item.status === "success").length;
  elements.successStat.textContent = String(successes);
  elements.issueStat.textContent = String(state.results.length - successes);
  renderRows();
}

function renderRows() {
  const query = elements.resultSearch.value.trim().toLocaleLowerCase("zh-CN");
  const status = elements.statusFilter.value;
  const tag = state.currentTag;

  const rows = state.results
    .filter((result) => status === "all" || result.status === status)
    .filter((result) => {
      if (tag === "dual_ai") return unifiedScore(result) >= 80 && serviceIsAvailable(result.gpt_access) && serviceIsAvailable(result.claude_access);
      if (tag === "residential") return result.is_residential === true;
      if (tag === "native") return result.is_native === true;
      if (tag === "clean") return result.security_status?.startsWith("🛡️") === true;
      if (tag === "gpt_ok") return serviceIsAvailable(result.gpt_access);
      if (tag === "claude_ok") return serviceIsAvailable(result.claude_access);
      if (tag === "issues") return result.status === "failed" || result.status === "partial" || !serviceIsAvailable(result.gpt_access) || !serviceIsAvailable(result.claude_access);
      return true;
    })
    .filter((result) => {
      if (!query) return true;
      const haystacks = [
        result.node,
        result.type,
        result.exit_ip,
        result.location,
        result.as_org,
        result.security_status,
        result.asn ? `AS${result.asn}` : "",
        result.is_residential ? "住宅" : "",
        result.is_datacenter ? "机房" : "",
        result.is_native ? "原生" : "",
        result.gpt_access,
        result.claude_access,
      ];
      return haystacks.some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(query));
    })
    .sort(compareResults);

  const fragment = document.createDocumentFragment();
  rows.forEach((result) => fragment.append(createResultRow(result)));
  elements.resultBody.replaceChildren(fragment);
  elements.emptyResults.hidden = rows.length > 0;
}

function createResultRow(result) {
  const row = document.createElement("tr");

  // 1. 节点名称 & 协议
  const nodeCell = document.createElement("td");
  const nodeBtn = document.createElement("button");
  nodeBtn.type = "button";
  nodeBtn.className = "node-name-btn";
  nodeBtn.textContent = result.node || "未命名";
  nodeBtn.title = `${result.node} (点击查看合并全景数据)`;
  nodeBtn.addEventListener("click", () => openDetails(result));
  nodeCell.append(nodeBtn);
  row.append(nodeCell);

  // 2. 状态
  const statusCell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `status-badge ${result.status || "failed"}`;
  badge.textContent = statusLabels[result.status] || result.status;
  statusCell.append(badge);
  row.append(statusCell);

  // 3. 出口 IP
  const ipCell = document.createElement("td");
  if (result.exit_ip) {
    const ipWrap = document.createElement("div");
    ipWrap.className = "ip-cell";
    const ipSpan = document.createElement("span");
    ipSpan.textContent = result.exit_ip;
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "mini-copy";
    copyBtn.textContent = "📋";
    copyBtn.title = "复制出口 IP";
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(result.exit_ip);
      copyBtn.textContent = "✓";
      setTimeout(() => { copyBtn.textContent = "📋"; }, 1500);
    });
    ipWrap.append(ipSpan, copyBtn);
    ipCell.append(ipWrap);
  } else {
    ipCell.textContent = "—";
  }
  row.append(ipCell);

  // 4. 地理位置 & 运营商
  const locCell = document.createElement("td");
  const locSpan = document.createElement("div");
  locSpan.className = "cell-truncate";
  locSpan.textContent = result.location || "—";
  locSpan.title = result.location || "";
  locCell.append(locSpan);
  row.append(locCell);

  // 5. 网络属性与原生性
  const propCell = document.createElement("td");
  const chipWrap = document.createElement("div");
  chipWrap.className = "tag-chips";
  if (result.is_residential) {
    chipWrap.innerHTML += '<span class="chip chip-res">🏠 住宅</span>';
  } else if (result.is_datacenter) {
    chipWrap.innerHTML += '<span class="chip chip-dc">🏢 机房</span>';
  }
  if (result.is_native) {
    chipWrap.innerHTML += '<span class="chip chip-native">✨ 原生</span>';
  }
  if (result.asn) {
    const asnSpan = document.createElement("span");
    asnSpan.className = "chip chip-asn";
    asnSpan.textContent = `AS${result.asn}`;
    asnSpan.title = result.as_org || "";
    chipWrap.append(asnSpan);
  }
  propCell.append(chipWrap);
  row.append(propCell);

  // 6. 安全与纯净度 (合并)
  const secCell = document.createElement("td");
  const secSpan = document.createElement("div");
  secSpan.className = "cell-truncate";
  if (result.security_status) {
    secSpan.textContent = result.security_status;
    secSpan.title = result.security_status;
    if (result.security_status.includes("⚠️")) {
      secSpan.style.color = "var(--danger)";
      secSpan.style.fontWeight = "700";
    } else {
      secSpan.style.color = "var(--good)";
    }
  } else {
    secSpan.textContent = "—";
  }
  secCell.append(secSpan);
  row.append(secCell);

  // 7. 唯一综合评分
  const scoreCell = document.createElement("td");
  scoreCell.append(createScorePill(unifiedScore(result)));
  row.append(scoreCell);

  // 8. AI 服务可用性（评分已合并，仅保留不同的连通状态）
  const aiCell = document.createElement("td");
  const aiWrap = document.createElement("div");
  aiWrap.className = "service-statuses";
  aiWrap.append(
    createServiceChip("GPT", result.gpt_access),
    createServiceChip("Claude", result.claude_access),
  );
  aiCell.append(aiWrap);
  row.append(aiCell);

  // 9. 全球 Ping 延迟条
  const pingCell = document.createElement("td");
  const pings = result.global_ping || [];
  if (pings.length) {
    const bar = document.createElement("div");
    bar.className = "mini-ping-bar";
    pings.forEach((p) => {
      const pNode = document.createElement("span");
      pNode.className = "mini-ping-node";
      const cls = p.ok ? (p.elapsed_ms < 80 ? "p-fast" : p.elapsed_ms < 180 ? "p-mid" : "p-slow") : "p-timeout";
      pNode.innerHTML = `<span class="p-code">${p.code.toUpperCase()}</span> <span class="p-ms ${cls}">${p.ok ? `${p.elapsed_ms}ms` : "×"}</span>`;
      pNode.title = `${p.name}: ${p.status || (p.elapsed_ms ? `${p.elapsed_ms}ms` : "超时")}`;
      bar.append(pNode);
    });
    pingCell.append(bar);
  } else {
    pingCell.textContent = "—";
  }
  row.append(pingCell);

  // 11. 耗时
  const timeCell = document.createElement("td");
  timeCell.textContent = result.elapsed_ms ? `${(result.elapsed_ms / 1000).toFixed(1)}s` : "—";
  row.append(timeCell);

  return row;
}

function unifiedScore(result) {
  const candidates = [result.score, result.ip_score, result.gpt_score, result.claude_score];
  return candidates.find((value) => typeof value === "number") ?? null;
}

function serviceIsAvailable(access) {
  if (!access || access.includes("地区受限")) return false;
  return access.split("·").some((part) => part.includes(" 可达 "));
}

function createServiceChip(label, access) {
  const chip = document.createElement("span");
  const restricted = Boolean(access?.includes("地区受限"));
  const available = serviceIsAvailable(access);
  chip.className = `service-chip ${restricted ? "restricted" : available ? "available" : access ? "unavailable" : "unknown"}`;
  chip.textContent = `${label} ${restricted ? "受限" : available ? "可用" : access ? "不可达" : "未知"}`;
  chip.title = access || `${label} 未返回检测结果`;
  return chip;
}

function createScorePill(score) {
  const pill = document.createElement("span");
  if (typeof score !== "number") {
    pill.className = "score-pill score-none";
    pill.textContent = "—";
    return pill;
  }
  pill.className = `score-pill ${getScoreClass(score)}`;
  pill.textContent = String(score);
  return pill;
}

function getScoreClass(score) {
  if (score >= 90) return "score-great";
  if (score >= 75) return "score-good";
  if (score >= 50) return "score-mid";
  if (score >= 25) return "score-low";
  return "score-bad";
}

function compareResults(left, right) {
  const direction = state.sortDirection === "asc" ? 1 : -1;
  const leftValue = left[state.sortKey];
  const rightValue = right[state.sortKey];
  if (typeof leftValue === "number" || typeof rightValue === "number") {
    return ((leftValue ?? -1) - (rightValue ?? -1)) * direction;
  }
  return String(leftValue || "").localeCompare(String(rightValue || ""), "zh-CN", {
    numeric: true,
    sensitivity: "base",
  }) * direction;
}

// ─────────────────────────────────────────────────────────────
// 深度合并唯一事实源详情弹窗 (Merged Single Source of Truth Dialog)
// ─────────────────────────────────────────────────────────────
async function openDetails(summary) {
  elements.detailTitle.textContent = `${summary.node} (${summary.type || "未知"})`;
  elements.detailSubtitle.textContent = `出口: ${summary.exit_ip || "未知"} · 位置: ${summary.location || "未知"}`;
  elements.detailContent.innerHTML = '<p class="text-muted" style="padding:20px 0;text-align:center;">正在读取全量数据...</p>';
  elements.detailDialog.showModal();

  try {
    const response = await fetch(
      `${apiBase}/api/scans/${state.job.id}/results/${summary._index}`,
      { cache: "no-store" },
    );
    const result = await readResponse(response);
    state.activeDetailResult = result;
    renderMergedDetails(result);
  } catch (error) {
    elements.detailContent.innerHTML = `<p class="error-banner">读取详情失败：${error.message}</p>`;
  }
}

function renderMergedDetails(result) {
  const pages = result.pages || {};
  const ipPage = pages.ip || {};
  const gptPage = pages.gpt || {};
  const claudePage = pages.claude || {};
  const ipLookup = ipPage.result || {};
  const gptRisk = gptPage.risk || {};
  const claudeRisk = claudePage.risk || {};
  const gptGeo = gptPage.geo || {};
  const claudeGeo = claudePage.geo || {};

  const frag = document.createDocumentFragment();

  // 1. 唯一合并综合网络属性与安全标记 (彻底去重)
  const unifiedSec = document.createElement("section");
  unifiedSec.className = "merged-card-section";
  unifiedSec.innerHTML = `
    <div class="section-title"><span>🌐 节点综合身份与安全纯净度 (Unified Network & Risk)</span></div>
    <dl class="dense-dl">
      <dt>出口 IP / 网段</dt><dd><code>${result.exit_ip || "—"}</code> (${result.cidr || ipLookup.cidr || "—"})</dd>
      <dt>网络属性</dt><dd>${result.is_residential === true ? "🏠 住宅宽带 (Residential)" : result.is_datacenter === true ? "🏢 机房托管 (Datacenter)" : "未知"} · ${result.is_native === true ? "✨ 原生 IP" : result.is_native === false ? "非原生 / 广播" : "原生性未知"} · ${result.company_type || "未知"}</dd>
      <dt>ASN 归属</dt><dd>AS${result.asn || ipLookup.asn || "—"} (${result.as_org || ipLookup.asOrganization || ipLookup.company_name || "—"})</dd>
      <dt>AI 判定与画像</dt><dd>${ipLookup.ai_verdict?.label || "—"} · ${result.traffic_profile || "人类偏多"}</dd>
      <dt>安全与纯净度</dt><dd><strong>${result.security_status || "检测数据不足"}</strong> (VPN: ${formatBoolText(result.is_vpn)}, 代理: ${formatBoolText(result.is_proxy)}, Tor: ${formatBoolText(result.is_tor)}, 爬虫: ${formatBoolText(result.is_crawler)}, 滥用: ${formatBoolText(result.is_abuser)})</dd>
      <dt>技术指标</dt><dd>反向 DNS: ${result.rdns || ipLookup.rdns || "—"} · RPKI: ${ipLookup.rpki_status ? `✓ ${ipLookup.rpki_status}` : "—"} · Reddit: ${typeof ipLookup.reddit_blocked === "boolean" ? ipLookup.reddit_blocked ? "⚠️ 已阻断" : "✅ 正常" : "—"}</dd>
    </dl>
  `;
  frag.append(unifiedSec);

  // 2. 唯一综合评分与 AI 服务可用性
  const serviceSec = document.createElement("section");
  serviceSec.className = "merged-card-section";
  serviceSec.innerHTML = '<div class="section-title"><span>📊 综合评分与 AI 服务可用性</span></div>';

  const score = unifiedScore(result);
  const scoreClass = typeof score === "number" ? getScoreClass(score) : "score-none";
  const serviceGrid = document.createElement("div");
  serviceGrid.className = "quality-grid";
  serviceGrid.innerHTML = `
    <div class="score-overview">
      <span class="quality-label">Coffee 综合评分</span>
      <span class="big-score-badge ${scoreClass}">${score ?? "—"}</span>
      <span class="quality-verdict">${typeof score !== "number" ? "暂无评分" : score >= 80 ? "极佳" : score >= 50 ? "良好" : "风险较高"}</span>
    </div>
    <div class="availability-card">
      <div class="availability-header"><strong>ChatGPT / Codex</strong><span class="service-chip ${gptPage.restricted ? "restricted" : serviceIsAvailable(result.gpt_access) ? "available" : "unavailable"}">${gptPage.restricted ? "受限" : serviceIsAvailable(result.gpt_access) ? "可用" : "不可达"}</span></div>
      <dl class="dense-dl">
        <dt>chatgpt.com</dt><dd>${gptPage.connectivity?.[0]?.ok ? `${gptPage.connectivity[0].elapsed_ms}ms` : "❌ 不可达"}</dd>
        <dt>api.openai.com</dt><dd>${gptPage.connectivity?.[1]?.ok ? `${gptPage.connectivity[1].elapsed_ms}ms` : "❌ 不可达"}</dd>
        <dt>官方状态</dt><dd>${gptPage.service_status?.overall || "—"}</dd>
      </dl>
    </div>
    <div class="availability-card">
      <div class="availability-header"><strong>Claude / Anthropic</strong><span class="service-chip ${claudePage.restricted ? "restricted" : serviceIsAvailable(result.claude_access) ? "available" : "unavailable"}">${claudePage.restricted ? "受限" : serviceIsAvailable(result.claude_access) ? "可用" : "不可达"}</span></div>
      <dl class="dense-dl">
        <dt>claude.ai</dt><dd>${claudePage.connectivity?.[0]?.ok ? `${claudePage.connectivity[0].elapsed_ms}ms` : "❌ 不可达"}</dd>
        <dt>anthropic.com</dt><dd>${claudePage.connectivity?.[1]?.ok ? `${claudePage.connectivity[1].elapsed_ms}ms` : "❌ 不可达"}</dd>
        <dt>官方状态</dt><dd>${claudePage.service_status?.overall || "—"}</dd>
      </dl>
    </div>
  `;
  serviceSec.append(serviceGrid);
  frag.append(serviceSec);

  // 3. 全球主要地区实时延迟 (Global Ping Grid)
  const pingSec = document.createElement("section");
  pingSec.className = "merged-card-section";
  pingSec.innerHTML = '<div class="section-title"><span>🌐 全球 8 大枢纽实时延迟 (Global Latency Grid)</span></div>';
  const pingGrid = document.createElement("div");
  pingGrid.className = "full-ping-grid";
  (result.global_ping || []).forEach((p) => {
    const cls = p.ok ? (p.elapsed_ms < 80 ? "p-fast" : p.elapsed_ms < 180 ? "p-mid" : "p-slow") : "p-timeout";
    pingGrid.innerHTML += `
      <div class="full-ping-cell">
        <span><strong>${p.code.toUpperCase()}</strong> ${p.name}</span>
        <strong class="${cls}">${p.ok ? `${p.elapsed_ms} ms` : "超时"}</strong>
      </div>
    `;
  });
  pingSec.append(pingGrid);
  frag.append(pingSec);

  // 4. 端口、DNS、UDP 与本地环境
  const envSec = document.createElement("section");
  envSec.className = "merged-card-section";
  const ports = result.port_scan;
  const portEntries = ports && typeof ports === "object" ? Object.entries(ports) : [];
  const portSummary = ports == null
    ? "未返回检测结果"
    : portEntries.length
      ? portEntries.map(([port, portStatus]) => `${port}: ${portStatus === "open" ? "🟢 开放" : "⚪ 关闭"}`).join(" · ")
      : "未发现已报告的开放端口";
  const pingcheck = result.ping_check || {};
  envSec.innerHTML = `
    <div class="section-title"><span>🔌 端口状态、网络可达性与客户端环境</span></div>
    <dl class="dense-dl">
      <dt>开放端口检测</dt><dd>${portSummary}</dd>
      <dt>Pingcheck 可达</dt><dd>${pingcheck.verdict ? `${pingcheck.verdict} (可用率 ${Math.round((pingcheck.ok_ratio || 0) * 100)}%)` : "未返回检测结果"}</dd>
      <dt>DNS / WebRTC</dt><dd>未检测（HTTP 扫描不具备浏览器侧泄漏检测能力）</dd>
      <dt>客户端环境</dt><dd>时区: ${clientEnv.timezone} · 语言: ${clientEnv.language} · 平台: ${clientEnv.platform}</dd>
    </dl>
  `;
  frag.append(envSec);

  // 5. 原始 JSON 折叠
  const rawDetails = document.createElement("details");
  rawDetails.innerHTML = `<summary>查看该节点完整 JSON 原始数据</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
  frag.append(rawDetails);

  elements.detailContent.replaceChildren(frag);
}

function formatBoolText(val) {
  if (val === true) return "是";
  if (val === false) return "否";
  return "—";
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setScanning(scanning) {
  elements.startButton.disabled = scanning;
  elements.startButton.textContent = scanning ? "检测中..." : "开始检测";
  elements.cancelButton.hidden = !scanning;
  elements.cancelButton.disabled = false;
}

function showInlineError(message) {
  elements.errorMessage.hidden = false;
  elements.errorMessage.textContent = message;
}

function showFatalError(message) {
  setScanning(false);
  elements.scanStatusBadge.hidden = true;
  showInlineError(message);
}

function jobTitle(status) {
  return ({
    queued: "排队中",
    preparing: "准备中",
    running: "扫描中",
    cancelling: "停止中",
    cancelled: "已停止",
    completed: "已完成",
    failed: "失败",
  })[status] || status;
}

async function readResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`后端异常 (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(data.detail || `请求失败 (HTTP ${response.status})`);
  return data;
}

async function checkHealth() {
  try {
    const response = await fetch(`${apiBase}/api/health`, { cache: "no-store" });
    const data = await readResponse(response);
    if (!data.mihomo_ready) throw new Error("Mihomo 未就绪");
    elements.healthStatus.textContent = "后端就绪";
    elements.healthStatus.className = "health ready";
  } catch (error) {
    elements.healthStatus.textContent = error.message;
    elements.healthStatus.className = "health error";
  }
}

checkHealth();

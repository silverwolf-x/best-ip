const configuredApiBase = document.querySelector('meta[name="api-base"]')?.content?.replace(/\/$/, "") || "";

const state = {
  job: null,
  results: [],
  sortKey: "node",
  sortDirection: "asc",
  pollTimer: null,
  pollGeneration: 0,
  activeDetailResult: null,
  detailGeneration: 0,
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

elements.resultSearch.addEventListener("input", renderRows);
elements.statusFilter.addEventListener("change", renderRows);
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
  if (state.job?.status !== "completed" || !state.job.manifest_ready || !state.results.length) return;
  const headers = ["节点名称", "协议", "状态", "出口IP", "位置", "ASN", "网络属性", "安全状态", "评分", "耗时(ms)"];
  const rows = state.results.map((result) => [
    csv(result.node),
    csv(result.type),
    csv(statusLabels[result.status] || result.status),
    csv(result.exit_ip || ""),
    csv(result.location || ""),
    csv(result.asn ? `AS${result.asn} ${result.as_org || ""}` : ""),
    csv(result.is_residential === true ? "住宅" : result.is_datacenter === true ? "机房" : "未知"),
    csv(result.security_status || ""),
    result.score ?? "",
    result.elapsed_ms ?? "",
  ]);
  downloadBlob("﻿" + [headers.join(","), ...rows.map((row) => row.join(","))].join("\n"), `best-ip-results-${dateStamp()}.csv`, "text/csv;charset=utf-8;");
});

elements.exportJsonBtn.addEventListener("click", async () => {
  if (state.job?.status !== "completed" || !state.job.manifest_ready) return;
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
  const status = elements.statusFilter.value;
  const rows = state.results
    .filter((result) => status === "all" || result.status === status)
    .filter((result) => {
      if (!query) return true;
      return [result.node, result.type, result.exit_ip, result.location, result.as_org, result.error, result.security_status, result.asn ? `AS${result.asn}` : ""]
        .some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(query));
    })
    .sort(compareResults);
  const fragment = document.createDocumentFragment();
  rows.forEach((result) => fragment.append(createResultRow(result)));
  elements.resultBody.replaceChildren(fragment);
  elements.emptyResults.hidden = rows.length > 0;
}

function createResultRow(result) {
  const row = document.createElement("tr");
  appendTextCell(row, result.node || "未命名", (cell) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "node-name-btn";
    button.textContent = result.node || "未命名";
    button.addEventListener("click", () => openDetails(result));
    cell.replaceChildren(button);
  });
  appendTextCell(row, statusLabels[result.status] || result.status || "失败", (cell) => {
    cell.className = `status-badge ${result.status || "failed"}`;
    cell.title = result.error || "";
  });
  appendTextCell(row, result.exit_ip || "—");
  appendTextCell(row, result.location || result.error || "—");
  appendTextCell(row, `${result.is_residential === true ? "住宅" : result.is_datacenter === true ? "机房" : "未知"} · ${result.is_native === true ? "原生" : result.is_native === false ? "非原生" : "原生性未知"} · ${result.asn ? `AS${result.asn}` : "ASN 未知"}`);
  appendTextCell(row, result.security_status || "检测数据不足");
  appendTextCell(row, result.score == null ? "—" : String(result.score));
  appendTextCell(row, pingSummary(result.global_ping));
  appendTextCell(row, result.elapsed_ms ? `${(result.elapsed_ms / 1000).toFixed(1)}s` : "—");
  return row;
}

function appendTextCell(row, text, configure) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (configure) configure(cell);
  row.append(cell);
}

function pingSummary(pings) {
  if (!Array.isArray(pings) || !pings.length) return "未返回";
  return pings.map((ping) => `${String(ping.code || "").toUpperCase()} ${ping.ok ? `${ping.elapsed_ms}ms` : ping.status || "未返回"}`).join(" · ");
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
    if (state.sortKey === key) state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    else {
      state.sortKey = key;
      state.sortDirection = key === "node" || key === "location" ? "asc" : "desc";
    }
    renderRows();
  });
});

async function openDetails(summary) {
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
  const content = document.createDocumentFragment();
  const section = document.createElement("section");
  section.className = "merged-card-section";
  section.innerHTML = `
    <div class="section-title"><span>🌐 Coffee IP 结构化结果</span></div>
    <dl class="dense-dl">
      <dt>出口 IP / 网段</dt><dd><code>${escapeHtml(result.exit_ip || "—")}</code> · ${escapeHtml(result.cidr || lookup.cidr || "—")}</dd>
      <dt>位置 / 运营商</dt><dd>${escapeHtml(result.location || "未知")} · ${escapeHtml(result.as_org || "未知")}</dd>
      <dt>评分</dt><dd><strong>${escapeHtml(String(result.score ?? "—"))}</strong></dd>
      <dt>网络属性</dt><dd>${result.is_residential === true ? "住宅" : result.is_datacenter === true ? "机房" : "未知"} · ${result.is_native === true ? "原生" : result.is_native === false ? "非原生" : "未知"}</dd>
      <dt>安全状态</dt><dd>${escapeHtml(result.security_status || "检测数据不足")}</dd>
      <dt>完整性</dt><dd>${result.completeness?.complete ? "全部接口完成" : `部分接口未完成：${escapeHtml((result.completeness?.missing || []).join("、"))}`}</dd>
      <dt>代理证据</dt><dd>${escapeHtml(JSON.stringify(result.proxy_evidence || {}))}</dd>
    </dl>`;
  content.append(section);
  const raw = document.createElement("details");
  raw.innerHTML = `<summary>查看完整暂存 JSON</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
  content.append(raw);
  elements.detailContent.replaceChildren(content);
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

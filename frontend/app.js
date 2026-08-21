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
  columnFilters: {
    node: "",
    status: "",
    exit_ip: "",
    location: "",
    isp: "",
    native: "",
    tech: "",
    security: "",
    score: "",
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
  if (state.job?.status !== "completed" || !state.job.manifest_ready || !state.results.length) return;
  const headers = ["节点名称", "协议", "状态", "出口IP", "位置", "服务商/ISP", "ASN", "ASN自报类型", "IP原生性", "Bogon", "RPKI", "反向DNS", "运营商类型", "人机流量", "安全状态", "滥用等级", "蜜罐状态", "评分", "耗时(ms)"];
  const rows = state.results.map((result) => [
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
          result.asn ? `AS${result.asn}` : "",
          result.asn_kind_display,
          result.native_status,
          result.company_type,
        ].some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(query));
        if (!matchesGlobal) return false;
      }

      // 列筛选 1: 节点名称
      if (cf.node && !String(result.node || "").toLocaleLowerCase("zh-CN").includes(cf.node.toLocaleLowerCase("zh-CN"))) {
        return false;
      }

      // 列筛选 2: 状态
      if (cf.status && result.status !== cf.status) {
        return false;
      }

      // 列筛选 3: 出口 IP
      if (cf.exit_ip && !String(result.exit_ip || "").toLowerCase().includes(cf.exit_ip.toLowerCase())) {
        return false;
      }

      // 列筛选 4: 地理位置
      if (cf.location && !String(result.location || "").toLocaleLowerCase("zh-CN").includes(cf.location.toLocaleLowerCase("zh-CN"))) {
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

      // 列筛选 7: 技术指标
      if (cf.tech) {
        if (cf.tech === "bogon" && !result.is_bogon) return false;
        if (cf.tech === "public" && result.is_bogon) return false;
        if (cf.tech === "rpki_valid" && !String(result.rpki_status || "").includes("Valid")) return false;
      }

      // 列筛选 8: 安全指标
      if (cf.security) {
        if (cf.security === "clean" && (!result.security_status || !result.security_status.includes("纯净"))) return false;
        if (cf.security === "threat" && (result.security_status && result.security_status.includes("纯净"))) return false;
        if (cf.security === "vpn" && !result.is_vpn) return false;
        if (cf.security === "proxy" && !result.is_proxy) return false;
        if (cf.security === "tor" && !result.is_tor) return false;
      }

      // 列筛选 9: 评分
      if (cf.score) {
        const s = result.score;
        if (s == null) return false;
        if (cf.score === "high" && s < 75) return false;
        if (cf.score === "mid" && (s < 45 || s >= 75)) return false;
        if (cf.score === "low" && s >= 45) return false;
      }

      // 列筛选 10: Coffee 全球 Ping
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
}

function createResultRow(result) {
  const row = document.createElement("tr");

  // 1. 节点名称
  appendTextCell(row, "", (cell) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "node-name-btn";
    button.textContent = result.node || "未命名";
    button.title = `${result.node || "未命名"} (${result.type || "未知"}) - 点击查看完整画像`;
    button.addEventListener("click", () => openDetails(result));
    cell.replaceChildren(button);
  });

  // 2. 状态
  appendTextCell(row, "", (cell) => {
    const badge = document.createElement("span");
    badge.className = `status-badge ${result.status || "failed"}`;
    badge.textContent = statusLabels[result.status] || result.status || "失败";
    if (result.error) {
      badge.title = result.error;
    }
    cell.replaceChildren(badge);
  });

  // 3. 出口 IP
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

  // 4. 地理位置
  appendTextCell(row, "", (cell) => {
    if (result.location) {
      cell.className = "cell-truncate";
      cell.textContent = result.location;
      cell.title = result.location;
    } else {
      cell.textContent = "—";
    }
  });

  // 5. 服务商 / ISP
  appendTextCell(row, "", (cell) => {
    const ispText = result.isp || result.as_org || "";
    if (ispText) {
      cell.className = "cell-truncate";
      cell.textContent = ispText;
      cell.title = ispText;
    } else {
      cell.textContent = "—";
    }
  });

  // 6. ASN / 原生性
  appendTextCell(row, "", (cell) => {
    if (result.status === "failed" && !result.asn && !result.is_native) {
      cell.textContent = "—";
      return;
    }
    const container = document.createElement("div");
    container.className = "tag-chips";

    // ASN 芯片
    if (result.asn) {
      const asnChip = document.createElement("span");
      asnChip.className = "chip chip-asn";
      asnChip.textContent = `AS${result.asn}`;
      if (result.asn_kind_display && result.asn_kind_display !== "未知") {
        asnChip.title = `自报类型: ${result.asn_kind_display}`;
      }
      container.append(asnChip);
    }

    // IP 原生性 芯片
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

    // 运营商类型/场景
    if (result.company_type && result.company_type !== "未知") {
      const compChip = document.createElement("span");
      compChip.className = `chip ${result.is_residential ? "chip-ok" : "chip-info"}`;
      compChip.textContent = result.company_type;
      container.append(compChip);
    }

    cell.replaceChildren(container.children.length ? container : document.createTextNode("—"));
  });

  // 7. 技术指标 (Bogon / RPKI / rDNS)
  appendTextCell(row, "", (cell) => {
    if (result.status === "failed") {
      cell.textContent = "—";
      return;
    }
    const container = document.createElement("div");
    container.className = "tag-chips";

    // Bogon
    const bogonChip = document.createElement("span");
    bogonChip.className = `chip ${result.is_bogon ? "chip-bad" : "chip-ok"}`;
    bogonChip.textContent = result.is_bogon ? "Bogon 广播" : "公网可达";
    bogonChip.title = "Bogon / 广播检测";
    container.append(bogonChip);

    // RPKI
    if (result.rpki_status && result.rpki_status !== "未知") {
      const rpkiChip = document.createElement("span");
      const isValid = result.rpki_status.includes("Valid") && !result.rpki_status.includes("Invalid");
      rpkiChip.className = `chip ${isValid ? "chip-ok" : "chip-bad"}`;
      rpkiChip.textContent = `RPKI: ${result.rpki_status}`;
      container.append(rpkiChip);
    }

    // rDNS
    if (result.rdns && result.rdns !== "-") {
      const rdnsSpan = document.createElement("span");
      rdnsSpan.className = "chip chip-asn";
      rdnsSpan.textContent = `rDNS: ${result.rdns}`;
      rdnsSpan.title = result.rdns;
      container.append(rdnsSpan);
    }

    cell.replaceChildren(container);
  });

  // 8. 安全 / 威胁指标
  appendTextCell(row, "", (cell) => {
    if (result.status === "failed") {
      cell.textContent = "—";
      return;
    }
    const container = document.createElement("div");
    container.className = "tag-chips";

    // 威胁芯片 (VPN / Proxy / Tor / 爬虫 / 滥用等)
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

    // 滥用等级 / 蜜罐
    if (result.abuse_level && result.abuse_level !== "纯净" && result.abuse_level !== "未知") {
      const abuseChip = document.createElement("span");
      abuseChip.className = "chip chip-warn";
      abuseChip.textContent = `滥用: ${result.abuse_level}`;
      container.append(abuseChip);
    }

    cell.replaceChildren(container);
  });

  // 9. 评分
  appendTextCell(row, "", (cell) => {
    if (result.score == null) {
      cell.innerHTML = '<span class="score-pill score-none">—</span>';
    } else {
      const score = Number(result.score);
      const scoreCls = score >= 75 ? "score-great" : score >= 45 ? "score-good" : "score-bad";
      cell.innerHTML = `<span class="score-pill ${scoreCls}">${score}</span>`;
    }
  });

  // 10. Coffee 全球 Ping
  appendTextCell(row, "", (cell) => {
    cell.replaceChildren(createMiniPingBar(result.global_ping));
  });

  // 11. 耗时
  appendTextCell(row, result.elapsed_ms ? `${(result.elapsed_ms / 1000).toFixed(1)}s` : "—");

  return row;
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
      node.innerHTML = `<span class="p-code">${escapeHtml(code)}</span><span class="p-ms ${speedCls}">${ms}ms</span>`;
      node.title = `${ping.name || code}: ${ms}ms`;
    } else {
      node.classList.add("node-timeout");
      node.innerHTML = `<span class="p-code">${escapeHtml(code)}</span><span class="p-ms p-timeout p-gray">-1ms</span>`;
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
  const intel = lookup.intelligence || {};
  const pings = result.global_ping || [];
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

  // 4. Coffee 全球 Ping 卡片
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

  // 5. 原始暂存与代理证据
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

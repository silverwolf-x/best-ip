import { normalizeIpureScores, IPURE_SCORE_LABELS, formatAsn, escapeHtml, normalizeUnavailableLatencyStatus } from "../results.js";
export function createDetailView(state, elements, document) {
function openDetails(summary) {
  state.detailGeneration += 1;
  state.activeDetailResult = summary;
  elements.detailTitle.textContent = `${summary.node || "节点"} (${summary.type || "未知"})`;
  elements.detailSubtitle.textContent = `${state.importSource || "artifact"} · 出口：${summary.exit_ip || "未知"} · ${summary.location || "位置未知"}`;
  renderDetails(summary);
  elements.detailDialog.showModal();
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
  const coffeeScore = Number.isFinite(result.coffee_score) ? result.coffee_score : null;
  const coffeeBadgeCls = coffeeScore == null ? "score-none" : coffeeScore >= 75 ? "score-great" : coffeeScore >= 45 ? "score-good" : "score-bad";
  const ipureScores = normalizeIpureScores(result.ipure_scores, result.score);
  const ipureScoreChips = IPURE_SCORE_LABELS
    .filter(([key]) => ipureScores[key] != null)
    .map(([key, label]) => `<span class="chip chip-info">${label} ${ipureScores[key]}</span>`)
    .join("");

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
          <span class="chip chip-asn">${escapeHtml(formatAsn(result.asn) || "ASN 未知")} ${escapeHtml(result.asn_kind_display || "")}</span>
          <span class="chip ${result.is_bogon ? "chip-bad" : "chip-ok"}">${result.is_bogon ? "Bogon 广播" : "公网可达"}</span>
          <span class="chip ${String(result.rpki_status || "").includes("Valid") ? "chip-ok" : "chip-bad"}">RPKI: ${escapeHtml(result.rpki_status || "未知")}</span>
        </div>
        ${ipureScoreChips ? `<div class="modal-tag-row">${ipureScoreChips}</div>` : ""}
      </div>
      <div class="modal-score-box ${coffeeBadgeCls}">
        <span class="modal-score-lbl">Coffee 评分</span>
        <strong class="modal-score-num">${coffeeScore ?? "—"}</strong>
      </div>
      <div class="modal-score-box ${scoreBadgeCls}">
        <span class="modal-score-lbl">IPure 总分</span>
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
    <div class="kv"><span class="k">开放端口<span class="tip-wrap">ⓘ<span class="tip-text">常见端口探测结果</span></span></span><span class="v">${renderOpenPortsHtml(ports, result.requests?.port_scan)}</span></div>
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
      const ms = p.ok && typeof p.elapsed_ms === "number"
        ? `${p.elapsed_ms} ms`
        : normalizeUnavailableLatencyStatus(p.status, "超时");
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
    const hasRiskEvidence = ["is_vpn", "is_proxy", "is_tor", "is_crawler", "is_abuser"]
      .every((key) => typeof result[key] === "boolean");
    if (!hasRiskEvidence) return '<span class="chip chip-info">检测数据不足</span>';
    return '<span class="chip chip-ok">未发现明显威胁</span>';
  }
  const chips = threats.map((t) => {
    const cls = t.severity === "bad" ? "chip-bad" : t.severity === "warn" ? "chip-warn" : "chip-info";
    return `<span class="chip ${cls}">${escapeHtml(t.label || "威胁")}</span>`;
  });
  return chips.join(" ") || '<span class="chip chip-warn">存在风险标记</span>';
}

function renderOpenPortsHtml(ports, request) {
  if (!ports || typeof ports !== "object" || !Object.keys(ports).length) {
    if (!request?.ok) return '<span class="chip chip-info">未检测</span>';
    return '<span class="chip chip-ok">未发现常见端口开放</span>';
  }
  const open = Object.keys(ports).filter((k) => ports[k] === "open" || ports[k] === true);
  if (!open.length) return '<span class="chip chip-ok">未发现常见端口开放</span>';
  return open.map((p) => `<span class="chip chip-warn">端口 ${escapeHtml(p)} 开放</span>`).join(" ");
}
return { openDetails, renderDetails, renderThreatChips, renderOpenPortsHtml };
}

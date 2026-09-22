/* ============================================================================
   页面主控 —— 筛选 / 排序 / 渲染 / 导出接线
   ----------------------------------------------------------------------------
   页面只有三个输入（搜索、状态、排序）和两类按钮（导出、复制）。所有筛选都在内存里
   对 12 条示例记录跑一遍，12 条数据也真的不值得为它上虚拟列表。

   与旧版的差别不只是数量：旧版每次改动都要重算 10 个逐列筛选器 + 全局搜索 + 表格
   排序 + 进度面板，这里只有一条归一化链路——原始记录 → 过滤 → 排序 → 建行。
   ========================================================================== */

import { NODES, SNAPSHOT_META } from "./data.js";
import { createRow, createColGroup, createHeadRow, applyScoreStyles, STATUS_LABELS } from "./render.js";
import { comparableScore } from "./score-color.js";
import { exportSnapshot } from "./snapshot.js";

const elements = {
  query: document.getElementById("query"),
  status: document.getElementById("statusFilter"),
  sort: document.getElementById("sortSelect"),
  grid: document.getElementById("grid"),
  gridColumns: document.getElementById("gridColumns"),
  gridHead: document.getElementById("gridHead"),
  rows: document.getElementById("rows"),
  empty: document.getElementById("emptyState"),
  count: document.getElementById("resultCount"),
  runStats: document.getElementById("runStats"),
  toast: document.getElementById("toast"),
  exportMhtml: document.getElementById("exportMhtml"),
  exportHtml: document.getElementById("exportHtml"),
};

const state = {
  query: "",
  status: "all",
  sortKey: "coffee",
  sortDirection: "desc",
};

/* --------------------------------------------------------------- 检索索引 --- */
// 一次算好可搜索文本，避免每次按键都对 12 条记录重新拼字段。
const searchIndex = new Map(
  NODES.map((result) => [
    result,
    [
      result.node,
      result.type,
      result.exit_ip,
      result.country,
      result.city,
      result.isp,
      result.asn ? `AS${result.asn}` : "",
      result.company_type,
      result.native_status,
      result.error,
      STATUS_LABELS[result.status] || "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("zh-CN"),
  ]),
);

/* ------------------------------------------------------------------ 排序 --- */
function numericValue(result, key) {
  if (key === "coffee") return Number.isFinite(result.coffee_score) ? result.coffee_score : null;
  // IPure 总分的 -1 是「该地区受限」哨兵，不参与数值比较；null 表示上游没给分。
  return comparableScore(result.score);
}

function byNodeName(a, b) {
  return String(a.node).localeCompare(String(b.node), "zh-CN");
}

function comparator() {
  const sign = state.sortDirection === "desc" ? -1 : 1;
  const key = state.sortKey;
  return (a, b) => {
    if (key === "node") return sign * byNodeName(a, b);
    const left = numericValue(a, key);
    const right = numericValue(b, key);
    // 没分的节点永远沉底，而不是在升序时冒充「分数最低」。
    if (left === null && right === null) return byNodeName(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left === right) return byNodeName(a, b);
    return sign * (left - right);
  };
}

/* ------------------------------------------------------------ 过滤 + 排序 --- */
function visibleRows() {
  const needle = state.query.trim().toLocaleLowerCase("zh-CN");
  const filtered = NODES.filter((result) => {
    if (state.status !== "all" && result.status !== state.status) return false;
    if (!needle) return true;
    return searchIndex.get(result).includes(needle);
  });
  return filtered.sort(comparator());
}

/* -------------------------------------------------------------- 渲染一帧 --- */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function labelOf(select) {
  return select.options[select.selectedIndex]?.textContent?.trim() || "";
}

function renderStats() {
  const counts = { success: 0, partial: 0, failed: 0 };
  NODES.forEach((result) => {
    if (counts[result.status] !== undefined) counts[result.status] += 1;
  });
  elements.runStats.replaceChildren(
    statText(String(NODES.length), " 个节点", true),
    statSep(),
    statText(String(counts.success), " 完整", true),
    statSep(),
    statText(String(counts.partial), " 部分", true),
    statSep(),
    statText(String(counts.failed), " 失败", true),
    statSep(),
    statText(`示例生成于 ${SNAPSHOT_META.generatedAt}`, "", false),
  );
}

function statText(value, suffix, strong) {
  const node = document.createElement(strong ? "b" : "span");
  node.textContent = `${value}${suffix}`;
  return node;
}

function statSep() {
  const sep = document.createElement("span");
  sep.className = "sep";
  sep.textContent = "·";
  sep.setAttribute("aria-hidden", "true");
  return sep;
}

function render() {
  const results = visibleRows();
  const ranked = state.sortKey !== "node" && state.sortDirection === "desc";
  const fragment = document.createDocumentFragment();

  results.forEach((result, index) => {
    const position = index + 1;
    // 只有「按分数降序」时前三名才真的是前三名；按名字排序时给第 1 名戴金牌是撒谎。
    const tier = ranked && position <= 3 && numericValue(result, state.sortKey) !== null;
    fragment.append(createRow(result, { position, tier }, document));
  });

  elements.rows.replaceChildren(fragment);
  // 顺序不能颠倒：色带要等元素进了 DOM 之后再用 CSSOM 写，才不会被 CSP 当成内联样式拦掉。
  applyScoreStyles(elements.rows);
  attachCopy(elements.rows);

  elements.empty.hidden = results.length > 0;
  elements.count.textContent = results.length === NODES.length
    ? `当前视图 ${NODES.length} 个节点`
    : `当前视图 ${results.length} 个节点（共 ${NODES.length} 个）`;
}

let frame = null;
function scheduleRender() {
  if (frame !== null) return;
  // 输入事件在 IME 组合期间会很密，合并到一帧里重建列表。
  frame = requestAnimationFrame(() => {
    frame = null;
    render();
  });
}

function attachCopy(root) {
  if (globalThis.BestIpCopy) globalThis.BestIpCopy.attach(root);
}

/* ---------------------------------------------------------------- 提示条 --- */
let toastTimer = null;
function toast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5200);
}

/* ------------------------------------------------------------------ 导出 --- */
async function runExport(format, button) {
  const results = visibleRows();
  button.disabled = true;
  try {
    const artifact = await exportSnapshot(format, {
      rowsHtml: elements.grid.outerHTML,
      total: NODES.length,
      shown: results.length,
      state: {
        query: state.query.trim(),
        statusLabel: labelOf(elements.status),
        sortLabel: labelOf(elements.sort),
        generatedAt: SNAPSHOT_META.generatedAt,
        exportedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
        success: NODES.filter((result) => result.status === "success").length,
        partial: NODES.filter((result) => result.status === "partial").length,
        failed: NODES.filter((result) => result.status === "failed").length,
      },
    });
    const warning = artifact.scriptWarning ? "；但快照内未内联复制脚本，复制按钮不可用" : "";
    toast(`已导出 ${artifact.filename}（${formatBytes(artifact.bytes)}）${warning}`);
  } catch (error) {
    toast(`导出失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ 接线 --- */
elements.query.addEventListener("input", () => {
  state.query = elements.query.value;
  scheduleRender();
});

elements.status.addEventListener("change", () => {
  state.status = elements.status.value;
  render();
});

elements.sort.addEventListener("change", () => {
  const [key, direction] = elements.sort.value.split(":");
  state.sortKey = key;
  state.sortDirection = direction;
  render();
});

elements.exportMhtml.addEventListener("click", () => runExport("mhtml", elements.exportMhtml));
elements.exportHtml.addEventListener("click", () => runExport("html", elements.exportHtml));

/* ------------------------------------------------------------ 表格骨架 --- */
// 表头文案与列宽都由 render.js 的 COLUMNS 生成，只在这里建一次；之后每帧只换 tbody，
// 表头不重建，避免每次输入都重排整张表。
elements.gridColumns.replaceChildren(createColGroup(document));
elements.gridHead.replaceChildren(createHeadRow(document));

renderStats();
render();

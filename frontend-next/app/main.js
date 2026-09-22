/* ============================================================================
   页面主控 —— 筛选 / 排序 / 渲染 / 导出接线
   ----------------------------------------------------------------------------
   页面只有三个输入（搜索、状态、排序）和两类按钮（导出、复制）。所有筛选都在内存里
   对整份数据跑一遍：示例 12 条、真实扫描几十条，都不值得为它上虚拟列表。

   与旧版的差别不只是数量：旧版每次改动都要重算 10 个逐列筛选器 + 全局搜索 + 表格
   排序 + 进度面板，这里只有一条归一化链路——原始记录 → 过滤 → 排序 → 建行。

   数据有三个来源，行对象只有一个形状：
   - 在线部署（site-config.js 说 mode === "gateway"）：本站 Worker 上「最近一次扫描」的
     产物，经 gateway.js 校验后由 records.js 映射成行对象——页面只读，不发起扫描；
   - `?job=<任务 ID>`：本机 loopback 上一次真实扫描的导出，同样的映射；任务只由 URL 参数
     指定，页面不为此增加任何控件；
   - 默认（地址栏没有 ?job= 且不是在线部署）：app/data.js 的合成示例，零网络请求。
   ========================================================================== */

import { NODES, SNAPSHOT_META } from "./data.js";
import { resolveTarget, fetchExport } from "./api.js";
import { fetchLatestScan } from "./gateway.js";
import { toRows, toSnapshotMeta } from "./records.js";
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
// 一次算好可搜索文本，避免每次按键都对整份数据重新拼字段。
function buildSearchIndex(nodes) {
  return new Map(
    nodes.map((result) => [
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
}

// 数据源是运行时可换的：示例数据打开页面就能渲染，真实数据要等 fetch 回来。两者共用
// 同一条渲染链路，所以只有这四个字段会换，其余代码不需要知道数据来自哪里。
const dataset = {
  nodes: NODES,
  meta: SNAPSHOT_META,
  index: buildSearchIndex(NODES),
  real: false,
  // 空状态的两行文字（加载中/加载失败）是「当前数据状态」的一部分，不是一次性的；
  // 数据到位后必须清回默认文案，否则搜不到东西时会显示「正在读取真实扫描结果…」这种假话。
  // null = 用 index.html 里那两句静态文案（启动时抓下来，避免把文案抄成两份）。
  emptyCopy: null,
};

// nodes 与 index 必须同批换：分两次赋值迟早会留下一份对不上号的索引，
// 表现是「搜索框里输入什么都没结果」。
function setNodes(nodes) {
  dataset.nodes = nodes;
  dataset.index = buildSearchIndex(nodes);
}

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
  const filtered = dataset.nodes.filter((result) => {
    if (state.status !== "all" && result.status !== state.status) return false;
    if (!needle) return true;
    return dataset.index.get(result).includes(needle);
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

// 「数据从哪来」这句话只有一处：示例是设计示例，真实数据是某一次真实扫描的导出。
// 两者混着说会让人把合成 IP 当成真实结果（或反过来），所以文案跟着 dataset.real 切。
// meta 为 null 表示真实数据还没到位/没加载成功：宁可不提来源，也不猜一个。
function metaLabel() {
  if (!dataset.meta) return null;
  const prefix = dataset.real ? "真实扫描快照生成于" : "示例生成于";
  return `${prefix} ${dataset.meta.generatedAt}`;
}

function renderStats() {
  const counts = { success: 0, partial: 0, failed: 0 };
  dataset.nodes.forEach((result) => {
    if (counts[result.status] !== undefined) counts[result.status] += 1;
  });
  const parts = [
    statText(String(dataset.nodes.length), " 个节点", true),
    statSep(),
    statText(String(counts.success), " 完整", true),
    statSep(),
    statText(String(counts.partial), " 部分", true),
    statSep(),
    statText(String(counts.failed), " 失败", true),
  ];
  const meta = metaLabel();
  if (meta) parts.push(statSep(), statText(meta, "", false));
  elements.runStats.replaceChildren(...parts);
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

/**
 * 导出按钮的可用性由「有没有数据」单独决定，不能散在 render 与 runExport 两处：
 * 没有任何行时点导出只会产出一个空表快照（且不含来源），在文件列表里跟
 * 「这次扫描确实没扫到节点」分不开。加载中/加载失败/真空结果三种情况都落在这一条上。
 *
 * 按钮的 title 是 index.html 写的（.mhtml 双击可打开 / .html 是兜底），禁用时换成原因，
 * 恢复可用时必须**写回原文案**：原来这里用 removeAttribute，而 render() 每次都会调到这里，
 * 于是页面一加载这两条说明就被永久删掉了（没有任何代码会再写回去）。
 */
const EXPORT_TITLES = {
  mhtml: elements.exportMhtml ? elements.exportMhtml.title : "",
  html: elements.exportHtml ? elements.exportHtml.title : "",
};

function syncExportAvailability() {
  const empty = dataset.nodes.length === 0;
  for (const [button, original] of [
    [elements.exportMhtml, EXPORT_TITLES.mhtml],
    [elements.exportHtml, EXPORT_TITLES.html],
  ]) {
    if (!button) continue;
    button.disabled = empty;
    button.title = empty ? "还没有可导出的扫描结果" : original;
  }
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
  elements.count.textContent = results.length === dataset.nodes.length
    ? `当前视图 ${dataset.nodes.length} 个节点`
    : `当前视图 ${results.length} 个节点（共 ${dataset.nodes.length} 个）`;
  // 没有数据（加载中/加载失败/这个任务真的没记录）时导出按钮不该能点：
  // 导出一份「什么都没有」的快照，在文件列表里和「真的没扫到东西」分不开。
  syncExportAvailability();
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

/* ----------------------------------------------------------- 空状态文案 --- */
// 空状态的两行文字就是「加载中 / 加载失败」的全部表达：复用现有的 #emptyState，
// 不弹窗也不新增控件。示例路径从不调用它，静态文案原样保留。
const EMPTY_DEFAULT = {
  title: document.querySelector("#emptyState .empty-title")?.textContent?.trim() || "没有匹配的节点",
  desc: document.querySelector("#emptyState .empty-desc")?.textContent?.trim() || "试试清空搜索框，或把状态切回「全部状态」。",
};

function applyEmptyCopy() {
  const copy = dataset.emptyCopy || EMPTY_DEFAULT;
  const titleNode = document.querySelector("#emptyState .empty-title");
  const descNode = document.querySelector("#emptyState .empty-desc");
  if (titleNode) titleNode.textContent = copy.title;
  if (descNode) descNode.textContent = copy.desc;
}

function setEmptyState(title, description) {
  dataset.emptyCopy = title === null ? null : { title, desc: description };
  applyEmptyCopy();
}

/* --------------------------------------------------------- 真实数据通路 --- */
// 页面顶上的 badge 默认写着「示例数据」：真实来源下不改口，等于给一屏真实 IP
// 贴上一个「合成数据」的标签。两处真实来源各说各的来源地：在线读的是本站 Worker 上的
// 最近一次扫描，本机读的是 loopback API 上的一次导出——混着说就把「从哪读的」讲错了。
const REAL_ORIGIN = {
  gateway: "来自本站 Worker 上最近一次有结果的扫描产物，只存在内存里",
  local: "来自本机 loopback API 上的一次真实扫描导出，只存在内存里",
};

function markRealSource(origin) {
  const badge = document.querySelector(".tag-demo");
  if (!badge) return;
  badge.textContent = "真实扫描";
  badge.title = `${dataset.meta ? dataset.meta.source : "真实扫描"}：${REAL_ORIGIN[origin] || REAL_ORIGIN.local}`;
}

/**
 * 真实数据到位之前先按「空表 + 加载中」渲染一帧：绝不能先亮一屏合成数据再被顶掉，
 * 那一帧里的 IP 全是假的，肉眼看和截图都可能把它当成这次扫描的结果。
 */
function beginRealSource(origin, title, description) {
  setNodes([]);
  dataset.meta = null;
  dataset.real = true;
  markRealSource(origin);
  renderStats();
  render();
  setEmptyState(title, description);
}

/**
 * 数据到手：换数据、补来源、把空状态清回默认文案——否则「搜不到」时会一直挂着
 * 「正在读取真实扫描结果…」那句假话。meta 到手后再叫一次 markRealSource，
 * badge 的 title 里要能看出这是「哪一次」扫描。
 */
function applyRealPayload(payload, origin, emptyTitle, emptyDesc) {
  setNodes(toRows(payload));
  dataset.meta = toSnapshotMeta(payload);
  markRealSource(origin);
  const empty = dataset.nodes.length === 0;
  setEmptyState(empty ? emptyTitle : null, empty ? emptyDesc : "");
  renderStats();
  render();
}

function failRealData(message) {
  beginRealSource("local", "真实扫描结果没有加载成功",
    `${message}。想换成别的 API 地址可以给页面加上 ?api=<本机 origin>。`);
  toast(`真实扫描加载失败：${message}`);
}

// 在线模式的失败没有 ?api= 这条退路（见 api.js 文件头），所以文案里不提它；
// 真正的成因由 gateway.js 分条给出：没扫过 / 产物已过期 / 还没跑完 / 产物坏了 / 跨源被拦。
// 在线模式的失败没有 ?api= 这条退路（见 api.js 文件头），所以文案里不提它；成因由 gateway.js
// 分条给出：没扫过 / 产物已过期 / 还没跑完 / 产物坏了 / 跨源被拦。标题也照抄它给的那一份——
// 「没有读到结果」套在「从没扫过」和「还在跑」上会把两件不同的事实说成同一次失败。
function failGateway(failure) {
  const title = typeof failure === "object" && failure?.title ? failure.title : "没有读到真实扫描结果";
  const message = (typeof failure === "string" ? failure : failure?.message) || "网关没有说明原因";
  beginRealSource("gateway", title, message);
  toast(`未显示真实扫描结果：${message}`);
}

async function loadRealData(target) {
  beginRealSource("local", "正在读取真实扫描结果…", `任务 ${target.jobId} · ${target.apiBase}`);
  try {
    const payload = await fetchExport(target.apiBase, target.jobId);
    applyRealPayload(payload, "local",
      "这次扫描没有任何节点记录", "任务本身是完成的，但导出里的 results 是空的。");
  } catch (error) {
    failRealData(error.message);
  }
}

// 在线模式：读本站 Worker 上的「最近一次扫描」。选中哪一次由 worker/latest.js 决定，
// 页面这一侧只负责把「最近一次」这件事说清楚，不提供任何选择入口（没有新增控件）。
async function loadGatewayData() {
  beginRealSource("gateway", "正在读取最近一次真实扫描…",
    "结果来自本站 Worker 上的扫描网关；页面只读已经发布的结果，不发起扫描。");
  try {
    const payload = await fetchLatestScan();
    applyRealPayload(payload, "gateway",
      "最近一次扫描没有任何节点记录", "那次运行是完成的，但产物里的 results 是空的。");
  } catch (error) {
    // 整条错误对象交下去：标题要用它带的成因（见 failGateway），只传 message 就只剩正文。
    failGateway(error);
  }
}

/* ------------------------------------------------------------------ 导出 --- */
function countOf(status) {
  return dataset.nodes.filter((result) => result.status === status).length;
}

async function runExport(format, button) {
  const results = visibleRows();
  if (dataset.nodes.length === 0) return;
  button.disabled = true;
  try {
    const artifact = await exportSnapshot(format, {
      rowsHtml: elements.grid.outerHTML,
      total: dataset.nodes.length,
      shown: results.length,
      state: {
        query: state.query.trim(),
        statusLabel: labelOf(elements.status),
        sortLabel: labelOf(elements.sort),
        // 快照会被归档、被转发，来源必须跟着页面一起走，否则一份真实结果和一个
        // 设计示例在文件里长得一模一样。
        source: dataset.meta?.source || "",
        generatedAt: dataset.meta?.generatedAt || "时间未知",
        exportedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
        success: countOf("success"),
        partial: countOf("partial"),
        failed: countOf("failed"),
      },
    });
    const warning = artifact.scriptWarning ? "；但快照内未内联复制脚本，复制按钮不可用" : "";
    toast(`已导出 ${artifact.filename}（${formatBytes(artifact.bytes)}）${warning}`);
  } catch (error) {
    toast(`导出失败：${error.message}`);
  } finally {
    // 只恢复「这一次点击」的禁用状态；没有数据时由 render() 保持禁用。
    syncExportAvailability();
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

/* ------------------------------------------------------------ 表格骨架/启动 --- */
// 表头文案与列宽都由 render.js 的 COLUMNS 生成，只在这里建一次；之后每帧只换 tbody，
// 表头不重建，避免每次输入都重排整张表。
elements.gridColumns.replaceChildren(createColGroup(document));
elements.gridHead.replaceChildren(createHeadRow(document));

const target = resolveTarget({
  search: globalThis.location?.search || "",
  config: globalThis.BEST_IP_CONFIG,
});

// 顺序不能反：`?job=`（写了但为空）会同时满足「jobId 为空」和「有 error」，
// 先判 jobId 就会把它当成演示路径，给出一条满屏合成 IP、零提示的深链。
// 在线模式排在最前面：它的「没有数据」和「读失败」都只有一条路（本站 Worker），
// 拿本机那套 ?api= 文案去解释它只会把人指向一个在生产里根本不存在的地址。
if (target.error) {
  // 两处失败能走的退路不同，所以按来源分岔，而不是共用一句「加载失败」。
  if (target.mode === "gateway") failGateway(target.error);
  else failRealData(target.error);
} else if (target.mode === "gateway") {
  // 同样不 await：先让页面把「正在读取」那一帧显示出来。
  loadGatewayData();
} else if (!target.jobId) {
  // 静态示例路径：不解析 API 地址、不发任何请求，打开即是一屏完整内容。
  renderStats();
  render();
} else {
  // 不 await：加载是异步的，成败都已在 loadRealData 内部转成渲染结果，
  // 先让页面把「正在读取」这一帧显示出来。
  loadRealData(target);
}

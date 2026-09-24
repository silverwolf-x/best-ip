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
import { startScan, pollScan, cancelScan, validateSubscriptionUrl, SCAN_POLL_FIRST_MS, SCAN_POLL_MAX_MS } from "./scan.js";
import { toRows, toSnapshotMeta } from "./records.js";
import { createRow, createColGroup, createHeadRow, applyScoreStyles, STATUS_LABELS } from "./render.js";
import { comparableScore } from "./score-color.js";
import { exportSnapshot } from "./snapshot.js";

/* ------------------------------------------------------------- 元素解析 --- */
// 页面是静态源码直上线的，没有构建期检查：id 被改名或删掉只会在运行时报错，而模块顶层拿一个
// null 去 addEventListener 就是 TypeError、整页白屏——那是最难查的一种失败。所以「必需」的 id
// 集中列在这里，缺了哪个都记下来，启动前统一处理（见 reportMissingElements）。
const REQUIRED_ELEMENT_IDS = {
  query: "query",
  status: "statusFilter",
  sort: "sortSelect",
  grid: "grid",
  gridColumns: "gridColumns",
  gridHead: "gridHead",
  rows: "rows",
  empty: "emptyState",
  count: "resultCount",
  runStats: "runStats",
};

// toast 与两个导出按钮不在必需表里：它们只是反馈层与可选功能，缺了最多是少一条提示、
// 少一个按钮（判空见 toast 与 syncExportAvailability），该显示的东西照旧显示。
const elements = {
  toast: document.getElementById("toast"),
  exportMhtml: document.getElementById("exportMhtml"),
  exportHtml: document.getElementById("exportHtml"),
};

const missingElementIds = [];
for (const [key, id] of Object.entries(REQUIRED_ELEMENT_IDS)) {
  const node = document.getElementById(id);
  if (node) elements[key] = node;
  else missingElementIds.push(`#${id}`);
}

/**
 * 缺任何必需元素时的唯一出路：把缺什么聚合说一次，而不是让它在后面某一行抛出去。
 * 出口按「用户一定能看见」的程度往后退：空状态那块 → 结果计数那一行 → toast → <body>。
 * 前两个是常驻文字，toast 只是过场提示，<body> 是整块骨架都没了之后唯一还能写字的地方；
 * 无论如何都不留白屏。
 */
function reportMissingElements(ids) {
  const message = `页面缺少必需的 DOM 元素：${ids.join("、")}，界面无法渲染。`;
  console.error(message);
  const empty = document.getElementById("emptyState");
  const emptyTitle = empty?.querySelector(".empty-title");
  const emptyDesc = empty?.querySelector(".empty-desc");
  if (empty && emptyTitle && emptyDesc) {
    emptyTitle.textContent = "页面结构不完整，无法渲染";
    emptyDesc.textContent = message;
    empty.hidden = false;
    return;
  }
  if (elements.count) {
    elements.count.textContent = message;
    return;
  }
  if (elements.toast) {
    toast(message);
    return;
  }
  document.body.textContent = message;
}

/** 排序下拉的 value 形状是 "key:direction"（见 index.html 的 option），内存态由它派生。 */
function readSortValue(value) {
  const [key, direction] = String(value || "").split(":");
  // 下拉的 value 被改坏时退回默认排序，而不是把 undefined 灌进 state（比较器会静默排错）。
  return key && direction
    ? { sortKey: key, sortDirection: direction }
    : { sortKey: "coffee", sortDirection: "desc" };
}

// 初值从 DOM 读，不能假定 index.html 的默认值：刷新/后退时浏览器会恢复表单值（搜索框里还留着
// 上次的关键字、状态下拉还停在「失败」），内存里若仍是「空搜索 + 全部状态」，页面就会显示一份
// 与输入框对不上的列表，导出摘要还会把它写成「筛选：无」。
const state = {
  query: elements.query?.value ?? "",
  status: elements.status?.value ?? "all",
  ...readSortValue(elements.sort?.value),
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
// 同一条渲染链路，所以只有这几个字段会换，其余代码不需要知道数据来自哪里。
// 这里没有「是不是真实来源」的布尔量：那件事由 meta 表达——真实数据的 meta 由
// toSnapshotMeta() 现造，只有示例路径留着 data.js 的 SNAPSHOT_META，来源未到位时是 null。
// 两个字段说同一件事就只能靠调用顺序保持一致，所以只留 meta（见 metaLabel）。
const dataset = {
  nodes: NODES,
  meta: SNAPSHOT_META,
  index: buildSearchIndex(NODES),
  // 数据版本：setNodes 每次 +1。渲染的脏检查与状态计数缓存都用它判断「这份数据换过了没」，
  // 不必逐条比较内容。
  version: 0,
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
  dataset.version += 1;
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
// 两者混着说会让人把合成 IP 当成真实结果（或反过来），所以文案跟着来源切。
//
// 「是不是示例」用 meta 的**对象引用**判断，不另立一个布尔量：dataset.meta 只会取三个值——
// SNAPSHOT_META（示例）、null（真实数据还没到位/加载失败，宁可不提来源也不猜）、
// toSnapshotMeta() 现造的另一个对象（真实数据）。用引用而不是比 source 文案，是因为文案是
// 会改的展示文字，改了这里就会悄悄判反。
function metaLabel() {
  if (!dataset.meta) return null;
  const prefix = dataset.meta === SNAPSHOT_META ? "示例生成于" : "真实扫描快照生成于";
  return `${prefix} ${dataset.meta.generatedAt}`;
}

// 状态计数是整表遍历，顶部统计行和导出摘要都要它，所以按数据版本缓存一份：
// 原来 renderStats 在局部算一遍，导出那边再用 countOf 对整份数据各 filter 三遍。
let countsCache = { version: -1, counts: null };

function statusCounts() {
  if (countsCache.version !== dataset.version) {
    const counts = { success: 0, partial: 0, failed: 0 };
    dataset.nodes.forEach((result) => {
      if (counts[result.status] !== undefined) counts[result.status] += 1;
    });
    countsCache = { version: dataset.version, counts };
  }
  return countsCache.counts;
}

function renderStats() {
  const counts = statusCounts();
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

// 渲染输入指纹：数据版本（setNodes 时 +1）+ 搜索 + 状态 + 排序。这四样没变，可见行和每行的
// DOM 就必然与上一帧逐字一样，于是整表重建（replaceChildren + 色带 + 复制接线）可以整段跳过：
// 它会把滚动位置、按钮焦点和正在显示中的复制反馈一起丢掉，而什么都没换。
let lastRenderKey = null;

function renderKey() {
  return `${dataset.version}|${state.query}|${state.status}|${state.sortKey}:${state.sortDirection}`;
}

// 渲染时算出来的可见行：导出要的「有多少行」就是这一份（见 runExport），不必再跑一次 filter+sort。
let lastVisibleRows = [];

function render() {
  const key = renderKey();
  if (key !== lastRenderKey) {
    lastRenderKey = key;
    lastVisibleRows = visibleRows();
    const ranked = state.sortKey !== "node" && state.sortDirection === "desc";
    const fragment = document.createDocumentFragment();

    lastVisibleRows.forEach((result, index) => {
      const position = index + 1;
      // 只有「按分数降序」时前三名才真的是前三名；按名字排序时给第 1 名戴金牌是撒谎。
      const tier = ranked && position <= 3 && numericValue(result, state.sortKey) !== null;
      fragment.append(createRow(result, { position, tier }, document));
    });

    elements.rows.replaceChildren(fragment);
    // 顺序不能颠倒：色带要等元素进了 DOM 之后再用 CSSOM 写，才不会被 CSP 当成内联样式拦掉。
    applyScoreStyles(elements.rows);
    attachCopy(elements.rows);
  }

  const results = lastVisibleRows;
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

/**
 * 把排队中的那一帧渲染立刻落下来。
 *
 * 单独一个函数是因为「导出」必须在一致的状态下读 DOM：见 runExport 开头那段。
 */
function flushPendingRender() {
  if (frame === null) return;
  cancelAnimationFrame(frame);
  frame = null;
  render();
}

function attachCopy(root) {
  if (globalThis.BestIpCopy) globalThis.BestIpCopy.attach(root);
}

/* ---------------------------------------------------------------- 提示条 --- */
let toastTimer = null;
function toast(message) {
  // toast 是可选的（见 elements 的注释）：它没被解析到时，少一个提示远好过让整条链路抛错。
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5200);
}

// pagehide 时把排队的帧与提示定时器清掉：留着它们会在文档已经不能画之后（或被塞进
// bfcache 时）再跑一次渲染、再改一次可见性，而那两件事都不该发生在一个已经离开的页面上。
globalThis.addEventListener("pagehide", () => {
  if (frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
});

/* ----------------------------------------------------------- 空状态文案 --- */
// 空状态的两行文字就是「加载中 / 加载失败」的全部表达：复用现有的 #emptyState，
// 不弹窗也不新增控件。示例路径从不调用它，静态文案原样保留。
// 这两个节点在 index.html 里各只有一处，启动时抓一次引用就够：applyEmptyCopy 会在
// 「加载中 / 加载失败 / 搜不到」之间来回切，原先每次调用都重新 querySelector 两个节点。
const EMPTY_NODES = {
  title: document.querySelector("#emptyState .empty-title"),
  desc: document.querySelector("#emptyState .empty-desc"),
};
const EMPTY_DEFAULT = {
  title: EMPTY_NODES.title?.textContent?.trim() || "没有匹配的节点",
  desc: EMPTY_NODES.desc?.textContent?.trim() || "试试清空搜索框，或把状态切回「全部状态」。",
};

function applyEmptyCopy() {
  const copy = dataset.emptyCopy || EMPTY_DEFAULT;
  if (EMPTY_NODES.title) EMPTY_NODES.title.textContent = copy.title;
  if (EMPTY_NODES.desc) EMPTY_NODES.desc.textContent = copy.desc;
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
  // meta 置 null 这件事本身就是「真实来源」的载体（见 metaLabel）：真实数据的 meta 由
  // toSnapshotMeta() 现造，只有示例路径才留着 data.js 的 SNAPSHOT_META。
  dataset.meta = null;
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
    failRealData(error?.message || String(error));
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
/**
 * 导出摘要里的状态计数与顶部统计行说的是同一件事，两边都用缓存过的 statusCounts()：
 * 原来 countOf 在这里对整份数据各 filter 三遍，而 renderStats 已经算过一次同样的数字。
 */
async function runExport(format, button) {
  if (dataset.nodes.length === 0) return;
  // 导出读的是渲染缓存（可见行 + elements.grid.outerHTML），而搜索框的输入是当下就写进 state、
  // 表格重建只排在下一个 rAF 里。不把那一帧落下来，快照就会是「筛选：<刚敲的字>」配一张上一帧
  // 的旧表——正文、行数、摘要三者必须取自同一时刻，所以这里先 flush。
  flushPendingRender();
  // 可见行直接用渲染时算好的那一份：原来为了取 length 又跑一遍 filter + sort，而且它读的是
  // 「此刻内存态」的行数、正文却是上一帧的 outerHTML，两个数字能对不上。
  const results = lastVisibleRows;
  const counts = statusCounts();
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
        success: counts.success,
        partial: counts.partial,
        failed: counts.failed,
      },
    });
    // .mhtml 从不内联复制脚本（那是决策、不是失败），所以「没读到 copy.js」只对 .html 有意义：
    // 那边按钮本来能用，读不到才会真的按不动。原来两种格式共用这一句，mhtml 上说的是假成因。
    const warning = format === "html" && artifact.scriptWarning
      ? "；但快照内未内联复制脚本，复制按钮不可用"
      : "";
    toast(`已导出 ${artifact.filename}（${formatBytes(artifact.bytes)}）${warning}`);
  } catch (error) {
    toast(`导出失败：${error?.message || String(error)}`);
  } finally {
    // 只恢复「这一次点击」的禁用状态；没有数据时由 render() 保持禁用。
    syncExportAvailability();
  }
}

/* ------------------------------------------------------------ 扫描入口 --- */
// 页面上的扫描只有三样东西：一个订阅地址输入、一个开始按钮、一行进度。整条链路的实现都在
// app/scan.js（加密、派发、轮询、取产物），这里只管「什么时候调它」和「把话说给谁看」。
const scanElements = {
  form: document.getElementById("scanForm"),
  url: document.getElementById("subscriptionUrl"),
  start: document.getElementById("startScan"),
  stop: document.getElementById("stopScan"),
  progress: document.getElementById("scanProgress"),
};

// 同一时刻只允许一次扫描：generation 用来作废上一轮还在路上的轮询与重试（旧前端
// scan-controller 的做法）。刷新页面就丢掉一切——扫描凭证只存在内存，见 app/scan.js 的文件头。
const scan = {
  session: null,
  generation: 0,
  timer: null,
  delay: SCAN_POLL_FIRST_MS,
  // starting 是同步闸：加密 + POST 那一整段里 session 还是 null（它要等 202 才有），
  // 只靠 session 挡不住连点两次提交。
  starting: false,
  cancelling: false,
  pendingCancel: false,
};

/** 进度那一行：空字符串就藏掉，别留一条空白的行高顶着顶部条。 */
function setScanProgress(text) {
  if (!scanElements.progress) return;
  scanElements.progress.textContent = text;
  scanElements.progress.hidden = !text;
}

function setScanBusy(busy) {
  if (scanElements.start) scanElements.start.disabled = busy;
  if (scanElements.url) scanElements.url.disabled = busy;
  if (scanElements.stop) {
    scanElements.stop.hidden = !busy;
    scanElements.stop.disabled = false;
  }
}

function stopPolling() {
  if (scan.timer !== null) clearTimeout(scan.timer);
  scan.timer = null;
}

function finishScan() {
  stopPolling();
  scan.session = null;
  scan.starting = false;
  scan.cancelling = false;
  scan.pendingCancel = false;
  setScanBusy(false);
}

/**
 * 收口一次扫描失败。
 *
 * keepSession 只给「等不到确认」那两种情形用（cancel_timeout / scan_deadline，见 pollOnce）：
 * 任务可能还在后台跑着，把会话和「停止」按钮一起收走，用户就再也没有那个按钮可按了——
 * 而 scan.js 的那句文案恰好是「请再点一次「停止」」。留下会话就等于把那句话兑现。
 *
 * keepTable 给「派发就没被接受」那一种用：那时表里还是上一轮的结果，没理由连带丢掉它。
 */
function failScan(message, { keepSession = false, keepTable = false } = {}) {
  if (keepSession && scan.session) {
    stopPolling();
    scan.starting = false;
    scan.cancelling = false;
    scan.pendingCancel = false;
    setScanBusy(true);
    setScanProgress(message);
    toast(`扫描失败：${message}`);
    return;
  }
  finishScan();
  setScanProgress(message);
  if (!keepTable) beginRealSource("gateway", "扫描没有成功", `${message}。稍后可以再点一次「开始扫描」。`);
  toast(`扫描失败：${message}`);
}

/**
 * 启动时决定这一块显不显示：只有「本站有网关」才谈得上发起扫描。
 * 公钥指纹（SCAN_KEY_ID）缺失时把按钮关掉并说明原因——摆一个点了必然被 400/503 拒掉的
 * 按钮，比明说「这里发不了扫描」更糟。
 */
function revealScanBar() {
  if (!scanElements.form) return;
  scanElements.form.hidden = false;
  const keyId = String(globalThis.BEST_IP_CONFIG?.keyId || "");
  if (/^[a-f0-9]{64}$/u.test(keyId)) return;
  if (scanElements.start) scanElements.start.disabled = true;
  setScanProgress("本站没有配置扫描公钥（SCAN_KEY_ID），这个页面暂时发不了扫描。");
}

async function beginScan() {
  const url = String(scanElements.url?.value || "").trim();
  try {
    validateSubscriptionUrl(url);
  } catch (error) {
    // 地址本身写错时不动表格：清掉一屏已有结果去换一句「格式不对」不划算。
    // 非 Error 的抛出（自定义抛字符串）也要有可读文案，不能显示 "undefined"。
    const message = error?.message || String(error);
    toast(message);
    setScanProgress(message);
    scanElements.url?.focus();
    return;
  }
  scan.generation += 1;
  const generation = scan.generation;
  stopPolling();
  scan.delay = SCAN_POLL_FIRST_MS;
  scan.starting = true;
  scan.cancelling = false;
  scan.pendingCancel = false;
  scan.session = null;
  setScanBusy(true);
  setScanProgress("正在加密订阅地址并交给扫描网关…");
  let session;
  try {
    session = await startScan(url, globalThis.BEST_IP_CONFIG, {});
  } catch (error) {
    if (generation !== scan.generation) return;
    // 派发就没被接受：表里还是上一轮的结果，留着它，只把原因说出来。
    failScan(error?.message || String(error), { keepTable: true });
    return;
  }
  if (generation !== scan.generation) return;
  scan.session = session;
  scan.starting = false;
  // 派发被接受（202）之后才清表：地址合法但网关拒了（403/503、指纹不符、POST 超时）不该让
  // 用户连带丢掉上一屏还能看的结果。清表与填表之间也没有「同框」窗口——一次扫描要么还没清，
  // 要么整屏换成这一轮的结果。
  beginRealSource("gateway", "正在扫描…", "扫描完成后这张表会自动填上刚扫出来的节点。");
  // 提交期间点过「停止」（onStopClick 的 starting 分支）：会话一到手就立刻发出去，
  // 不等首轮轮询回来——pollOnce 里那条 pendingCancel 分支要等一轮状态请求才有机会跑。
  // 没点过停止则照旧排首轮轮询：刚拿到 202 时运行往往还没建立，立刻问只是白问一次。
  if (scan.pendingCancel) sendStopRequest(generation);
  else schedulePoll(generation, SCAN_POLL_FIRST_MS);
}

/** 下一次轮询的间隔：每次 ×1.5，上限 SCAN_POLL_MAX_MS。 */
function nextDelay() {
  scan.delay = Math.min(SCAN_POLL_MAX_MS, Math.round(scan.delay * 1.5));
  return scan.delay;
}

function schedulePoll(generation, delay) {
  stopPolling();
  scan.timer = setTimeout(() => {
    // pollOnce 自己已经把可预期的失败转成了界面文案；这里兜住的是「不该发生的那一种」，
    // 让它以一句真话收口，而不是变成一条没人看的未捕获拒绝。
    pollOnce(generation).catch((error) => {
      if (generation !== scan.generation) return;
      failScan(error?.message || "扫描状态读取失败");
    });
  }, delay);
}

async function pollOnce(generation) {
  if (generation !== scan.generation || !scan.session) return;
  let state;
  try {
    state = await pollScan(scan.session, {});
  } catch (error) {
    if (generation !== scan.generation) return;
    // 明确不是瞬时故障（任务对不上 / 超过等待上限 / 取消等不到确认）就不再刷请求，把真话
    // 说出来；其余（网络抖动、边缘 5xx、200 却不是 JSON）保留一次退避重试，别让一次抖动
    // 把整次扫描判死。
    if (error.retryable !== true) {
      // 「等不到确认」这两种，任务可能还在后台跑：会话留着，用户才有「停止」可按。
      const keepSession = error.code === "cancel_timeout" || error.code === "scan_deadline";
      failScan(error?.message || String(error), { keepSession });
      return;
    }
    setScanProgress(`读取扫描状态失败，正在重试：${error?.message || String(error)}`);
    schedulePoll(generation, nextDelay());
    return;
  }
  if (generation !== scan.generation) return;
  setScanProgress(state.detail ? `${state.label} · ${state.detail}` : state.label);
  if (state.done) {
    if (state.failure) {
      // 用户自己点的停止：说「已按你的请求停止」比转述上游的 conclusion 值更像人话。
      const stopped = Boolean(scan.session?.cancelRequestedAt) && state.status === "cancelled";
      failScan(stopped ? "已按你的请求停止这次扫描，没有可显示的结果" : state.failure);
      return;
    }
    finishScan();
    applyRealPayload(state.payload, "gateway",
      "这次扫描没有任何节点记录", "那次运行是完成的，但产物里的 results 是空的。");
    toast(`扫描完成：已显示刚扫出来的 ${dataset.nodes.length} 个节点。`);
    return;
  }
  // 还在跑。点过「停止」但那时运行还没建立，就在这里补发一次。
  if (scan.pendingCancel) { await requestStop(generation); return; }
  schedulePoll(generation, nextDelay());
}

async function requestStop(generation) {
  if (!scan.session) return;
  scan.pendingCancel = false;
  try {
    const result = await cancelScan(scan.session, {});
    if (generation !== scan.generation || !scan.session) return;
    if (result.requested === false) {
      // 运行还没出现：Worker 侧无运行可取消，等下一轮轮询看到 run 再补发。
      scan.pendingCancel = true;
      setScanProgress("扫描运行还没建立，停止请求会在它出现后立刻补发…");
    } else {
      // 请求已经发出去了，cancelling 必须在这里复位：它不复位就一直为真，onStopClick
      // 会永久早退——用户再点「停止」毫无反应，只能等 cancel_timeout（最长 2 分钟）才恢复。
      scan.cancelling = false;
      setScanProgress("已请求停止，等待执行端确认结束（取消不等于清理已完成）…");
    }
  } catch (error) {
    if (generation !== scan.generation || !scan.session) return;
    // 一次停止请求没发出去不能把按钮废掉：复位这两个标志，用户才点得动第二次——
    // scan.js 的「请再点一次「停止」」正是这么承诺的。
    scan.cancelling = false;
    scan.pendingCancel = true;
    setScanProgress(`停止失败：${error?.message || String(error)}`);
  }
  if (generation !== scan.generation || !scan.session) return;
  schedulePoll(generation, nextDelay());
}

/**
 * 发一次停止请求。requestStop 内部的 try 只兜住 cancelScan 本身，它自己后面那几步
 * （进度文案、续排轮询）任一处提前抛都会变成一条没人看的未捕获拒绝，而界面还停在
 * 「正在请求停止…」。这里把那种失败收成一句界面文案。
 */
function sendStopRequest(generation) {
  requestStop(generation).catch((error) => {
    if (generation !== scan.generation) return;
    scan.cancelling = false;
    scan.pendingCancel = false;
    setScanProgress(`停止失败：${error?.message || String(error)}`);
  });
}

function onStopClick() {
  // 加密 + POST 那段窗口里「停止」已经显示，但会话要等 202 才有（scan.session 还是 null）。
  // 原来这里直接 return，于是最长 START_TIMEOUT_MS（30 秒）里按钮按下去毫无反馈。
  // 记下 pendingCancel，会话一到手就立刻把停止请求发出去（见 beginScan 的收尾）。
  if (!scan.session) {
    if (scan.starting) {
      scan.pendingCancel = true;
      scan.cancelling = true;
      setScanProgress("扫描正在提交，已记下停止请求：一旦开始运行就立刻停止…");
    }
    return;
  }
  if (scan.cancelling) return;
  // 先掐掉已经排好的那一次轮询：不然它和这次停止请求同时在路上，白多一轮状态请求。
  stopPolling();
  scan.cancelling = true;
  scan.pendingCancel = true;
  setScanProgress("正在请求停止…");
  sendStopRequest(scan.generation);
}

/* ------------------------------------------------------------------ 接线 --- */
// 接线与启动都收进函数，是为了给「必需元素缺失」留一条明确路径（见文件末尾）：
// 逐条 addEventListener 都指着一个可能不存在的节点，缺一个就是模块顶层的 TypeError，
// 整页白屏——那是最难查的一种失败。
function wireControls() {
  elements.query.addEventListener("input", () => {
    state.query = elements.query.value;
    scheduleRender();
  });

  // change 与 input 走同一条 rAF 调度：change 里直接 render() 是同步重建整表，
  // 而输入事件正排着一个 rAF，同一帧里就会连着重建两次（第二次的输入完全没变）。
  elements.status.addEventListener("change", () => {
    state.status = elements.status.value;
    scheduleRender();
  });

  elements.sort.addEventListener("change", () => {
    const next = readSortValue(elements.sort.value);
    state.sortKey = next.sortKey;
    state.sortDirection = next.sortDirection;
    scheduleRender();
  });

  // 导出按钮是可选的（见 elements 的注释）：它们没解析到就不接线，页面照旧显示。
  if (elements.exportMhtml) {
    elements.exportMhtml.addEventListener("click", () => runExport("mhtml", elements.exportMhtml));
  }
  if (elements.exportHtml) {
    elements.exportHtml.addEventListener("click", () => runExport("html", elements.exportHtml));
  }

  // 表单默认提交会让浏览器导航（这里没有 action，会重载当前地址，凭证与进度全丢），
  // 所以必须拦下来；扫描进行中重复提交也只认第一次。判据是 session 或 starting——
  // 加密 + POST 那一段里 session 还是 null，光看它会漏掉「连点两下」。
  if (scanElements.form) {
    scanElements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (scan.session || scan.starting) return;
      beginScan();
    });
  }
  if (scanElements.stop) scanElements.stop.addEventListener("click", onStopClick);
}

/* ------------------------------------------------------------ 表格骨架/启动 --- */
function boot() {
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
  // 扫描入口只属于在线部署：那里才有本站的 Worker 网关与扫描公钥。它与下面三条分支无关——
  // 那三条决定这张表显示什么，这一块决定「能不能在本页发起一次扫描」。
  if (target.mode === "gateway") revealScanBar();

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
}

// 必需元素缺任何一个就既不接线也不加载：整条链路都指着一个不存在的节点，继续跑只会在
// 某个 undefined 上抛错，把剩下的半张页面也带走。缺什么就说什么，静态骨架照旧可见。
if (missingElementIds.length) {
  reportMissingElements(missingElementIds);
} else {
  wireControls();
  boot();
}

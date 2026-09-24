/* ============================================================================
   行渲染 —— 一个节点 = 宽表的一行 = 9 项信息全部在行内
   ----------------------------------------------------------------------------
   旧版是 12 列宽表再挂一个详情弹窗补全字段。新版**保留宽表的信息密度**，但把两级
   合成一级：一行的十列就是全部结论——排名、节点、出口 IP、国家/地区、服务商/ISP、
   住宅或机房、原生性、Coffee 评分、IPure 总分、六项场景评分。没有折叠、没有弹窗、
   没有二级页；表头也不挂逐列筛选器，筛选只留全局搜索 + 状态筛选。

   COLUMNS 是**唯一**的列真值：表头文案、colgroup 宽度、单元格在窄屏折叠时用的
   data-label 全部由它生成。三处各写一份必然漂移，所以这里只写一份。

   CSP 约束（生产是 style-src 'self'）：分数色带只能等元素进了 DOM 之后用 CSSOM
   赋值，不能拼进标记的 style 属性里。见 applyScoreStyles。
   ========================================================================== */

import { SCENARIO_LABELS } from "./data.js";
import { ipureScoreInlineStyle } from "./score-color.js";

const STATUS_LABELS = { success: "完整", partial: "部分", failed: "失败" };

/* --------------------------------------------------------------- 列定义 --- */
// width 是列宽的**唯一**来源，值来自真实浏览器的实测（见 styles.css 表格段的注释）：
// 每列按「内容自然宽度」给，谁也不许白占地方——窄列攒下的 77px 正好够「节点」列
// 从 184 涨到 268（原来 7/12 行的协议 tag 与状态药丸被省略号吃掉）。268 是这样来的：
// 最长的一行（洛杉矶 ColoCrossing-03 + 状态药丸）实测要 275.83px，该格左右内边距
// 从 9px 收到 5px 后再省 8px → 266.83px，取 268 留 1px 余量。
// width 为空表示吃掉剩余宽度；align=center 用于分数列，等宽数字右对齐反而不齐。
// 注意：col 元素不支持 min-width，「IPure 场景评分」那列不允许折行的硬下限写在 CSS 里。
export const COLUMNS = [
  { key: "rank", label: "#", width: "40px" },
  { key: "ident", label: "节点", width: "268px" },
  { key: "ip", label: "出口 IP", width: "168px" },
  // 归属地列只写国家：真实数据里城市常与国家同名（Hong Kong Hong Kong），一列里写两遍
  // 不增信息，116px 还被城市吃掉一半。表头写「国家和地区」而不是「国家」——这一列的值里
  // 就有「香港」这类不是国家的地区；措辞的理由见 .agents/notes 里 2026-09-23 的表头笔记。
  // 96px 的来历：62 行真实+示例数据里最长的国家是 "United States"，含左右内边距实测
  // 83.94px，留 12px 余量。表头「国家和地区」在 10.5px/800/0.07em 下含内边距实测 75.19px，
  // 也装得下（th 是 nowrap，最小内容宽就是它，不会向表格算法多要宽度）。城市仍可搜
  // （main.js 的检索索引），只是不占列宽。
  { key: "geo", label: "国家和地区", width: "96px" },
  { key: "isp", label: "服务商 / ISP", width: "168px" },
  { key: "kind", label: "接入", width: "58px" },
  { key: "native", label: "原生性", width: "58px" },
  { key: "coffee", label: "Coffee", width: "62px", align: "center" },
  { key: "ipure", label: "IPure", width: "58px", align: "center" },
  { key: "scn", label: "IPure 场景评分" },
];

// 失败节点缺的是同一组字段（出口 IP / 地区 / 服务商 / 接入 / 原生性），
// 用一个 colspan 单元格说明原因，比摆五个「—」更省地方也更诚实。
const ABSENT_KEYS = ["ip", "geo", "isp", "kind", "native"];

// labelOf 是每个单元格都要走一次的热路径（一行十个 td），每次 find 线性扫一遍 COLUMNS 不划算：
// 映射在模块加载时建一次，之后只查表。用 ?? 而不是 ||：label 为空串时也要原样返回。
const LABEL_BY_KEY = new Map(COLUMNS.map((column) => [column.key, column.label]));

function labelOf(key) {
  return LABEL_BY_KEY.get(key) ?? key;
}

/* -------------------------------------------------------------- 表头 --- */
// col-<key> 是 colgroup 与 thead 共用的命名契约（styles.css 只消费 col-scn 的 min-width，
// 其余九个暂时没有规则）。这十个 class 保留：删掉就得给表头另起一套命名，而 colgroup 的
// 宽度本来就靠 COLUMNS 生成，两处的钩子名必须对得上。
export function createColGroup(document) {
  const group = document.createDocumentFragment();
  COLUMNS.forEach((column) => {
    const col = document.createElement("col");
    col.className = `col-${column.key}`;
    if (column.width) col.style.width = column.width;
    group.append(col);
  });
  return group;
}

export function createHeadRow(document) {
  const row = document.createElement("tr");
  COLUMNS.forEach((column) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.className = `col-${column.key}`;
    if (column.align) th.dataset.align = column.align;
    th.textContent = column.label;
    row.append(th);
  });
  return row;
}

/* ------------------------------------------------------------- 小工具 --- */
/** 左侧导轨与状态药丸共用的语义：good=住宅+原生，mixed=可用但有折损，bad=失败。 */
export function verdictOf(result) {
  if (result.status === "failed") return "bad";
  if (result.status === "partial") return "mixed";
  return result.is_residential === true && result.is_native === true ? "good" : "mixed";
}
/**
 * 归属地只写国家。原先是「国家 · 城市」，但真实数据里城市经常和国家同名
 * （`Hong Kong Hong Kong`），一列里出现两次同样的字只占宽度不增信息；这一列
 * 本来只有 116px 还被城市吃掉一半。城市仍然可搜（见 main.js 的检索索引），只是不占列宽。
 */
function locationText(result) {
  if (result.country) return result.country;
  return result.exit_ip ? "归属地未知" : "位置未知";
}

function formatAsn(asn) {
  const value = Number(asn);
  return Number.isFinite(value) && value > 0 ? `AS${value}` : "";
}

function coffeeBand(score) {
  if (!Number.isFinite(score)) return "na";
  if (score >= 75) return "good";
  if (score >= 45) return "warn";
  return "bad";
}

function el(document, tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function chip(document, label, tone) {
  const node = el(document, "span", `chip chip-${tone}`);
  node.textContent = label;
  return node;
}

function textCell(document, key, className) {
  const td = el(document, "td", className);
  td.dataset.label = labelOf(key);
  return td;
}

/* --------------------------------------------------------------- 单元格 --- */
function rankCell(document, position) {
  const td = textCell(document, "rank", "rank");
  td.textContent = String(position);
  td.setAttribute("aria-label", `第 ${position} 位`);
  return td;
}

function identCell(document, result) {
  const td = textCell(document, "ident", "ident");
  const name = el(document, "span", "node");
  name.textContent = result.node || "未命名节点";
  name.title = result.node || "未命名节点";
  td.append(name);

  if (result.type) {
    const proto = el(document, "span", "proto");
    proto.textContent = result.type;
    td.append(proto);
  }

  // 行状态药丸只在非「完整」时出现：完整是常态，每行都挂一个「完整」就是噪声。
  // 失败行的原因写在后面的 colspan 单元格里，这里只标记状态本身。
  if (result.status === "partial") td.append(chip(document, STATUS_LABELS.partial, "warn"));
  else if (result.status === "failed") td.append(chip(document, STATUS_LABELS.failed, "bad"));

  // 这一列是十列里唯一还可能省略号的（最长的一行要 275.83px，列宽 268px）：会被吃掉
  // 的是末尾状态药丸，所以整格带上 title，鼠标停上去（不论停在哪一段）都能读到状态。
  td.title = result.status && result.status !== "success"
    ? `${result.node || "未命名节点"}（${STATUS_LABELS[result.status]}）`
    : result.node || "未命名节点";
  // 节点名自己也有 title，而它盖在整格上面：两处写一样的内容，否则鼠标停在节点名上
  // （最自然的悬停位置）反而读不到状态——实测 elementFromPoint 命中的是 span.node。
  name.title = td.title;

  return td;
}

function ipCell(document, result) {
  const td = textCell(document, "ip", "cell-ip");
  const code = el(document, "code", "ip");
  code.textContent = result.exit_ip;

  const copy = el(document, "button", "copy-btn");
  copy.type = "button";
  copy.dataset.copy = result.exit_ip;
  copy.title = `复制出口 IP ${result.exit_ip}`;
  copy.setAttribute("aria-label", `复制出口 IP ${result.exit_ip}`);
  copy.append(copyIcon(document), Object.assign(el(document, "span", "copy-lbl"), { textContent: "复制" }));

  td.append(code, copy);
  return td;
}

function geoCell(document, result) {
  const td = textCell(document, "geo", "cell-geo");
  const text = locationText(result);
  td.textContent = text;
  // 这一列是固定 96px 且不许折行，超过的部分由 CSS 的 ellipsis 裁掉（`.cell-geo` 的
  // max-width:0）。裁掉的字只能靠 title 读回来，这也是这里写 title 的唯一理由。
  td.title = result.country || text;
  return td;
}

function ispCell(document, result) {
  const td = textCell(document, "isp", "cell-isp");

  const isp = el(document, "span", "isp");
  isp.textContent = result.isp || "服务商未知";
  isp.title = result.isp || "服务商未知";
  td.append(isp);

  // ASN 与公司类型是同一条「这个地址是谁的」的事实，合成一行的次级说明。
  const sub = el(document, "span", "isp-sub");
  const asnText = formatAsn(result.asn);
  if (asnText) sub.append(document.createTextNode(asnText));
  if (result.company_type) {
    if (asnText) sub.append(el(document, "span", "route"), document.createTextNode("·"));
    sub.append(document.createTextNode(result.company_type));
  }
  if (sub.childNodes.length) td.append(sub);

  return td;
}

function kindCell(document, result) {
  const td = textCell(document, "kind", "cell-kind");
  if (result.is_residential === true) td.append(chip(document, "住宅", "good"));
  else if (result.is_residential === false) td.append(chip(document, "机房", "warn"));
  else td.append(chip(document, "未知", "neutral"));
  return td;
}

function nativeCell(document, result) {
  const td = textCell(document, "native", "cell-native");
  const chipEl = result.is_native === true ? chip(document, "原生", "good")
    : result.is_native === false ? chip(document, "广播", "warn")
      : chip(document, "未知", "neutral");
  // 三态 chip 只有三个词，而 native_status 是上游原话（如「广播 IP (AE)」「任播服务」）。
  // 挂在 title 上：既是「未知」时的解释，也让三个词背后的判据可查，但不占一列宽度。
  const status = typeof result.native_status === "string" ? result.native_status.trim() : "";
  if (status) chipEl.title = status;
  td.append(chipEl);
  return td;
}

/** 分数药丸：Coffee 走三档，IPure 总分走色带（色带由 CSSOM 后置写入）。 */
function scorePill(document, { kind, value, note }) {
  const pill = el(document, "span", "score");
  if (kind === "ipure") {
    // 通道串只在这里算一次：applyScoreStyles 直接取用，不再对同一个分数重算第二遍。
    const scoreStyle = ipureScoreInlineStyle(value);
    const hasBand = scoreStyle !== "";
    pill.dataset.band = hasBand ? "band" : "na";
    // 通道挂在元素上（data-* 是属性不是 style 属性，CSP 不管），等进 DOM 后由
    // applyScoreStyles 用 CSSOM 写进去。漏掉这一步，分数就只能吃 CSS 里的兜底灰，
    // 永远不变色 —— 它必须留在「元素已进 DOM」之后的执行路径上。
    if (hasBand) {
      pill.dataset.ipureScore = String(value);
      pill.dataset.ipureStyle = scoreStyle;
    }
    pill.textContent = value === null || value === undefined ? "—" : String(value);
    if (value === -1) pill.title = "该地区受限";
    else if (hasBand) pill.title = `IPure 纯净度总分 ${value}`;
    else pill.title = note || "IPure 未返回纯净度总分";
    return pill;
  }
  pill.dataset.band = coffeeBand(value);
  pill.textContent = Number.isFinite(value) ? String(value) : "—";
  pill.title = Number.isFinite(value) ? `Coffee 评分 ${value}` : "暂无 Coffee 评分";
  return pill;
}

function coffeeCell(document, result) {
  const td = textCell(document, "coffee", "cell-coffee");
  td.dataset.align = "center";
  td.append(scorePill(document, {
    kind: "coffee",
    value: Number.isFinite(result.coffee_score) ? result.coffee_score : null,
  }));
  return td;
}

/** IPure 总分：无值或空串一律归一成 null，避免药丸里出现空数字。 */
function ipureTotalOf(result) {
  const value = result.score;
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ipureCell(document, result) {
  const td = textCell(document, "ipure", "cell-ipure");
  td.dataset.align = "center";
  td.append(scorePill(document, { kind: "ipure", value: ipureTotalOf(result), note: result.score_note }));
  return td;
}

function scenarioCell(document, result) {
  const td = textCell(document, "scn", "cell-scn");
  const list = el(document, "ul", "scenarios");
  const scores = result.ipure_scores;

  // 只有「根本没连上」的行才不画格子：那行的另外五列已经换成失败原因，这里补一句
  // 「无场景评分」比摆六个 -1 更直白。判据是「有没有出口 IP」而不是「有没有评分对象」——
  // 上游漏发 ipure_scores 时也要按缺项显示 -1，不能悄悄换成另一种文案。
  if (!result.exit_ip) {
    const none = el(document, "li", "scn-none");
    none.textContent = result.status === "failed" ? "无场景评分（未连接成功）" : "无场景评分";
    list.append(none);
    td.append(list);
    return td;
  }

  // 连上的行六项永远齐：没测到的项按 -1 显示。原来缺项直接不画、末尾挂一句「另有 N 项无数据」，
  // 那句注记的长度随数据变化，把「IPure 场景评分」这一列的宽度一起带着抖；而且同一行
  // 少一项时六格变五格，横着比对两个节点的同一个场景要先数位次。统一成 -1 之后六格恒定、
  // 与「该地区受限」共用同一个中性灰通道，也不参与数值排序。
  //
  // 但两种 -1 的成因不同，不能都说成「该地区受限」：上游没返回值是「无数据」，
  // 上游明确回 -1 才是受限。差别放在 title 里说，格子里只出现一个数字。
  const six = scores && typeof scores === "object" ? scores : {};
  SCENARIO_LABELS.forEach(([key, label]) => {
    const raw = six[key];
    const missing = raw === null || raw === undefined;
    const value = missing ? -1 : raw;
    const item = el(document, "li", "scn");
    item.dataset.ipureScore = String(value);
    if (missing) item.title = `${label}：无数据（显示为 -1）`;
    else if (value === -1) item.title = `${label}：该地区受限`;
    else item.title = `${label} 场景评分 ${value}`;
    const lbl = el(document, "span", "scn-lbl");
    lbl.textContent = label;
    const num = el(document, "span", "scn-num");
    num.textContent = String(value);
    item.append(lbl, num);
    list.append(item);
  });

  td.append(list);
  return td;
}

/** 失败行不留白：把原因和卡住的步骤写进本该显示网络信息的跨列单元格。 */
function absentCell(document, result) {
  const td = el(document, "td", "cell-absent");
  td.dataset.label = "失败原因";
  td.colSpan = ABSENT_KEYS.length;

  const line = el(document, "span", "failure");
  line.append(warnIcon(document), document.createTextNode(result.error || "连接失败"));
  if (result.error_step) {
    const step = el(document, "span", "failure-step");
    step.textContent = `（${result.error_step}）`;
    line.append(step);
  }
  td.append(line);

  if (result.isp) {
    const configured = el(document, "span", "failure-isp");
    configured.textContent = `配置服务商：${result.isp}${formatAsn(result.asn) ? ` · ${formatAsn(result.asn)}` : ""}`;
    td.append(configured);
  }
  return td;
}

/* ----------------------------------------------------------- 行装配 --- */
export function createRow(result, { position, tier }, document) {
  const row = el(document, "tr", "row");
  row.dataset.status = result.status || "failed";
  row.dataset.verdict = verdictOf(result);
  // 前三名的高亮挂在行上，由 CSS 转给 .rank —— 行是导轨和所有子元素的共同父级。
  if (tier) row.dataset.tier = "top";

  row.append(rankCell(document, position), identCell(document, result));

  if (result.exit_ip) {
    row.append(
      ipCell(document, result),
      geoCell(document, result),
      ispCell(document, result),
      kindCell(document, result),
      nativeCell(document, result),
    );
  } else {
    row.append(absentCell(document, result));
  }

  row.append(coffeeCell(document, result), ipureCell(document, result), scenarioCell(document, result));
  return row;
}

export function applyScoreStyles(root) {
  // 顺序契约：赋值必须发生在元素进了 DOM 之后 —— 生产 CSP 是 style-src 'self'，标记里的
  // style 属性会被拦掉，CSSOM 赋值不算内联样式。药丸的通道串由 scorePill 算好挂在
  // data-ipure-style 上，这里直接取用；场景 chip 只挂了分数，到这里才合成通道串。
  root.querySelectorAll("[data-ipure-score]").forEach((element) => {
    const precomputed = element.dataset.ipureStyle;
    element.style.cssText = precomputed ?? ipureScoreInlineStyle(element.dataset.ipureScore);
  });
}

/* --------------------------------------------------------------- 图标 --- */
function copyIcon(document) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "11");
  svg.setAttribute("height", "11");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "9");
  rect.setAttribute("y", "9");
  rect.setAttribute("width", "12");
  rect.setAttribute("height", "12");
  rect.setAttribute("rx", "2.5");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M5 15V5a2 2 0 0 1 2-2h10");
  svg.append(rect, path);
  return svg;
}

function warnIcon(document) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "9");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("d", "M12 8v5M12 16.5h.01");
  svg.append(circle, line);
  return svg;
}

export { STATUS_LABELS };

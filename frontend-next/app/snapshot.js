/* ============================================================================
   离线快照导出 —— 「导出按钮」的全部实现
   ----------------------------------------------------------------------------
   产物有两种，内容同源：
   1. .mhtml —— MIME multipart/related 单文件。HTML 部件用 <link href="./styles.css">
      引样式，样式表作为独立部件靠 Content-Location 命中同一个 URL，这正是 MHTML 的
      标准关联机制（Chrome 自己保存网页就是这个形状）。CSS 不在正文里，所以正文可以
      做到零外链。
   2. .html —— 自包含单文件，CSS 直接内联进 <style>，不需要任何子资源。
      MHTML 是被逐步冷落的老格式（Firefox 早已不支持），必须有这条兜底。

   两条共同要求：
   - 快照里带上 copy.js 的**原文**，所以快照内的复制按钮在离线/无安全上下文时
     仍然走 execCommand 回退，真的能复制。
   - 快照不含任何 <a href> 外链、不含 <meta> CSP。后者很关键：快照靠内联 <script>
     挂复制行为，一旦写上 CSP 就会把自己的脚本拦掉。
   ========================================================================== */

import { buildMhtml, utf8ToBytes } from "../export/mhtml.js";

const STYLESHEET_URL = new URL("../styles.css", import.meta.url);
const COPY_SCRIPT_URL = new URL("./copy.js", import.meta.url);

/* ------------------------------------------------------- 读取可内联的资源 --- */

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} 读取失败：HTTP ${response.status}`);
  return response.text();
}

// fetch 在 file:// 打开的页面上会被浏览器拒绝（不透明来源），此时退回到 CSSOM：
// 已加载的样式表规则可以逐条序列化。代价是丢注释与格式，换来「从本地文件也能导出」。
function stylesheetFromCssom() {
  const chunks = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (error) {
      continue; // 跨源样式表读不到规则，跳过而不是让整次导出失败
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) chunks.push(rule.cssText);
  }
  return chunks.join("\n");
}

async function collectStylesheet() {
  try {
    return { css: await fetchText(STYLESHEET_URL), from: "fetch" };
  } catch (error) {
    const css = stylesheetFromCssom();
    // 两条路都走不通只在一种情况下发生：页面是 file:// 直接打开的。
    // 浏览器把每个本地文件当独立的不透明来源，fetch 和 cssRules 都会拒绝。
    // 这不是能靠代码绕开的事，所以直接把「怎么才能导出」写进错误里。
    if (!css) {
      throw new Error(
        `浏览器不允许页面读取同目录的 styles.css（${error.message}）。`
        + "请通过本地静态服务打开本页后再导出，例如：uv run --no-dev python -m http.server 5180 --directory frontend-next",
      );
    }
    return { css, from: "cssom" };
  }
}

async function collectCopyScript() {
  try {
    return { script: await fetchText(COPY_SCRIPT_URL), from: "fetch" };
  } catch (error) {
    // 不抛：快照本身仍然可用，只是复制按钮会失效。由调用方把这件事告诉用户，
    // 而不是悄悄给出一个「看着能用其实按不动」的文件。
    return { script: "", from: "missing", reason: error.message };
  }
}

/* --------------------------------------------------------- 拼装快照文档 --- */

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * @param {object} options
 * @param {"mhtml"|"html"} options.format 决定顶部的复制路径说明：mhtml 里的脚本会被
 *        浏览器沙箱拦掉，必须改用「单击 IP 全选」这条零 JS 路径。
 * @param {"linked"|"inlined"} options.styleMode linked=给 MHTML（<link> + 独立部件），
 *        inlined=给 .html 兜底（<style> 内联）
 * @param {string} options.css
 * @param {string} options.rowsHtml 整张表的实时 outerHTML（含表头与色带的 CSSOM 结果）
 * @param {string} options.copyScript copy.js 原文；为空则快照内复制不可用
 * @param {object} options.summary 顶部静态摘要用到的文案
 */
export function buildSnapshotDocument(options) {
  const { format, styleMode, css, rowsHtml, copyScript, summary } = options;

  const styleBlock = styleMode === "inlined"
    ? `<style>\n${css}\n</style>`
    : `<link rel="stylesheet" href="./styles.css">`;


  // Chrome 把 file:// 打开的 .mhtml 放进**沙箱 frame 且不设 allow-scripts**，
  // 实测日志：Blocked script execution … the document's frame is sandboxed and the
  // 'allow-scripts' permission is not set。也就是说 mhtml 版本里 BestIpCopy 永远不会被
  // 绑定，复制按钮点了没反应——这是浏览器对 MHTML 的处置，不是绑定逻辑写错了。
  // 所以 mhtml 版本要额外写清一条不依赖脚本的复制路径（.ip 的 user-select: all
  // 让单击即全选），并指向脚本可用的 .html 版本。.html 版本脚本正常，不加这段说明。
  const scriptNote = format === "mhtml"
    ? "<p class=\"snapshot-note\">浏览器会把 .mhtml 里的脚本置于沙箱、不执行，"
      + "因此本文件的复制按钮不可用：<b>单击出口 IP 即全选</b>，再按 Ctrl/⌘+C 复制；"
      + "要按钮可用请打开同批导出的 .html 版本。</p>"
    : "";
  // 快照的头部是静态摘要而不是控件：离线快照没有可操作的对象，
  // 摆一排按不动的输入框只会让人以为下载坏了。这里改为把「当时的视图条件」写清楚。
  const header = `
    <header class="topbar topbar-static">
      <div class="topbar-head">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 17.5 8.5 11l4 4L21 6"></path><path d="M15.5 6H21v5.5"></path>
            </svg>
          </span>
          <h1>节点质量榜</h1>
          <span class="tag-demo">离线快照</span>
        </div>
        <p class="run-stats">${summary.statsHtml}</p>
      </div>
      <div class="topbar-controls">
        <p class="snapshot-state">${summary.stateHtml}</p>
        ${scriptNote}
      </div>
    </header>`;

  const scriptBlock = copyScript
    ? `\n<script>\n${copyScript}\n</script>\n<script>\nBestIpCopy.attach(document);\n</script>`
    : "\n<!-- 快照内未内联 copy.js，复制按钮不可用 -->";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(summary.title)}</title>
${styleBlock}
</head>
<body>
<div class="shell">
${header}
<p class="result-count">${summary.countHtml}</p>
<main class="table-wrap">${rowsHtml}</main>
</div>${scriptBlock}
</body>
</html>
`;
}

/* ------------------------------------------------------------- 下载产物 --- */

function timestampSlug(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // 立刻 revoke 会让部分浏览器来不及读取；延迟释放，代价只是多占一会儿内存。
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/* --------------------------------------------------------------- 对外接口 --- */

function buildSummary({ total, shown, state }) {
  return {
    title: `节点质量榜 · 离线快照 · ${state.generatedAt}`,
    statsHtml: `<b>${total}</b> 个节点 <span class="sep">·</span> 完整 <b>${state.success}</b> <span class="sep">·</span> 部分 <b>${state.partial}</b> <span class="sep">·</span> 失败 <b>${state.failed}</b>`,
    stateHtml: `筛选：<b>${escapeHtml(state.query || "无")}</b> <span class="sep">·</span> 状态：<b>${escapeHtml(state.statusLabel)}</b> <span class="sep">·</span> 排序：<b>${escapeHtml(state.sortLabel)}</b> <span class="sep">·</span> 视图内 <b>${shown}</b> / ${total} 个节点 <span class="sep">·</span> 导出于 <b>${escapeHtml(state.exportedAt)}</b>`,
    countHtml: `当前视图 <b>${shown}</b> 个节点，共 ${total} 个`,
  };
}

const FORMATS = {
  mhtml: { mime: "multipart/related", extension: "mhtml" },
  html: { mime: "text/html;charset=utf-8", extension: "html" },
};

/**
 * 导出当前视图。
 * @returns {Promise<{filename:string, bytes:number, styleSource:string, scriptSource:string}>}
 */
export async function exportSnapshot(format, context) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`未知的导出格式：${format}`);

  const { rowsHtml, total, shown, state } = context;
  const [stylesheet, copy] = await Promise.all([collectStylesheet(), collectCopyScript()]);
  const summary = buildSummary({ total, shown, state });

  const now = new Date();
  const filename = `best-ip-snapshot-${timestampSlug(now)}.${spec.extension}`;
  const documentUrl = `${location.href.split("#")[0].split("?")[0]}`;

  if (format === "mhtml") {
    const html = buildSnapshotDocument({
      format: "mhtml",
      styleMode: "linked",
      css: "",
      rowsHtml,
      copyScript: copy.script,
      summary,
    });
    const bytes = buildMhtml({
      snapshotUrl: documentUrl,
      subject: summary.title,
      date: now,
      parts: [
        {
          contentType: "text/html; charset=utf-8",
          contentLocation: documentUrl,
          encoding: "quoted-printable",
          bytes: utf8ToBytes(html),
        },
        {
          contentType: "text/css; charset=utf-8",
          contentLocation: new URL("styles.css", documentUrl).href,
          encoding: "quoted-printable",
          bytes: utf8ToBytes(stylesheet.css),
        },
      ],
    });
    download(new Blob([bytes], { type: spec.mime }), filename);
    return {
      filename,
      bytes: bytes.byteLength,
      styleSource: stylesheet.from,
      scriptSource: copy.from,
      scriptWarning: copy.reason || "",
    };
  }

  const html = buildSnapshotDocument({
    format: "html",
    styleMode: "inlined",
    css: stylesheet.css,
    rowsHtml,
    copyScript: copy.script,
    summary,
  });
  const bytes = utf8ToBytes(html);
  download(new Blob([bytes], { type: spec.mime }), filename);
  return {
    filename,
    bytes: bytes.byteLength,
    styleSource: stylesheet.from,
    scriptSource: copy.from,
    scriptWarning: copy.reason || "",
  };
}

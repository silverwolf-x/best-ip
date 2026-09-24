/* ============================================================================
   MHTML 序列化往返测试
   运行：node frontend-next/tools/mhtml-roundtrip.mjs
   ----------------------------------------------------------------------------
   这份脚本回答两个问题：
   1. 导出的 .mhtml 能不能**无损**还原成源 HTML / CSS。QP 的软换行、行尾空白转义、
      CRLF 归一化都是「看起来对但边界上会吃字符」的地方，所以断言全部落在字节上，
      而不是「字符串看起来一样」。
   2. app/snapshot.js 的 buildSnapshotDocument 拼出来的快照对不对：两种格式的脚本内联
      差异、转义（含双转义回归）、标签平衡、可读性换行。第 1 节到第 6 节只覆盖 MIME
      编解码，快照拼装本身在别处零覆盖，所以第 7 节直接调生产函数（不是抄一份拼装）。
   ========================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BOUNDARY,
  MAX_LINE_LENGTH,
  utf8ToBytes,
  bytesToUtf8,
  normalizeToCrlf,
  encodeQuotedPrintable,
  decodeQuotedPrintable,
  encodeBase64,
  decodeBase64,
  buildMhtml,
  parseMhtml,
} from "../export/mhtml.js";
// 只 import 纯函数：buildSnapshotDocument / buildSummary / serializeSnapshot 都不碰 DOM，
// 所以这份测试在 Node 下不需要任何 window 或 document stub。
import { buildSnapshotDocument, buildSummary, serializeSnapshot } from "../app/snapshot.js";

let failures = 0;
const pass = (label, note = "") => console.log(`PASS ${label}${note ? `  — ${note}` : ""}`);
const fail = (label, detail) => {
  failures += 1;
  console.error(`FAIL ${label}\n     ${detail}`);
};
const check = (label, condition, detail) => (condition ? pass(label) : fail(label, detail));

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function firstDiff(a, b) {
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    if (a[index] !== b[index]) return `首个差异在第 ${index} 字节：得 ${a[index]} / 期 ${b[index]}`;
  }
  return "前缀相同，仅长度不同";
}

// 只把裸 \n 补成 \r\n，其余字节一律不动。往返断言都对照它，而不是对照原文，
// 因为 CRLF 是 QP 的格式要求，编码前必须归一化。
function crlfOnlyIfLoneLf(bytes) {
  const out = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 10 && bytes[index - 1] !== 13) out.push(13, 10);
    else out.push(byte);
  }
  return new Uint8Array(out);
}

function linesOf(bytes) {
  const text = bytesToLatin1Local(bytes);
  return text.split("\r\n");
}

function bytesToLatin1Local(bytes) {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/* ------------------------------------------------------------- 合成夹具 --- */
// 故意塞进所有边界：中文、`=`、行尾空白、超长无空格行、制表符、\n 与 \r\n 混用、
// 孤立 \r、以及一条完全不以换行结尾的单行文本。
const FIXTURE = [
  "第一行中文内容，含等号 = 与制表符\t结束",
  "第二行以三个空格结尾   ",
  "line-with-crlf\r\n第三行使用 CRLF",
  `超长无空格行:${"X".repeat(240)}`,
  "孤立回车符之后: \r 这一段不应该被当成换行",
  "最后一行没有换行符",
].join("\n");
const FIXTURE_BYTES = utf8ToBytes(FIXTURE);
const SINGLE_LINE = "单行且没有换行符 = with trailing tab \t and spaces   ";

/* --------------------------------------------------- 1. QP 往返（合成） --- */
{
  const encoded = encodeQuotedPrintable(FIXTURE_BYTES);
  const decoded = decodeQuotedPrintable(encoded);
  const expected = normalizeToCrlf(FIXTURE_BYTES);
  check(
    "合成夹具 QP 往返逐字节等于「只把裸 \\n 换成 \\r\\n」的结果",
    bytesEqual(decoded, expected) && bytesEqual(expected, crlfOnlyIfLoneLf(FIXTURE_BYTES)),
    `${firstDiff(decoded, expected)}；与 crlfOnlyIfLoneLf 的差异：${firstDiff(expected, crlfOnlyIfLoneLf(FIXTURE_BYTES))}`,
  );
  check(
    "合成夹具往返与原文的差异只是插入的 CR 字节（没有字符被吃掉）",
    decoded.length === FIXTURE_BYTES.length + (FIXTURE.match(/(?<!\r)\n/g) || []).length,
    `长度 ${decoded.length} vs 预期 ${FIXTURE_BYTES.length + (FIXTURE.match(/(?<!\r)\n/g) || []).length}`,
  );
  console.log(`     夹具 ${FIXTURE_BYTES.length} B → QP ${encoded.length} B`);
}

/* ------------------------------------------------------- 2. 行规与字符集 --- */
{
  const encoded = encodeQuotedPrintable(FIXTURE_BYTES);
  const lines = linesOf(encoded);
  const tooLong = lines.filter((line) => line.length > MAX_LINE_LENGTH);
  check("QP 每一行长度 ≤ 76", tooLong.length === 0, `超长行 ${tooLong.length} 条，最长 ${Math.max(...lines.map((l) => l.length))}`);

  const bytes = Array.from(encoded);
  const badTrailing = bytes.length && (bytes[bytes.length - 1] === 32 || bytes[bytes.length - 1] === 9);
  const trailingWhitespaceLines = lines.filter((line) => line.endsWith(" ") || line.endsWith("\t"));
  check(
    "没有任何一行以字面空格/制表符结尾（含全文末尾）",
    trailingWhitespaceLines.length === 0 && !badTrailing,
    `可疑行 ${trailingWhitespaceLines.length} 条，末尾字节 ${bytes[bytes.length - 1]}`,
  );

  const illegal = bytes.filter((byte) => byte !== 9 && byte !== 10 && byte !== 13 && !(byte >= 32 && byte <= 126));
  check("QP 输出只含 0x09/0x0A/0x0D/0x20–0x7E", illegal.length === 0, `非法字节 ${illegal.slice(0, 8).join(",")}`);

  const softAfterSpace = /=[ \t]/.test(bytesToLatin1Local(encoded));
  check("软换行 `=` 后面不紧跟空白（否则解码有歧义）", !softAfterSpace, "出现了 `=` 后跟空格的序列");

  const decodedSingle = decodeQuotedPrintable(encodeQuotedPrintable(utf8ToBytes(SINGLE_LINE)));
  check(
    "行尾空格/制表符被转义后能原样还原（不被读取端吞掉）",
    bytesToUtf8(decodedSingle) === SINGLE_LINE,
    `得 ${JSON.stringify(bytesToUtf8(decodedSingle))}`,
  );
}

/* ------------------------------------------------------- 3. base64 往返 --- */
{
  const allBytes = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) allBytes[index] = index;
  const cases = [FIXTURE_BYTES, allBytes, new Uint8Array(0), utf8ToBytes("只有一行中文")];
  cases.forEach((input, index) => {
    const encoded = encodeBase64(input);
    const decoded = decodeBase64(encoded);
    const encodedLines = linesOf(encoded).filter((line) => line.length > 0);
    const tooLong = encodedLines.filter((line) => line.length > MAX_LINE_LENGTH);
    check(
      `base64 往返逐字节一致（用例 ${index + 1}/${cases.length}，${input.length} B）`,
      bytesEqual(decoded, input) && tooLong.length === 0,
      `${firstDiff(decoded, input)}；超长行 ${tooLong.length}`,
    );
  });
}

/* --------------------------------------------------------- 4. 真实文件 --- */
const INDEX_HTML = fileURLToPath(new URL("../index.html", import.meta.url));
const STYLESHEET = fileURLToPath(new URL("../styles.css", import.meta.url));
const sources = [
  ["frontend-next/index.html", new Uint8Array(readFileSync(INDEX_HTML))],
  ["frontend-next/styles.css", new Uint8Array(readFileSync(STYLESHEET))],
];
sources.forEach(([label, bytes]) => {
  const decoded = decodeQuotedPrintable(encodeQuotedPrintable(bytes));
  check(
    `${label} 经 QP 往返逐字节不变（仅换行归一化为 CRLF）`,
    bytesEqual(decoded, normalizeToCrlf(bytes)),
    firstDiff(decoded, normalizeToCrlf(bytes)),
  );
});

/* ---------------------------------------- 5. buildMhtml + parseMhtml --- */
const snapshotUrl = "https://example.invalid/best-ip/index.html";
const parts = [
  {
    contentType: "text/html; charset=utf-8",
    contentLocation: snapshotUrl,
    encoding: "quoted-printable",
    bytes: sources[0][1],
  },
  {
    contentType: "text/css; charset=utf-8",
    contentLocation: "https://example.invalid/best-ip/styles.css",
    encoding: "quoted-printable",
    bytes: sources[1][1],
  },
];
{
  const mhtml = buildMhtml({ snapshotUrl, subject: "节点质量榜 · 离线快照", date: new Date("2026-09-22T04:00:00Z"), parts });
  const parsed = parseMhtml(mhtml);

  const topType = String(parsed.headers["Content-Type"] || "");
  check("顶层 Content-Type 是 multipart/related", topType.includes("multipart/related"), topType);
  check("部件数量为 2", parsed.parts.length === 2, `实际 ${parsed.parts.length}`);
  check("顶层 Snapshot-Content-Location 与输入一致", parsed.headers["Snapshot-Content-Location"] === snapshotUrl, String(parsed.headers["Snapshot-Content-Location"]));

  parsed.parts.forEach((part, index) => {
    const expected = parts[index];
    check(
      `部件 ${index + 1} 的 Content-Type / Content-Location / Encoding 与输入一致`,
      part.headers["Content-Type"] === expected.contentType
        && part.headers["Content-Location"] === expected.contentLocation
        && part.headers["Content-Transfer-Encoding"] === expected.encoding,
      JSON.stringify(part.headers),
    );
    const want = normalizeToCrlf(expected.bytes);
    const exact = bytesEqual(part.body, want);
    const trailing = bytesEqual(part.body, new Uint8Array([...want, 13, 10]));
    check(
      `部件 ${index + 1} 解析回来的正文与源文件逐字节一致（${want.length} B）`,
      exact || trailing,
      exact ? "" : `差 ${firstDiff(part.body, want)}`,
    );
    if (!exact && trailing) console.log("     注：源文件不以换行结尾，恢复出的正文多一个 CRLF —— MIME 分隔的固有代价");
  });

  // 正文里的外链计数：只统计正文，Content-Location 这类头字段不算正文。
  parsed.parts.forEach((part, index) => {
    const body = bytesToLatin1Local(part.body);
    const httpCount = (body.match(/http:\/\//g) || []).length;
    const httpsCount = (body.match(/https:\/\//g) || []).length;
    check(`部件 ${index + 1} 正文内 http(s):// 外链计数为 0`, httpCount + httpsCount === 0, `http=${httpCount} https=${httpsCount}`);
    check(`部件 ${index + 1} 正文内不含边界串`, !body.includes(BOUNDARY), "正文里出现了边界串");
  });

  const head = bytesToLatin1Local(mhtml.slice(0, 520));
  check("MHTML 以 From: 开头且边界声明正确", head.startsWith("From: ") && head.includes(`boundary="${BOUNDARY}"`), head.split("\r\n")[0]);
  check(
    "每个部件块以 `--<边界>` 起头、以 `--<边界>--` 收尾",
    bytesToLatin1Local(mhtml).includes(`--${BOUNDARY}\r\n`) && bytesToLatin1Local(mhtml).endsWith(`--${BOUNDARY}--\r\n`),
    "分隔行不符合预期",
  );
  console.log(`     产物 ${mhtml.length} B（源 HTML ${sources[0][1].length} B + CSS ${sources[1][1].length} B）`);
}

/* --------------------------------------------------------- 6. 中文存活 --- */
{
  const html = `<!doctype html><html lang="zh-CN"><body><p>东京 NTT 01 · 日本 · 东京</p></body></html>`;
  const mhtml = buildMhtml({
    snapshotUrl: "file:///tmp/snapshot.mhtml",
    subject: "中文主题",
    date: new Date("2026-09-22T04:00:00Z"),
    parts: [{ contentType: "text/html; charset=utf-8", contentLocation: "file:///tmp/snapshot.mhtml", encoding: "quoted-printable", bytes: utf8ToBytes(html) }],
  });
  const parsed = parseMhtml(mhtml);
  check(
    "解析回来的 HTML 部件里能找到夹具中的中文",
    bytesToUtf8(parsed.parts[0].body).includes("东京 NTT 01 · 日本 · 东京"),
    bytesToUtf8(parsed.parts[0].body).slice(0, 80),
  );
}

/* --------------------------------------- 7. buildSnapshotDocument 的产物 --- */
// 这一节补的是快照**自己**的拼装：格式差异（.mhtml 不内联 copy.js）、转义、标签平衡、
// 可读性换行。在此之前整个测试只覆盖 MHTML 编解码，快照拼装的回归保护是零。
// DOM 依赖用夹具绕开：被测函数只要一个 summary 对象和一段 rowsHtml 字符串，
// 唯一用到 document 的 CSSOM 回退在导出时才走，这里不需要 stub 一个 DOM。
const COPY_JS = readFileSync(fileURLToPath(new URL("../app/copy.js", import.meta.url)), "utf8");
const SNAPSHOT_CSS = readFileSync(STYLESHEET, "utf8");
const SNAPSHOT_URL = "file:///tmp/best-ip-snapshot.mhtml";
const SNAPSHOT_DATE = new Date("2026-09-22T04:00:00Z");

// 表格夹具：属性里带单引号，文本里带中文与标记，用来同时验证「转义不破属性」「标签平衡」
// 「</tr> 后补换行」。形状照着 app/render.js 的列定义来（行 = tr.row + 若干 td）。
const ROWS_HTML = [
  '<table class="grid" id="grid">',
  '<caption>节点质量榜</caption>',
  '<colgroup><col class="col-rank"></colgroup>',
  '<thead><tr><th scope="col" class="col-rank">#</th></tr></thead>',
  '<tbody>',
  '<tr class="row" data-status="success"><td class="ident" title="AT&amp;T \'东京\'">东京 NTT 01</td>',
  '<td class="cell-ip"><code class="ip">203.0.113.7</code></td></tr>',
  '<tr class="row" data-status="failed"><td class="ident"><span class="node">洛杉矶 ColoCrossing-03</span></td>',
  '<td class="cell-absent" colspan="5">连接失败</td></tr>',
  '</tbody></table>',
].join("");

// 来源、筛选词、生成时间都刻意带上 `&`、`<`、`'`：双转义与属性打破都只在含 `&` 或 `'`
// 的输入上才现形，干净夹具永远测不出来。
const SNAPSHOT_SUMMARY = buildSummary({
  total: 3,
  shown: 2,
  state: {
    query: "东京 & <b>",
    statusLabel: "全部状态",
    sortLabel: "Coffee 评分 ↓",
    source: "AT&T & <op> 'x'",
    generatedAt: "2026-09-22 12:00",
    exportedAt: "2026-09-22 12:05",
    success: 2,
    partial: 1,
    failed: 0,
  },
});

// .mhtml 里那句「按钮按不动、单击 IP 全选」的免责说明：不内联脚本之后它必须原样在，
// 所以这里逐字冻结一份期望值——被改写就会红。见 app/snapshot.js 的 scriptNote。
const DISCLAIMER = '<p class="snapshot-note">浏览器会把 .mhtml 里的脚本置于沙箱、不执行，'
  + '因此本文件的复制按钮不可用：<b>单击出口 IP 即全选</b>，再按 Ctrl/⌘+C 复制；'
  + '要按钮可用请打开同批导出的 .html 版本。</p>';

const countOfText = (text, needle) => text.split(needle).length - 1;
const titleOf = (html) => (/<title>([^<]*)<\/title>/u.exec(html) || [])[1] || "";

const mhtmlDocument = buildSnapshotDocument({
  format: "mhtml",
  styleMode: "linked",
  css: "",
  rowsHtml: ROWS_HTML,
  copyScript: COPY_JS,
  summary: SNAPSHOT_SUMMARY,
});
const htmlDocument = buildSnapshotDocument({
  format: "html",
  styleMode: "inlined",
  css: SNAPSHOT_CSS,
  rowsHtml: ROWS_HTML,
  copyScript: COPY_JS,
  summary: SNAPSHOT_SUMMARY,
});

{
  /* ------------------------------------------- 7.1 脚本内联门（决策翻转） --- */
  const firstScript = (/<script[^>]*>/iu.exec(mhtmlDocument) || ["（无）"])[0];
  check(".mhtml 产物不含任何 <script>", !/<script/iu.test(mhtmlDocument), `出现了 ${firstScript}`);
  check(
    ".mhtml 产物不含 copy.js 原文（6.9KB 死代码不再内联）",
    !mhtmlDocument.includes("BestIpCopy") && !mhtmlDocument.includes("execCommand"),
    "产物里出现了 copy.js 的标记",
  );
  check(
    ".mhtml 产物原样保留「复制按钮不可用、单击 IP 全选」的免责说明",
    mhtmlDocument.includes(DISCLAIMER),
    "免责说明缺失或被改写",
  );
  check(
    ".html 产物含内联 copy.js 与 BestIpCopy.attach(document)",
    htmlDocument.includes(COPY_JS) && htmlDocument.includes("BestIpCopy.attach(document);"),
    "html 产物里找不到内联脚本",
  );
  check(".html 产物不含 mhtml 专用的免责说明", !htmlDocument.includes(DISCLAIMER), "html 里混进了 mhtml 的说明");
  check(
    ".mhtml 用 <link rel=\"stylesheet\"> 而非内联 <style>",
    mhtmlDocument.includes('<link rel="stylesheet" href="./styles.css">') && !mhtmlDocument.includes("<style>"),
    "样式块的形状不对",
  );
  check(
    ".html 把 CSS 内联进 <style>",
    htmlDocument.includes(`<style>\n${SNAPSHOT_CSS}\n</style>`),
    "html 产物里没有内联 CSS",
  );
  check(
    ".mhtml 仍带 <main class=\"table-wrap\"> 与结果计数（壳体没被这轮改动削掉）",
    mhtmlDocument.includes('<main class="table-wrap">') && mhtmlDocument.includes('<p class="result-count">'),
    "壳体缺件",
  );

  /* ------------------------------------------------------ 7.2 转义 --- */
  const escapedTitle = titleOf(mhtmlDocument);
  check(
    "来源里的 & 只被转义一次：<title> 里是 AT&amp;T，全篇没有 &amp;amp;",
    escapedTitle.includes("AT&amp;T &amp; &lt;op&gt; &#39;x&#39; · ") && !mhtmlDocument.includes("&amp;amp;"),
    escapedTitle,
  );
  check(
    "单引号被转义成 &#39;（下游用单引号写属性也不会被打破）",
    escapedTitle.includes("&#39;x&#39;") && !escapedTitle.includes("'x'"),
    escapedTitle,
  );
  check(
    "摘要里的来源与标题同源同一次转义（出现 &amp;amp; 即为双转义回归）",
    mhtmlDocument.includes("来源：<b>AT&amp;T &amp; &lt;op&gt; &#39;x&#39;</b>") && !mhtmlDocument.includes("&amp;amp;"),
    "摘要里的来源转义不对",
  );
  check(
    "筛选词里的标记不会逃逸成真元素",
    mhtmlDocument.includes("筛选：<b>东京 &amp; &lt;b&gt;</b>") && !mhtmlDocument.includes("东京 & <b>"),
    "筛选词没被转义",
  );

  // 上游把非数字塞进 total/shown/success 时，拼装层自己就该挡住（不再依赖 main.js 的类型纪律）。
  const hostileSummary = buildSummary({
    total: "2<script>",
    shown: "<b>1</b>",
    state: {
      query: "",
      statusLabel: "全部状态",
      sortLabel: "Coffee 评分 ↓",
      source: "示例数据",
      generatedAt: "t",
      exportedAt: "t",
      success: "x&y",
      partial: 0,
      failed: 0,
    },
  });
  check(
    "统计数字全部走转义：上游塞标记也只会以实体形式出现",
    hostileSummary.statsHtml.includes("&lt;script&gt;")
      && hostileSummary.statsHtml.includes("x&amp;y")
      && !hostileSummary.statsHtml.includes("<script>")
      && hostileSummary.countHtml.includes("&lt;b&gt;1&lt;/b&gt;")
      && !hostileSummary.countHtml.includes("<b>1</b>")
      && hostileSummary.stateHtml.includes("视图内 <b>&lt;b&gt;1&lt;/b&gt;</b> / 2&lt;script&gt; 个节点"),
    hostileSummary.statsHtml,
  );

  /* ------------------------------------------- 7.3 可读性换行与标签平衡 --- */
  check(
    "每个 </tr> 后有换行（不再把 29 行挤在一行 84KB 里）",
    countOfText(mhtmlDocument, "</tr>\n") === countOfText(mhtmlDocument, "</tr>") && !mhtmlDocument.includes("</tr><"),
    "没有补换行",
  );
  const tags = [["<tr", "</tr>"], ["<td", "</td>"], ["<table", "</table>"], ["<tbody", "</tbody>"], ["<thead", "</thead>"], ["<html", "</html>"]];
  const unbalanced = tags.filter(([open, close]) => countOfText(mhtmlDocument, open) !== countOfText(mhtmlDocument, close));
  check(
    "标签平衡：<tr>/<td>/<table>/<tbody>/<thead>/<html> 开闭数量相等",
    unbalanced.length === 0,
    unbalanced.map(([open, close]) => `${open}=${countOfText(mhtmlDocument, open)} vs ${close}=${countOfText(mhtmlDocument, close)}`).join("；"),
  );
  check(
    "<td> 内部没有被换行拆开（只动 </tr>）",
    mhtmlDocument.includes('<td class="cell-absent" colspan="5">连接失败</td>'),
    "td 内容被改动",
  );

  /* ---------------------------------------- 7.4 .mhtml 字节逐字节往返 --- */
  const mhtmlBytes = serializeSnapshot({
    format: "mhtml",
    html: mhtmlDocument,
    css: SNAPSHOT_CSS,
    snapshotUrl: SNAPSHOT_URL,
    subject: SNAPSHOT_SUMMARY.title,
    date: SNAPSHOT_DATE,
  });
  const parsedSnapshot = parseMhtml(mhtmlBytes);
  check("快照 MHTML 有 HTML + CSS 两个部件", parsedSnapshot.parts.length === 2, `实际 ${parsedSnapshot.parts.length}`);
  check(
    "顶层 Snapshot-Content-Location 与页面地址一致",
    parsedSnapshot.headers["Snapshot-Content-Location"] === SNAPSHOT_URL,
    String(parsedSnapshot.headers["Snapshot-Content-Location"]),
  );
  const snapshotParts = [
    ["HTML 部件", mhtmlDocument, SNAPSHOT_URL, parsedSnapshot.parts[0]],
    ["CSS 部件", SNAPSHOT_CSS, "file:///tmp/styles.css", parsedSnapshot.parts[1]],
  ];
  snapshotParts.forEach(([label, text, location, part]) => {
    const want = normalizeToCrlf(utf8ToBytes(text));
    const exact = bytesEqual(part.body, want);
    const trailing = bytesEqual(part.body, new Uint8Array([...want, 13, 10]));
    check(
      `${label}经 QP 解码后逐字节等于快照原文（${want.length} B）`,
      exact || trailing,
      exact ? "" : `差 ${firstDiff(part.body, want)}${trailing ? "（只多一个 MIME 分隔必需的 CRLF）" : ""}`,
    );
    check(`${label}的 Content-Type / Content-Location 与输入一致`, part.headers["Content-Type"] === "text/html; charset=utf-8" || part.headers["Content-Type"] === "text/css; charset=utf-8", JSON.stringify(part.headers));
    check(`${label}的 Content-Location 是快照同目录的 URL`, part.headers["Content-Location"] === location, String(part.headers["Content-Location"]));
  });
  const decodedSnapshotHtml = bytesToUtf8(parsedSnapshot.parts[0].body);
  check(
    "解码回来的快照 HTML 里中文、免责说明、转义后的标题都还在",
    decodedSnapshotHtml.includes("节点质量榜") && decodedSnapshotHtml.includes(DISCLAIMER)
      && decodedSnapshotHtml.includes("AT&amp;T &amp; &lt;op&gt;") && decodedSnapshotHtml.trimEnd().endsWith("</html>"),
    decodedSnapshotHtml.slice(0, 120),
  );
  console.log(`     快照 .mhtml ${mhtmlBytes.length} B（HTML ${utf8ToBytes(mhtmlDocument).length} B + CSS ${utf8ToBytes(SNAPSHOT_CSS).length} B）`);

  /* ---------------------------------------------- 7.5 .html 字节产物 --- */
  const htmlBytes = serializeSnapshot({
    format: "html",
    html: htmlDocument,
    css: SNAPSHOT_CSS,
    snapshotUrl: SNAPSHOT_URL,
    subject: SNAPSHOT_SUMMARY.title,
    date: SNAPSHOT_DATE,
  });
  check(
    ".html 产物就是 HTML 的 UTF-8 字节本身（没有 MIME 封装、没有边界串）",
    bytesToUtf8(htmlBytes) === htmlDocument && !bytesToLatin1Local(htmlBytes).includes(BOUNDARY),
    `长度 ${htmlBytes.length} vs ${utf8ToBytes(htmlDocument).length}`,
  );
}

console.log(failures === 0 ? "\n全部断言通过" : `\n${failures} 条断言失败`);
process.exit(failures === 0 ? 0 : 1);

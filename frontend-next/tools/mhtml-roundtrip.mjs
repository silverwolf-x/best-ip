/* ============================================================================
   MHTML 序列化往返测试
   运行：node frontend-next/tools/mhtml-roundtrip.mjs
   ----------------------------------------------------------------------------
   这份脚本要回答的问题只有一个：导出的 .mhtml 能不能**无损**还原成源 HTML / CSS。
   QP 的软换行、行尾空白转义、CRLF 归一化都是「看起来对但边界上会吃字符」的地方，
   所以断言全部落在字节上，而不是「字符串看起来一样」。
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

console.log(failures === 0 ? "\n全部断言通过" : `\n${failures} 条断言失败`);
process.exit(failures === 0 ? 0 : 1);

/* ============================================================================
   MHTML 序列化 —— 零依赖，浏览器与 Node 共用同一份实现
   ----------------------------------------------------------------------------
   为什么自己写而不是让浏览器存：浏览器只在用户手动「另存为」时才会产出 MHTML，
   页面脚本拿不到那个能力。而「把当前视图变成一个离线可双击的单文件」必须由页面
   自己完成，所以这里按 MIME multipart/related 的规则把字节拼出来。

   为什么用 quoted-printable 而不是 base64 承载 HTML/CSS：与 Chrome 自己保存网页的
   形状保持一致，MHTML 读取端对 QP 正文的支持最普遍，而且产物用记事本打开也能看懂
   结构（排查「快照为什么没样式」时这一点很值钱）。

   quoted-printable 的边界规则（不是随意选择，每一条都是解码歧义的来源）：
   1. 行分隔必须是 CRLF。裸 LF 在部分读取端会被当成正文而不是行分隔，所以在编码前
      就要统一（normalizeToCrlf）。裸 CR 不能当换行，它只能被转义成 =0D。
   2. 空格与制表符在**行尾**必须转义成 =20 / =09：读取端允许丢弃行尾空白，
      不转义就等于内容会被悄悄吃掉。
   3. 软换行（行尾的 `=`）后面绝不能紧跟空白字符：那种情况下 `=` 后面跟着的空格
      到底是软换行标记还是内容，解码端无法判断。实现上把整段连续空白当成不可分割
      的单元——要么整体字面输出，要么整体转义。
   4. 一行最长 76 字符（含软换行那个 `=`），所以字面字符累计到 75 就该断行。
   ========================================================================== */

export const BOUNDARY = "----=_BestIp_Mhtml_Boundary_7f3a";

const CR = 13;
const LF = 10;
const SPACE = 32;
const TAB = 9;
const EQUALS = 61;

const MAX_LINE = 76;    // 一行含软换行标记的最大长度
const SOFT_LIMIT = 75;  // 字面内容最多占这么多，第 76 个位置留给软换行的 `=`

const HEX = "0123456789ABCDEF";

/* --------------------------------------------------------------- 字节互转 --- */

export function utf8ToBytes(text) {
  return new TextEncoder().encode(text);
}

export function bytesToUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

// 每字节一个码点的无损映射，用来对 MIME 结构做字符串切分（正文是纯 ASCII，
// 所以这样切分不会破坏任何字节）。
function bytesToLatin1(bytes) {
  let out = "";
  const CHUNK = 8192;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + CHUNK)));
  }
  return out;
}

function latin1ToBytes(text) {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

/**
 * 把 CRLF / 裸 LF 统一成 CRLF；裸 CR 原样保留（它会被转义成 =0D，不是换行）。
 * 只改变换行字节，其他字节逐一照抄——往返测试依赖这条不变量。
 */
export function normalizeToCrlf(bytes) {
  const out = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === CR && bytes[index + 1] === LF) {
      out.push(CR, LF);
      index += 1;
    } else if (byte === LF) {
      out.push(CR, LF);
    } else {
      out.push(byte);
    }
  }
  return new Uint8Array(out);
}

/* --------------------------------------------------------- quoted-printable --- */

function isLiteralByte(byte) {
  // 可字面输出的可见 ASCII：0x21–0x3C 与 0x3E–0x7E（即除 `=` 之外）。
  return (byte >= 0x21 && byte <= 0x3c) || (byte >= 0x3e && byte <= 0x7e);
}

export function encodeQuotedPrintable(bytes) {
  const input = normalizeToCrlf(bytes);
  const out = [];
  let lineLength = 0;
  // 行内遇到的空白先挂起：它们后面还有内容就不是行尾，可以字面输出；
  // 一旦后面直接跟换行，就必须转义（见文件头第 2 条）。
  let pendingWhitespace = [];

  const softBreak = () => {
    out.push(EQUALS, CR, LF);
    lineLength = 0;
  };

  const emitLiteral = (byte) => {
    if (lineLength + 1 > SOFT_LIMIT) softBreak();
    out.push(byte);
    lineLength += 1;
  };

  const emitEscape = (byte) => {
    if (lineLength + 3 > SOFT_LIMIT) softBreak();
    out.push(EQUALS, HEX.charCodeAt((byte >> 4) & 0x0f), HEX.charCodeAt(byte & 0x0f));
    lineLength += 3;
  };

  const flushPendingAsLiteral = () => {
    if (!pendingWhitespace.length) return;
    const run = pendingWhitespace;
    pendingWhitespace = [];
    if (run.length > SOFT_LIMIT) {
      // 极端情况：一整段空白比一行还长。字面输出必然溢出，只能全部转义。
      // 转义后每个空白变成 3 字节且都不是空白，软换行可以任意插。
      run.forEach(emitEscape);
      return;
    }
    // 整段空白是不可分割单元：放不下就整段挪到下一行，绝不让软换行落在空白前。
    if (lineLength + run.length > SOFT_LIMIT) softBreak();
    run.forEach((byte) => {
      out.push(byte);
      lineLength += 1;
    });
  };

  const flushPendingAsEscapes = () => {
    pendingWhitespace.forEach(emitEscape);
    pendingWhitespace = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index];
    if (byte === CR && input[index + 1] === LF) {
      flushPendingAsEscapes(); // 行尾空白必须转义，否则读取端可能丢字符
      out.push(CR, LF);
      lineLength = 0;
      index += 1;
      continue;
    }
    if (byte === SPACE || byte === TAB) {
      pendingWhitespace.push(byte);
      continue;
    }
    flushPendingAsLiteral();
    if (isLiteralByte(byte)) emitLiteral(byte);
    else emitEscape(byte);
  }
  flushPendingAsEscapes();

  return new Uint8Array(out);
}

export function decodeQuotedPrintable(bytes) {
  const out = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== EQUALS) {
      // 刻意不做「丢弃行尾空白」那份宽容：我们的编码器从不写出行尾空白，
      // 宽容会让往返不再是严格逆运算。见文件头第 2 条。
      out.push(byte);
      continue;
    }
    const next = bytes[index + 1];
    const after = bytes[index + 2];
    if (next === CR && after === LF) {
      index += 2; // 软换行，解码时丢弃
      continue;
    }
    if (next === LF) {
      index += 1; // 容忍裸 LF 形式的软换行
      continue;
    }
    const high = HEX.indexOf(String.fromCharCode(next ?? -1));
    const low = HEX.indexOf(String.fromCharCode(after ?? -1));
    if (high < 0 || low < 0) throw new Error(`quoted-printable 转义序列非法：= 后跟 ${next}/${after}`);
    out.push((high << 4) | low);
    index += 2;
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------- base64 ---

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < B64.length; index += 1) table[B64.charCodeAt(index)] = index;
  return table;
})();

export function encodeBase64(bytes) {
  const out = [];
  let lineLength = 0;
  const pushChar = (charCode) => {
    // 每 76 字符一个硬换行（MIME 行宽上限），换行后重新计数。
    if (lineLength === MAX_LINE) {
      out.push(CR, LF);
      lineLength = 0;
    }
    out.push(charCode);
    lineLength += 1;
  };

  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    pushChar(B64.charCodeAt(b0 >> 2));
    pushChar(B64.charCodeAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)));
    pushChar(b1 === undefined ? 0x3d : B64.charCodeAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)));
    pushChar(b2 === undefined ? 0x3d : B64.charCodeAt(b2 & 0x3f));
  }
  // 末尾补一个 CRLF：编码结果要能直接作为完整的 MIME 行拼接。
  out.push(CR, LF);
  return new Uint8Array(out);
}

export function decodeBase64(bytes) {
  const text = bytesToLatin1(bytes).replace(/[^A-Za-z0-9+/=]/g, "");
  const out = [];
  for (let index = 0; index < text.length; index += 4) {
    const c0 = B64_INDEX[text.charCodeAt(index)] ?? -1;
    const c1 = B64_INDEX[text.charCodeAt(index + 1)] ?? -1;
    if (c0 < 0 || c1 < 0) throw new Error("base64 内容非法");
    out.push(((c0 << 2) | (c1 >> 4)) & 0xff);
    const c2 = B64_INDEX[text.charCodeAt(index + 2)] ?? -1;
    if (text[index + 2] !== "=" && c2 >= 0) {
      out.push((((c1 & 0x0f) << 4) | (c2 >> 2)) & 0xff);
      const c3 = B64_INDEX[text.charCodeAt(index + 3)] ?? -1;
      if (text[index + 3] !== "=" && c3 >= 0) out.push((((c2 & 0x03) << 6) | c3) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ------------------------------------------------------------- MIME 拼装 ---

function endsWithCrlf(bytes) {
  return bytes.length >= 2 && bytes[bytes.length - 2] === CR && bytes[bytes.length - 1] === LF;
}

// 头部值里不能出现 CR/LF：换行会把一个头字段拆成两个，构成头注入。
function sanitizeHeaderValue(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

// 拼出完整的 MHTML 字节。parts 每项：
// { contentType, contentLocation, encoding: "quoted-printable"|"base64", bytes }
export function buildMhtml({ snapshotUrl, subject, date, parts }) {
  const chunks = [];
  const header = [
    "From: <Saved by Best IP>",
    `Snapshot-Content-Location: ${sanitizeHeaderValue(snapshotUrl)}`,
    `Subject: ${sanitizeHeaderValue(subject)}`,
    `Date: ${date.toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; type="text/html"; boundary="${BOUNDARY}"`,
    "",
    "",
  ].join("\r\n");
  chunks.push(header);

  parts.forEach((part) => {
    chunks.push(
      `--${BOUNDARY}\r\n`,
      `Content-Type: ${sanitizeHeaderValue(part.contentType)}\r\n`,
      `Content-Transfer-Encoding: ${part.encoding}\r\n`,
      `Content-Location: ${sanitizeHeaderValue(part.contentLocation)}\r\n`,
      "\r\n",
    );
    const encoded = part.encoding === "base64" ? encodeBase64(part.bytes) : encodeQuotedPrintable(part.bytes);
    chunks.push(bytesToLatin1(encoded));
    // 边界行必须落在行首：正文末尾没有 CRLF 就补一个；已经有就不能再补，
    // 多补一个会在正文尾部凭空多出一个空行，往返就再也对不上了。
    if (!endsWithCrlf(encoded)) chunks.push("\r\n");
  });

  chunks.push(`--${BOUNDARY}--\r\n`);
  return latin1ToBytes(chunks.join(""));
}

// ------------------------------------------------------------- MIME 解析 ---

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseHeaderBlock(text) {
  const headers = {};
  text.split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    const colon = line.indexOf(":");
    if (colon <= 0) return;
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  });
  return headers;
}

function splitHeaderAndBody(text) {
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { head: text, body: "" };
  return { head: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

// 把 MHTML 字节解回 { headers, parts }，部件正文是**解码后**的字节。
//
// 切分按 latin1 字符串上的偏移来做，不做「按行切开再拼回去」：正文末尾那个属于
// 正文自身的 CRLF 和分隔边界的换行长得一模一样，按行拼装会把它吃掉，
// 往返就不再逐字节相等。
//
// 注意：正文若原本不以换行结尾，buildMhtml 会为边界行补一个 CRLF，
// 解析回来就会多出这一个 CRLF。这是 MIME 分隔的固有代价，不是实现缺陷。
export function parseMhtml(bytes) {
  const text = bytesToLatin1(bytes);
  const delimiterRe = new RegExp(`^--${escapeRegExp(BOUNDARY)}(--)?[ \\t]*\\r?\\n`, "gm");
  const marks = [];
  let match = delimiterRe.exec(text);
  while (match !== null) {
    marks.push({ start: match.index, end: delimiterRe.lastIndex, closing: Boolean(match[1]) });
    match = delimiterRe.exec(text);
  }

  const headers = parseHeaderBlock(marks.length ? text.slice(0, marks[0].start) : text);
  const parts = [];

  for (let index = 0; index < marks.length; index += 1) {
    if (marks[index].closing) break;
    const next = marks[index + 1];
    if (!next) break;
    const block = splitHeaderAndBody(text.slice(marks[index].end, next.start));
    const partHeaders = parseHeaderBlock(block.head);
    const raw = latin1ToBytes(block.body);
    const encoding = String(partHeaders["Content-Transfer-Encoding"] || "").trim().toLowerCase();
    parts.push({
      headers: partHeaders,
      body: encoding === "base64" ? decodeBase64(raw) : decodeQuotedPrintable(raw),
    });
  }

  return { headers, parts };
}

// 行宽上限只留一处真值：往返测试直接断言编码结果不超过它。
export { MAX_LINE as MAX_LINE_LENGTH };

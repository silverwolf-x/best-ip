// 发布闭环的最后一步：对刚上线的生产站点做自证。
//
// 只做两件事，且都不依赖部署方的自述：
//   1. 无凭据可达性——登录页可达、CSP 仍放行签名 blob、静态资源仍被会话门挡住；
//   2. 有凭据字节比对——用 SITE_PASSWORD 登录后，把**当前 assets 目录**下每一个被 git
//      跟踪的文件与它在该 commit 里的 blob 逐字节比对。
// 第 2 步是真正的漂移门：`wrangler deploy` 只报「上传成功」，它不说线上提供的是不是这一个
// commit 的内容；而历史上确实发生过线上跑旧资产的静默漂移。
//
// assets 目录不写死：从 wrangler.jsonc 的 assets.directory 读（`--assets` 可覆盖）。写死成某一个
// 目录会变成一个绿着的假门禁——部署根换了、校验还在比老目录，每个「线上文件」都 404，而 404 与
// 内容不一致在结论里长得一模一样，只是更难查。
//
// 没有 SITE_PASSWORD 时只跑第 1 步并明确标注「未做字节比对」，不会假装验过。
//
// 用法：
//   node scripts/verify_deploy.mjs --site https://best-ip.silverwolfx.workers.dev
//   SITE_PASSWORD=... node scripts/verify_deploy.mjs --site <url> --commit <sha>
// 退出码：0 全通过；1 有失败项。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const argOf = (name, fallback = "") => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

function stripJsonComments(text) {
  // wrangler.jsonc 是 JSONC：先删块注释，再删整行注释。这个配置里没有含 // 的字符串值。
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^[ \t]*\/\/.*$/gmu, "");
}

/** assets.directory → 仓库相对路径（`./frontend-next/` → `frontend-next`）。 */
function assetDirectoryOfWrangler(configPath = "wrangler.jsonc") {
  const config = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")));
  const directory = config?.assets?.directory;
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error(`${configPath} 里没有 assets.directory，无法确定该拿哪个目录当比对基准`);
  }
  return directory.trim().replace(/^\.\//u, "").replace(/\/+$/u, "");
}

const SITE = argOf("site", "https://best-ip.silverwolfx.workers.dev").replace(/\/+$/u, "");
const COMMIT = argOf("commit", "HEAD");
const PASSWORD = argOf("password", process.env.SITE_PASSWORD || "");
const ASSETS_DIR = argOf("assets", assetDirectoryOfWrangler());
const UA = "best-ip-deploy-verify";
const ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;
const BLOB_CSP = "connect-src 'self' https://*.blob.core.windows.net";
const SESSION_COOKIE = "__Host-best-ip-session";
// 新资产在边缘生效有个窗口（见 waitForAssets 的注释）：探到生效为止，最多 6 轮 × 5 秒。
const ASSET_GRACE_ROUNDS = 6;
const ASSET_GRACE_WAIT_MS = 5_000;

const failures = [];
const results = [];

function record(ok, label, detail = "") {
  results.push({ ok, label, detail });
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, { method = "GET", headers = {}, body } = {}) {
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(SITE + path, {
        method,
        headers: { "User-Agent": UA, ...headers },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // 5xx 是 Cloudflare/上游的瞬时面，重试；4xx 是确定答复，直接返回。
      if (response.status >= 500 && attempt < ATTEMPTS) {
        lastError = `HTTP ${response.status}`;
        await sleep(1500 * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error?.message || String(error);
      if (attempt < ATTEMPTS) await sleep(1500 * attempt);
    }
  }
  throw new Error(`${method} ${path} 连续 ${ATTEMPTS} 次失败：${lastError}`);
}

function cookiesOf(response) {
  const raw = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return raw.map((entry) => entry.split(";")[0].trim()).filter(Boolean);
}

function blobAt(path) {
  // blob 原始字节，绕开本地 checkout 的换行转换（core.autocrlf）。
  return execFileSync("git", ["show", `${COMMIT}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
}

/** 当前 assets 目录下被 git 跟踪的全部文件，路径已去掉目录前缀。 */
function trackedAssetFiles() {
  return execFileSync("git", ["ls-files", ASSETS_DIR], { encoding: "utf8" })
    .split("\n").map((line) => line.trim()).filter(Boolean)
    .map((path) => path.slice(ASSETS_DIR.length + 1));
}

/**
 * 未登录可达性探测用的那条静态资源路径：取目录里真实存在的一个文件。
 * 不写死某个具体路径——换了 assets 根之后写死的路径根本不存在，而那条断言测的是「会话门挡不挡」，
 * 不管文件在不在，会一直绿着。
 */
function assetProbePath() {
  const files = trackedAssetFiles();
  return files.find((path) => path !== "index.html" && !path.endsWith(".pem")) || "styles.css";
}

/**
 * 等线上资产真的生效，再进逐字节比对。Cloudflare 把新版本切到每个边缘有个窗口：
 * 2026-09-22 那次发布实测——版本创建后约 2 秒去看，嵌套目录下的文件全是 404；3 分钟后再看同一个
 * URL 是 200 且字节正确（`/app/api.js` 12089 B、`/app/main.js` 20001 B）。那不是漂移，但会把发布
 * 判红。所以这里用目录里第一个非 index.html 的文件探一次，404 就等 5 秒重探，最多 6 轮。
 * 等不到也不放弃比对：真正的漂移（发错版本、漏发文件）正是后面要判红的东西。
 */
async function waitForAssets(session) {
  const probePath = assetProbePath();
  let status = 0;
  for (let round = 1; round <= ASSET_GRACE_ROUNDS; round += 1) {
    const response = await request(`/${probePath}`, { headers: { Cookie: session } });
    status = response.status;
    if (status !== 404) return { probePath, round, status };
    if (round < ASSET_GRACE_ROUNDS) {
      console.log(`      /${probePath} 还是 404（第 ${round} 轮）：新资产在边缘生效有个窗口，等 ${ASSET_GRACE_WAIT_MS / 1000} 秒再探。`);
      await sleep(ASSET_GRACE_WAIT_MS);
    }
  }
  return { probePath, round: ASSET_GRACE_ROUNDS, status };
}

async function main() {
  console.log(`站点：${SITE}`);
  console.log(`比对基准：${COMMIT}（${ASSETS_DIR}/ 下全部被跟踪文件）\n`);

  // ---- 第 1 步：无凭据可达性 ----
  const loginPage = await request("/login");
  const loginHtml = await loginPage.text();
  record(loginPage.status === 200 && /name="password"/u.test(loginHtml), "登录页可达", `HTTP ${loginPage.status}`);

  const csp = loginPage.headers.get("content-security-policy") || "";
  record(csp.includes(BLOB_CSP), "CSP 仍放行签名 blob", csp ? "connect-src 已核对" : "缺少 CSP 头");

  const root = await request("/");
  const rootBody = await root.text();
  let gated = false;
  try {
    gated = root.status === 401 && JSON.parse(rootBody).error === "login_required";
  } catch {
    gated = false;
  }
  record(gated, "未登录访问被会话门挡住", `HTTP ${root.status}`);

  const probePath = assetProbePath();
  const asset = await request(`/${probePath}`);
  record(asset.status === 401, "静态资源未登录不可读", `HTTP ${asset.status}`);

  // ---- 第 2 步：有凭据字节比对 ----
  if (!PASSWORD) {
    console.log("\n未提供 SITE_PASSWORD：跳过字节比对，本次**没有**验证线上内容与 commit 一致。");
  } else {
    const csrf = /name="csrf" value="([A-Za-z0-9_-]{32})"/u.exec(loginHtml)?.[1] || "";
    const csrfCookie = cookiesOf(loginPage).find((entry) => entry.includes("login-csrf")) || "";
    record(Boolean(csrf && csrfCookie), "登录页下发 CSRF 令牌");
    if (!csrf || !csrfCookie) return;

    const loginResponse = await request("/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: SITE,
        Cookie: csrfCookie,
      },
      body: new URLSearchParams({ csrf, password: PASSWORD }).toString(),
    });
    const session = cookiesOf(loginResponse).find((entry) => entry.startsWith(`${SESSION_COOKIE}=`)) || "";
    record(loginResponse.status === 303 && Boolean(session), "登录换取会话", `HTTP ${loginResponse.status}`);
    if (!session) return;

    const grace = await waitForAssets(session);
    if (grace.status === 404) {
      console.log(`      /${grace.probePath} 等满 ${ASSET_GRACE_ROUNDS} 轮仍是 404：按真实漂移处理。`);
    } else if (grace.round > 1) {
      console.log(`      /${grace.probePath} 在第 ${grace.round} 轮生效（HTTP ${grace.status}）。`);
    }

    // /site-config.js 不在这份清单里：它由 worker/router.js 现算（注入 mode 与公钥指纹），
    // 不是仓库里的文件，没有可比对的 blob。
    const files = trackedAssetFiles();
    const mismatches = [];
    for (const path of files) {
      const served = path === "index.html" ? "/" : `/${path}`; // 首页只挂在根路径上
      const response = await request(served, { headers: { Cookie: session } });
      if (response.status !== 200) {
        mismatches.push(`${path} -> HTTP ${response.status}`);
        continue;
      }
      const live = Buffer.from(await response.arrayBuffer());
      const expected = blobAt(`${ASSETS_DIR}/${path}`);
      if (!live.equals(expected)) {
        mismatches.push(`${path} -> ${live.length}B sha=${createHash("sha256").update(live).digest("hex").slice(0, 12)} ≠ ${expected.length}B sha=${createHash("sha256").update(expected).digest("hex").slice(0, 12)}`);
      }
    }
    record(mismatches.length === 0, `线上内容与 ${COMMIT} 逐字节一致`, mismatches.length === 0 ? `${files.length}/${files.length} 个文件` : mismatches.slice(0, 5).join("; "));
    if (mismatches.length > 5) console.log(`     …另有 ${mismatches.length - 5} 处不一致`);
  }

  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n结果：${passed}/${results.length} 项通过`);
  if (failures.length) {
    console.log("失败项：");
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
}

await main();

// ============================================================================
// 发布路径门闩：只有远程（GitHub Actions）能发布，本地一律拒绝。
// ----------------------------------------------------------------------------
// 为什么需要这个门闩：2026-09-24 那次「本地 npm run deploy」把工作区里 CRLF 的资产
// （本机 core.autocrlf=true，而仓库 blob 是 LF）当成线上内容发了上去，线上因此短暂跑着
// 与任何 commit 都不一致的文件（app/api.js 12327B vs blob 12089B）。`wrangler deploy`
// 只报「上传成功」，它不会说发上去的是不是仓库里的字节；发布能「等于某个 commit」这条
// 契约只有把发布固定在流水线上才守得住（CI 检出是 LF，且发布的就是 CI 验过的那一个 commit）。
//
// 这个脚本做两件事：
//   1. 非 GitHub Actions 环境直接拒绝（exit 2），并打印两条真正的发布路径；
//   2. 在 Actions 里发布之前再断言一次：assets 目录下的文本资产一个 CR 字节都不能有——
//      把「发布内容与 commit 的 blob 不一致」从发布后的事后检查提到发布前。
//      发布后仍由 scripts/verify_deploy.mjs 做逐字节比对，这里只是更早的一道。
//
// 用法（只有 worker.yml 会用到）：node scripts/deploy_guard.mjs
// 退出码：0 可以发布；1 资产含 CR；2 不是 Actions 环境。
// ============================================================================

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEXT_ASSET_PATTERN = /\.(?:html|css|js|mjs|json|pem|svg|txt)$/iu;

function stripJsonComments(text) {
  // wrangler.jsonc 是 JSONC：先删块注释，再删整行注释（与 verify_deploy.mjs 同一套读法）。
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^[ \t]*\/\/.*$/gmu, "");
}

/** assets.directory → 仓库相对路径（`./frontend-next/` → `frontend-next`）。 */
function assetDirectoryOfWrangler(configPath = "wrangler.jsonc") {
  const config = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")));
  const directory = config?.assets?.directory;
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error(`${configPath} 里没有 assets.directory，发布前无法确认要检查哪个目录`);
  }
  return directory.trim().replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function textAssets(directory) {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile() && TEXT_ASSET_PATTERN.test(entry.name)) files.push(next);
    }
  };
  walk("");
  return files.sort();
}

function commitOfHead() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

if (process.env.GITHUB_ACTIONS !== "true") {
  console.error(
    [
      "拒绝本地发布：发布只能走远程仓库，本地 npm run deploy 已被禁止。",
      "",
      "两条真正的发布路径：",
      "  1. push 到 main → CI（lint + 语法 + wrangler dry-run）成功后，Deploy Cloudflare Worker",
      "     工作流自动发布，发布的就是 CI 验过的那一个 commit；",
      "  2. 需要重发一次时：gh workflow run worker.yml --ref main（或 GitHub 页面上手动派发）。",
      "",
      "为什么：本地部署会把工作区（可能是 CRLF 检出、可能带着未提交改动）的字节直接发到线上，",
      "而 wrangler deploy 只报「上传成功」，不会说发上去的是不是仓库里的内容。本地能做的只读检查：",
      "npm run check、npm run dry-run、npm run verify:deploy（核对线上内容与当前 commit 一致）。",
    ].join("\n"),
  );
  process.exit(2);
}

const assetsDir = assetDirectoryOfWrangler();
const files = textAssets(assetsDir);
const offending = [];
for (const path of files) {
  const body = readFileSync(join(assetsDir, path));
  if (body.includes(0x0d)) offending.push(`${path}（${body.length} 字节，含 CR 字节）`);
}

if (offending.length) {
  console.error(
    [
      `拒绝发布：${assetsDir}/ 下有 ${offending.length} 个文本资产含 CR 字节，发布内容不可能等于任何 commit 的 blob。`,
      ...offending.slice(0, 10).map((entry) => `  - ${entry}`),
      "多半是检出时被换行转换过（core.autocrlf=true）。在 Actions 里出现说明 checkout 配置被改过。",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  `发布前检查通过：${assetsDir}/ 下 ${files.length} 个文本资产无 CR 字节，commit ${commitOfHead()}（GitHub Actions 检出）。`,
);

// 跑 write-notes-like-deepseek 的三条校验线，作为提交前的笔记门禁。
//
// 校验脚本本体在 skill 仓库里，不在本仓库内：本仓库只做调用，避免把 skill 的
// TypeScript 工具链和依赖复制进来。skill 位置优先取 AGENT_NOTES_SKILL，否则用
// 约定的用户级安装路径。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const skillRoot =
  process.env.AGENT_NOTES_SKILL || join(homedir(), ".agents", "skills", "write-notes-like-deepseek");

if (!existsSync(join(skillRoot, "scripts", "verify-agent-note-tree.ts"))) {
  console.error(
    `找不到笔记校验脚本：${skillRoot}\n` +
      "请安装 write-notes-like-deepseek skill，或用 AGENT_NOTES_SKILL 指向它的根目录。",
  );
  process.exit(2);
}

const lines = [
  "verify-agent-note-tree.ts",
  "verify-agent-note-format.ts",
  "verify-archived-agent-notes.ts",
];

// Windows 上 npx 是 .cmd，Node 不允许不带 shell 直接 spawn；把它整条当命令串交给
// shell，既避开 DEP0190（传 args 数组 + shell），也不用猜 tsx 装在哪。
const isWindows = process.platform === "win32";

for (const line of lines) {
  const script = join(skillRoot, "scripts", line);
  const result = isWindows
    ? spawnSync(`npx --yes tsx "${script}"`, { stdio: "inherit", shell: true })
    : spawnSync("npx", ["--yes", "tsx", script], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

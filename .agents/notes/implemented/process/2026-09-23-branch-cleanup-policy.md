# Agent Note: 分支清理——squash 合过的分支按「内容已进 main」判定后删

Status: implemented

## Problem

远端堆着 5 个非 main 分支、本地 4 个：`design/new-frontend`、`feat/frontend-next-gateway`、`feat/verify-assets-grace`、`probe/ipv6-egress`、`probe/selector-404`。前三个早已通过 PR #4 / #5 / #7 squash 合并，但**「已合并」这件事在 git 里看不出来**：squash 落地的是新提交，`git merge-base --is-ancestor <branch> main` 一律报 NO，`git cherry main <branch>` 对分支上每个提交都打 `+`（未合并）。结果没人敢删：分不清谁比谁新，probe/* 更像「还有没回流的活」——而它们的结论其实早已变成 main 上的生产修复。

## Decision

删分支之前先证明它**没有独有内容**，判据是逐文件比对 blob：

1. 取该分支相对 `merge-base` 改过的每个文件（`git diff --name-only $(git merge-base main <b>) <b>`）；
2. 取分支 tip 上该文件的 blob：`git ls-tree -r <b> -- <path>`。**不要用 `git rev-parse <b>:<path>`**——本机 Git Bash 会把含 `:`、以 `.` 开头的参数做路径转换（`/` 变 `\`、`:` 变 `;`），这类路径会静默失败，把「该文件不在分支上」误报成结论；
3. `git log --all --format=%H --find-object=<blob>` 找出引入这个 blob 的提交，只要其中**有一个是 main 的祖先**，这个文件的内容就已经进过 main。之后 main 可能又改过它——那是 main 更新，不是分支独有。

判据结果与动作：

- `design/new-frontend`（`b12debe`）、`feat/frontend-next-gateway`（`8de0743`）、`feat/verify-assets-grace`（`c89eb50`）的每个改动文件都 landed=yes → 本地 + 远端都删。
- `docs/frontend-next-notes`（PR #8）与 `debug/live-assets`（PR #6，自述「临时探针，验完即删」）在 PR 合并/关闭时已被 GitHub 删掉，本地只剩过时的 remote-tracking ref，由 `git fetch --prune origin` 收掉。
- `probe/selector-404`（`f2f821f`）与 `probe/ipv6-egress`（`29249bb`）landed=no：独有的只是两个探测脚本（`scripts/probe_selector_race.py`、`scripts/probe_ipv6_relay.py`）和探针专用的 `scan.yml` 改动（`ref: main` → `ref: ${{ github.ref_name }}`，并把「Run production scan」换成探测脚本）。它们的**结论**已在 main 上（`ba75d74` 就绪判据补 selector 组注册、`6725c79` mihomo 允许 IPv6），并写进 [selector 就绪竞态笔记](../bug-fix/2026-09-23-selector-readiness-race.md) 与 [mihomo 允许 IPv6 笔记](../bug-fix/2026-09-23-mihomo-allow-ipv6.md)（run ID + 分支名 + SHA）。**两个脚本本轮不回流，两个 probe 分支直接删。**

`scan.yml` 的 checkout `ref` 保持写死 `main`：生产派发（`worker/config.js` 的 `GITHUB_REF = "main"`）恒跑 main 的代码，这是它的语义。探针要跑分支代码**不需要**改它——**派发到某分支时，被执行的 workflow 文件就是那个分支自己的**（probe 分支正是靠这一点把探测步骤塞进 runner 的），所以探针分支自带一行 `ref` 改动即可；派到没改过 `ref` 的分支会静默跑 main 的代码，那次无效实验的坑见 mihomo 笔记，排错时先比 `headSha` 与被执行代码是否同一份。

## Alternatives considered

### Why not 把两个探针脚本回流 main？
最强理由：它们是笔记里引用的取证工具，回流后「这个实验怎么做」有可执行副本，下次遇到同类竞态不必重写；`scripts/` 本来就是这类脚本的家（`verify_real_scan.py` 就在那儿）。不选的原因：两个脚本把这次订阅的节点名与目标表写死在源码里（`TARGETS` / `CASES`），回流等于把一份具体订阅清单固化成仓库工具；而它们的价值是「一次取证」，结论已经变成 main 上的生产判据，留下复现配方就够了——配方与判据都在那两篇笔记里。

### Why not 保留这些分支不删？
最强理由：分支名 + SHA 是直达证据的最短路径，删了之后 `git log --all` 再也找不到那些提交，公开仓库里只剩 squash 后的那一个。不选的原因：这些分支已经没有独有内容（判据逐个证明过），留下的代价是分支列表持续腐化——已合并的分支在 `git cherry` 里全部显示 `+`，会不断被误读成「有没合完的活」。

### Why not 顺手把 main 的 `scan.yml` 改成 `ref: ${{ github.ref_name }}`？
最强理由：那次无效实验的根因就是这个 `ref: main`，改成派发 ref 以后任何分支探针都不会再踩；仓库自己的笔记也把它写成「派分支探针的正确姿势」。不选的原因：生产扫描工作流的语义就是「派发即跑 main 的代码」，这是边界不是缺陷；而探针要跑分支代码时被执行的本就是分支自己的 workflow 文件，一行 `ref` 改动留在探针分支里就够。本轮只做清理，不顺手改生产 workflow 的语义。

### Why not 直接把判据写成 CI 检查 / git hook？
最强理由：靠人记得删就是会忘，机械纪律该由脚本兜底（本仓库的笔记门禁就是这么做的）。不选的原因（本轮）：判据要 `--find-object` 扫全历史，跑在 CI 上得全量 clone，代价大于它拦下的问题；先落在笔记里，等真出现第二个维护者再脚本化。

## Consequences

- 收益：远端非 main 分支 5 → 0，本地 4 → 0（清理后只剩 main）。
- 收益：「squash 合并过的分支能不能删」有了机械判据（blob 在 main 历史里），不必再靠人肉 diff 或直觉。
- 代价：probe 分支的取证现场（脚本源码、探针 workflow 改动、失败现场日志）只剩笔记与 SHA；GitHub 侧未被引用的对象最终会被回收，所以**要复现得按笔记重写脚本**。
- 代价：删除动作本身没有 PR 审计，只有本笔记的清单与 SHA。
- 仍未做：没有自动检查拦「已合并分支长期保留」。

## Testing

- 删前对 5 个分支逐个跑上面的逐文件判据（一次性脚本，跑在本机），landed=yes/no 的结论与 tip SHA 都写在 Decision 里。
- 清理后 `git fetch --prune origin` + `git branch -a` 只剩 main。
- 门禁：`npm run verify-notes`、`npm run check`、`uv run ruff check .`。

# Agent Note: 发布只走远程——本地 `npm run deploy` 一律拒绝

Status: implemented

## Problem

[上一轮](2026-09-21-worker-autodeploy-on-ci-success.md)把「push → CI → 自动发布」这条链建起来了，但 `npm run deploy` 仍然是 `wrangler deploy`，也就是说**本地手工发布这条路依旧通着**。本轮它当场咬了人：

- 本机 `core.autocrlf=true`（工作区是 CRLF，仓库 blob 是 LF）。本地 `npm run deploy` 把工作区的字节原样发上线，线上因此跑着与**任何 commit 都不一致**的资产：`app/api.js` 线上 12327 B vs blob 12089 B，差的 238 字节正是 CR 的个数（每行一个）。
- 而 `wrangler deploy` 对这种发布只报「上传成功」（`Total Upload` / `Uploaded best-ip` / `Current Version ID`），它不会说发上去的是不是仓库里的内容——发布本身**没有任何自证**。
- 后果落在门禁上：随后派发的 `Deploy Cloudflare Worker` 运行 `35928634041` 的 `Verify deployed release` 在 22:29:52→22:29:55 判红（`6/7`，失败项就是「线上内容与 commit 逐字节一致」）。三分钟后原样重跑同一个 run（attempt 2）是 `7/7`、18/18 全绿。

于是有两个独立的问题被暴露出来：

1. **本地发布没有任何拦截**：发布这份「必须等于某个 commit」的契约，靠的是「人不去跑那条命令」，而人已经跑了。
2. **部署后自证的宽限口径太窄**：宽限只在探针文件返回 `404` 时才等（`ASSET_GRACE_ROUNDS=6` × 5 秒），而边缘切换窗口还有另一种形态——探针文件已是新字节，别的路径仍返回**上一版**的字节。那次 attempt 1 就是这一种：`404` 分支根本没进（进了至少等 5 秒，而这一步 3 秒就结束了），逐字节比对直接判红。假红会让这道门禁变成噪音，真漂移反而不容易看见。

## Decision

**发布只能发生在远程，本地一律拒绝。**

- `package.json`：`"deploy": "node scripts/deploy_guard.mjs && wrangler deploy"`。守卫串在 deploy 前面，任何走 `npm run deploy` 的路径（本地、脚本、以后新加的 workflow）都会先过它。
- `scripts/deploy_guard.mjs` 两件事：
  1. `process.env.GITHUB_ACTIONS !== "true"` → 打印两条真正的发布路径并 `exit 2`。本地跑不通，且报错信息直接把正确做法摊开：push 到 main 走 CI 自动发布，或 `gh workflow run worker.yml --ref main` 重发一次。
  2. 在 Actions 里发布**之前**再断言一次：`assets.directory`（从 `wrangler.jsonc` 读，不写死）下的文本资产一个 CR 字节都不能有，`exit 1`。这把「发布内容与 blob 不一致」从发布**后**的事后检查提到发布**前**；发布后仍有 `scripts/verify_deploy.mjs` 逐字节比对兜底。
- `scripts/verify_deploy.mjs` 的宽限判据从「是不是 404」改成「内容是否已等于目标 blob」：新增 `fetchTrackedAsset()`（取到 200 且字节等于该 commit 的 blob 才算到位，否则在预算内重取）、`waitForGrace()`，常量由 `ASSET_GRACE_ROUNDS` 换成共用预算 `ASSET_GRACE_BUDGET_MS = 90_000` + 单轮 `ASSET_GRACE_WAIT_MS = 5_000`。预算在整个比对过程里**共用一份**，所以真漂移最多拖住 90 秒，不会每个文件各等一轮把 CI 拖成十几分钟。探针（`waitForAssets`）与逐文件比对走同一个函数，口径一致。
- 文档同步：`README.md` 部署章节、`docs/CONTRACTS.md` 里那句 `npm run deploy` publishes 的描述、`worker.yml` 的 deploy 步骤注释。

发布入口仍然只有一个：`worker.yml`（`workflow_run` on CI success + `workflow_dispatch`），checkout 的是 CI 验过的那个 `head_sha`，CI 检出固定 LF。**「发布内容等于某个 commit」这条性质现在由流水线保证，而不是由人的自觉保证。**

## Alternatives considered

### Why not 只写进文档/约定，不动脚本？

最强理由：零新增脚本、不动 `package.json`、不给发布加一层壳，纯粹靠纪律；而且本地发布在排查时确实偶尔方便。不选的原因：这条纪律在本轮已经被违反过一次并真实污染了线上（见 Problem），而文档不会在有人敲下 `npm run deploy` 的那一刻拦住他。守卫脚本的成本是 100 行、零依赖、零运行时开销。顺带它还提供了「排查时怎么做」的正解（只读检查清单），把「方便」的需求也接住了。

### Why not 用 `.gitattributes`（`* text=auto eol=lf`）治根？

最强理由：这才是根因——CRLF 根本不该出现在工作区，正规化之后再本地发布也不会发出与 blob 不同的字节；一个文件解决问题，所有工具（不只 wrangler）都受益。不选的原因（本轮）：它会重写全仓文本文件的 blob，是一次影响所有协作者的大 diff，需要用户明确拍板；而且它只解决 CRLF 这一种偏差，拦不住「带着未提交改动发布」，也不提供「发布等于某个 commit」这条可验证的性质。两条路不互斥——将来若要做，这条笔记是它的前置论证。

### Why not 在 wrangler 侧做门闩？

最强理由：把限制放在工具层，绕过 `package.json` 也没用，最贴近「不可绕」。不选的原因：wrangler 没有「只在 CI 里允许 deploy」这类开关；而用 `deploy --dry-run` 之类替换真实 deploy 会连 CI 发布一起禁掉。工具层做不到，就只能落在调用层，那就是 `package.json` 的 deploy 脚本。

### Why not 用 npm 的 `predeploy` 生命周期钩子？

最强理由：更 npm 原生，不改 `deploy` 这一行的语义，任何 `npm run deploy` 都会自动触发。不选的原因：钩子是隐式的，改守卫的人得先知道它存在；串在同一条命令里（`node scripts/deploy_guard.mjs && wrangler deploy`）读起来更直白，退出码语义也一样。

### Why not 让 `verify_deploy` 保持只对 404 宽限？

最强理由：改动最小，且能让真漂移更快报红（不必等预算）。不选的原因：实测已经出现过非 404 的中间态判红（Problem 第 2 条），假红会把门禁变成噪音——而一道会自己变红的门禁很快就会被忽略，那才是真漂移的开头。宽限只作用于「不一致」这一支，真漂移仍然报红，只是最坏多花 90 秒。

## Consequences

- 收益：本机（以及任何非 Actions 环境）无法再发布；线上内容与 `main` 上某个 commit 的一致性由流水线保证，不再依赖人的自觉。
- 收益：CRLF 类不一致在发布**前**就被拦下（Actions 里的 CR 断言），而不是发布**后**由自证发现——坏发布产生的窗口更短。
- 收益：`verify:deploy` 不再把边缘传播窗口判成漂移；真漂移仍报红且带逐文件字节/SHA 明细。
- 代价：本地无法再用 `npm run deploy` 做“先发上去看看”的试探，排查只能靠 `dry-run` 与本地 dev（`npm run dev`）。这是有意的。
- 代价：`GITHUB_ACTIONS=true` 是环境变量层面的判据，理论上可以本地伪造（`GITHUB_ACTIONS=true npm run deploy` 会通过）。它拦的是「顺手跑」（也就是真实发生的那次），不是恶意绕过；要更强需要平台侧的 Environment 审批，那是另一个决定。
- 代价：`verify:deploy` 最坏多花 90 秒。目前 18 个文件、正常情况几秒内全绿，实测无感。
- 事实：`scan.yml` 与订阅扫描链路完全不受影响。

## Testing

- 门禁：`uv run --no-dev ruff check .`、`npm run check`（逐文件 `node --check`，含新脚本）、`npm run verify-notes`、`npm run dry-run`。
- 守卫本地拒绝：直接跑 `npm run deploy` → 退出码 2、打印两条远程发布路径、**没有**发生任何上传。
- 守卫在 Actions 里的 CR 断言：`worker.yml` 的 `Deploy Worker and static assets` 步骤日志里出现 `发布前检查通过：frontend-next/ 下 N 个文本资产无 CR 字节，commit <sha>`。
- 发布后自证：`npm run verify:deploy` 逐字节比对 + 无凭据可达性共 7 项，必须 `7/7`（本地核对时用 `SITE_PASSWORD`）。
- 端到端：这次改动由 `main` 的 CI → `worker.yml` 自动发布，工作流自身是这条规则的第一次真实运行。

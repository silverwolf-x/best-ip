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
- `scripts/deploy_guard.mjs` 四道断言：
  1. `process.env.GITHUB_ACTIONS !== "true"` → 打印两条真正的发布路径并 `exit 2`。本地跑不通，且报错信息直接把正确做法摊开：push 到 main 走 CI 自动发布，或 `gh workflow run worker.yml --ref main` 重发一次。
  2. 分支不是 `main` → `exit 3`。`workflow_dispatch` 可以指定 ref，不钉住分支的话 `gh workflow run worker.yml --ref <别处>` 能把任意分支发上线，而发布后自证比对的还是那个分支的 HEAD，会一路绿灯（这两条都是代码复核指出来的缺口）。
  3. `HEAD !== GITHUB_SHA` → `exit 4`。「发布的就是 CI 验过的那一个 commit」是这条链的性质，不该只靠 workflow 里那一行 `ref:` 的自觉。
  4. 发布**之前**断言「工作区字节 == 这个 commit 的 blob」：`assets.directory`（从 `wrangler.jsonc` 读，不写死）下每个文件都必须被 git 跟踪，且逐字节等于 `git show HEAD:<path>`；符号链接、未被跟踪的文件、被跟踪但缺失的文件各自报出来，都 `exit 1`。这把「发布内容与 blob 不一致」从发布**后**的事后检查提到发布**前**；发布后仍由 `scripts/verify_deploy.mjs` 对线上逐字节比对兜底。
      - 这一条最初的写法是「按扩展名挑文本资产、查里面有没有 CR 字节」，复核指出那只是这条性质的**代理**：会漏掉 `.webmanifest`/`.map`/`.xml` 之类清单外的扩展名，也会把「blob 本身就含 CR」误判成漂移。直接比 blob 才是契约本身，代码也因此更短。
- `scripts/verify_deploy.mjs` 两处修改：
  - 宽限判据从「是不是 404」改成「内容是否已等于目标 blob」：新增 `fetchTrackedAsset()`（取到 200 且字节等于该 commit 的 blob 才算到位，否则在预算内重取）、`waitForGrace()`/`armGrace()`，常量由 `ASSET_GRACE_ROUNDS` 换成 `ASSET_GRACE_BUDGET_MS = 180_000`（与实测到的约 3 分钟传播窗口对齐）+ 单轮 `ASSET_GRACE_WAIT_MS = 5_000`。探针与逐文件比对**各开一段**预算（`armGrace()`），所以探针等久了不会把后面的文件剥夺掉重取机会；最坏耗时是 2 × 预算（真漂移），外加 `request()` 自身对 5xx/网络的重试。`worker.yml` 的 deploy job 加 `timeout-minutes: 20` 给这个最坏值封顶。
  - 收尾抽成 `finish()`，`main()` 的提前退出路径（CSRF 缺失、登录失败）改成 `return finish()`。原先那两处直接 `return`：`process.exitCode = 1` 只在收尾块里设置，于是 `SITE_PASSWORD` 轮换/填错时**门禁以 exit 0 收场**，工作流绿着、逐字节比对根本没跑——正是 worker.yml 想避免的「绿灯但没验」（同样是复核发现的）。
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

最强理由：改动最小，且能让真漂移更快报红（不必等预算）。不选的原因：实测已经出现过非 404 的中间态判红（Problem 第 2 条），假红会把门禁变成噪音——而一道会自己变红的门禁很快就会被忽略，那才是真漂移的开头。宽限只作用于「不一致」这一支，真漂移仍然报红，只是最坏多花 2 × 预算（探针与逐文件各一段）。

## Consequences

- 收益：本机（以及任何非 Actions 环境）无法再发布；线上内容与 `main` 上某个 commit 的一致性由流水线保证，不再依赖人的自觉。
- 收益：CRLF 类不一致在发布**前**就被拦下（断言工作区字节 == blob），而不是发布**后**由自证发现——坏发布产生的窗口更短。
- 收益：发布必须来自 `main` 的某个 commit，且检出与该 commit 一致；`--ref` 派发到别处、checkout 指错 ref 都会在发布前失败。
- 收益：`verify:deploy` 不再把边缘传播窗口判成漂移，也不会在登录失败时以 exit 0 蒙过工作流；真漂移仍报红且带逐文件字节/SHA 明细。
- 代价：本地无法再用 `npm run deploy` 做“先发上去看看”的试探，排查只能靠 `dry-run` 与本地 dev（`npm run dev`）。这是有意的。
- 代价：`GITHUB_ACTIONS=true` 是环境变量层面的判据，理论上可以本地伪造（`GITHUB_ACTIONS=true GITHUB_REF_NAME=main GITHUB_SHA=$(git rev-parse HEAD) npm run deploy` 会通过——但那要显式凑齐三个变量，而这次守卫对它们全部做了断言）。它拦的是「顺手跑」，不是恶意绕过；要更强需要平台侧的 Environment 审批，那是另一个决定。
- 代价：`verify:deploy` 最坏多花 2 × 180 秒（探针一段 + 逐文件一段），deploy job 的 `timeout-minutes: 20` 给这个上界封顶。目前 18 个文件、正常情况几秒全绿，实测无感。
- 代价：`wrangler deploy` 直接调用（不走 `npm run deploy`）仍然能把 CRLF 字节发上线；能做到的只有把 `npm run deploy` 钉死。发布正确姿势是写进文档、报错信息与 workflow 的，不是靠工具强制——真正的兜底是发布后 `verify:deploy` 的逐字节比对会把这种漂移判红。
- 事实：`scan.yml` 与订阅扫描链路完全不受影响。

## Testing

- 门禁：`uv run --no-dev ruff check .`（All checks passed）、`npm run check`（逐文件 `node --check`，含新脚本）、`npm run verify-notes`（24 篇三线 ok）、`npm run dry-run`。
- 守卫逐条实测（本机，scratch 里另造一个只含 LF blob 的 git 仓库，4 个文件）：
  - 非 Actions → `exit 2`，打印两条远程发布路径，**没有**发生任何上传；
  - `GITHUB_ACTIONS=true GITHUB_REF_NAME=main GITHUB_SHA=$(git rev-parse HEAD)`（LF 工作区）→ `exit 0`，输出「frontend-next/ 下 3 个文件与 commit 0776559 的 blob 逐字节一致（分支 main）」；
  - 工作区改一个字节不提交 → `exit 1`，点名 `styles.css：工作区 22B、blob 21B`；
  - 资产目录里塞一个未跟踪文件 → `exit 1`，点名「未被 git 跟踪但仍会被上传的文件 1 个：app/stray.js」；
  - 分支换成 `probe/x` → `exit 3`；`GITHUB_SHA` 换成全零 → `exit 4`；
  - 本机真实 CRLF 工作区 + Actions 环境 → `exit 1`，`15/18 个文件的工作区字节 ≠ blob`，逐条给出「多出的 N 字节全是 CR（CRLF 检出）」——正是那次事故的形态（`app/api.js` 工作区 12327B vs blob 12089B，多 238 字节）。
- `verify:deploy` 实测：正确 `SITE_PASSWORD` → `7/7`、18/18 文件、exit 0；故意用错误密码 → 打印 `结果：5/6 项通过` + 失败项并 **exit 1**（改之前这条路是退出码 0、连结果行都没有）。
- 端到端：push 到 `main` → CI 成功 → `workflow_run` 自动发布；`Deploy Worker and static assets` 步骤日志出现 `发布前检查通过：… commit <sha>`，`Verify deployed release` 步骤 `7/7`。第一次这样发布的是运行 `35929389626`（commit `38f78b1`，版本 `07454fc9-7d07-4a9e-aaeb-945f5508389e`）。

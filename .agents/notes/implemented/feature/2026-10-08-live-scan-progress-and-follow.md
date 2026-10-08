# Agent Note: 扫描实时进度、刷新后自动跟进，以及更快的通路

Status: implemented

## Problem

用户要求「进一步优化前端和整个通路流程，使得迅速直观」，并用一条真实订阅实测。基线实测（本改动之前的 main，run `37740177614`）：派发 → 执行机就绪 8 秒、环境准备 12 秒、`Run production scan` 34 秒、上传 1 秒，共 59 秒。

这 59 秒里页面能说的只有 Actions 的步骤名：[页面内触发](2026-09-22-frontend-next-in-page-scan-trigger.md) 那一轮的进度行是「扫描执行中 · 已用时 18秒 · 当前步骤：Run production scan」，三十多秒一动不动，看不出扫了几个、还剩几个、成没成。根因不在页面：GitHub 在 job 结束前不给日志（在进行中的 job 上取日志实测 404），Actions API 只给得出步骤名与状态，节点级的进度在 runner 内存里，没有任何一条路通到浏览器。

同一篇笔记还记下两条体验缺口：刷新页面就丢掉本次扫描的进度（`scan_token` 只在内存），以及轮询上限 10 秒——一次一分钟的扫描跑完后页面最多还要干等 10 秒才发现。

## Decision

### runner → Worker 的进度通道（只有计数）

- `scripts/run_scan.py` 在扫描期间起一个跟报任务（`backend/app/scan/reporter.py` 的 `ProgressReporter.follow`），每 2 秒读一次扫描任务的内存计数，有变化（或 15 秒心跳）就 `POST /api/scan-progress`：`{request_id, run_id, run_attempt, phase, total, completed, success, partial, failed}`，`phase` 只有 `subscription → scanning → packaging → done` 四档。下载订阅前先发一条 `subscription`（不等它回来，订阅下载不排在上报后面），产物打包前发 `packaging`，`_publish` 之后发 `done`。
- 凭证与订阅中继同一把：进度端点是中继所在 Worker 的同源路径（从 `BEST_IP_SUBSCRIPTION_RELAY_URL` 取 origin），头 `X-Best-IP-Relay-Token` 对 Worker secret `SUBSCRIPTION_RELAY_TOKEN` 做常量时间比较。没配中继（本机）就不回报。
- **尽力而为**：任何失败（网络、非 204、超时 4 秒）只记一笔，不抛、不拖住扫描；结束时打一行 `progress_reports: sent=N failed=M` 当证据。
- Worker 侧（`worker/progress.js`）整条校验后写进 SQLite 后端的 Durable Object `SCAN_PROGRESS`：每个 `request_id` 一个实例、只存最新一条；同一次运行里**阶段不倒退、同阶段完成数不减少**（并发的首报与跟报、晚到的旧报告都不会把读数往回拨）；第一次写入 6 小时后整条清掉。
- 读的一侧只交回与 `run_id + run_attempt` 对得上的那条：同一 request_id 重跑时，上一次 attempt 的计数不能冒充这一次的。读不到、超时（3 秒）、绑定缺失一律是 `null`。

报告里**没有节点名、出口 IP 或订阅内容**——这些只在终态 artifact 里，而 artifact 要过脱敏与逐字节校验。进度是过程中的读数，不进表、不进导出；完成那一刻面板改用终态 artifact 的计数，两边数字在那一刻是同一份。

### Durable Object，而不是别的存储

两次 HTTP 请求（runner 的报告、浏览器的轮询）会落在不同的 Worker 实例上，必须有共享状态。Durable Object 用 `wrangler.jsonc` 的 `durable_objects` 绑定 + `migrations: [{ tag: "v1", new_sqlite_classes: ["ScanProgress"] }]` 声明，发布时由迁移自动创建，Workers 免费计划可用，**不需要在控制台事先建任何资源**——这和「发布只走远程流水线」的约定兼容。

### 前端：步骤条 + 真实进度条 + 自动跟进

- `frontend-next/app/progress.js`：五段步骤条「提交 → 排队 → 准备环境 → 扫描节点 → 校验结果」、一根 `<progress>`、一行说明、每秒走的用时。阶段由运行状态 + 步骤名（`Run production scan` 之前是准备、之后是校验）+ runner 读数三者合成，取较后的那一段，晚到的旧读数不往回拨。有总数时是确定进度（「12 / 25 个节点 · 9 完整 · 2 部分 · 1 失败」），没有总数时是不定进度条，**不编数字**。
- 状态全部用 `data-state` 与 `<progress>` 自己的属性表达，不写 style：生产 CSP 是 `style-src 'self'`，标记里的 style 会被静默丢弃（见 [CSP 笔记](../architecture/2026-09-22-frontend-csp-blocks-markup-styles.md)）。
- **刷新后自动跟进**：`GET /api/scans/latest` 新增 `active`——最新一次还在排队/执行时把它的身份、状态与进度读数交出来。页面照常显示已有结果，同时在顶部跟着那一次走进度，跑完自动换上新结果。跟进只读：没有停止按钮，自己一发起扫描就让位。
- 轮询改为首轮 1.5 秒、每次 ×1.5、上限 4 秒（原为 2 / 10 秒）；Worker 侧 `GET /api/scans/:id` 的 job 明细、进度读数、产物探测三路并行。

### 提速：节点并发 16

`scan.yml` 给 `Run production scan` 设 `BEST_IP_MAX_PARALLEL_NODES: "16"`。托管 runner 只有 2～4 核，`backend/app/config.py` 的默认公式 `min(16, max(8, CPU))` 在那里落在 8；同一个文件记着同一条 25 节点订阅 8→16 并发的墙钟实测（50.9s/70.9s → 30.4s/31.2s）。节点检测几乎全在等网络，16 个 Mihomo 进程对 runner 的内存不是问题。

### 端到端实测入口

`Verify scan flow`（`.github/workflows/verify-scan.yml`，人工派发）+ `scripts/verify_scan_flow.mjs`：在 runner 上用 `SITE_PASSWORD` 登录线上站点，`POST /api/scans` 投一封事先封好的信封，然后**直接 import 前端的 `scan.js` / `gateway.js` / `progress.js` / artifact reader** 跟进度、取产物、逐字节校验，只把 `fetch` 换成带会话 cookie 与同源 `Origin` 的那一个。它绿了，说明的是页面那条路通了，而不是一份仿制品通了。订阅明文不进 Actions 输入：信封在发起方本机用 `app/scan-crypto.js` 封好（15 分钟有效）。日志只打印聚合数字。

## Alternatives considered

### Why not 从 GitHub 拿进度（日志、步骤、annotation、check run）？

最强理由：零新增存储，Worker 已经有 GitHub App token，进度天然和运行身份绑在一起。不选的原因：进行中 job 的日志 API 返回 404（本轮实测）；步骤名是静态的，表达不了「第几个节点」；annotation / check run 需要 App 额外的 `checks` 权限，而 App 现在只有 `Actions: Read and write` + `Metadata: Read`，为一个进度读数扩权不划算；step summary 要等步骤结束才上传。

### Why not 用 KV 或 Cache API 存进度？

最强理由：KV 读写 API 最简单；Cache API 不需要任何绑定。不选的原因：KV namespace 要先在控制台或用带账号权限的命令建出来并把 id 写进配置，和「发布只走远程」的流水线不贴合，而且 KV 的最终一致（跨边缘可达一分钟）对一个两秒一跳的进度没用；Cache API 按数据中心隔离，runner 与浏览器很可能落在不同数据中心，彼此看不见。Durable Object 强一致、随迁移自动创建。

### Why not 把节点结果边扫边推给页面（流式填表）？

最强理由：最直观——节点一个个出现在表里，比一根进度条更「迅速」。不选的原因：表格只认通过 ZIP / CRC / SHA-256 / 运行身份 / manifest 校验的终态 artifact，这是整个设计的完整性锚点；边扫边推的节点记录没有经过脱敏与这套校验，一旦进表就是「未校验数据冒充结果」。进度条只给计数，正好停在这条线的这一侧。

### Why not 把 `scan_token` 存进 sessionStorage 来解决刷新丢进度？

最强理由：刷新后还能继续用同一个会话，连「停止」都保住。不选的原因与 [页面内触发](2026-09-22-frontend-next-in-page-scan-trigger.md) 当时的结论相同：它是本次扫描的操作凭证，放进 Web Storage 就成了脚本可读的长效凭证。这一轮换了一条不碰凭证的路：`/api/scans/latest` 的 `active` 只给只读身份与计数，刷新后照样能跟到底，只是不能停止——停止仍然只属于发起时内存里握着 token 的那一页。

### Why not 让产物在上传完成、run 还没结束时就交给页面？

最强理由：上传后到 run `completed` 还有约 4 秒的收尾步骤（清理密钥与工作区、post-job），提前取能再快几秒。不选的原因：现有契约只认 `conclusion: success` 的运行，收尾步骤失败会让 run 变成 failure；为 4 秒放宽运行身份判据不值。

## Consequences

- **收益**：扫描期间页面能说清「走到哪一段、扫了几个、各几个完整/部分/失败、用了多久」；刷新或换标签页不再丢进度，跑完自动换表。
- **收益**：节点并发 8 → 16，节点多于 8 个的订阅扫描段明显变短；轮询上限 10 → 4 秒，跑完后的等待最多 4 秒。
- **代价**：Worker 多了一个 Durable Object 与一个 server-to-server 端点；每次轮询多一次 DO 往返（与 job / 产物探测并行，不加延迟）。DO 请求按天计额度（免费计划为 10 万次量级），一次一分钟的扫描大约三四十次。
- **代价**：`/api/scan-progress` 与订阅中继共用 runner 凭证；那把凭证泄露的影响面从「借 Worker 出口拉订阅」扩大到「能写进度读数」——后者只能让面板上的数字变错，表格与导出不受影响。
- **约定**：`progress.js` 用步骤名 `Run production scan` 切分「准备 / 扫描 / 校验」；改 `scan.yml` 那一步的名字时要同步。

## Testing

- `npm run check`（语法 + 前端契约 + mhtml 往返）、`uv run ruff check .`、`git diff --check`、`wrangler deploy --dry-run`（列出 `env.SCAN_PROGRESS (ScanProgress) Durable Object`）全部通过。
- workerd（`wrangler dev`）实测进度端点：无 token 401、`completed > total` 400、合法 204；同 run 的完成数回退与阶段倒退被忽略；run/attempt 不符、未知 request_id、无绑定都读成 `null`。
- runner 回报器对本机 workerd 的真实 HTTP 往返：sent=6 failed=0，最终读数 `done 6/6`；错 token、端点不通都只计失败不抛。`run_scan.run()` 注入假 manager：首报不阻塞下载、跟报读到即时计数、扫描失败照常以 `scan_unavailable` 收口。
- 无头 Chromium + 模拟 Worker（生产同款 CSP）：桌面 1280、手机 390、深色三组；发起 → 排队 → 准备 → 扫描 2/25 … 25/25 → 完成并填表；刷新后跟进时旧表不清、跑完自动换表；控制台错误与 CSP 违规 0。
- 线上闭环的结果见 PR 评论（合并、发布之后用同一条订阅跑 `Verify scan flow`）。

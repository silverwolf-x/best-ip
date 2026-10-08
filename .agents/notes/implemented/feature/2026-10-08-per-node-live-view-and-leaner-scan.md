# Agent Note: 逐节点实时视图、并行重试与精简的 scan.yml

Status: implemented

## Problem

[实时进度与跟进](2026-10-08-live-scan-progress-and-follow.md) 上线后，用户的反馈是两句：「我希望具体看到每个节点扫描的过程，我不在乎其余启动等流程」，以及「action 流程能否最大化精简提高效率」。

那一轮的面板只有一根进度条和「12 / 22 个节点 · 10 完整」这样的计数，看不出是哪个节点在跑、卡在哪一步、为什么失败；而五段步骤条里有三段（提交、排队、准备环境）是用户既管不了也不关心的。

效率这边，那一轮线上实测（`Verify scan flow` run `37745264309`，扫描 run `37745287206`，22 个节点）的时间线是：

| 段落 | 用时 | 说明 |
| --- | --- | --- |
| 点击 → 派发返回 | 1.7s | GitHub dispatch API |
| 排队 + Set up job | 4s + 2s | 托管 runner，改不了 |
| 准备环境 | 7s | setup-uv 3s、Mihomo 缓存 1s、解密 1s、其余步骤各零点几秒 |
| 扫描 | 20s | 20/22 个节点在扫描开始后约 10 秒内完成；剩下 2 个永久失败节点各吃满 3 次尝试 |
| 上传 + 收尾 | 2~3s | |
| 运行结束 → 结果上屏 | ~6s | 轮询上限 4 秒 + 取产物 |

长尾是那 2 个失败节点：按 [墙钟预算笔记](../architecture/2026-09-21-scan-wall-clock-budget.md) 的「节点侧成本构成」，永久连不上的节点每次尝试吃满 Mihomo 的 5 秒拨号超时，三次串行加 0.5 + 1.0 秒退避约 18 秒。

## Decision

### 逐节点实时视图

- runner 的扫描任务为每个节点记一行实时状态（`ScanJobManager.live_nodes`）：`wait → start（启动代理）→ connect（连检测站）→ lookup（取到出口 IP、查 IP 质量）`，失败后进入 `retry` 再走一遍，终态 `success / partial / failed`；外加最高尝试次数、整节点用时（含重试）和一句原因。阶段由 `NodeRunner` 的 `on_stage` 回调与采集器的 `on_exit_ip` 回调推进，终态与计数在同一段同步代码里落定，所以「各终态的节点数」与计数永远一致。
- 回报器约每 0.75 秒看一次，有节点换了阶段才发（心跳 5 秒），报告多一个 `nodes` 数组（短键 `{n,t,s,a,ms,r}`）。Worker 整条校验：个数等于总数、三种终态个数分别等于三个计数、名字无控制字符且 ≤ 80 字、状态在八档之内、原因 ≤ 60 字，否则整条 400。
- 页面每秒读一次新的 `GET /api/scans/{id}/progress`：只读 Durable Object、不碰 GitHub API，门是站点会话（不要 scan token，刷新后跟进的页面也能用）。主轮询照旧负责运行状态与取结果。
- 面板：步骤条从五段并成三段（启动 → 扫描节点 → 校验结果），主体换成逐节点格子——点的颜色是阶段，名字、用时每秒往上走，第二行是阶段说明或终态原因。完成后格子只在「全部落定、三种终态个数与产物逐一相同」时保留。

**格子里有什么、没有什么。** 有：名字、协议类型、阶段、尝试次数、用时、原因。没有：出口 IP、评分、任何订阅内容——这些仍然只在终态 artifact 里，过脱敏与逐字节校验。名字是上一轮刻意不报的，这一轮报了，因为「看到每个节点」离不开它；两道防线是：节点名里只要含有订阅地址或凭证里的值（与产物同一套 `contains_forbidden_value` 判据、同一个禁用集合）就换成「节点 N」；原因只取 `errors.live_reason` 白名单里代码自己写的分类文案，`partial` 只说缺了哪几项（`completeness.unrecorded_requests` 的键映射成中文）。

### 并行重试

`NodeRunner.run` 拆成 `_attempt`（一次尝试，独立 Mihomo，结束或被取消时确认清理）与外层编排：第 1 次失败且值得重试时，等一次退避（0.5 秒），余下的尝试**同时**起，第一份非失败记录胜出、其余立刻取消，并等每个被取消尝试的 Mihomo 清理落定；任何一个清理未确认就以 `MihomoStopError` 收口，与节点 worker 同口径。判定口径不变：最多 `max_node_attempts` 次；`attempt_count` 只数「失败的」+「胜出的那一次」（被取消的不算），所以 `attempt_errors` 与 `retry_count` 的既有校验（`validate_node`）原样成立；全部失败时用编号最大的那次作终态。永久失败节点从约 18 秒降到约 11 秒（5 + 0.5 + 5 + 启动）。

### 精简 scan.yml

- 校验派发输入、校验中继配置、写 IPure 配置、写私钥、解密订阅合成一步 `Validate inputs and decrypt subscription URL`；私钥用 `trap` 在这一步结束时删掉，不再留到收尾步骤（收尾那条 `rm` 仍保留作兜底）。
- uv 管理的 Python 3.13（`UV_PYTHON_PREFERENCE=only-managed` 装进 `/home/runner/.best-ip/python`）、`.venv` 与 Mihomo 压缩包放进**同一个** `actions/cache`，键由 `uv.lock`、`pyproject.toml`、Mihomo 版本与 SHA-256 组成。命中时不装 uv、不跑 `uv sync`，直接 `.venv/bin/python`；没命中才走「setup-uv → `uv sync`」，并断言 `.venv/bin/python` 解析到缓存目录里（缓存自洽：镜像换了也不会指向一个不存在的解释器）。
- Mihomo 压缩包仍然每次按 SHA-256 校验后解压（`download_mihomo.py`），缓存的是压缩包而不是解压后的二进制。
- 页面在 runner 报出 `packaging/done` 之后把主轮询改成每秒一次：运行一结束就取结果，而不是最多再等 4 秒。

## Alternatives considered

### Why not 把每个节点的出口 IP 和评分也实时推给页面？

最强理由：用户要「具体看到过程」，出口 IP 与分数是最具体的东西，边扫边出现比一格「查询 IP 质量」更有信息量。不选的原因：那就是把未经脱敏与校验的结果数据放上屏幕，等于在完整性锚点（终态 artifact）旁边开了一条旁路；而结果在扫描结束后几秒就会以校验过的形式出现在表格里。格子只讲过程，结果交给表格。

### Why not 用 WebSocket / SSE 从 Durable Object 推送，而不是每秒轮询？

最强理由：真正的推送没有轮询间隔，阶段一变就到。不选的原因：runner 本身就是约 0.75 秒一报，推送最多再省半秒；而 WebSocket 要处理会话鉴权、CSP 的 `connect-src`、断线重连与 Durable Object 的连接生命周期，复杂度与故障面都大得多。只读 Durable Object 的轮询每次几十毫秒，一次扫描几十次请求。

### Why not 第一次尝试就三路并行（对冲），或者干脆减少尝试次数？

最强理由：三路齐发能把永久失败节点压到约 5 秒；减到 1~2 次尝试也能直接砍掉长尾。不选的原因：三路齐发让每个正常节点也多起两个 Mihomo、多打两遍检测站与 IPure（IPure 有预算头），而绝大多数节点第一次就成功；减少尝试次数会丢掉重试救回来的节点——[DNS 引导笔记](../bug-fix/2026-09-23-dns-bootstrap-ipv6-poisoning.md) 里重试按尝试编号轮换 DNS 引导出口，有节点就是第 2、3 次才成功的。「第一次失败后其余并行」只在失败节点上多花资源，救回能力不变。

### Why not 把整个准备环境做成一个预构建的容器镜像，或者用自托管 runner？

最强理由：自托管常驻 runner 能把排队、Set up job 与准备环境（合计约 10 秒）几乎全部省掉，是唯一能再砍一大截的办法。不选的原因：它需要一台常驻机器和它的运维与安全边界（runner 会接触订阅明文与私钥），超出了这一轮「精简现有流程」的范围；容器镜像在托管 runner 上要先拉镜像，通常比还原一个约 60MB 的缓存更慢。这条作为后续选项留给用户决定。

## Consequences

- **收益**：扫描期间能逐个节点看到它在做什么、用了多久、为什么失败；启动段只占一格。
- **收益（预期，以线上实测为准）**：准备环境约 7 秒 → 约 3 秒；永久失败节点约 18 秒 → 约 11 秒；运行结束到结果上屏约 6 秒 → 约 1~2 秒。
- **代价**：进度报告从约 150 字节变成每节点约 100~150 字节（1000 个节点约 140KB，上限 256KiB）；页面每秒多一次只读 Durable Object 的请求；失败节点在重试阶段同时占两个 Mihomo 进程。
- **代价**：节点名第一次出现在 runner → Worker → 页面的过程通道里（有禁用值替换兜底）；与终态 artifact 一样只对登录后的页面可见，Durable Object 6 小时后整条清掉。
- **约定**：`scan.yml` 改了 Python 版本、依赖或 Mihomo 版本时，缓存键会随之变化、自动走一次慢路；`Run production scan` 这个步骤名仍被 `frontend-next/app/progress.js` 用来切分阶段。

## Testing

- `uv run ruff check .`、`npm run check`、`git diff --check`、`wrangler deploy --dry-run` 通过。
- 并行重试（本机替身 Mihomo + 采集器）：首次成功只用 1 次；首次失败后第 3 次先成功、第 2 次被取消——`attempt_count=2`、1 条错误，被取消的 Mihomo 已停止；三次全失败约 1.35 秒（串行约 2 倍）；重试中途取消整个节点，所有 Mihomo 清理确认；每条记录过 `validate_node`。
- 实时表（同一套替身跑完整 `ScanJobManager`）：每一帧「终态个数 = 计数」；含 `SECRET123` 的节点名被换成「节点 2」；失败原因落在白名单「连接节点服务器超时」。
- Worker（`wrangler dev`）：合法报告 204；个数不符、终态个数不符、名字含控制字符、未知状态都是 400；同完成数的阶段更新被接受；`/progress` 缺 run 参数 400、attempt 不符 `null`；1000 节点 × 64 字名字（约 14 万字符）204 并能完整读回；未登录访问 `/api/scans/{id}/progress` 401。
- 页面（无头 Chromium + 模拟 Worker，生产同款 CSP）：桌面、手机两列、深色跟进三组截图；控制台错误与 CSP 违规 0；`Verify scan flow` 脚本对模拟环境跑通，「最后一份逐节点读数与产物逐一一致」通过，结果在模拟运行结束后约 0.2 秒上屏。
- 缓存慢路（本机）：`UV_PYTHON_PREFERENCE=only-managed` + 指定安装目录的 `uv sync --frozen --no-dev` 约 2.7 秒，`.venv/bin/python` 解析到该目录内。
- 线上闭环（合并、发布之后用同一条订阅跑 `Verify scan flow`，慢路一次、命中一次）的结果见 PR 评论。

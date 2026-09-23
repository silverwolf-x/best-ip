# Agent Note: 在线上页面里发起扫描（A2），把触发链路移植进 frontend-next

Status: implemented

## Problem

[新前端的在线只读通路](../architecture/2026-09-22-frontend-next-online-readonly-gateway.md) 把线上页面做成纯只读查看器：它只回答「最近一次**有结果**的扫描长什么样」，发起扫描留在页面之外（Actions 的 `workflow_dispatch` 或脚本）。这个取舍建立在一条当时的硬约束上——页面输入控件白名单只有搜索、状态筛选、排序、两个导出与行内复制。

用户看过线上页面后的反应是「那我 worker 在哪里输入订阅地址???????你的逻辑不完善！」。他说得对：只读通路把**查看**搬到了线上，却把**触发**留在本机脚本里，等于线上那一半功能对用户不可用——他没跑过脚本，页面上就永远没有他关心的数据。这条指令直接取代了那条控件白名单约束，也取代了本仓库 `.pi/goal/新前端设计-…-20260922-1156.md` 验收标准第 3 条里「页面上的输入控件只剩……」那句话。

同时旧前端 `frontend/` 里已经有一条在生产跑通的完整触发链路（订阅信封加密 → `POST /api/scans` → 轮询进度 → 取产物 → 停止），关键问题是：它能不能在**不放宽任何服务端约束、不动 `worker/` 一个字节**的前提下搬进新前端。答案取决于 `worker/scans.js` 的契约本身——它认的是「站点会话 + 同源 + 合法信封 + 本次的 `scan_token`」，与页面长什么样无关。

## Decision

`frontend-next/` 自己实现 A2：页面顶部多一条扫描栏（默认隐藏，只有网关模式才露出），粘订阅地址 → 点「开始扫描」→ 页面加密信封、投递、轮询进度、取回产物、渲染进同一张表。

页面控件集合因此从 5 个变成 **8 个**：`subscriptionUrl`、`startScan`、`stopScan`、`query`、`statusFilter`、`sortSelect`、`exportMhtml`、`exportHtml`（DOM 顺序如此）。**表头内仍然零控件**——列名是数据标签，不是操作区，这条没有跟着放开。

### 服务端：一个字节都没改

链路完全走既有端点，`worker/` 与生产 CSP 都不需要动（触发链路全同源，`connect-src 'self'` 已经够）：

- `GET /site-config.js`（既有）给出 `{mode:"gateway", publicKeyPath:"./scan-public.pem", keyId:"<64 位小写十六进制>"}`；
- `POST /api/scans`：本站会话 + `assertSameOrigin` 之后，信封要过 `validateEnvelope`（`v` / `alg` / `kid` / `request_id` / `issued_at` / `expires_at` / `ek` / `iv` / `aad` / `ct` 的取值与长度，且 `expires_at - issued_at` 必须恰好 900），回 202 `{request_id, run_id: null, dispatched_at, scan_token}`；
- `GET /api/scans/<request_id>` 轮询进度，`?run_id=&run_attempt=` 一旦拿到就锁死；
- `GET /api/scans/<request_id>/artifact` 每轮重新换一张签名地址（地址有有效期）；
- `DELETE /api/scans/<request_id>` 请求停止，202。

**加密在浏览器里做，私钥只在 GitHub Actions**：订阅地址是半机密，页面用 Actions 公钥（`frontend-next/scan-public.pem`，与线上 `SCAN_KEY_ID` 对应的 DER SHA-256 逐字符相同）做 RSA-OAEP-3072 包 AES-256-GCM 密钥，AAD 绑定 `${request_id}:${keyId}:${expires_at}`。Worker 只转手密文，它自己也解不开。

### 产物地址端点的路径拼装（搬错了会静默打错端点）

`frontend-next/app/scan.js` 里 `/artifact` 必须拼在查询串**之前**：

```
/api/scans/<request_id>/artifact?run_id=<n>&run_attempt=<m>
```

移植时写成了 `` `${scanPath(session)}/artifact` ``（`scanPath` 返回的是带查询串的状态地址），请求实际打到状态端点上、拿回一个没有 `artifact_url` 的响应，页面只会说一句「网关返回的产物地址无效」。旧实现 `frontend/src/transport/gateway.js` 是对的，是移植出的错。判据不是页面自述——harness 的请求日志里**根本没有 `artifact-address` 记录**，只有一条形状奇怪的轮询（`?run_id=…/artifact`），一眼看出请求没走对端点。

### 取字节与校验只有一份实现

`frontend-next/app/gateway.js` 导出 `readArtifactFrom(rounds, {fetchImpl})`：「最近一次扫描」与「本次刚发起的扫描」共用取字节 / 校验 / 报错口径，差别只在 `rounds()` 怎么问出地址。两条路都必须**同一轮响应里同时拿地址与身份**——拿上一轮的身份校验这一轮取回的字节，会把「地址换了一批内容」判成「产物被改动过」。只有 `artifact_truncated`（字节没读完）重试 ≤3 次且每轮换新地址；`artifact_invalid` 与取不到都不重试：前者字节已完整到手、内容不对是确定结论，后者重试也不会变好。

### `scan_token` 只存内存

`SCAN_TOKEN_TTL_SECONDS=7200`，且只对本次 `request_id` 生效。页面把它放在内存里，**不写 sessionStorage / localStorage**：放进去等于引入一个可被读走的长效凭证，而刷新页面的代价很小——`GET /api/scans/latest` 会如实说「最近那次还在进行」，用户重新粘一次地址就能再来一遍。这条限制写在 `scan.js` 的文件头与这里，别在后续顺手「优化」成持久化。

### 轮询节奏与超时口径照抄既有实现

首发 2000 ms、每次 ×1.5、上限 10000 ms；超出上限的判定是「取消后 2 分钟 / 排队 13 分钟 / 运行 31 分钟」。超时不等于停止：页面说的是「任务可能仍在后台运行」，不是「已停止」。用户主动点「停止」时收口文案是「已按你的请求停止这次扫描，没有可显示的结果」——请求已发出，但这一轮确实没有结果可显示。

### 复制而非共享（无打包器的静态站只有这一个选择）

`frontend-next/app/scan-crypto.js` 是 `frontend/src/crypto.js` 的逐字副本 + 头注释，`frontend-next/scan-public.pem` 是 `frontend/scan-public.pem` 的副本，与 `app/artifact/{reader,validation}.js` 同一约定：生产只能有一个 `assets.directory`，跨目录相对 import 在线上是 404，所以「共享一份」落不了地。改动必须两边同步，文件头写明。

## Alternatives considered

### Why not 保持只读，让用户继续用脚本 / Actions 发起扫描？

最强理由：与用户先前亲口定死的控件白名单完全一致，页面最小、攻击面最小，且只读通路的每一处取舍都不必重审。不选的原因：用户看到线上页面后明确要求「在页面里输入订阅地址」——只读那一半功能对真实用户不可用，他要的数据永远不会自己出现在页面上。**用户的直接指令高于先前自定的约束**，而且这条约束本来就是我们替他划的，不是他反复要求的。

### Why not 让 Worker 收订阅地址（明文或自加密）再转发？

最强理由：页面只要一个输入框 + 一次 POST，不用移植加密代码，也不用在浏览器里保管公钥指纹；Worker 已经在 GitHub 里，转手最省事。不选的原因：订阅地址是半机密，让 Worker 拿到明文等于把它写进 Worker 的内存与日志路径；既有设计刻意把解密能力锁在 Actions（私钥是 GitHub secret `SCAN_PRIVATE_KEY_PEM`），浏览器与 Worker 都解不开。复用既有信封链路一分钱不花，还能让服务端校验器原封不动地继续当门。

### Why not 直接把旧前端 `frontend/` 的页面内触发整页当入口（保留旧 UI）？

最强理由：零移植成本，那条链路已经在生产真跑过（订阅加密、POST、轮询、产物都对），把 `assets.directory` 切回 `./frontend` 就完事。不选的原因：旧 UI 正是这一轮被判定为垃圾的东西（12 列宽表、10 个表头筛选器、详情弹窗、说明文案、页脚、主题切换）；为了拿回触发能力把整个 UI 退回去，等于用上一步的成果换一个输入框。另外生产只能有一个 `assets.directory`，两套页面没法同时挂在根上。

### Why not 把 `scan_token` 存进 sessionStorage，刷新后继续看进度？

最强理由：用户的直觉是「我发起的扫描应该一直能看」——刷新即丢进度、只剩一句「最近那次还在进行」，体验上确实差一截。不选的原因：`scan_token` 是本次扫描的操作凭证（能读状态、能停止），放进 Web Storage 就变成脚本可读的长效凭证，而这道门的强度只有一把站点密码。**刷新代价小、凭证泄露代价大**，所以选择不持久化，并把「刷新即丢」明写成限制而不是 bug。

### Why not 这轮顺带把两个前端合成一份（共用一个 `crypto.js`）？

最强理由：两份实现迟早漂移，安全边界（信封构造、指纹核对）漂移的后果比 UI 漂移严重。不选的原因：无打包器的静态站里做不到——跨目录相对 import 在生产 404（既有结论，见在线只读通路的 Alternatives）。要么引入打包器（本轮明确不引依赖），要么逐字复制 + 头注释 + 两边同步，二者取后者。

## Consequences

- **收益**：线上页面成为完整闭环——粘订阅地址、发起扫描、看进度、取结果、导出快照，全在同一页；用户不需要认识脚本或 Actions。
- **收益**：服务端与部署面零改动。`worker/` 一个字节没动，CSP 一个字没放宽（触发链路全同源），`verify_deploy` 的比对清单只是多出 `scan-public.pem`、`scan-crypto.js`、`scan.js` 三个文件。
- **收益**：取字节与校验从两份收敛成一份，`fetchLatestScan` 改成复用 `readArtifactFrom` 之后，「最近一次」与「本次」不会再各自演化出不同的重试与报错口径（回归验证见 Testing）。
- **代价**：页面控件从 5 个变成 8 个，只读查看器变成带操作的表单；`subscriptionUrl` 用 `type="password"` 减少肩窥，但它在 DOM 里仍是明文值——**这是操作入口的固有代价，不是疏漏**。
- **代价**：`frontend/src/crypto.js` 与 `frontend-next/app/scan-crypto.js` 现在必须同步；旧前端一旦下线（`frontend/` 仍保留作回退），这份副本才重新变成唯一实现。两边同步是人工纪律，没有脚本守着。
- **代价**：页面内的「本次扫描」进度在刷新后不可恢复（`scan_token` 只存内存，见上）；用户看到的是「最近一次有结果的扫描」+ 一句「还在进行」。
- **已知缺口**：`scan.yml` 的产物 `retention-days: 1` 未动，所以「最近一次有结果」经常已经过期，页面常常是空的——除非用户当场扫一次（这恰好是 A2 让它变可行的路径），或保留期被单独决定改掉。
- **已知缺口（2026-09-22 已补证，不再是缺口）**：线上解密能力无法在本机直接证伪——私钥在 GitHub secret `SCAN_PRIVATE_KEY_PEM` 里。合成密钥的真加真解（见 Testing）之外，这一轮在生产里真跑了一次：Actions 侧 `subscription_source: relay` 说明它**把页面加密的信封解开了**并拿到了订阅地址，随后走 relay 拉订阅、扫节点、出产物。这条缺口结案，证据见「发布实录」。

## Testing

- **信封与加密：`scan-crypto-test.mjs` 14/14（合成 RSA-3072 密钥对，真加真解）**：私钥真解密回原订阅地址；`aad` 必须等于 `${request_id}:${keyId}:${expires_at}`（改 AAD 后解密失败，证明身份真被绑进密文）；`kid` 与公钥指纹不符、地址带账号密码都在投递前当场失败；同一份信封交给**生产** `worker/scans.js` 的 `validateEnvelope` 通过，改掉 `kid` 的对照被拒。
- **线上契约的浏览器闭环：`scan-check.mjs` 41/41（真实 Chromium + 生产同款 CSP + 生产 `validateEnvelope` + 真实产物字节）**：本地 harness 在与生产同款 CSP 下提供站点与 `/api/*`，`POST /api/scans` 的信封用 `validateEnvelope` 验收并按 `assertSameOrigin` 核 `Origin` / `Sec-Fetch-Site`；产物用 `gh api` 下载的那份真实 `artifact.zip` 逐字节提供（主机名保持 `productionresultssa9.blob.core.windows.net`，由 `--host-resolver-rules` 指到本机）。断言覆盖：入口可见、`type=password` 且 `required`、控件集合恰为约定的 8 个、表头零控件、地址格式错时如实报错且一个请求都不发、进入扫描态、进度文案（「等待创建扫描任务」/「扫描执行中 · 已用时 8秒 · 当前步骤：IPure 场景评分」）、25 行结果落表、badge 切成「真实扫描」、统计行、首行九项、导出恢复可用、停止后收口「已按你的请求停止」、两次扫描 request_id 互相独立、轮询与 `DELETE` 都带 `X-Best-IP-Scan-Token` 且同源、拿到 run 身份之后不再退回无 `run_id` 的轮询、产物字节由浏览器直连 blob 且**不带 cookie**、零异常 / 零控制台错误 / 零 CSP 拦截 / 零失败请求。
- **产物重建必须骗不过校验器（`scan-artifact-check.mjs`，3/3）**：harness 想让它手上的真实产物冒充「这一次的产物」，就得把 `status.request_id`、`result.id`、`result.manifest.job_id` 以及**每条 `record.job_id`** 一起改成新 request_id，并按新字节重算 `status.result_sha256`——少改任何一处，`frontend-next/app/artifact/reader.js` 都会拒（「身份、安全标记或摘要校验失败」/「结果完整性校验失败」/「节点身份或状态校验失败」）。反向对照：换一个 `request_id` 或 `run_attempt` 都被拒。这三条同时证明校验器真的在核身份，不是走过场。
- **回归零回退**：`gw-run.mjs` 51/51（`gateway.js` 抽出 `readArtifactFrom` 之后，「最近一次扫描」的七种无数据成因、截断重取自愈且**恰好 2 次 blob 请求、出口 IP 集合掩码比对全部照旧）；`worker-latest-test.mjs` 21/21；`verify-loop.mjs` 38/42——失败 4 条全部落在数据侧：那一轮本机真扫的 25 个节点**全部失败**（`statuses:{"failed":25}`，「节点服务器域名无法解析」），没有出口 IP、没有评分，于是「首行九项齐全 / IPure 降序 / 快照含真实出口 IP / .html 兜底含真实出口 IP」这四条无从成立；同批次里「输入控件恰为约定的 8 个」已按新契约更新并通过。**这 4 条是订阅数据侧抖动，不是本改动的回归**：同一订阅当天晚些时候再扫就给出 25 完整 / 15 失败的正常结果（见「发布实录」），失败时那批节点域名在三个公共解析器（223.5.5.5 / 1.12.12.12 / 1.1.1.1 的 DoH）里都没有 A 记录，即 NXDOMAIN，本地挂不挂 fake-ip 都一样。

> **2026-09-23 更正（这条归因被推翻）**：「本机真扫 25 个节点全部失败」被这里记成了「订阅数据侧抖动，不是本改动的回归」，但根因是 [DNS 引导候选池混入 IPv6 字面量节点](../bug-fix/2026-09-23-dns-bootstrap-ipv6-poisoning.md)——被记成「域名无法解析」的域名里有 A 记录正常的，而失败集合能由引导候选轮转规则逐条预测。**「节点服务器域名无法解析」不再等于订阅数据有问题**，见到它先读那篇笔记；上面「发布实录」里连续三次 `scan_unavailable` 的因果同样不再唯一（`neokocloud.host` 确实 NXDOMAIN 是事实，但当时没有排除同一个缺陷）。
- **门禁**：`npm run check`、`npm run verify-notes`、`npx --no-install wrangler deploy --dry-run` 全绿（结果见本轮发布实录）。

### 发布实录（2026-09-22 → 2026-09-23）

**发布**：`aef4280` push 到 main → CI `35799362636` 绿（29s）→ Deploy `35799399426` 绿（28s，worker.yml 的 `workflow_run` 自动通路）→ 版本 `61198421-df93-4a19-a084-3f1be1d607cb`。`wrangler` 报「读 22 个文件、6 个新增或修改」（`/app/scan.js`、`/app/scan-crypto.js`、`/app/gateway.js`、`/app/main.js`、`/index.html`、`/styles.css`），`Verify deployed release` 7/7 项通过，其中「线上内容与 HEAD 逐字节一致」为 **18/18 个文件**（比对根从 `wrangler.jsonc` 的 `assets.directory` 读出，多出来的正是 `scan-public.pem` / `scan-crypto.js` / `scan.js`）。发布后带会话复核线上资产：`/app/scan.js` 14064 B、`/app/scan-crypto.js` 4457 B、`/scan-public.pem` 625 B 全部 200，`/site-config.js` 的 `keyId` 与仓库里 `scan-public.pem` 的 DER SHA-256 逐字符相同（`8cd5e64e…`）。

**生产端整条闭环（真订阅、真 Actions、真产物）**：用站点会话从生产 `POST /api/scans` 投一封页面同款信封（`alg: RSA-OAEP-3072-SHA256+AES-256-GCM`，这点被服务端校验器当场纠过一次——算法标识写错就是 400「订阅密文算法无效」），回 202 带 `scan_token`；轮询走 `queued → in_progress → completed/success` 57 秒，`artifact_ready` 由 false 转 true，`/artifact` 给出 `productionresultssa11.blob.core.windows.net` 的签名地址，取回 **110925 B** 产物（run `35800244675`）。产物交给**页面自己的** `frontend-next/app/artifact/reader.js` 逐字节校验：通过，40 条记录（25 完整 / 0 部分 / 15 失败），首个可用节点出口 IP 104.238.221.29、Coffee 67、IPure 39。

**页面自己的闭环（PI-Desktop 内置浏览器，线上站点）**：登录 → 页面自动读到这次扫描并渲染 **40 行**、badge「真实扫描」、失败行给出各自原因（「ConnectError；节点服务器域名无法解析」/「Mihomo selector 切换失败（HTTP 404）」）；随后在页面里粘订阅地址点「开始扫描」，进度行如实报出 Actions 的步骤名（「扫描执行中 · 已用时 18秒 · 当前步骤：Run production scan」），**51 秒**收口「扫描已完成 · 已用时 51秒」，表格快照时间戳由 08:03 换成 08:07——页面内的触发、轮询、取字节、校验、重绘全部在生产里走过一遍。

**同一轮里的三次失败（先于上面那次成功）**：连续三次 `conclusion: failure`、`scan_unavailable`，日志停在 `subscription_source: relay` 之后。根因在订阅数据侧而非本改动：那批节点域名（如 `aws-hk.neokocloud.host`）在三个公共解析器上都是 NXDOMAIN，而同一个订阅地址晚些时候再取就变成 43 个节点、节点域名有 A 记录，于是同一条链路当场跑绿。触发链路本身在那三次里已经全部成立（202 → `pending` → `in_progress` → `completed`，`subscription_source: relay` 证明 Actions 解开了浏览器侧的信封）。**结论：`scan_unavailable` 这类失败要先看订阅内容与节点域名，别先怀疑信封或页面。**

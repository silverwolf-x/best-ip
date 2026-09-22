# Agent Note: 新前端的在线只读通路，以及线上入口切到 frontend-next

Status: implemented

## Problem

新前端 `frontend-next/` 交付时有两条数据通路：内嵌示例数据，和 `?job=<任务 ID>` 读本机 loopback 后端的一次导出（见 [新前端接上本机真实链路](../feature/2026-09-22-frontend-next-real-data-path.md)）。两条都不适用于线上：

- 示例数据是合成值，放在生产页面上等于用一屏假 IP 冒充扫描结果；
- `?job=` 指向 `http://127.0.0.1:8000`，生产页面的同源策略与 CSP 都过不去，而且**线上根本没有那个后端**；
- 真实产物躺在 GitHub Actions 上，只有 Worker 手里的 GitHub App token 能换出签名下载地址。

同时，交付这一版时页面的输入控件被一条硬约束框住：**只允许**搜索框、状态筛选、排序切换、两个导出按钮、行内复制；表头 `thead` 内不得有任何控件；选任务只走 URL 参数。也就是说「在页面里放一个开始扫描的按钮」这条路当时是关着的——扫描只能由页面之外发起（Actions 的 `workflow_dispatch` / 脚本），页面必须是一个**只读**的查看器。**这条约束 2026-09-22 被用户的直接指令取代**（他要求在页面里输入订阅地址并发起扫描），A2 已落地：见 [在线上页面里发起扫描（A2）](../feature/2026-09-22-frontend-next-in-page-scan-trigger.md)。下面凡是建立在「页面不发起扫描」之上的取舍，读完那篇再看。

还有两个既有事实决定了这条通路长什么样：产物字节由浏览器直连签名 blob（Worker 出口到 `*.blob.core.windows.net` 实测 40%~60% 挂死，见 [artifact 字节交给浏览器直连](2026-09-21-artifact-bytes-delegated-to-browser.md)）；`scan.yml` 的产物 `retention-days: 1`，所以「最近一次扫描」经常已经过期。

## Decision

线上页面（`wrangler.jsonc` 的 `assets.directory` 已指向 `./frontend-next`）打开后走一条只读通路：问本站 Worker「最近一次有结果的扫描是哪一次」，拿它给的签名地址直连取字节，本地校验后渲染。**扫描的发起不在这一条通路上**——2026-09-22 起由页面内的扫描栏负责（见 [在线上页面里发起扫描（A2）](../feature/2026-09-22-frontend-next-in-page-scan-trigger.md)）：两者共用同一套取字节与校验口径，但端点各走各的，这条只读通路不认 `scan_token`。

### `GET /api/scans/latest`（`worker/latest.js`）

- 与其它 `/api/*` 一样排在站点密码门之后、`assertSameOrigin` 之后（后者只对 POST/DELETE 生效，GET 不受影响）。**这条路径不碰、也不放宽 `scan_token` 模型**：`scan_token` 仍然只属于发起那次扫描的人；这里的门就是站点访问密码，登录后能看到的节点结果与它返回的是同一份数据。
- 列 run：`GET /repos/{owner}/{repo}/actions/workflows/scan.yml/runs?event=workflow_dispatch&branch=main&per_page=20`。
- 每个候选 run 都要再核一遍身份（`path` / `event` / `head_branch`）并解析标题里的 `request_id`，判据对齐 `worker/scans.js` 的 `exactRun`。查询参数已经过滤过一次，这里再核是因为「挑中另一次运行」在只读路径上是最坏的错法：不报错，只安静地展示别处的数据。
- 从最新往回最多探 `ARTIFACT_PROBES = 5` 次（只探 `completed` 的运行），命中产物即返回，**并给出该产物的签名地址**（`githubArtifactUrl`）。回退是因为产物只留 1 天：最新那次常常已过期，往前多找几次比让页面空着有用。
- **单次探测失败不塌整条通路**：限流 / 5xx / 产物名撞车都只记下来继续往前找；只有当「每一次探测都失败了」才把第一个错误抛出去（502）。否则一次 GitHub 抖动会被说成「你的结果已经不在 GitHub 上了」。
- 回给浏览器的只有身份字段：`request_id`、`status`、`run`（只挑 `id` / `run_attempt` / `status` / `conclusion` / `created_at` / `updated_at`）、`artifact_ready` / `artifact_id` / `artifact_name` / `artifact_url` / `scanned_at`。**不回整个 GitHub run 对象**——那会带出触发者与日志地址，而这条路径的门只是一把站点密码。
- `status` 取值：`completed`、`artifact_expired`、`none`、`running`、`queued`、`failed`、`cancelled`。`artifact_expired` 只用于「最新那次是成功完成、却挑不到产物」；从没扫过报 `none`，正在跑/排队/失败/取消照实报。全部响应 `Cache-Control: no-store`。

### 浏览器侧（`frontend-next/app/gateway.js`）

`index.html` 在 `<head>` 里加载 `./site-config.js`（生产由 Worker 现算，`mode: "gateway"`），`app/api.js` 的 `isGatewayMode()` 只看 `mode === "gateway"`。在线模式下：

1. `fetchLatestState`：同源 `GET /api/scans/latest`，`credentials: "same-origin"`，`Accept: application/json`，30 秒超时；
2. `artifactUrlOf`：产物地址必须是 `https:` 且 hostname 以 `.blob.core.windows.net` 结尾（与 `worker/github.js` 同判据，作为第二道防线）；`artifact_ready` 为真却没有地址，按网关自相矛盾处理；
3. `downloadArtifact`：直连签名地址，`credentials: "omit"` 且不带任何自定义头（Azure 回 `Access-Control-Allow-Origin: *`；带上 cookie 或自定义头会变成预检反而取不到），30 秒超时，≤ 50 MB；
4. `readArtifact(bytes, {requestId, runId, runAttempt})`：身份三件套、`result_sha256`、CRC、manifest 逐个字节校验，通过后把 `result.json` **原样**交出——它的形状与 `?job=` 的导出完全一样，因此 `records.js` / `render.js` 一行都没改。

**传输截断是唯一会重试的失败**：字节没读完时最多重取 3 次，每轮重新问一次 `/api/scans/latest` 拿新的签名地址（复用旧地址第二发必然还是坏字节）。取不到（跨源被拦 / 404 / 超时）与校验失败都不重试——前者重试也不会好，后者字节已经完整到手、内容不对是确定结论。旧前端对这种情况本来就有 3 次有界重取，这里补齐是回归修复而非新能力。

错误文案分两层：**标题说「是哪种情况」，正文说「接下来会怎样」**（`STATUS_REPORT`）。没有产物时只信上游 `status` 那一句，`run` / `artifact` 字段一律不读，免得用半个身份拼出一行数据。页面在等数据时先渲染一帧空表（绝不让合成数据先亮一屏再被顶掉）。在线模式遇到 `?job=` **当场报错**（`在线部署只显示最近一次扫描：?job= 只在本机静态服务下有效`），而不是默默忽略。

### 线上入口与自证

- `wrangler.jsonc`：`assets.directory` 从 `./frontend` 改为 `./frontend-next`。旧 `frontend/` 一个文件都没删，只是不再被提供；**回退就是把这一行改回去**。
- `scripts/verify_deploy.mjs` 的比对根不再写死：从 `wrangler.jsonc` 的 `assets.directory` 读（`--assets` 可覆盖），未登录可达性探测也不再打写死的 `/src/results.js` 而是取当前目录里真实存在的第一个文件。写死目录会让换了根之后的门禁变成「每个文件都 404」——404 与内容不一致在结论里长得一样，只是更难查。详见 [发布后自证](../process/2026-09-21-post-deploy-self-verification.md)。
- `/site-config.js` 不再在缺 `SCAN_KEY_ID` 时 503：这个文件是「这次部署怎么跑」的标记，不是「扫描能力齐不齐」的检查。它 503 的后果是页面读不到配置 → 退回示例数据 → 线上安静地显示一屏合成 IP，一个配置疏漏装成了设计示例。能力检查留给 `/api/*` 的 `assertWorkerConfigured`（那里缺配置就该明确 503）。`publicKeyPath` / `keyId` 字段保留（`keyId` 不合法时为 `null`），因为发起扫描的那条链路（旧前端，以及 2026-09-22 起新前端的扫描栏）都要读它，回退路径也靠它。

## Alternatives considered

### Why not 在页面里放「开始扫描」按钮（A2 路线）？

最强理由：功能上最完整——用户不用离开页面就能发起一次扫描，触发与查看在同一处，也省掉「谁去点 Actions」这一步。当时不选的原因：那一版页面的输入控件白名单是用户亲口定死的硬约束（搜索、状态、排序、两个导出、行内复制），而「开始扫描」不在其中，还得配上订阅输入框、进度区与 `scan_token` 的存取——那等于把旧前端被判定为垃圾的东西请回来。**当时判断「违反硬约束比少一个入口更糟」。** 2026-09-22 用户明确要求页面内能输入订阅地址，这条白名单当场作废，A2 落地：见 [在线上页面里发起扫描（A2）](../feature/2026-09-22-frontend-next-in-page-scan-trigger.md)。留这段的理由是记住当时的取舍，而不是继续拿它当约束。

### Why not 复用旧前端的 `frontend/src/transport/gateway.js`？

最强理由：那条通路已经在线上跑过，订阅信封加密、`POST /api/scans`、轮询、取产物全都写好了，共享一份就没有两套实现漂移的问题。不选的原因有两条：一是它整条链都围着「发起这次扫描的人」转（订阅 URL、`keyId`、`scan_token`、进度面板），而当时新页面不发起扫描（这一条 2026-09-22 之后不再成立：新页面自己发起了扫描，但选择的是「把用得到的模块逐字复制进 `frontend-next/`」而不是跨目录共享，见 [在线上页面里发起扫描（A2）](../feature/2026-09-22-frontend-next-in-page-scan-trigger.md)）；二是生产只能有一个 `assets.directory`，跨目录的相对 import 在线上是 404，所以「共享」在无打包器的静态站里根本落不了地——这一条今天仍然成立，也是 A2 沿用「复制 + 头注释注明同步」的依据。

### Why not 让 Worker 代理产物字节（页面只连本站）？

最强理由：页面只需要连自己的源，CSP 连 `connect-src https://*.blob.core.windows.net` 都不用放开，也不必在浏览器侧再写一遍主机白名单。不选的原因：既有笔记已实测 Cloudflare 出口到 blob 主机的请求 40%~60% 挂死到超时或被边缘改写成 522（[artifact 字节交给浏览器直连](2026-09-21-artifact-bytes-delegated-to-browser.md)）——把这一跳搬回 Worker 等于把已知故障重新引入，还要让 Worker 承担 50 MB 的转发。

### Why not 端点只认「最新那一次」，不回退？

最强理由：语义最简单——「最近一次」就是最近一次，页面与端点不用解释回退，badge 也不用改成「最近一次有结果的」。不选的原因：`scan.yml` 的产物只保留 1 天，只认最新那一次的结果是「绝大多数时候页面空着，还要用户自己意识到是保留期问题」。往前探最多 5 次换来「通常有东西可看」，代价是 badge 文案必须收紧成「最近一次**有结果**的扫描」——这个代价是明写的，不是含糊过去的。

### Why not 端点照抄 `GET /api/scans/:id` 把整个 run 对象回给浏览器？

最强理由：字段现成、形状现成，前端不用挑字段，将来要显示触发者/耗时也不用改端点。不选的原因：`GET /api/scans/:id` 的形状是为「发起扫描的人拿着 scan_token 轮询自己的任务」设计的，里面有触发者与日志地址；这条只读路径的门只是一把站点密码，**能把暴露面收窄就该收窄**，页面也确实只需要身份三件套。

### Why not 不回退、但把「最新那次还在跑」也告诉页面？

最强理由：用户常常是「发一次扫描 → 打开页面」，这时页面显示的是上一次结果，能提示「新一次正在跑」会很有用。不选的原因：这需要在 payload 里加一个「最新运行的状态」字段，再在页面上找一处显示它，而当时页面的输入控件与状态区同样受硬约束约束。当前取舍是：badge 明确写「最近一次**有结果**的扫描」，`running` / `queued` 只在最新 5 次 completed 都没有产物时才成为答案。这是**已知的信息缺口**，不是遗漏。（那条硬约束 2026-09-22 已被用户放开，页面有了一条只属于**本次**扫描的进度行，见 [在线上页面里发起扫描（A2）](../feature/2026-09-22-frontend-next-in-page-scan-trigger.md)；但「最近一次扫描还在跑」仍未提示，缺口没被 A2 顺手补上。）

### Why not 本轮先不切 `assets.directory`？

最强理由：零生产风险，旧前端的页面内触发按钮保留，新前端继续只在本机静态服务下看。不选的原因：用户这一轮的指令是「推送到 worker、worker 形成闭环」——不切的话线上仍是旧前端，这条只读通路永远不会在生产里被真跑一次，验收只能是纸面的。切了之后 `verify_deploy` 会在发布流水线里逐字节证明线上就是新前端（见 Consequences 里的运行证据）。

### Why not 让两个前端各留一份产物解析器，不写「必须同步」的约束？

最强理由：两份就等于可以各自演进，不必迁就对方。不选的原因：解析器是**安全边界**（身份、SHA-256、CRC、manifest 逐字节校验），两份漂移意味着两条通路的可信度不一致；所以 `frontend-next/app/artifact/{reader,validation}.js` 是 `frontend/src/artifact/` 的逐字副本，文件头写明「只能复制、改动须两边同步」，并注明旧前线下线后这里才重新成为唯一实现。

## Consequences

- **收益**：线上页面一打开就是最近一次**有结果**的扫描，九项内容一屏可见；这条只读通路本身不需要任何控件（2026-09-22 起页面另有扫描栏，但那是另一条链路，两条端点互不干涉，见 [在线上页面里发起扫描（A2）](../feature/2026-09-22-frontend-next-in-page-scan-trigger.md)）。
- **收益**：发布自证门禁跟着 `assets.directory` 走，入口切换与回退都不需要再改校验脚本（回退只改 `wrangler.jsonc` 一行）。
- **收益**：条条「没有数据」都有各自的话（没扫过 / 产物过期 / 还在跑 / 排队 / 失败 / 取消 / 取不到 / 产物坏了），标题与正文分工明确，不再有「加载失败：本站还没有跑过扫描」这种自相矛盾的句子。
- **代价**：旧 `frontend/` 不再被提供，**当时页面里的「发起扫描」入口随之消失**（2026-09-22 起由新前端的扫描栏补回，见 [在线上页面里发起扫描（A2）](../feature/2026-09-22-frontend-next-in-page-scan-trigger.md)），在那之前扫描只能由 Actions `workflow_dispatch` / 脚本发起。仓库文件未删，回退一行即恢复。
- **代价**：产物保留期仍是 1 天（`scan.yml` 的既有策略，本轮未动），过期后页面只能如实报「产物已过期」；要长期有数据得改保留期，那是另一个决定。
- **代价**：首次成功最多 1 次 run 列表 + ≤5 次产物列表 + 1 次签名地址解析，所以浏览器侧超时给到 30 秒（20 秒可能小于 Worker 最坏耗时）；超时的表现是一句明确的「网关 30 秒内没有响应」，不是永久转圈。
- **代价**：产物地址白名单只认 `https:` + `*.blob.core.windows.net`，同族主机（如 `evil.blob.core.windows.net`）能通过——地址只来自 Worker 且 Worker 侧同一判据，属既定信任边界，不是新增风险。
- **已知缺口**：「你刚发起的新扫描还在跑」不会被页面提示（见 Alternatives 里那一条），只有在最新 5 次 completed 都没有产物时 `running` / `queued` 才成为答案。
- **独立审查改掉的四处**（都发生在「已经跑通 46 条断言」之后，记在这里免得重犯）：① 只重试了「取不到」，**没重试传输截断**——一次半截传输会被渲染成「产物校验失败」，而且没有重试入口，比旧前端还差；现在对截断有 3 次有界重取、每轮换新签名地址。② `findArtifact` 一抛错就整条 502，更旧那次完好的产物也一起丢；现在单次探测失败继续往前找，**只有每次探测都失败**才抛错。③ `/site-config.js` 缺 `SCAN_KEY_ID` 时 503，后果是页面静默退回示例数据（配置疏漏装成设计示例）；现在这个文件只回答「怎么跑」，能力检查留给 `/api/*`。④ 空状态标题把 `none` / `artifact_expired` / `running` 全说成「没有读到真实扫描结果」，与正文自相矛盾；现在标题与正文一起按成因分条给出。

## Testing

- **真实 Chromium + 真实生产产物字节的在线闭环（51/51）**：本地起一个与生产同款 CSP 的站点 + 一个冒充 `*.blob.core.windows.net` 的 blob 服务（`--host-resolver-rules` 映射），产物用 `gh api` 下载的那份真实 artifact zip 逐字节提供。断言覆盖：十列表头含「国家」、`thead` 零控件、25 行逐字段与 `records.js` 期望一致、六格场景值域、`-1` 格标题区分成因、统计行、两个导出按钮的可用/禁用、**真的从 blob 主机跨源取了字节**、无 CSP 拦下的请求、无未捕获异常、七种「没有数据」成因各自的标题与正文、没扫过时不去取字节也不再提 `?api=`、在线模式 `?job=` 的明确解释、出口 IP 集合掩码比对。本轮新增两条：**第一次传输截断（只写一半就断线）时换地址重取一次即自愈，恰好 2 次 blob 请求**；**连续 3 次都截断时如实报「产物字节连续 3 次都没有读完」**。
- **`worker/latest.js` 逻辑测试（21/21，打桩 GitHub API）**：命中 / 回退 / 探到上限 / 从没扫过 / 最新在跑但旧的有产物 / 只有一次在跑 / 最新失败 / 冒名运行跳过 / 标题非法 / 产物名三件套不匹配 / env 不完整先 503；本轮新增两条：**一次探测报错时继续往前找并交出更旧那次的结果**、**每次探测都失败时抛错而不是谎报「产物已过期」**；并断言对仓库只发只读 GET（唯一的 POST 是换 GitHub App token）。
- **回归**：`?job=` 本机真实链路闭环 42/42 通过；`npm run check`、`npm run verify-notes`、`node frontend-next/tools/mhtml-roundtrip.mjs` 全绿；`npx wrangler deploy --dry-run` 读到 `frontend-next` 下 19 个条目（15 个文件 + 4 个目录）。
- **发布链**：走仓库既有的 `push main → CI → worker.yml 自动部署 → Verify deployed release`（本轮先 PR 再 squash merge，即走上这条链），发布后由 `verify:deploy` 用真实会话把线上每一个资源与 commit 里的 blob 逐字节比对——入口切换是否真的生效，由这条门禁给出证据而不是由本笔记声称。
- **发布实录（这条门禁真的给出的证据，2026-09-22）**：PR #5 squash merge 成 `6ce88bd` 后自动发布，`Verify deployed release` 判红——15 个文件里嵌套目录下的 13 个报 404。**先证伪「漂移」再改门禁**：用临时 workflow（PR #6，验完即关、分支即删）在发布后 3 分钟带会话复探，`/` 200（5432 B）、`/styles.css` 200（25180 B）、`/app/api.js` 200（12089 B）、`/app/main.js` 200（20001 B）、`/export/mhtml.js` 200（13290 B）全部字节正确，说明新前端**确实已上线**，判红的是 Cloudflare 的边缘传播窗口（`/index.html` 307 到 `/` 是 `html_handling` 的预期行为，不是缺文件）。据此加「等资产生效」宽限（6 轮 × 5s）后 PR #7 → `2a0a280` 发布绿：`worker.yml` run `35742442216` success、**Version ID `28222f32-f622-49bd-8662-29f26ef3d51d`**、`Read 19 files from the assets directory …/frontend-next`、`Total Upload: 51.31 KiB / gzip: 13.74 KiB`，`Verify deployed release` 7/7 项通过，其中「线上内容与 HEAD 逐字节一致（15/15 个文件）」。宽限分支本身没被这一轮真跑到（探针首轮即 200，因为内容与上次部署相同、边缘已有），所以它的行为由离线假站点测试覆盖，见 [发布后自证](../process/2026-09-21-post-deploy-self-verification.md)。

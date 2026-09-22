# Agent Note: 新前端接上本机真实链路 —— 导出记录映射成行对象

Status: implemented

## Problem

`frontend-next/` 上一轮只交付了静态设计示例：数据是 `app/data.js` 里的 12 条合成记录（IP 全取自 RFC 5737 文档网段），行对象字段名对齐 `frontend/src/results.js` 归一化后的形状，但**真实产物从来没喂进去过**。这意味着：

- 列契约与真实字段的映射只存在于纸面假设里，没人知道 `is_residential` 的三态、`ipure_scores` 的 `-1` 哨兵、`location` 拼接串在真实记录里长什么样；
- 本地 FastAPI（`GET /api/scans/{job_id}/export`）已经能给出真实扫描的导出，但没有一条通到新前端；
- 一旦把真实 JSON 直接交给渲染器，三态与哨兵会被静默压扁成 `false` 和低分，页面上就会出现「没测出归属的节点被标成机房」这种看着正常、其实说假话的行。

## Decision

真实数据走一条独立的小通路，行对象形状不变：

- `app/api.js`：解析「读哪个任务、用哪个 API」并取回一次导出。base 只接受 `http://` + `127.0.0.1`/`localhost`/`::1` + 显式端口 + 无路径/查询/凭据（照抄 `frontend/src/transport/local.js` 的严格性，只多收 `localhost` 与 `::1`）；请求只有 `GET` + `Accept: application/json`，`credentials: "omit"`。优先级：`window.BEST_IP_CONFIG.apiBase`（dev 服务器注入）→ `?api=` → `http://127.0.0.1:8000`；任务来自 `?job=`。
- `app/records.js`：`toRows(exportPayload)` 把 `results[i]` 映射成 `app/data.js` 的行对象（字段顺序即契约顺序：`node / type / status / exit_ip / country / city / isp / asn / company_type / is_residential / native_status / is_native / coffee_score / score / score_note / ipure_scores / error / error_step`），按 `node_index` 归位；`toSnapshotMeta()` 给出 `{generatedAt, source}`，`source` 形如 `真实扫描 · <job 前 8 位>`，`generatedAt` 由 `finished_at` 格式化成 `YYYY-MM-DD HH:mm`。
- `app/main.js`：启动时按 `?job=` 分叉。有任务就走真实通路（先渲染一帧「正在读取」的空表，再整表替换），没有就保持原来的示例路径——不解析地址、不发任何请求。加载失败复用现有的 `#emptyState` 与提示条写明原因，`SNAPSHOT_META` 随来源切换文案，顶部 badge 从「示例数据」改成「真实扫描」。
- `app/snapshot.js` 的 `buildSummary` 多认一个 `state.source`：非「示例数据」时把它写进快照标题与摘要。

渲染器（`render.js` 的列契约、列宽、行高、表格结构）与 `index.html` 一行未动：真实数据必须适配渲染器，不是渲染器适配真实数据。

### 映射里三条必须写死的规则

1. **三态布尔不压缩**。`is_residential` / `is_native` 的 `null` 是「没测到」，不是「否」：渲染器把 `null` 画成中性灰的「未知」，压成 `false` 就是当面把一个未知节点诬告成机房/广播。非布尔脏值（`"true"`、`0`）一律归 `null`。
2. **`-1` 是哨兵，不是低分**。`ipure_scores` 的六项场景里 `-1` 表示「该地区受限」，原样透传交给色带与排序按哨兵处理（见 [IPure 受限档改记 -1](../../implemented/architecture/2026-09-21-ipure-restricted-sentinel-and-score-band.md)）；`null` 才是「该项无数据」。两者混起来会把受限地区画成红色垫底。
3. **脏值截断成 `null`**。空串 `isp`（真实 failed 记录里就是这个值）、数字型节点名、空数组公司类型，全部按「无值」处理——渲染器对「有值」和「无值」走不同分支，空串会让服务商那格变成一片空白而不是「服务商未知」。

`failed` 行强制清空 `exit_ip` / `score` / `coffee_score` / `ipure_scores`（记录里可能残留旧值），`score === null` 且状态为 `partial` 时补 `score_note: "IPure 未返回纯净度总分"`。已退役的 `ipure_level` / `ipure_verdict` / `ipure_scenario_levels` 一律不读——契约已删除，前端不渲染任何档位文案。

### 归属地的优先级与 `location` 的拆法

`requests.lookup.data.country` / `city` → `coffee.lookup.country` / `city`（两种落盘形态：直接是数据，或包一层 `{data}`）→ 从 `location` 串派生 → `null`。`location` 是后端把国家与城市用空格拼出来给人看的串，只有两种形态能无歧义拆开：

- `"Hong Kong Hong Kong"`（国家与城市同名，整串是同一段重复两次）→ 前后两半相等时取那一半同时当国家和城市；
- `"Singapore"`（只有一个词）→ 只当国家，城市留 `null`。

其余形态（`"United States Los Angeles"`、`"New York"`）一律返回 `null`：光靠空格分不出 `New York` 是城市还是国家，猜错比留白更糟（渲染器对空值显示「归属地未知」）。按空格取「第一个词 / 最后一个词」会把上面第一种拆成 `Hong` / `Kong`，所以不能那么写。

### 启动路径的错误是返回值，不是异常

`resolveTarget()` 把「地址非法 / 任务 ID 非法」当成返回值里的 `error`：它在模块顶层被调用，抛异常会让整页连表头都不渲染——一个拼错的地址参数换来一屏白页，代价太大。真正发请求的 `fetchExport()` 仍旧抛错，`main.js` 用 `try/catch` 收口并显示原因（409 → 「该任务还没有生成导出」、404 → 「本地没有这个任务」、非 JSON、`status !== completed`、`results` 非数组、缺 `manifest` 各有各的文案）。这是刻意不复刻生产浏览器通路的 ZIP/manifest 逐字节校验：那是网关的职责（载荷在 worker 侧验完才交给前端），本地 loopback 的载荷来自同一台机器上的同一个后端，重复校验只会把本地调试卡死。

## Alternatives considered

### Why not 复用 `frontend/src/results.js` 的归一化函数？

它的最强理由是「已经有映射了」：新前端的行对象字段名本来就是照着它的归一化结果定的（见 `app/data.js` 头部注释），复用它意味着零新代码，而且老前端线上跑过。不用它的原因是它绑在另一条链路上：它的输入是浏览器生产通路 `validateExport()` 的输出（要解密订阅、解 ZIP、逐字节核对 manifest），会把这套 crypto/artifact 校验链整个拖进新前端——而 `frontend-next` 的验收之一是「零第三方依赖、打开即渲染」。更直接的问题是字段集不同：它归一化出的记录带 `ipure_level` / `ipure_verdict` / `ipure_scenario_levels` 这些**已退役**的字段，新前端按契约不许渲染档位文案，复用等于把刚删掉的东西请回来。映射规则只有三条（三态、哨兵、脏值），单独一份反而比共享一份更难写错。

### Why not 让 `main.js` 直接渲染 `export.results`（不加适配层）？

最强理由：少一个文件、少一层，字段少转一次手就没有转错的机会。不用它的原因：列契约要的 `country` / `city` / `score_note` / `error_step` 在真实记录里要么不存在、要么形态不同（`country` 埋在 `requests.lookup.data` 里，`error_step` 要从 `requests` 的 `ok` 推断），这些规则一旦零散地写进 `render.js`，就会把「真实数据的特例」渗进列契约——而列契约是与上一轮验收绑定的，不许动。

### Why not 页面上下拉选择历史任务？

最强理由：不用记 URL，切任务一点即得；`runtime/results/` 里现成躺着几十个任务。不用它的原因：任务身份一旦变成页面状态，刷新、转发、多开标签页都会丢掉「我在看哪一次扫描」；而且要为此新增一个列表接口和一个新控件，与「控件数不增」的验收直接冲突。选任务只走 `?job=`，链接本身就是深链。

### Why not 复刻生产通路的完整导出校验（sha256 / 字节数 / ZIP）？

最强理由：与生产同一条校验路径，最不容易漏掉真实损坏。不用它的原因：那是网关（worker/浏览器生产通路）的职责，本地 loopback 的载荷由同一台机器上的同一个后端直接产出，重算哈希只会让本地调试变慢、并给前端加一个 crypto 依赖；这里只留「渲染不动就报错」的最小校验（`status === "completed"`、`manifest_ready`、`results` 是数组、`manifest` 存在）。

### Why not `error` / `error_step` 只填给 `failed` 行？

最强理由：行契约里错误文案本来就是「失败行的解释」，`partial` 行带着 `TimeoutError` 这种内部噪声还可能被全局搜索命中。不用它的原因：`partial` 行也可能恰好缺出口 IP（`trace` 没成功），那时 `render.js` 走的正是失败行分支，需要 `error` / `error_step` 才说得清这行为什么没有网络信息；`error` 取 `record.error`（为空回落到 `transport_error`），`error_step` 取四步流水线（`page` / `trace` / `lookup` / `ipure`）里第一个 `ok !== true` 的请求。

## Consequences

- **可以在页面上看真实扫描结果**：`frontend-next/index.html?job=<任务 ID>` 直接渲染导出记录；`?api=http://127.0.0.1:8000` 可换端口。没有 `?job=` 时一切照旧——示例数据、零网络请求。
- **没有真实输入控件**：任务只由 URL 指定，页面控件数与上一轮验收一致（搜索、状态、排序、两个导出 + 行内复制）。
- **失败是可见的，不是白屏**：地址非法、连不上后端、任务没生成导出、载荷缺字段，都会在空状态与提示条里写明原因，页面顶部 badge 也改成「真实扫描」。
- **代价：只认四步流水线做 `error_step`**。`global_ping` / `port_scan` / `ping_check` / `related` 是可选探针，失败不代表流程卡住，因此不参与推断——某条记录只有探针失败时 `error_step` 留 `null`。
- **代价：`location` 拆不出来就留空**。真实产物里国家/城市基本都在 `requests.lookup.data` 里，派生的兜底路径几乎不会被走到；走到且形态不止「重复」或「单词」时，`country`/`city` 为 `null`（显示「归属地未知」），不做猜测。
- **已知噪声**：`partial` / `success` 行的 `error` 会被全局搜索命中（如输入 `TimeoutError` 能筛出部分节点），而页面上这些行并不显示错误文案。这是让「错误文案对所有状态都照抄」换来的，若要收窄只需在 `toRow` 里加一个 `status === "failed"` 条件。
- **验证分两层（真扫闭环，最近一轮 38/38 通过；第三轮显示收口前是 41/41，断言块去重并新增两条后是这个数）**。第一层是 Node 侧的：`npm run check`（逐文件 `node --check`，含新文件）通过；用真实产物 `runtime/results/<job>/nodes/*.json` 直调 `toRows()` 核对字段与边界，并用最小 DOM 替身在 Node 里跑 `main.js` 的启动分支。第二层是**真实浏览器闭环**（补上第一层看不见的真机 CORS / 深链 / 加载态）：一个脚本在同一进程里同时持有本地 API 与 `frontend-next/` 静态站，用 `.env` 里的正式订阅走 `POST /api/scans` 真扫一次（25 节点，28–59s，实测抽到 13/1/11、14/0/11、14/2/9、16/3/6、14/1/10 等分布），再用 CDP 打开 `?job=<该任务>`；`/export` 只读内存里的 `_jobs`，进程一退就 404，所以扫描必须与 API 同进程、且必须在同一进程存活期间被浏览器读到。断言覆盖：25 行逐字段（出口 IP / IPure 总分 / Coffee / 场景六项 / 状态 / 服务商 / 归属 / chip）与 export 一致、九项齐全、控件恰 5 个、`thead` 无控件、垃圾区块 0、0 外链、对比度 0 违规、1440 无横滚、行高统一 51px、原生性 chip 的 `title` = 上游 `native_status`、快照含真实出口 IP 且不含订阅 URL/主机、搜索/状态筛选/排序/空态与真实分布一致，以及三条坏深链（`?job=` 空值、非 loopback `?api=`、端口无服务）都落在「0 行 + 报错 + 导出禁用」，之后回到正常深链仍能渲染。**同一批真实数据还用来覆盖本轮真扫未必抽到的形态**：把磁盘上已有的历史产物（`partial` 最多的两份，各 25 行，13/9/3 与 9/7/9）挂进内存 job 表再验一遍，9 行与 7 行「部分成功」逐字段零问题。**真实数据里 `-1` 哨兵是存在的**（第三轮真扫抽到 3 条记录的 `ai` 项为 `-1`，此处原先写「不存在」是错的，已改正）；仍未出现过的只剩「`score` 为 `null` 却有出口 IP」的行。
- **独立审查改掉的七处**（上面这层验证之后仍然漏掉的，都写在这里，别再犯）：① **空状态文案是状态而不是一次性设置**——原来加载成功后仍留着「正在读取真实扫描结果…」，用户搜到 0 行时页面会一边有数据一边说自己没读完；改成 `dataset.emptyCopy`（`null` = 用 index.html 原文案），数据到手即清回默认。② **`?job=`（写了但为空）不能再当「没写」**——原来看 `jobId` 是否为空就分流，空值深链会渲染 12 行合成 IP 且零提示；现在 `resolveTarget` 用 `URLSearchParams.has("job")` 区分「没有这个参数」与「参数是空的」，`main.js` 也必须**先判 `error` 再判 `jobId`**，顺序反了这条修不生效。③ **导出请求加 15 秒超时**（`AbortSignal.timeout`）：没有超时的话后端活着但卡住时页面永久停在「正在读取」，既无报错也无重试入口。④ **`is_datacenter` 用来补「机房」**：`is_residential` 与 `is_datacenter` 是后端两个独立键，只回了「是机房」时三态停在 `null` 会画成「未知」，把上游写明的事实丢掉；只补 `false`（机房必然不是住宅），绝不反着补 `true`。⑤ **`results` 里非对象的记录项直接报错**：原来 `[null]` 会被兜成一行「未命名节点 / 连接失败」，看着像真有一个节点失败。⑥ **没有数据时禁用两个导出按钮**：否则导出的是一份空表快照，在文件列表里跟「这次扫描确实没扫到节点」分不开；禁用状态由 `render()` 统一同步（`syncExportAvailability`），不在 `render` 与 `runExport` 两处各判一次。⑦ **导出按钮的 `title` 不能被 `removeAttribute` 抹掉**（第三轮审查发现，是 ⑥ 引入的）：`index.html` 给两个按钮写的说明（`.mhtml` 双击可打开 / `.html` 是兜底）只写在那里，而 `render()` 每次都调 `syncExportAvailability()`，用 `removeAttribute("title")` 恢复「可用」状态等于**在页面加载时就把这两条说明永久删除**——没有任何代码会再写回去，且 `aria-label` 里没有等价信息。现在启动时把原文案存进 `EXPORT_TITLES`，禁用时写原因、可用时写回原文案。
- **两套前端仍共存于仓库**：`frontend/`（订阅信封 + 发起扫描）与 `frontend-next/`（只读查看器）各自有一份归属地/评分的处理逻辑，这次没有收敛它们。**线上入口已切到 `frontend-next`**（`wrangler.jsonc` 的 `assets.directory`），`frontend/` 不再被提供但也不许删——回退就是把那一行改回去；新前端的在线只读通路见 [新前端的在线只读通路](../architecture/2026-09-22-frontend-next-online-readonly-gateway.md)。
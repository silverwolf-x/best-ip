# Agent Note: 让 artifact 转发自证完整性，并把“信封不完整”与“内容被拒”分开

Status: implemented

## Problem

一次生产扫描（run 35607531797）成功后，浏览器报 `artifact ZIP 缺少结束目录`，整轮结果再也回不来。逐层取证的结果是：

- 运行成功，artifact 上传完好：upload 步骤记录了 92831 字节与 zip 的 SHA-256，artifact 名称与 Worker 期望的 `best-ip-result-{request_id}-{run_id}-{run_attempt}` 逐字符匹配。
- `GET /repos/{owner}/{repo}/actions/artifacts/{id}/zip` 返回 **302**（`Content-Length: 0`），真身在 `productionresultssa*.blob.core.windows.net` 的签名 URL 上；那份 blob 是合法 ZIP —— 2 个条目 `result.json` / `status.json`、deflate、CRC 齐全、EOCD 落在 `byteLength - 22`。
- 在 Cloudflare workerd 里跑 `worker/github.js` 的取件逻辑与完整转发链（`limitStream` + `secureResponse`），得到的就是完整的 92831 字节、EOCD 齐全。
- 把这份 artifact 喂给 HEAD 版 `readArtifact`，25 个节点全部通过（19 success / 4 partial / 2 failed）。

也就是说：**代码路径本身是对的，但链路上没有任何一层校验“转发出去的是不是一份 ZIP”**。于是三件事叠加成这次现场：

1. 传输层只要给出一个 0 字节的 200 body（重定向没被跟随、blob 刚 finalize 还没就绪，或任何中间环节截断），`downloadArtifact` 会把它当成功原样转发给浏览器。GitHub 那个 302 的 body 恰好就是 0 字节，所以“把 3xx 当 2xx 转出去”这一步不会报错，只会静默送出一个空 body。
2. `findEnd` 对 0 字节 body 与“归档真的坏了”抛出**完全相同**的 `缺少结束目录`，现场无法区分是传输少给了字节还是归档本身有问题。
3. `gateway.poll` 把任何 `readArtifact` 失败一次性写成 `invalid: true, done: true` —— 一次抖动等于整轮扫描永久作废，不会再取第二次。

## Decision

转发边界必须自证完整性；前端必须能区分“信封不完整”和“信封完整但内容有问题”，两者处置不同。

> **已被取代**：「worker 侧」这一半（Worker 自己取字节、校验 ZIP 魔数再转发）已由 [artifact 字节改由浏览器直取](2026-09-21-artifact-bytes-delegated-to-browser.md) 撤销——Cloudflare 出口到那一族 blob 主机不可靠，Worker 现在只换取签名地址。下面「前端侧」与「取件侧」两条继续有效：归档完整性校验没有消失，只是全部落在浏览器 `readArtifact` 上。

**worker 侧（`worker/github.js`）**：`githubRawArtifact` 在把 body 交出去之前先读掉第一个分片，判定它是否以 ZIP 魔数开头（`PK\x03\x04` / `PK\x05\x06` / `PK\x07\x08`），再把首片拼回流里交给调用方。

- 是 ZIP：正常返回，只多一次 `read()`（`inspectArchiveResponse`）。
- 不是 ZIP：用 `redirect: "follow"` 直接重取一次，同时覆盖“运行时不暴露 `Location`”和“blob 尚未就绪”两种瞬时情况；仍不是 ZIP 就抛 `GitHubError(502, "GitHub artifact 响应不是 ZIP（收到 N 字节）")`。
- 3xx 但拿不到 `Location` 不再直接失败，改为退回默认重定向重取；`Content-Length` 上限检查（50 MiB）保留，抽成 `assertArchiveSize`。

**前端侧（`frontend/src/artifact/reader.js`）**：新增 `MIN_ZIP_BYTES = 22`（空归档的结束目录本身就是 22 字节），比它短的 body 直接报 `artifact ZIP 内容不完整：只收到 N 字节`；`findEnd` 失败也带上 `code: "artifact_truncated"`。**只有**带这个 code 的错误才被当作“传输层少给了字节”。

**取件侧（`frontend/src/transport/gateway.js`）**：`gateway.poll` 只对 `artifact_truncated` 做有界重取（`ARTIFACT_FETCH_ATTEMPTS = 3`，在同一次 poll 内完成，不改变轮询节奏）；其它 `readArtifact` 失败仍然一次定终态，`invalid_artifact`（超过浏览器 50 MiB 上限）保持原样。

## 取证方法（现场可复现）

- 只看响应头就能看到 302 与 `Content-Length: 0`；跟随 `Location` 取到真身字节，逐项核对中央目录、压缩方法、CRC 与 EOCD 偏移。
- 用 `wrangler dev` 搭一个临时工程（把 `worker/` 整目录复制进去，密钥走 `.dev.vars`），在 workerd 里验证：`redirect: "manual"` 在该运行时返回 302 且 `Location` 可见；`inspectArchiveResponse` 重组后的 body 与原始 blob 逐位一致（SHA-256 相同，92831 字节）。
- 前端截断矩阵：用真实 artifact 字节截成 0 / 21 / 100 字节，分别核对错误 code 与文案；完好归档必须**不**被判成截断。

## Alternatives considered

1. **只改前端的报错文案**，把“缺少结束目录”写得更清楚。最省事，也能让下一次故障一眼定性。放弃原因：传输层仍会把空 body 当成功转发，故障本身没被消除，只是变得好读。
2. **干脆把 `redirect: "manual"` 换成 `redirect: "follow"`**，让运行时自己跟完重定向。这是最少代码的写法，也能覆盖“拿不到 Location”。放弃原因：跟随之后我们就看不到跨到 blob 存储这一步，签名 URL 也交给运行时自行处理；更关键的是它对“200 但不是 ZIP”毫无防护，而这次要防的正是内容问题。保留 `manual` + 显式读 `Location`，只在兜底那一次退回 `follow`。
3. **在 worker 里把整个归档读进内存再校验**（算 CRC、查 EOCD）。最彻底的校验。放弃原因：上限 50 MiB，等于给每次取件加一个同量级内存峰值；首片魔数已经能拦下“根本不是 ZIP”的响应，结构校验留给本来就要算 CRC 和摘要的浏览器。
4. **让前端无限重试 `readArtifact`**。放弃原因：无界重试会把“归档真的坏了”变成永远转圈，比立刻失败更糟；有界 3 次足够覆盖瞬时截断。
5. **不做改动，靠重跑**。放弃原因：无法区分“传输截断”和“归档损坏”，现场只会再次以同一条误导性报错终止，而且一次抖动就作废整轮扫描。

## Consequences

- 收益：这类“空 body 冒充成功”在 worker 边界就被拦下，浏览器不会再收到 0 字节的 200；即便再次发生，报错直接给出字节数，不必再从 ZIP 格式开始怀疑。
- 收益：一次瞬时截断不再作废整轮扫描，最多多取两次归档。
- 代价：成功路径多一次 `read()` 与一次流重组；失败路径最多多一个 subrequest。
- 代价：`artifact_truncated` 成为 reader 与 transport 之间的隐式契约，将来改 `readZip` 的抛错必须保留这个 code，否则有界重取会静默失效。
- 未解决：本地复现不出触发条件。workerd 下 302 与完整 body 都正常，所以**不能断言生产那一次是哪一环给出的短 body**；本次改动把不确定性收敛成一条带字节数的报错，而不是宣称已定位。
- 未解决：artifact 只有 1 天保留期，过期后前端看到的仍是 `artifact_pending`，与本次问题无关。
- 相关：`SUMMARY_KEYS` 三处刻意重复导致的“manifest 与节点结果不一致”记在 [IPure 官方契约笔记](2026-09-21-ipure-official-api-contract.md)；本次排查中它在“已部署前端 + HEAD 后端”错配时真实复现过一次，属于同一类交付窗口问题的另一面。

## Testing

- workerd 探针：`hasZipMagic` 对真 ZIP / 空归档 / 分卷返回 true，对 0 字节、3 字节、JSON 错误页、HTML 错误页返回 false；`inspectArchiveResponse` 重组后的 body 与原始 blob SHA-256 相同、EOCD 仍在尾部；空 body 与 JSON body 都判 `zip: false`。
- 前端截断矩阵（真实 artifact 字节）：0 / 21 字节 → `artifact_truncated` + 具体字节数；100 字节 → `artifact_truncated` + `缺少结束目录`；完好归档不判截断，继续走内容校验。
- 真实 artifact 端到端：HEAD 版前后端配对能读完 run 35607531797 的 artifact（25 节点，19/4/2）。
- 本仓库当前没有测试套件（见 [process 笔记](../process/2026-09-21-actions-node24-and-pinned-runner.md)），因此上述验证以 workerd 探针与真实字节为准，没有仓库内回归用例；这是本次改动的已知短板。

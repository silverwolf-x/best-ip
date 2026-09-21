# Agent Note: artifact 字节改由浏览器直取，Worker 只换签名地址

Status: implemented

## Problem

生产闭环在取件这一步挂掉：Worker 返回 502 `GitHub artifact 下载失败`，整轮扫描结果回不来。加一行跳转状态进错误信息后拿到现场：`manual=302 → location=522`。

也就是说，GitHub App token 换签名地址这一步是好的（302 + `Location` 都在），坏的是**Worker 自己去取那个签名 blob**：

- 临时探针 Worker（`npx wrangler deploy` 一个独立脚本，目标 URL 从 POST body 读，不进日志）对 `productionresultssa12.blob.core.windows.net` 与 `productionresultssa7.blob.core.windows.net` 各打 10 次：**约 40%~60% 的请求挂死**，超过 8s 不返回，最长到 144s 后被边缘改写成 522/520。
- 同一次请求内重试**不独立**：带 8s 预算连打 4 次，4 次全部 `TimeoutError`（8s 精准中断，说明 `AbortSignal.timeout` 在 workerd 里有效）；紧接着换独立请求打 5 次，5 次都在 700ms 内成功。所以「同一个请求里多试几次」这条退路基本无效。
- 对照组健康：同一次探针里 `example.com` 12ms、`httpbin.org` 400ms、`productionresultssa1` 400ms（400 XML）。不是出口全断，是这一族主机在这条 Cloudflare↔Azure 路径上时好时坏。
- 同一个签名地址从本机与浏览器直连是健康的：`HTTP/1.1 200 OK`、`Content-Length: 91083`、`Content-Type: application/zip`，并且**带 `Access-Control-Allow-Origin: *`**（连 root/不存在的路径也带）。

于是「Worker 转发字节」这条设计的前提（Worker 能稳定取到 blob）在这个账户、这条网络路径上不成立。

## Decision

`GET /api/scans/:id/artifact` 不再搬字节，改成只回签名地址；字节由浏览器自己跨域直取。

- `worker/github.js`：`githubRawArtifact` 换成 `githubArtifactUrl(env, artifactId, retry)`，只解析并返回地址。首选 `redirect: "manual"` 读 `Location`；拿不到时才退回 `redirect: "follow"`（带 `AbortSignal.timeout(10_000)`）用 `response.url` 反推。两条跳转都各自有 10s 上限并自己兜住网络异常——放开不管的话它会以 500 `internal_error` 冒出去，既丢掉跳转轨迹也绕过 401 重试。**不用的 body 一律经 `dropBody` 丢掉并吞掉 `cancel()` 的 reject**（在已经出错或已被消费的流上 cancel 会 reject，而「别继续挂着连接」这件事本身不希望因为这一点变成失败）。地址必须 `https` 且 host 以 `.blob.core.windows.net` 结尾，否则按 502 `GitHub artifact 下载地址缺失（<跳转状态轨迹>）` / `code: "artifact_location_missing"` 失败。401 仍按原逻辑清 token 缓存重试一次。删除 `ZIP_MAGIC` / `hasZipMagic` / `inspectArchiveResponse` / `assertArchiveSize`。
- `worker/artifacts.js`：`downloadArtifact` 返回 `{artifact_id, artifact_name, artifact_url}`。前两个字段与 `GET /api/scans/:id` 一致，前端并不读——留着是为了让取件方能把这份归档与具体 run/artifact 对上（闭环验证就用 `artifact_id` 另取同一份做逐字节比对）。`findArtifact` 与 `limitStream` 不动（后者仍被 `worker/login.js` 的订阅中继用）。
- `worker/responses.js`：HTML 的 CSP `connect-src` 从 `'self'` 放宽到 `'self' https://*.blob.core.windows.net`。不放行浏览器就连不上，这是这次改动唯一必须动的安全边界，范围限定在这一族主机。
- `frontend/src/transport/http.js`：`artifact()` 读 JSON、再用 `/^https:\/\/[a-z0-9.-]+\.blob\.core\.windows\.net\//u` 复核地址（Worker 与前端各校验一次），然后 `fetch(url, { mode: "cors", credentials: "omit", cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(15_000) })`。**刻意一个自定义头都不发**：跨域请求只要带上 `X-Best-IP-Scan-Token` 这类非安全清单头，就会先来一次 CORS 预检，而 Azure 那侧并没有为 OPTIONS 配规则。**必须带超时**：这一跳没有任何外层看门狗（`checkDeadline` 只在每次 poll 开头跑，而这次 `await` 未结束就不会排下一次 poll），会挂死成「永远停在等待终态结果」。取不到字节时抛 `{code: "artifact_unavailable", retryable: true}`。
- `frontend/src/transport/gateway.js`：`ARTIFACT_FETCH_ATTEMPTS = 3` 的有界重取从「只重取 `artifact_truncated`」扩到「也重取 retryable 的传输失败」，每次重取都是一次新的 Worker 请求、拿到一个新的签名地址。失败分三类落地：`invalid_artifact` 定终态且 `invalid: true`；**字节取不到（`artifact_unavailable`）定终态但 `invalid: false`**——这是传输失败，不是结果无效，而且重取三次结果一样，再按 retryable 交给外层只会一路轮询到 31 分钟上限，最后给出一条与真实原因无关的「扫描超过 31 分钟」；签名地址拿不到这类 Worker 侧偶发失败仍然抛出去按 retryable 重试。

**完整性校验没有消失，只是全部落在浏览器**：`frontend/src/artifact/reader.js` 本来就要核 ZIP 目录、CRC、`status.json` 的 SHA-256、运行身份、manifest 与逐节点记录，比 worker 侧那个「首片是不是 `PK`」更严；而「信封不完整」这条可操作的错误码（`artifact_truncated`）本来也出自它。worker 侧唯一少掉的守卫是「别把空 200 原样转发」——现在空 body 会在 reader 里变成带字节数的 `artifact_truncated`，并且会被有界重取。

## Alternatives considered

1. **保留 Worker 转发，只加有界超时 + 重试**（最强理由：把 ZIP 魔数校验留在信任边界上，CSP 与接口契约都不用动，改动面最小）。放弃原因：单次失败率约 50%、且同请求内重试相关，4 次也还剩两位数百分比失败，而每次失败要烧掉 8s；等于用延迟换一个仍然会偶发作废整轮扫描的方案。
2. **只在客户端重试**（最强理由：不动 CSP、不动契约，复用已有的有界重取，改动更小）。放弃原因：每次重试仍然走那条坏路径，3 次后残留约 12% 失败率，而且最多给用户加 24s 等待；探针已经证明坏运气是成簇出现的。
3. **让 Actions 把归档 POST 给 Worker 并落存储（KV / R2 / Durable Object）**（最强理由：彻底不依赖 blob 这一跳，也不依赖 Worker 出网到 Azure，链路最短）。放弃原因：为了一个浏览器本来就能拿到的 90KB 文件，引入新的账户级存储资源、保留期与清理契约，还要重做「结果是终态唯一来源」的验证顺序。
4. **返回 302 让浏览器跟到 blob**（最强理由：前端一行都不用改，`fetch` 默认跟随重定向）。放弃原因：`http.artifact` 会带 `X-Best-IP-Scan-Token`，跨域后这个头触发预检，而 Azure 的 CORS 规则没有为 OPTIONS 配响应；要么改成无头请求（那和当前方案等价），要么赌预检能过。
5. **走第三方 CORS 代理取 blob**。放弃原因：为了绕开一条网络路径，把结果字节交给一个与本项目无关的第三方。
6. **什么都不改，靠重跑**。放弃原因：一次瞬时抖动就作废整轮扫描，用户没有任何手段自愈。

## Consequences

- 收益：闭环不再取决于 Cloudflare→Azure 这条路径。改动后连跑两轮生产闭环，取件都没再出现 502。
- 收益：数据路径短了一跳，Worker 不再为每次取件搬运 ~90KB，也没有内存峰值。
- 收益：失败信息自带跳转状态轨迹（`manual=302 → location=522` 就是这么读出来的），下一次同类故障不必再从探针开始。
- 代价：签名地址交给了浏览器。它是只读、约 1 小时、单 artifact 的地址，而那些字节本来就整份交给浏览器；真正的增量是「同页 XSS 能拿到的东西多了一个 URL」。
- 代价：CSP `connect-src` 放宽了一个主机族。原因写在 `worker/responses.js` 就地注释里，将来想收紧必须同时改 `frontend/src/transport/http.js` 的主机校验与这里。
- 代价：Worker 不再执行 50 MiB 上限（它看不到字节了）。`MAX_ARTIFACT_BYTES` 现在只管 `limitStream`（订阅中继）；浏览器侧的上限只能在下载完之后判，这一次的防呆能力是下降的。
- 事实：`docs/CONTRACTS.md` 与 `README.md` 里的取件契约已按新形状改写；被撤销的那一半留在 [artifact 转发完整性笔记](2026-09-21-artifact-relay-integrity.md) 里，用取代标记互链。
- 未解决：如果用户所在网络根本到不了那一族 blob 主机（例如只放行特定域名的代理），结果就取不回来——旧设计下 Worker 偶尔还能转发成功。本轮没有遇到过这种情况。

## Testing

- 生产闭环两轮（Node harness 直接 import 真实 `frontend/src/transport/gateway.js` 与 `frontend/src/artifact/reader.js`，打线上 Worker；订阅地址与站点密码从 `.env` 读入，不打印）：
  - 第 1 轮：`/artifact` 返回 810 字节 JSON（`artifact_url` 在 `productionresultssa7`），浏览器侧取得 91489 字节、首片 `50 4b 03 04`、EOCD 在尾部；同一条 artifact 另经 `gh` 直取，SHA-256 `cffb9733…` **一致**；25 节点 15/8/2，`-1` 哨兵 5 个。
  - 第 2 轮：地址在 `productionresultssa5`，96342 字节，与 `gh` 直取的 SHA-256 `5eabc4f0…` **一致**；25 节点 18/7/0，25 个节点全部拿到分数，`-1` 哨兵 5 个，越界场景值 0 个。
- 真实浏览器（CDP，站点源 `https://best-ip.silverwolfx.workers.dev`）：`fetch` 到 `https://productionresultssa7.blob.core.windows.net/` 能到网络层（`type: "cors"`、status 400），同一页 `fetch` 到 `https://example.com/` 被 CSP 拦成 `Failed to fetch`——证明 CSP 真的在这页生效，而 blob 主机是真的被放行，而不是「CSP 没生效」。
- 探针 Worker 取证：`*.blob.core.windows.net` 两个分片各 10 次单次有界尝试，统计挂死比例；同请求内 4 次重试与随后 5 次独立请求对照，证明重试相关性。
- `node --check` 覆盖全部改动文件；`npm run check`、`npm run verify-notes`、`uv run --no-dev ruff check .` 通过。本仓库没有测试套件（见 [CI 门禁笔记](../process/2026-09-21-ci-gates-without-tests.md)），因此没有仓库内回归用例。
- 对抗性评审（只读子代理）报了 7 条，处置：3 条实际缺陷在本轮修掉——浏览器侧取件缺超时（会挂成「永远停在等待终态结果」）、Worker 首跳缺 catch/超时（会变成 500 `internal_error` 并绕过 401 重试）、`dropBody` 前身 `cancel()` 可能 reject 并把「地址已解析出来」变成失败；2 条资源卫生（不返回 body 的两个分支也要丢 body）；1 条 UX 缺陷（字节取不到会被重试到 31 分钟上限）。文档、契约与笔记里的反面描述在评审之前就已改完。保留项：`artifact_id` / `artifact_name` 有意留在响应里（理由见 Decision）。
- 未做的验证：真实浏览器只验证到 blob 主机 root（可读 400 ⇒ CORS 头在位），那 ~91KB 对象的下载跑在 Node 里，而 Node 不执行 CORS/CSP。对象级 `Access-Control-Allow-Origin` 目前只有 curl 证据（curl 带 `Origin` 取真实签名对象时，响应里有 `Access-Control-Allow-Origin: *` 与 `Access-Control-Expose-Headers`）。

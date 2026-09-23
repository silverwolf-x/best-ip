# Agent Note: runner 拿不到订阅时改走自有 Worker 中继

Status: implemented

## Problem

`.github/workflows/scan.yml` 的「Run production scan」在 GitHub Actions 上稳定失败：步骤启动到退出
只有 **542 ms**，输出 `input_invalid: 扫描输入或运行身份无效`（exit 2），此前所有步骤（含解密订阅
URL）都成功。

542 ms 这个时长本身就是证据：本地实测 `run_scan.py --help` 冷启动 130 ms、成功下载订阅
1.577 s / 37145 字节 / 29 条 proxies，runner 上不可能在 542 ms 内跑完一次正常下载。而 exit 2 只
覆盖 `ValueError` / `SubscriptionError`（连接错误会是 exit 4），说明拿到了**真实的 HTTP 响应**，
只是被拒绝。

一次只打结构性证据的诊断 dispatch 给出根因（原因码与状态码，无凭据）：

| 探针 | 结果 | 结论 |
| --- | --- | --- |
| 通用出网对照 | `rc=0 http=200` | runner 出网正常，不是网络封锁 |
| `getent` 解析订阅主机 | 公网地址、非 fake-ip | 不是 DNS 或本地策略拦截 |
| 生产 UA 抓订阅 | `rc=0 http=403 bytes=19 time≈0.19s` | 服务商直接 403 |
| 浏览器 UA 抓订阅 | `http=403 bytes=19` | 换 UA 无用 |
| 不带 UA 抓订阅 | `http=403 bytes=19` | 不是 UA 判定 |
| `run_scan.py` 真实抓取 | `rc=1 reason=http_status_403` | 与原始 542 ms 失败一致 |

即：订阅主机对 Azure runner 出口一律回 403，与 User-Agent 无关，与参数/身份/文件校验无关。
同一 URL 从 Cloudflare 边缘抓取返回 `200 / 37145 字节`（两次 `890 ms`、`806 ms`），所以问题在
**抓取方的出口网络**，不在订阅本身。[本地侧另一条独立的节点噪声](../architecture/2026-09-21-ipure-official-api-contract.md)
**抓取方的出口网络**，不在订阅本身。[本地侧另一条独立的节点噪声](2026-09-21-ipure-official-api-contract.md)
是别的问题，不要混为一谈。
## Decision

> 2026-09-23 更新：本篇里「生产扫描把抓订阅固定委托给 Worker」和「直连被 403 后不再重试」两条口径已被
> [抓订阅改成直连优先，Worker 中继只在 403 时回退](2026-09-23-direct-first-subscription-egress.md)
> 取代——同一台订阅主机可以只拒 Azure，也可以只拒 Cloudflare（后者是站点自己的 managed challenge），
> 写死任何一侧都会把另一侧打成 403。中继本身、路由、鉴权、wire 契约与「逐跳公网校验只在 runner 做」
> 仍然有效，本篇其余内容照旧。

生产扫描把「抓订阅」这一步委托给自有 Cloudflare Worker；**安全判定仍只在 runner 侧做**。

**为什么是 Worker**：它是用户已经拥有、已经在跑的那一个出口（同一个 `best-ip` Worker 既发 dispatch
也给站点供页面），所以不引入新的第三方信任方；Cloudflare 边缘能抓到，浏览器不能（见备选一）。

**路由与鉴权**：`POST /api/subscription-relay`，走 `SUBSCRIPTION_RELAY_TOKEN` 共享密钥（常数时间比较，
≥16 字符，缺失返回 503 `worker_not_configured`）。它必须挂在**站点密码会话与 `assertSameOrigin()`
之前**：调用方是 Actions runner，既没有浏览器 Cookie 也不带 Origin。令牌只从请求头
`X-Best-IP-Relay-Token` 读，不回显、不记日志，也不转发任何入站头或 Cookie。

**Worker 不做地址安全判定**：它只做结构性校验（长度 8..4096、http/https、有 hostname、无 userinfo、
无空白与控制字符、端口 1..65535，且拒绝 localhost/`.localhost`/`.internal`/`.local` 与私有、回环、
链路本地、保留地址字面量），**不解析 DNS、不判断目标是否公网可达**。逐跳的公网校验留在 runner：
`validate_public_url()` 对每一次重定向后的地址重跑，SSRF/内网防护因此没有被中继绕开。

**Wire 契约**：上游用 `redirect:"manual"` 抓取（Cloudflare 运行时会返回真实 3xx 与 `Location`，不是
opaque response，已实测），20 秒超时，响应上限 5 MiB。成功一律 200，body 为
`{status, location, body_b64}`：`location` 只在 300..399 出现（截断到 4096 字符，此时 `body_b64` 为
`null`）以便 runner 解析后再校验下一跳；其余情况 `body_b64` 是上游 body 的 base64。错误体是
`{error: stable_code}` 且 `no-store`：400 `invalid_request`、405 `method_not_allowed`、
413 `response_too_large`、502 `upstream_unreachable`、504 `upstream_timeout`。

**配置语义**：`BEST_IP_SUBSCRIPTION_RELAY_URL` 与 `BEST_IP_SUBSCRIPTION_RELAY_TOKEN` **要么都给、
要么都不给**；只给一半按配置错误处理（`environment_not_ready`），而不是静默退回直连。直连被 403
拒绝时静默改用中继，会让"这次到底从哪个出口抓的"变得不可查——宁可硬失败。成功抓取后打印
`subscription_source: relay|direct` 把出口选择固化进日志。

**工作流**：`Run production scan` 之前加一步 `Validate subscription relay configuration`，断言
`vars.SCAN_RELAY_URL` 非空且以 `https://` 开头、`secrets.SCAN_RELAY_TOKEN` ≥16 字符。缺配置时在扫描
之前就红，而不是等 30 秒的扫描预算在最后一步崩掉。

**诊断面**：失败路径只打印固定闭集原因码——`subscription_fetch_reason: <code>`
（`non_http_scheme`、`url_credentials`、`localhost_target`、`dns_unresolved`、`dns_not_global`、
`doh_unavailable`、`dns_no_public_records`、`http_status_<code>`、`redirect_without_location`、
`redirect_limit`、`response_too_large`、`relay_*`、`unknown`）与 `scan_failure_code: <code>`。原因码由
`subscription_failure_reason()` 夹到 `[a-z0-9_]{1,48}`，永远不会带出订阅地址、主机或任何凭据，
符合 [CLI.md](../../../../docs/CLI.md) 的"只打印固定安全码/消息，绝不打印原始异常文本"。

## Alternatives considered

**浏览器侧快照后把订阅内容提交给 dispatch。** 最强理由：不需要新增服务端信任方，订阅 URL 只经过
用户自己的浏览器，加密模型完全不变。否定理由有两条硬事实：① 订阅主机虽然对浏览器回 200，但响应里
**没有 `access-control-allow-origin`**，前端读不到 body（拿到的只有 `content-type`、`server: nginx`、
`cf-cache-status: DYNAMIC`）；② 即使能读，Workflow dispatch 的 input 上限是 65535 字符，实测订阅
37145 字节转 base64 后约 48 KB，天花板只够一份订阅且没有余量，URL 长度或节点数一变就爆。

**换 User-Agent / 走公共 CORS 代理。** 最强理由：改动最小，一行请求头就能试。否定理由：三种 UA
（生产 UA、浏览器 UA、无 UA）在 runner 上都是 `403 / 19 字节`，服务商拒的是出口网络而不是客户端
指纹；用公共代理则换成"把订阅 URL 交给一个陌生第三方"，比自有 Worker 更差。

**让 runner 换出口（自建 WARP / 其它代理）。** 最强理由：抓取方仍是 runner，wire 契约和校验路径
一个字都不用改。否定理由：要往 CI 里塞代理凭据并长期维护一条新的网络路径，而用户已经有一个能抓到的
Cloudflare 出口；把新信任方压到零不现实，不如复用已有的那个。

**不做中继，把红运行当已知限制记录下来。** 最强理由：不新增任何攻击面，也不改工作流。否定理由：
这条工作流的目的就是产出脱敏产物，长期红等于这个功能不存在；而"每个取得出口 IP 的节点都有 IPure
分数"这条验收要求本来就必须跑完一次真实扫描才能成立。

## Consequences

收益：生产扫描可以真的跑完并上传 `best-ip-result-*` 产物；抓取出口在日志里显式可查
（`subscription_source`），失败可归因到固定原因码；逐跳公网校验仍由 runner 掌握，中继没有绕过任何
安全判定。

代价：**订阅 URL 对 Worker 可见**（用户已明确接受这个加密模型的改变）。分发链由此多一跳信任：
Worker 的 `SUBSCRIPTION_RELAY_TOKEN` 与仓库 `SCAN_RELAY_TOKEN` 必须是同一个值，轮换时要两边同改。
中继这条路因此也必须自己防滥用——没有会话 Cookie 的保护，唯一防线就是那个共享密钥，所以它必须
≥16 字符且常数时间比较。

代价：抓取上限从"runner 侧 30 秒 / 5 MiB"变成"Worker 侧 20 秒 + 5 MiB，再经 base64 放大 4/3 后传给
runner"。base64 编码后的响应体在 Worker 里是内存中的字符串，5 MiB 上限在编码前生效，因此中继响应
最大约 6.7 MiB。

代价：`worker/relay.js` 与 `backend/app/subscription.py::_relay_fetch` 是一对必须同改的契约。任一侧
单改会让中继以 `relay_response_invalid` / `relay_error` 失败——这仍然是一个安全的固定码，不会泄露
地址，但排查时需要同时读两侧。

## Testing

`uv run --no-dev pytest`：236 passed, 2 skipped。新增 `tests/test_subscription_relay.py`
（21 例，用 `httpx.MockTransport` 注入）：happy path 与 base64 body、上游 403 原样透传、重定向逐跳
校验、重定向到私网被 `dns_not_global` 拒绝、401→`relay_unauthorized`、413→`relay_response_too_large`、
超时→`relay_timeout`、连接错误→`relay_unreachable`、六种畸形载荷、body 超限→`response_too_large`、
空 body→`relay_empty_body`、`SubscriptionRelay` 配置校验、以及"没有中继时直连路径不变"。

`npm test`：59 passed（frontend 29 / worker 22 / contracts 8）。新增 `tests/worker/relay.test.mjs`
（9 例，stub `globalThis.fetch`）：缺/错令牌零次上游调用、405、503、9 种畸形 body 与 27 个被拒 URL、
字节级往返与 fetch 选项断言、带恶意 Origin 仍放行（证明它是服务器间端点）、403/503 透传与 3xx 处理
（含 4096 截断）、声明与流式两种超限都 413、`TimeoutError`/`AbortError`→504、`TypeError`→502、
以及六种响应形态都不含目标 URL。

部署后实测（`scripts/` 外的临时探针，只打印结构值）：无令牌/错令牌 401、GET 405、回环 URL 400、
真实订阅经中继 `upstream=200 bytes=37145 proxies=29 url_echoed=no`、公网重定向目标
`upstream=302 location=present body_b64=null`。

`docs/CONTRACTS.md` 与 `docs/CLI.md` 同批更新：新路由的鉴权、校验边界与错误码，以及
`subscription_source` / `relay_*` 的闭集说明。

## 未采用：让 Worker 同时判定目标是否公网可达

一开始想让 Worker 也做 DNS 解析与私网拒绝，理由是"防御纵深"。放弃理由：Worker 的 resolver 解析结果
与 runner 的 `getaddrinfo` 并不等价，两边判定不一致会出现"Worker 放行、runner 拒绝"的假失败；而且
真正要用这个连接的是 runner 侧（后续还要用同一个地址做节点探测），安全判定必须发生在真正发起连接
的那一侧。Worker 只做结构性过滤，把"是否公网"留给 `validate_public_url()`。

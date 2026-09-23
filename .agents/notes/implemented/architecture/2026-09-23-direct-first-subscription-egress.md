# Agent Note: 抓订阅改成直连优先，Worker 中继只在 403 时回退

Status: implemented

## Problem

`Scan subscription` 运行 `35924938863`（2026-09-23，由线上页面发起，订阅主机 `xn--9kqs1lo79d.cc`）
在「Run production scan」红了，全程 10 秒：

```
subscription_fetch_reason: http_status_403
input_invalid: 扫描输入或运行身份无效
```

`http_status_403` 只可能来自**上游**：中继自己出错时回的是 400/405/413/502/504，runner 侧映射成
`relay_*`；只有中继成功（HTTP 200）时上游状态才被放进 body，再由 `_relay_fetch` 转成
`http_status_<code>`（`backend/app/subscription.py`）。所以这是「Worker 出口抓订阅被拒」，不是
「Worker 拒绝调度」，也不是中继鉴权问题。

三个探针给出根因，全部只打状态码与响应头，不打地址与内容：

| 抓取出口 | 同一 URL 的结果（生产 UA `clash.meta`） | 判据 |
| --- | --- | --- |
| 本机住宅出口 | 200 / 34536 字节 | 订阅本身可用，token 没坏 |
| Cloudflare Worker（临时探针 `best-ip-probe-tmp`） | **403 / 5650 字节**，`cf-mitigated: challenge`，`server: cloudflare` | 站点自己的 Cloudflare 对 Cloudflare 出口下发 managed challenge；换浏览器 UA、去掉全部请求头都是同样的 403（2–18 ms） |
| GitHub Actions（ubuntu-24.04） | **200 / 34536 字节**，`cf-mitigated: none` | runner 出口这一次是通的 |

也就是说，[原设计](2026-09-21-runner-403-subscription-relay.md)之所以把抓取固定委托给 Worker，是因为
当时那台订阅主机（`sub-1.smjcdh.top`）只拒 Azure；而 `xn--9kqs1lo79d.cc` 恰好相反——它拒
Cloudflare、放行 Azure。**「订阅主机按出口网络拒绝」这件事没有固定方向**，写死任何一侧都会把另一侧
的主机打在 403 上，而且失败发生在下载阶段，页面侧只能看到「扫描执行结束：failure」。

同一个探针也确认中继本身没坏：`sub-1.smjcdh.top` 在 Worker 出口仍是 200 / 18854 字节（`clash.meta`
UA 给 YAML，浏览器 UA 给 base64 订阅，与本次改动无关）。

## Decision

`download_subscription()` **直连优先**：先由 runner 自己抓；只有直连以「这个出口到不了订阅主机」的方式
失败、且配了中继时，才改走 Worker 中继重抓一次。触发回退的固定码只有三个
（`EGRESS_FALLBACK_REASONS`）：`http_status_403`（出口被拒的实测特征），以及 `direct_timeout` /
`direct_unreachable`（连接根本没完成：黑洞、重置、TLS/协议中断，由 `_download_direct` 把 httpx 的
超时与传输异常收敛而来）。其他失败（`dns_*`、`http_status_401/404`、`redirect_*`、
`response_too_large`）照原样抛出。

**回退口径是「出口问题」，不是「订阅问题」。** 判据只有一条：换一个出口重抓有没有可能变好。403 是
订阅主机按出口网络拒绝（两个方向都实测过），连接层失败是连都没连上——旧策略「一直走中继」时，这类
主机本来是被中继救回来的，直连优先不能把它变成硬失败，那是这次改动自己引入的回归。反过来，接不上
401/404 也送去重试，只会把一次明确的输入错误变成两次网络往返加一个更难解释的原因码：token 失效是
401、路径错是 404、YAML 结构错在解析阶段，换出口都不会变好。要再扩这个闭集，先给出新出口的实测证据。

**连不上也必须留下固定码。** `_download_direct` 把 httpx 的 `TimeoutException` / `TransportError`
收敛成 `direct_timeout` / `direct_unreachable`：此前这类异常会裸穿到 `run_scan.py` 的兜底分支
（exit 4/6），既没有 `subscription_fetch_reason`，也违背 [CLI.md](../../../../docs/CLI.md) 「失败的
运行打印一行机器可读原因」的承诺。收敛后它们和其他下载失败一样落到 `input_invalid`（exit 2）——这个
桶本来就是「订阅没拿到」的桶，`relay_unreachable` / `relay_timeout` 一直这么走。

**实际出口必须可查。** `download_subscription(..., source=SubscriptionSource())` 把这次真正应答的
出口写回调用方，`run_scan.py` 据此打印 `subscription_source: direct|relay`（替身没回写时报
`unknown`，不假装知道），并在发生回退时补一行 `subscription_fallback_reason: <直连那次的码>`；回退
之后仍然失败时，这行打在 `subscription_fetch_reason` 之前，两个出口的痕迹都在。都是固定闭集 token，
不带地址、主机或凭据。改动前的 `subscription_source` 是按「配没配中继」猜出来的，回退一上线它就会说谎。

**中继保留。** 只拒 Azure 的主机（`sub-1.smjcdh.top`）只能靠它抓。路由、鉴权、wire 契约、逐跳公网
校验一律不动：`worker/relay.js` 与本篇无关。

## Alternatives considered

**保持中继优先，改用 `vars.SCAN_RELAY_URL` 为空来给这台主机关掉中继。** 最强理由：一行仓库变量就能
让这次运行变绿，代码一个字都不用改。否定理由：那是把「出口选择」绑死在「用户手头用哪个订阅」上——
换一个订阅就要改一次生产变量，而且改错了没有任何提示，下一个只拒 Azure 的订阅会以同样的 403 重演；
出口本来该由抓取结果决定，不该由人猜着配。

**直连失败一律回退中继（连 401/404 也回退）。** 最强理由：实现更短，一行 `except SubscriptionError`
就够，不必解释哪个码才算「出口问题」。否定理由：401/404 会被重试成两倍耗时，最终仍失败，而用户看到的原因码
还会变成后一次的结果——把「订阅地址里 token 错了」报成中继问题，是比慢更难查的伤害。连接层失败是故意
留在集合里的例外：它同样是「这个出口到不了」，留着它才不丢旧策略已经救回来的那批主机。

**两个出口都试、取第一个 200（即把所有失败都靠「都试一遍」抹平）。** 最强理由：不需要判断哪种失败
值得回退，鲁棒性看起来最好。否定理由：正常路径上每个订阅都要多花一次跨洋往返，而「谁先谁后」照样
得说清；取巧只是把顺序问题藏进延迟里，失败时也说不清是哪一侧的 403。

**让 Worker 解 challenge（Cloudflare Browser Rendering）。** 最强理由：能在 Cloudflare 侧真正拿到
这台主机的 200，出口种类不用动，页面与 workflow 都不改。否定理由：要开 Workers 付费的 Browser
Rendering，往中继里塞一个无头浏览器与一套 session 生命周期，只为绕开站点自己的反自动化策略；而
runner 直连这条更便宜的路已经实测能通，代价与收益不成比例。

**在浏览器里抓订阅内容再交给 Actions。** 最强理由：出口是用户的真实浏览器，天然过得去 challenge，
而且该站点会把 `Access-Control-Allow-Origin` 回显给来源站，浏览器确实读得到 body。否定理由：
`workflow_dispatch` 的 input 上限是 65535 字符，34536 字节的 YAML 转 base64 已到 46 KB，一份订阅就
把天花板占满；还要为「订阅内容」这条新通道重做一遍校验与脱敏。成本远高于「换个出口再抓一次」。

**不做回退，把红运行记成已知限制。** 最强理由：不改任何代码，中继策略保持单一、好解释。否定理由：
这条工作流存在的意义就是产出脱敏产物；占用户实际的订阅主机一旦被判成不兼容，等于功能不存在。而这次
的根因恰恰是「策略写死了出口」，不是订阅不可用。

## Consequences

收益：两个方向的主机都能跑完——只拒 Azure 的走中继，只拒 Cloudflare 的走直连；日志里的
`subscription_source` 第一次说的是真实出口。

代价：正常路径多一次「先直连」的尝试；对被 Azure 拒绝的主机，这一次是 403（实测 0.19 秒）。对
「直连连不上」的主机则要耗尽一次直连超时预算再走中继，单次抓取最长约等于两份
`subscription_timeout_seconds`（每一步仍分别受 `min(subscription_timeout_seconds, --timeout)` 约束，
总预算 1500 秒不变）。

代价：`subscription_source` 从「配置事实」变成「运行结果」，读日志时不能再用环境变量反推出口。这是
刻意的——本次事故的根因就是出口被猜出来、而不是被报出来。

代价：`backend/app/subscription.py` 的 `source` 参数与 `scripts/run_scan.py` 的打印是一对成对契约，
`docs/CLI.md`、`docs/CONTRACTS.md` 必须同批更新。

代价：中继也失败时，报出来的是中继那次的码，直连那次的只能从先打的
`subscription_fallback_reason` 看出来——排查时两行都要看。

## Testing

**判定顺序（离线，注入式替身）**：九个场景——直连成功时中继零次调用并记 `direct`；直连 403 → 中继成功（记
`relay` + `fallback_reason=http_status_403`）；直连 403 且未配中继 → 原样抛 `http_status_403`；直连 404 →
中继零次调用、原样抛 `http_status_404`；直连 403 且中继也 403 → 报中继那次的码；未配中继 + 直连成功 →
`direct`；`direct_timeout` 与 `direct_unreachable` → 都回退；`dns_unresolved` → 不回退。9/9 通过，且失败
路径上记录器保持未回写（`source=None`），这正是 `run_scan.py` 敢在成功时才打 `subscription_source` 的依据。

**两类真实失败各跑一遍**（配真实生产中继地址 + 故意用错的 token，这样只验证「回退真的发出去了、码收敛对」）：
① 真的回 403 的公网地址（`https://httpbin.org/status/403`）→ `fallback=http_status_403
reason=relay_unauthorized`；② 真的连不上的公网地址（`https://example.com:9/`，黑洞端口，实测 curl 8 秒超时）
→ `fallback=direct_timeout reason=relay_unauthorized`。两条都证明回退确实跨网发起了请求，生产中继按契约以
401 拒绝并收敛成闭集码。

**生产闭环 A（CLI 触发，复现原缺陷场景）**：用页面同款信封对 `xn--9kqs1lo79d.cc` 这条订阅 dispatch
`scan.yml`，运行 `35926228537` completed/success：`subscription_source: direct`（修复前这里必然走中继并 403），
11 秒扫完，产物 `best-ip-result-req-verify-1790201044-35926228537-1`（zip 82270 字节，`result.json` 1006192
字节），`status.json` 为 `total: 22 / success: 22 / partial: 0 / failed: 0`，行里是真实出口 IP 与 CIDR
（如 `18.178.247.88` / `18.178.247.0/24`）。对照同一条订阅在修复前的运行 `35924938863`：10 秒红在
`subscription_fetch_reason: http_status_403`。改动收尾（把连接层失败收敛成固定码那批）之后又原样重跑一次：
运行 `35928184512` completed/success、同样 `subscription_source: direct`（8 秒），确认收敛没动到正常路径。

**生产闭环 B（页面发起，走 Worker 那条路）**：用 `SITE_PASSWORD` 登录线上站点后，订阅框是 `type="text"`
明文输入（实测 `document.getElementById('subscriptionUrl').type === "text"`），粘进同一条订阅地址 →
`POST /api/scans`（run `35926441941`，日志里同样 `subscription_source: direct`）→ dispatch → 轮询 → 浏览器
直连 blob 取产物 → 落表：进度行
「扫描已完成 · 已用时 28秒」，统计行「22 个节点·22 完整·0 部分·0 失败·真实扫描快照生成于 2026-09-24 06:06」，
toast「扫描完成：已显示刚扫出来的 22 个节点。」，表格 22 行、十列表头齐全，首行「🇬🇧英国•电信01 / vless /
51.24.48.151 / United Kingdom / Amazon.com AS16509·Hosting / 机房 / 广播 / Coffee 89 / IPure 44 /
AI0·社交4·流媒体23·游戏19·电商18·邮件59」。

**部署面**：推送后 CI `35926211148` success → `Deploy Cloudflare Worker` `35926278617` success；
`SITE_PASSWORD=… node scripts/verify_deploy.mjs --site …` → `7/7 项通过`，其中「线上内容与 HEAD 逐字节一致
（18/18 个文件）」把改动后的 `index.html` 也覆盖在内。门禁：`uv run --no-dev ruff check .` 全过、
`npm run check` 全过、`npm run verify-notes` 三线 ok（23 篇）。

**留下的缺口**：本仓库没有测试套件，上面这些证据（离线九场景 + 两类真实失败各一次）都是一次性脚本，
没有回归护栏；
`subscription_source` / `subscription_fallback_reason` 只被生产日志与文档约束。另外这次没能造出「runner 出口
被 403 的真实订阅主机」——旧订阅 `sub-1.smjcdh.top` 今天在 runner 出口已是 200（运行 `35926898998`，同样
`subscription_source: direct`），所以中继回退在生产里只验证到「会发起请求、按契约收码」这一半；「中继带正确
token 抓到订阅」最近一次生产证据是 2026-09-21，本次改动没有碰那条路径。

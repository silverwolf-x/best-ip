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

`download_subscription()` **直连优先**：先由 runner 自己抓；只有直连以 `http_status_403`
（`EGRESS_REFUSAL_REASON`，出口被拒的实测特征）失败、且配了中继时，才改走 Worker 中继重抓一次。
其他失败（`dns_*`、重定向、超限、`http_status_401/404`、`redirect_limit`）照原样抛出。

**回退口径只认 403。** 把「订阅本身有问题」也送去中继重试，只会把一次明确的输入错误变成两次网络
往返加一个更难解释的原因码：token 失效是 401、路径错是 404、YAML 结构错在解析阶段，它们换出口也不会
变好。要扩这个闭集，先给出新出口的实测证据。

**实际出口必须可查。** `download_subscription(..., source=SubscriptionSource())` 把这次真正应答的
出口写回调用方，`run_scan.py` 据此打印 `subscription_source: direct|relay`，并在发生回退时补一行
`subscription_fallback_reason: http_status_403`。两个都是固定闭集 token，不带地址、主机或凭据。
改动前的 `subscription_source` 是按「配没配中继」猜出来的，回退一上线它就会说谎。

**中继保留。** 只拒 Azure 的主机（`sub-1.smjcdh.top`）只能靠它抓。路由、鉴权、wire 契约、逐跳公网
校验一律不动：`worker/relay.js` 与本篇无关。

## Alternatives considered

**保持中继优先，改用 `vars.SCAN_RELAY_URL` 为空来给这台主机关掉中继。** 最强理由：一行仓库变量就能
让这次运行变绿，代码一个字都不用改。否定理由：那是把「出口选择」绑死在「用户手头用哪个订阅」上——
换一个订阅就要改一次生产变量，而且改错了没有任何提示，下一个只拒 Azure 的订阅会以同样的 403 重演；
出口本来该由抓取结果决定，不该由人猜着配。

**直连失败一律回退中继（不挑状态码）。** 最强理由：实现更短，一行 `except SubscriptionError` 就够，
不必解释哪个码才算「出口拒绝」。否定理由：401/404 会被重试成两倍耗时，最终仍失败，而用户看到的原因码
还会变成后一次的结果——把「订阅地址里 token 错了」报成中继问题，是比慢更难查的伤害。

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

代价：正常路径多一次「先直连」的尝试；对被 Azure 拒绝的主机，这一次是 403（实测 0.19 秒）。

代价：`subscription_source` 从「配置事实」变成「运行结果」，读日志时不能再用环境变量反推出口。这是
刻意的——本次事故的根因就是出口被猜出来、而不是被报出来。

代价：`backend/app/subscription.py` 的 `source` 参数与 `scripts/run_scan.py` 的打印是一对成对契约，
`docs/CLI.md`、`docs/CONTRACTS.md` 必须同批更新。

代价：中继的失败原因码在回退路径上会被直连那次的码覆盖（`subscription_fallback_reason` 先落地），
排查时两个出口都要看。

## Testing

（真实证据待补：生产闭环运行 ID 与日志行）

# Agent Note: IPure 接入对齐官方 /docs/api 契约

Status: implemented

## Problem

IPure 接入是在"未收录 IP 需要人机验证"的前提下长出来的：结果记录里带
`proxy_evidence.direct_fallback` 与 `ipure_verification_session_used`，查询被验证墙拒绝时改用
`config/ipure.yml` 里的 `ipure_verified` Cookie 直连重试，前端与三处校验器都认这两个字段。

官方 `/docs/api` 现在的契约不是这样：接口无需 API key 或 Cookie；来自出口 IP 自身的查询不需要
验证；未收录 IP 的免验证额度按来源 IP 每天 5 次、全站每分钟 15 次，用尽返回
`403 verification_required` 并附 `reportUrl`；限流返回 `429 open_rate_limited` 与 `Retry-After`。
同时 `scenarios[]` 有六项（`ai · social · streaming · gaming · ecommerce · email`），我们只解析四项，
且只按 `score` 取数，丢掉了 `level` —— 而官方明确要求 `restricted` / `not_applicable` / `unusable`
档位下的分数不得当作可用性结论。

后果有两层：凭据回退路径无法在真实扫描中稳定复现，且每个节点都会因为缺少 `social`、`gaming`
两项而无法给出完整评分；验收脚本又只要求"有终态记录"，所以缺分不会被拦下。

## Decision

接入以官方 `/docs/api` 为唯一事实来源，按无凭据、六场景、档位感知重写。

**边界**：`GET https://ipure.dev/api/lookup?ip={ip}`，可选 `refresh=1`。allowlist 只放行这两个
查询参数，路径固定 `/api/lookup`，其余一律拒绝。请求头只做可选覆盖（`config/ipure.yml` 的
`headers`，用于 User-Agent 之类），不含任何凭据，缺失时回落到 `application/json` +
`MyIPChecker/1.0`。凭据回退路径整体删除：`_direct_request`、`_verification_cookie`、
`BEST_IP_IPURE_COOKIE` 以及记录里的 `direct_fallback` / `ipure_verification_session_used` 全部不再存在，
校验器不再接受它们。

**解析**：`risk.purity` 是唯一的硬要求，缺它才算解析失败；`risk.level / label / verdict`、
`scenarios[].score / level / levelLabel`、`reportUrl`、`source`（fresh / cache / store）、
`stale`、`scenarioApplicable` 都是尽力解析。六项场景永远齐备：某个场景缺席时该项为 `null`，
不影响纯净度总分，因为验收要求的是"每个节点都有分数"，不是"每个场景都有分数"。

**失败语义**：`429` 最多重试 3 次，退避 1、2 秒并取 `Retry-After` 与之较大者；等待若会超出本次
查询时间预算就不再等待，也不会切换出口重试。`403` 不重试，把官方 `reportUrl` 记进结果。
`x-open-budget-remaining` 写入 `proxy_evidence.ipure_budget_remaining`。

**落盘契约**：节点记录新增 `ipure_scores`（七键：`total` + 六场景）、`ipure_level`、
`ipure_verdict`、`ipure_scenario_levels`（六场景 id → 档位码）、`ipure_report_url`。`score` 必须等于
`ipure_scores.total`。`ipure_scores` 与 `ipure_scenario_levels` 的键集合必须精确等于约定集合，
取值必须是 0..100 的整数或 `null`。

**前后端分离**：前后端之间只有 artifact / 节点记录这一个契约，前端不 import 后端任何东西。
`frontend/src/artifact/` 是自包含的契约层（校验、ZIP 读取），不依赖 `src/results.js` 这类应用层模块；
场景键与中文标签因此在两侧各有一份自有清单，靠"两侧都对同一份外部文档"和契约测试对齐，
而不是靠共享模块——前端没有构建步骤，跨层 import 会把契约层绑死在应用层上。

**档位渲染**：场景 chip 存在与否只看"这个场景有没有值"，不看"有没有数字"。分数可以合法缺席
（IPure 对 `restricted` 场景回 `score: null`），此时档位仍然存在，必须渲染档位中文名，而不是把
这一项丢掉。`frontend/src/views/table-view.js` 因此先取档位、再判有无：只有分数与档位都没有才算
缺值。丢掉它的后果不是"少一个标签"，而是让一个拿到出口 IP 的节点在表格里只剩五项——与"六项场景
齐备"这条契约直接矛盾。

**验收门槛**：`scripts/verify_real_scan.py` 对每个 `success` / `partial` 节点强制校验完整六场景报告，
任缺一项即整体失败。这条门槛比 `ResultStore` 的结构校验更严：结构校验允许 `null`（离线导入、
历史产物仍要能读），验收门槛不允许。范围差异是有意的——`failed` 节点没有出口 IP，不存在可查询对象，
因此"每个节点都有分数"的准确含义是"每个取得出口 IP 的节点都有分数"。

## Alternatives considered

**保留 Cookie 回退，只补解析与场景。** 改动最小，也不会丢已有部署能力。否定理由是官方明确
无需凭据、且出口 IP 自查免验证，这条路径在真实扫描中既非必要也无法稳定覆盖；留着等于长期维护
一条测不到的分支，还要把凭据同步进 GitHub Secret。

**维持四项场景，只加 `total` 与新错误码。** 能过验收。否定理由是 `gaming` 与 `social` 恰是选节点
时最常被问的两项，官方既然给了六项，缺两项就是主动丢信息。

**沿用"每个场景都必须存在，否则整份报告作废"的旧解析。** 语义简单。否定理由是把一部分场景的
缺失升级成整份报告不可用，会直接牺牲纯净度总分——而总分才是验收与排序真正依赖的字段。

**给 IPure 请求加进程级并发闸门，压低 429。** 看起来能提升成功率。否定理由是每个节点都从自己的
出口 IP 发出查询，单客户端限流是逐节点独立的；唯一的全站限制（每分钟 15 次免验证放行）是与整个
互联网共享的服务端配额，本地闸门主要效果是拖慢扫描，而 `Retry-After` 已经能覆盖真实限流。

**改用文档推荐的路径式端点 `/ip/{ip}.json`（官方称其对 Agent 浏览环境更稳）。** 否定理由是本项目
的客户端是脚本，不吃查询参数拦截；保留单一端点能让 allowlist、代理证据绑定与验收断言都少一套分支。

## Consequences

收益：节点只要拿到出口 IP 就会带一份完整六场景报告与原始 `reportUrl`；前端不会再把
`restricted` / `not_applicable` / `unusable` 的分数渲染成可用性结论，而是显示档位并给出原因提示；
整个 IPure 链路不再有凭据，`IPURE_CONFIG_YAML` Secret 变为可选的请求头覆盖。

代价：`ipure_scenario_levels` 的键集合在三处镜像 —— 后端 `_SUMMARY_KEYS`、
`frontend/src/artifact/reader.js` 的 `SUMMARY_KEYS`、以及两个 JS 契约 fixture 的 `summaryKeys`。
漏改任意一处会让 artifact 校验以"manifest 与节点结果不一致"失败。这是刻意保留的重复：
reader 是自包含契约层，不能 import 后端常量，也无法在运行时读 Python。改字段时必须四处同改。

代价：单次 IPure 查询预算由 8 秒放宽到 20 秒，以覆盖未收录 IP 的实时多源查询。该查询与
lookup、global ping、portscan 并发，通常不延长节点墙钟时间；极端情况下会多占一个节点槽位。

代价：免验证额度是真实约束。额度耗尽时节点只能标记"部分"并记录 `reportUrl`，本次扫描拿不到分数，
验收会因此失败——这是有意暴露而不是静默降级。

代价：`ipure_via_direct_fallback` 记录了一条"这次分数不是从节点出口问到的"的例外。IPure 的报告按
被查询的 IP 索引（`reportUrl` 即 `/ip/{ip}`），所以换一个查询方拿到的是同一份文档；但代理证据的
可信度确实弱于正常情况下，因此它必须显式落盘、由校验器比对，而不是静默生效。

### 真实订阅扫描暴露的节点侧噪声

**失败与传输类型一一对应。** 25 节点订阅里，11 个 `network=ws` 的 vless 节点全部指向同一个主机
`cf-yes.nekocloud.host`（解析链 `cfyes.lxy1015.top` → `cf.yfjc.sbs` → 单个 A 记录）；另外 14 个节点
（3 个 hysteria2 直连 IP + 3 个不同主机上的 tcp vless）在全部轮次中 14/14 成功，无一失败。
失败永远只出现在这一个共享主机上。

**失败是时间相关的坏窗口，不是节点永久不可用，也不是本地资源竞争。** 逐条排除：

- 同一节点在同一 Mihomo 进程内连续 8 次请求：`ConnectError` 两次后转好，后续 6 次稳定 420ms 成功。
- 另一次窗口里对 3 个该主机节点做「并发 vs 串行」对照：两组各 5/5 全成功。
- 但同一批节点换一个时间点，并发 1（完全独占）反而 9/10 失败，比并发 8 的 6/11 更差。
  并发不是原因，坏窗口才是。
- 每节点独占 Mihomo 进程（无其他节点竞争）时，持续失败节点 4/4 仍然失败。
- 提高尝试次数到 6 次、把退避从 2s 拉到 30s 把重试在时间上摊开 60s，均无改善（6/11 → 4/11）。

失败面的 `page` 与 `trace` 停在 ~5003ms，即 Mihomo 侧 5s 拨号超时（日志
`context deadline exceeded`），不是业务错误。结论：这是订阅方共享主机的容量/限流问题，
**本地参数无法调出"零失败"**，"每个节点都有分数"在这条订阅上不可能达成。

因此 `verify_real_scan.py` 的可用性门槛（默认拒绝任何失败节点）在真实链路上通常无法满足，
`BEST_IP_ALLOW_PARTIAL=1` 是既有的、有意的逃生门。而"每个节点都有 IPure 分数"这条要求，
严格可验证的形式是：**每个取得出口 IP 的节点都必须有完整的纯净度总分与六项场景评分**；
没有出口 IP 的失败节点不存在可查询对象。
生产扫描在 CI 侧还遇到过另一个独立的阻塞（订阅主机对 runner 出口一律回 403），
见 [runner 拿不到订阅时改走自有 Worker 中继](2026-09-21-runner-403-subscription-relay.md)。
那一条不影响本节结论：本节讲的是本地链路里共享主机的节点噪声。

## Testing

`uv run --no-dev pytest`：209 passed, 2 skipped。覆盖六场景解析、`total` 缺失才判失败、单场景缺失
保留总分、`403 verification_required` 带出 `reportUrl`、`429` 有界重试不换出口、`refresh` 参数
allowlist、以及"IPure 请求不携带 Cookie/Authorization"。

`npm test`：49 passed（frontend 28 / worker 13 / contracts 8）。覆盖六项评分键集合与取值校验、
伪造 `ipure_scores` 被拒、CSV 往返保留六项评分、artifact summary 键集合与 reader 一致。

真实验收：`scripts/verify_real_scan.py` 用 `.env` 的正式订阅跑完整扫描，断言每个取得出口 IP 的节点
都带整数 0..100 的纯净度总分与六项场景评分，并打印评分覆盖数。订阅 token 不落盘、不入结果。
25 节点订阅历次可评分覆盖在 18–22/25 之间波动，全部失败都落在共享主机 `cf-yes.nekocloud.host` 上。

浏览器闭环：用 Playwright 自带的 Chromium（CDP，无第三方依赖）打开本地前端，在页面里提交同一份
正式订阅，走完 前端 → 后端 → artifact → 表格渲染 全链路。结果：25 行全部渲染，每个取得出口 IP 的
节点都显示 IPure 总分与六项场景；`restricted` / `not_applicable` / `unusable` 档位渲染为档位中文名
（如「地区受限」「不可用」）而不是分数，与官方"不得当作可用性结论"的要求一致；详情弹窗渲染
IPure 判定、六项场景、总分与 `ipure.dev` 原始报告链接；控制台 error/warning 与未捕获异常均为 0。

### 未采用：为失败节点枚举候选出口 IP

失败节点没有出口 IP，就没有可查询的 IPure 对象，因此"每个节点都有分数"在这些节点上不可能成立。
曾考虑用 `ip.net.coffee` 的 `/api/ip/related/{ip}` 或同类接口，从一个已知出口 IP 枚举同网段候选地址，
逐个查 IPure 后分配给"缺失分数"的节点。

放弃理由：这些接口的存在意义是"追查过去用过的关联地址"，不是"给我一个没连上的节点随便配个 IP"；
把候选地址挂到该节点上，等于给一条**从未验证过**的出口 IP 生成评分，属于伪造证据而非补全数据。
即便事后把全部候选 IP 都列出，规则也退化成"预先断言这些地址属于该节点"，与 `lookup`/`trace`
必须与出口 IP 一致这条既有契约直接冲突。

解析器另用 `https://ipure.dev/api/lookup` 的真实响应（`8.8.8.8` 的 `not_applicable` 全场景、
以及一个 `restricted`/`unusable` 混合的真实出口 IP）回放校验，确认两种档位分布都能得到完整六场景。

# Agent Note: 归属信息改以 IPure 为准，表格改成点列名排序、逐列筛选

Status: implemented

## Problem

用户的要求是两件事：

1. 出口 IP、国家和地区、服务商 / ISP 这三列（并举一反三到接入与原生性）要从 [IPure `/api/lookup`](https://ipure.dev/docs/api) 取，而不是 Coffee。此前这三列全部来自 Coffee 的 trace + lookup，IPure 只贡献评分；IPure 报告里关于这个 IP 的归属描述被解析时直接丢掉了。
2. 表格「僵硬」：排序只能用顶部下拉里的六个固定选项（Coffee / IPure / 名称各升降），筛选只有全局搜索与状态下拉。想按国家排、按服务商筛、按流媒体分排序都做不到——IPure 六项场景评分挤在同一列里，连单独排序的对象都没有。

## Decision

### 归属信息：IPure 优先，按组回落

- `ipure._parse_ipure_report` 多解析一个 `network`，留在 `requests.ipure.data.network` 作原始证据。字段按用户贴出的真实响应（8.8.8.8，2026-10-06）逐个对应：`geo.countryName` 是国名、`geo.country` 是**国家代码**（第一版宽容解析器把它当国名，于是国名丢了、只剩 "US"）；`asn.org` 是运营组织（"Google Public DNS"），`asn.name` 是 "GOOGLE - Google LLC, US" 形状的 AS 名，清洗成 "Google LLC"；`registry.org / country` 是 RIR 登记；`usageType`（"hosting"）与 `nativeType`（"native"）只在能下结论时给出布尔值。缺失或类型不对一律 null，不猜。
- 用户授权后在 Actions runner 上实查（临时探针 workflow，跑完即删）：官方 `/docs/api` 写明 `usageType` = residential · mobile · business · hosting · education · government · unknown，`nativeType` = native · broadcast · unknown；16 个样本里 HiNet 是 residential、台湾大哥大是 mobile、Google IPv6（登记美国、用在加拿大）是 broadcast、`192.0.2.1` 各组全空。据此「接入」列直接显示六档（住宅 / 移动 / 商业 / 机房 / 教育 / 政府），新增可选字段 `usage_type`；移动网络不再被当成「未知」回落 Coffee，并与住宅一样计入左侧绿色导轨。同一次实查还确认未收录 IP 每个来源每天 5 次免验证额度（第 6 次起 `403 verification_required`）——生产查询从各节点自己的出口发出，不共用这份额度。
- `collector._network_identity` 按五组合并：地区（国家 / 代码 / 地区 / 城市）、服务商（ISP = `asn.org`、AS 组织、ASN）、接入（住宅 / 机房）、原生性（含「广播 IP (登记国)」文案），每组先看 IPure，IPure 那组为空才回落 Coffee。来源写进 `network_source = {exit_ip, geo, isp, kind, native}`。出口 IP 仍由 trace 发现——IPure 的查询必须带上一个 IP——IPure 回显的 `ip` 与之一致时记 `"ipure"`。
- 节点记录新增可选字段 `country`、`country_code`、`region`、`city`、`network_source`；后端 `validate_node` 与两份前端 `artifact/validation.js` 都放行并做类型校验。旧产物没有这些字段照常能读：`records.js` 先读顶层 `country / city`，没有再走原来的 `requests.lookup.data` → `coffee.lookup` → `location` 串。
- 状态判定与「五项基础采集检查」没动：success / partial 仍要求 Coffee 的 page / trace / lookup 成功。这一轮只换显示值的来源，不改「什么算扫成功」的契约。

### 表格：像电子表格一样用

- `render.js` 的 `COLUMNS` 每列带 `sort`（text / ip / enum / num）、`filter`（text / enum / num）与取值函数，表头两行（列名按钮 + 筛选控件）、colgroup、卡片态 data-label 全由它生成。IPure 六项场景评分拆成六个真列。
- 纯逻辑放在新的 `app/table.js`：文本筛选（空格多词全中、`a|b` 任一、`!词` 排除）、分数筛选（`80` 即 ≥80、`>80`、`<=60`、`60-90`、`=-1`；写不成分数的输入标红但不生效）、多列排序（null 永远沉底，平局按节点名再按订阅顺序）、点表头的三态循环（分数列先降序、文本列先升序，Shift 叠加次级排序）、地址栏 hash 编解码（`#sort=…&status=…&q=…&f.<列>=…`，不认识的列与方向直接丢弃）。
- 顶部的排序下拉删除；状态下拉换成带个数的分段按钮；新增「列筛选」开关（宽屏默认展开、窄屏默认收起）与「清除筛选」。单元格里的国家、服务商、AS 号、接入、原生性、协议可点，一键把那一列筛成这个值，再点取消。`/` 聚焦全局搜索，筛选框里 Esc 清空。
- 窄屏卡片态：表头不再整块裁掉，列名行变成可横滑的排序胶囊，筛选行变成带标签的输入格；六项场景在手机宽度折成 3×2。
- 导出快照：克隆表格后删掉筛选行、列名按钮换成文字、摘掉一键筛选样式；摘要里的「筛选 / 状态 / 排序」由内存态生成（「接入：住宅」「IPure ↓ · Coffee ↓」）。
- `check_frontend_contracts.mjs` 的契约 b 断言不变（`index.html` 的 `<thead>` 里零控件），理由改写为「表头控件只能由 render.js 按 COLUMNS 生成」。

## Alternatives considered

**用 IPure 的无参自查（`/api/lookup` 不带 `ip`）直接拿出口 IP，省掉 trace。** 这样「出口 IP 来自 IPure」最彻底。否定理由：官方契约与本仓库的 URL 白名单都要求恰好一个 `ip` 参数，无参调用是否被支持无从验证；trace 失败时整节点失败的判据也会跟着变，那是另一次契约修改。

**把 Coffee 从必需检查里拿掉，IPure 成功就算 success。** 改动面覆盖两份校验器、验收脚本与 CONTRACTS，且需要真实 IPure 响应才能定义「IPure 成功」的最低字段集。这次先只换显示来源，等拿到真实响应样本后再单独决定。

**保留场景评分为一列六 chip，只在表头加一个「按哪项排」的下拉。** 版面不动。否定理由：那又是「只能通过一个按钮操作」，正是用户要去掉的交互；拆成真列后排序、筛选、窄屏折叠都走同一套列模型。

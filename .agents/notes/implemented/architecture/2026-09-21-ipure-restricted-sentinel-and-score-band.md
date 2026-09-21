# Agent Note: IPure 受限档改记 -1，评分按 ipure.dev 色带直显

Status: implemented

## Problem

前端此前把 IPure 的档位（`restricted` / `not_applicable` / `unusable`）渲染成中文标签（「地区受限」「不可用」），
分数即使有值也不显示；`ipure_scores` 的取值域只允许 `0..100` 或 `null`，档位与分数是两套并行的表示。
后果是同一列里既有数字又有文案，无法横向比较；而「不显示分数」并不是官方要求的那件事——
官方说的是 `restricted` 下的分数不得当作可用性结论，用标签替代数字是把「小心解读」做成了「丢掉信息」。

需求因此是：一个节点的每项 IPure 评分只有一种形态——带颜色的数字。受限项也不例外，
它需要一个显式的「不在刻度上」取值，而不是另一种渲染分支。

## Decision

**受限即 `-1`，由后端写入。** `risk.level == restricted` 时，`_ipure_scores()` 把该项写成
`IPURE_RESTRICTED_SCORE = -1`；总分与六项场景同一规则，上游即便同时给了一个数字也一律改写。
前端不做二次推导，`-1` 是记录里的既成事实。

**取值域。** `ipure_scores` 七个键（`total` + 六场景）取值 ∈ `0..100 ∪ {-1} ∪ {null}`，
`score` 必须等于 `ipure_scores.total`。`-2` 与 `101` 被两侧校验器拒绝；
`record.score` 的取值域独立于 `ipure_scores` 校验，删掉 `ipure_scores` 藏不住一个越界的 `score`。

**颜色规则复刻 ipure.dev 自己的色带。** 官网对分数用五段连续渐变、逐通道线性插值后取整：

| 分数 | 颜色 |
| --- | --- |
| 0 | `#E8447D` |
| 25 | `#F2734E` |
| 50 | `#F2C14E` |
| 75 | `#8DE86A` |
| 100 | `#34E5C4` |

该规则用官网实测采样点反推确认（如 32→`rgb(242 137 78)`、59→`rgb(206 207 88)`、82→`rgb(116 231 131)`），
`frontend/src/results.js` 的 `ipureScoreChannels()` 是唯一实现。

**`-1` 用中性灰 `rgb(139 155 171)`。** 这是 ipure.dev 的 `--color-ink-dim`（官网对没有分数的行用色）。
`-1` 不在刻度上：按 0 去插值会让受限项落到最刺眼的品红，等于把「地区受限」误报成「分数最低」。
官网同样不给受限项上色，这条规则与它保持一致。

**唯一着色点。** `ipureScoreInlineStyle(score)` 同时给出 `color` / `border-color` / `background` 三段样式，
表格分数格、场景 chip、详情 hero 都走它；`.score-band` 与 `.chip-score` 只留字重与等宽数字、不留颜色，
同一个分数不会在两处渲染出两种颜色。

**`-1` 不是数值。** 排序与分数列筛选走 `comparableIpureScore()`，`-1` 返回 `null`，
既不参与数值排序，也不会被 `<45` 这类筛选命中。

**落盘契约收窄。** `ipure_level`、`ipure_verdict`、`ipure_scenario_levels` 不再写进节点记录；
档位、`label`、`verdict` 仍留在 `requests.ipure.data` 里作为原样证据，前端不再有档位文案可渲染。
`data.total` 与 `data.scenarios[].score` 保留上游原值（`null` 也算），`-1` 只出现在记录层——
一份证据文档里不会同时存在同一个取值的两种约定。

**读取容忍。** 两个校验器忽略历史记录里的这三个字段（`_RETIRED_NODE_FIELDS` / `retired`），
否则改动前写下的 `runtime/results/*` 与已导出的 artifact 会整批打不开；其它未知字段仍然一律拒绝。

本笔记只覆盖取值与显示；同批的墙钟改动见
[真实订阅扫描的墙钟预算](2026-09-21-scan-wall-clock-budget.md)，
被本文取代的档位渲染与取值域事实见
[IPure 接入对齐官方 /docs/api 契约](2026-09-21-ipure-official-api-contract.md)。

## Alternatives considered

**前端推导 `-1`（后端保留上游原值）。** 最强理由：落盘内容完全不变，历史产物与新产物格式一致，
也不必动两个校验器和验收脚本。否定理由：表格、CSV 导出、详情弹窗、验收脚本会各自推导一遍「这个项算不算受限」，
规则一旦分叉，同一节点在不同出口就会显示不同数字；而 `score == ipure_scores.total` 这条一致性校验也随之失去意义——
它存在的目的就是让「总分」只有一个来源。

**把 `-1` 当 0 参与插值上色。** 最强理由：颜色函数保持单一输入域，不需要哨兵分支。
否定理由：受限是「没有落在刻度上的值」，画成 0 号色就是在断言它是最差分数，正是官方文档要求避免的误读。

**同时显示档位文案与分数。** 最强理由：信息最全，受限项既能看到原因又能看到数字。
否定理由：两种表示并列时读者仍会按数字比较，「不得当作可用性结论」这条约束并没有被满足；这正是要删掉的形态。

**沿用应用自己的三档配色（`score-great` / `score-good` / `score-bad`）。** 最强理由：复用现成 class，
改动最小，还能让 IPure 与 Coffee 两个分数看起来一致。否定理由：官网用的是五段连续插值，
三档会在同一段内产生色阶跳变，与用户自己能打开的报告页对不上；Coffee 分数保持三档配色，
因为它不是 IPure 分数，套 IPure 色带等于编一个不存在的映射。

**把 `requests.ipure.data.total` 也改写成 `-1`（让证据文档统一）。** 最强理由：验收脚本可以直接比较
`record["score"] == data["total"]`，不必知道受限规则。否定理由：`data` 的定义是上游原样证据；
同一份文档里 `total` 被改写而 `scenarios[].score` 保留原值，会给读 `data` 的人留下「同一受限档、两个约定」。
现在改由验收脚本从 `data.level` 推导期望值，反而把「受限项必须恰为 -1」和「非受限项必须等于上游值」两侧都钉死。

## Consequences

- 收益：一项评分只有一种形态——数字加颜色，`restricted` 不再表现为「这一项没有分数」。
- 收益：颜色规则与官网同源且只有一个实现点，表格、chip、详情弹窗不可能各画一套。
- 代价：`-1` 是哨兵而非分数，任何消费方都必须先分辨它；CSV 导出会直接出现 `-1`（排序与列筛选已按非数值处理）。
- 代价：取值域变宽要同步四处——后端校验器与 `_SUMMARY_KEYS`、`frontend/src/artifact/validation.js`、
  `docs/CONTRACTS.md`、`tests/fixtures/contracts/records.json` 驱动的两侧契约测试；漏改一处靠 fixture 红。
- 代价：删字段是破坏性收窄，读端容忍只是迁移窗口。重访信号：`runtime/results` 里不再有改动前的任务时，
  `_RETIRED_NODE_FIELDS` 与 `retired` 应一并删除；它们还在，就说明仍有旧产物依赖这条容忍。

## Testing

`tests/frontend_app.test.mjs` 用官网采样点钉住五段端点与插值（0 / 25 / 50 / 75 / 100 与
32 / 54 / 58 / 59 / 77 / 79 / 82），`-1` → `rgb(139 155 171)`，`-2` / `101` → 无色；
并断言 chip 里不再出现「不可用」「不适用」「地区受限」，`-1` 不参与排序与分数列筛选。
还有一个源码级用例把「档位文案回归」钉死：渲染层（`results.js` / `table-view.js` / `detail-view.js` /
`import-export.js`）去注释后不许再出现档位文案与已删除的档位标识符，色带函数 `ipureScoreColor`
只许在 `results.js` 里被引用；唯一豁免是 GPT · Codex 探针卡片（按锚点切掉后再断言，它渲染的是
chatgpt.com / api.openai.com 的可达性状态，与 IPure 分数无关）。该用例的灵敏度已用注入副本验证：
注入 `ipureScenarioLevel` / 「不可用」/ 「地区受限」三处回归全部被抓到。

`tests/fixtures/contracts/records.json` 增补 `-1` 合法、`-2` / `101` 非法的用例，由 Python 与 JS 两侧同时消费，
避免只有一侧校验取值域时另一侧的回归不可见。

`tests/test_verify_real_scan.py` 覆盖受限 → `-1`、非受限项写 `-1` 被拒、受限项保留上游数字被拒、`-2` / `101` 被拒。

真机：`scripts/verify_real_scan.py` 对每个取得出口 IP 的节点断言六项场景齐备、受限项恰为 `-1`。

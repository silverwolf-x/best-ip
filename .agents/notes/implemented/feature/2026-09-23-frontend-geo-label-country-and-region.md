# Agent Note: 归属地列表头写「国家和地区」

Status: implemented

## Problem

归属地那一列的表头写着「国家」，而这一列的取值是归属查询的 `country` 字段，真实数据里这个字段既给国家也给地区：上一轮 25 节点真扫里有多条节点的 `location` 是 `Hong Kong Hong Kong`（国家与城市同名），也就是 `country = "Hong Kong"`——香港不是国家。表头写「国家」，等于替这类值做了一个错的归类，读表的人会把「这一列只放国家」当成前提。

这不是渲染缺陷，是**表头文案与列内容不符**，而表头文案是列契约的一部分：`COLUMNS[].label` 同时供 `th` 的文本与每个 `td` 的 `data-label`（≤900px 卡片模式下的行内标签）使用，见 [十列宽表笔记](2026-09-22-frontend-single-view-redesign.md)。

## Decision

`frontend-next/app/render.js` 的 `COLUMNS` 里 `geo` 一列表头由「国家」改成「国家和地区」。`data-label` 由 `labelOf()` 从同一份 `label` 派生，自动跟随，没有第二处要改。

- **列内容不变**：`locationText()` 仍只写 `result.country`；城市仍在检索索引里（`main.js` 的 `buildSearchIndex`）。那是 [归属地列只写国家](2026-09-22-frontend-next-country-column-and-unified-minus-one.md) 的决定，本笔记不改它。
- **列宽不变（96px）**：真 Chromium 实测（10.5px / 800 / 0.07em，含 th 的 18px 内边距与 1px 左边框）「国家」41.48px、「国家和地区」75.19px、「国家 / 地区」77.05px——三者在 96px 里都装得下，所以这次改动**没有**引起列宽或表宽变化：`geo` 列仍 96px，十列合计 1357px，`.grid { min-width }` 仍是 1322px，1440 视口无横滚。
- **两处搜索框占位文案跟着改**：`frontend-next/index.html` 的 `#query`，以及仓库里已不再被提供的旧 `frontend/index.html` 的 `#resultSearch`。线上页面由 `wrangler.jsonc` 的 assets 根指向 `frontend-next`。

## Alternatives considered

### Why not 保持「国家」？
最强理由：这一列的字段名就是 `country`，值直接来自归属查询的 country 字段，「国家」是最贴近实现的写法，改文案反而要额外解释一次「为什么表头和字段不同名」；而且这一列 96px 的宽度预算是按最长的国名量的，动表头本来有触碰列宽的风险。不选的原因：表头是给读表的人看的，不是字段名的复述，而真实数据里这个字段确实会给出地区值（`Hong Kong`）；宽度那条风险已实测排除（75.19px < 96px）。

### Why not 写回「国家 / 地区」（上一轮改动之前的表头）？
最强理由：不用新造词，回到 PR #4 之前的表头即可；`国家 / 地区` 是常见写法，与仓库里已有的「服务商 / ISP」风格一致，宽度也装得下（77.05px）。不选的原因：这张表里带斜杠的表头专门表示**两个并列的字段**（「服务商 / ISP」是两个来源的信息），拿同一个符号表示「国家或地区」会和那列的惯例打架；表示这个口径的汉语固定说法是「国家和地区」。

### Why not 把列内容也补成「国家和地区」（例如把城市放回来）？
最强理由：表头写了两个词，列里却只有一份值，补上地区/城市才名副其实。不选的原因：城市一屏可见这件事已在上一轮的笔记里被否过（96px 硬上限、横向可比性、同名去重会按数据形态分岔），本轮只改文案，不动数据契约；城市仍然可搜。

## Consequences

- 收益：表头与列内容一致——`country` 字段本来就同时给国家和「香港」这类地区；真值只有一处（`COLUMNS`），`data-label` 同源跟随。
- 代价：表头从 2 个字变成 4 个字，表头行视觉上更密一点；卡片模式的行内标签也跟着变长，实测 880px 的 `min-width:88px` 与 375px 的 `76px` 仍留有余量（标签不折行、`geo` 格不裁切）。
- 事实：本笔记取代 [上一轮笔记](2026-09-22-frontend-next-country-column-and-unified-minus-one.md) 的 Decision 里「表头文案由『国家 / 地区』改成『国家』」这一句，那句已就地同步；那份笔记的其余决定（只写国家、有出口 IP 的行恒六格、IPure 取值先过域）全部不变。

## Testing

真 Chromium（headless + CDP，用本机已装的 playwright chromium）打静态 `frontend-next`，走示例数据路径（地址栏无 `?job=`、非在线部署，零网络请求，12 行）：

- **1440 视口**：表头 10 列且第 4 列恰为「国家和地区」；10 个 `td.cell-geo` 的 `data-label` 全是「国家和地区」；`th.col-geo` 不裁切（`scrollWidth === clientWidth === 95`）；每个 `geo` 格不裁切；表宽 1357px = 十列宽度之和、`geo` 列 96px、`.grid { min-width }` 仍是 1322px；`documentElement.scrollWidth` 1399 < `innerWidth` 1414，无横滚。
- **880px 与 375px（卡片模式）**：`thead` 隐藏、标签由 `td[data-label]::before` 渲染，实测 `content` 为 `"国家和地区"`、`min-width` 分别 88px / 76px、无横滚（`scrollWidth` 865 / 360 均 ≤ 视口）、`geo` 格不裁切。
- **固有宽度的量法**：把三串文案放进脱离文档流、字体栈与 `th` 一致的 `span` 里量文字宽，再加 th 的 18px 内边距与 1px 左边框（「国家」41.48 / 「国家和地区」75.19 / 「国家 / 地区」77.05）。
- **门禁**：`npm run check`、`npm run verify-notes`、`uv run ruff check .`。
- 上一轮笔记里那条「表头恰为『国家』」的断言，现在应断言「国家和地区」。

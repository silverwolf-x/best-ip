# Agent Note: 新前端改成单视图十列宽表，并把整页存成可离线打开的 mhtml 快照

Status: proposed

## Problem

旧 `frontend/` 把一切都塞进一页，但把关键信息藏了两层：

- **9 项核心结论要点击才看全**。节点名称、Coffee 评分、IPure 总分、出口 IP、国家/地区、服务商/ISP、住宅或机房、原生性、IPure 六项场景评分——其中过半只在详情弹窗里出现。列表本身是 12 列，窄屏还要横向滚动。
- **噪声占了首屏三分之一**。顶部导航栏、页面说明段、个人网关模式提示、页脚、主题切换按钮、导入导出区，都是与"这个节点值不值得用"无关的东西；表头还挂了 10 个逐列筛选器。
- **当前视图存不下来**。榜单是扫描结果的即时视图，"今天筛出来的这 12 个节点"没有任何办法变成一个可以归档、可以离线打开、可以转发给别人的文件。

另有一次中间改稿的教训：把每行做成卡片（rank/身份一行、网络与评分折行）确实去掉了弹窗，却把**信息密度做得比旧版宽表还低**——12 行要 700px 以上，扫读一列数值时眼睛要走 Z 字。密度是这类榜单的第一价值，卡片不是答案。

## Proposal

新建 `frontend-next/`，做一版**无弹窗、无展开、无二级页的单视图十列宽表**，本轮只交付静态示例（内置合成数据、零网络请求），不接真实链路。

页面结构：

- `.table-wrap > table.grid#grid > caption.sr-only + colgroup#gridColumns + thead#gridHead + tbody#rows`。十列依次是：排名 `#`、节点（名称 + 协议 tag）、出口 IP（带复制按钮）、国家 / 地区、服务商 / ISP（次行给 `AS…` 与公司类型）、接入（住宅 / 机房）、原生性（原生 / 广播）、Coffee 评分、IPure 总分、IPure 六项场景评分（六个紧凑 chip）。
- 表头是**静态列名**，`thead` 内不得有任何 `input` / `select` / `button`。页面上只留 5 个控件：`#query`、`#statusFilter`（全部/完整/部分/失败）、`#sortSelect`、`#exportMhtml`、`#exportHtml`，外加每行的 `.copy-btn`。
- 首列的 3px 左边框当导轨，编码"值不值得用"：`data-verdict="good|mixed|bad"` → 绿 / 琥珀 / 红。它不是文字，不占列宽也不加对比度负担。
- 前三名只在"按分数降序"时高亮（`data-tier="top"` → 金色）。按名字排序时给第 1 名戴金牌是撒谎。
- 行状态药丸只在非"完整"时出现：完整是常态，每行挂一个"完整"就是噪声。失败行用 `td.cell-absent[colspan=5]` 占掉"出口 IP / 地区 / 服务商 / 接入 / 原生性"五列，写明失败原因与卡在哪一步，**不留白**。
- 响应式两段 + 一个兜底：宽度够（可用宽度 ≥1350px，即视口 ≥1440px）就十列平铺；不够就整张横向滚动，**只滚不删列、也不压列宽**；≤900px 折成卡片，每个单元格用 `td[data-label]::before` 自报家门，`thead` 与 `colgroup` 隐藏（卡片模式要撤销所有为表格算宽度设的 `min-width`，并放开 `.ident` 上的 `max-width: 0`，否则节点名会被裁成 0 宽）。

## 单一真值：列定义

`app/render.js` 的 `COLUMNS` 是列的**唯一**真值，`table` 只描述它要哪些列：

```js
COLUMNS = [ { key, label, width?, align? } × 10 ]
```

表头文案（`createHeadRow`）、`colgroup` 宽度（`createColGroup`）、窄屏折叠时每个单元格的 `data-label` 全部由它派生。这三处各写一份必然漂移：改了列名却忘了改 `data-label`，手机上的每个字段都会被贴错标签，而这种错在桌面上永远看不见。

`app/main.js` 启动时建一次 `colgroup` 与 `thead`，之后每帧只换 `tbody` —— 输入每次按键都重建表头会让整张表重排（IME 组合期间尤其明显）。

## 列宽是量出来的预算，不是画出来的

十列的宽度不是设计稿标的，是在真实 Chromium 里量出来的：把 `#grid` 克隆进 `width:max-content` 的容器并**摘掉 `colgroup`**，浏览器给出的每列宽度就是"内容自然需要多宽"。照这个数重排（`rank 40 / ident 258 / ip 168 / geo 116 / isp 168 / kind 58 / native 58 / coffee 62 / ipure 58`），把 `kind`/`native`/`coffee`/`ipure` 四列白占的 77px 全转给「节点」列（184 → 258）——原先 12 行里有 7 行的协议 tag 与状态药丸被省略号静默吃掉（连"部分"这个状态本身都吃）。1440 视口可用 1358px，十列实测和 1350px，放得下，且行高从 53–57px 收到统一的 50.5px（整表 705 → 645px）。

「IPure 场景评分」是唯一不许折行的列（6 个 chip 要 346px），它的硬下限只能写在 CSS 里：`<col>` 元素不支持 `min-width`，于是宽度写在 `COLUMNS`、下限写在 `.grid .cell-scn`。同理 `.grid { min-width: 1350px }` 是"列宽实测和的硬下限"，低于它浏览器就从场景列挖宽度，6 个 chip 折行后行高膨胀到 57/80/149px。窄屏宁可横向滚动也不压列宽；卡片模式下这两条下限都必须撤销（`.cell-scn { min-width: 0 }`），否则窄屏会被它们撑出横向滚动。

## 快照里的脚本会被 Chrome 沙箱拦掉

`.mhtml` 双击打开时 Chrome 报的是：`Blocked script execution in 'file:///…' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.` 于是快照内联的 `copy.js` 永远不会执行（`globalThis.BestIpCopy === undefined`），复制按钮点了没反应。三条应对：

- `.ip { user-select: all }`：单击出口 IP 即全选，再按 Ctrl/⌘+C——这是 `.mhtml` 里**唯一**可用的复制路径（实测有效）。
- `.mhtml` 版快照顶部插一条 `.snapshot-note`，当面说明按钮不可用并指向同批 `.html`；`.html` 版不插。
- `.html` 兜底脚本可用，没有这个限制。

测这条路径有个坑：离屏有头窗口默认没有 OS 焦点，合成的 Ctrl+C 会落到地址栏（剪贴板里出现的是页面 URL 而不是选集），必须先 `Page.bringToFront` 并确认 `document.hasFocus() === true`，否则测出来的不是页面行为。

## 离线快照：两个产物，一套源码

「导出整页」产出两种文件，内容同源：

- `.mhtml`（主）：`multipart/related`，HTML 部件用 `<link href="./styles.css">`，样式表作为**独立部件**靠 `Content-Location` 命中同一个 URL —— 这正是 Chrome 自己"保存网页"的形状。
- `.html`（兜底）：自包含单文件，CSS 内联进 `<style>`。部分浏览器已不再渲染 `.mhtml`，没有这条兜底就会出现"快照打不开且没有替代路径"。

两条共同要求：

- 导出取的是**整张表**的实时 `outerHTML`（含 `thead` 与 CSSOM 写出的色带通道），所以快照里表格结构完整，不只是一个裸露的 `tbody`。
- 快照内联 `app/copy.js` 的**原文**，而不是把复制逻辑抄一份进模板：同一份文本既能被页面当经典脚本加载，也能被快照原样内联。两份实现必然漂移。
- 快照正文不含 `http(s)` 外链，也不写 `<meta>` CSP —— 快照靠内联 `<script>` 挂复制行为，写上 CSP 就会把自己的脚本拦掉。

`navigator.clipboard` 只在安全上下文可用，`file://` 打开的快照拿不到它，所以 `copy.js` 必须有 `execCommand("copy")` + 临时 textarea 的回退路径。快照要能离线复制，这条回退是必需路径，不是锦上添花。

## 分数取色仍然只能走 CSSOM

十列表格里的分数是药丸（`.score[data-band=…]`），IPure 总分与六个场景 chip 带 `data-ipure-score`，由 `applyScoreStyles` 在元素进 DOM **之后**用 CSSOM 写 `--sc-l` / `--sc-d` 通道，CSS 只负责决定前景/描边/底色的比例（`rgb(var(--sc))` / `rgb(var(--sc) / 0.10)` / `rgb(var(--sc) / 0.42)`）。生产 CSP 是 `style-src 'self'`，标记里的 `style` 属性会被静默拦掉，所以色带绝不出现在标记里，只能这样分两步走——见 [生产 CSP 只认 CSSOM](../../implemented/architecture/2026-09-22-frontend-csp-blocks-markup-styles.md)。色带本身取自已验证的配方，见 [IPure 色带改用 Coffee 色调配方](../../implemented/bug-fix/2026-09-22-ipure-score-band-coffee-tone.md)。

`-1` 是"该地区受限"的哨兵值，不是低分：它走中性灰通道，且**不参与数值排序**（升序时也不许被顶到最高分）。`score: null` 显示"—"并给出 `score_note` 原因；场景缺项显示"另有 N 项无数据"。无值不伪装——见 [IPure 受限档改记 -1](../../implemented/architecture/2026-09-21-ipure-restricted-sentinel-and-score-band.md)。

## Alternatives considered

### Why not 沿用旧 12 列宽表，只删掉 10 个表头筛选器与详情弹窗？

这是最低风险的选项：复用现有渲染/排序代码与已经在线上验证过的 CSS，改动面最小，几乎不可能引入新回归。否掉的原因是它没解决问题——导航栏、说明段、页脚、主题切换这些噪声源都留着；更重要的是"删掉弹窗"之后没有替代物承载"把这批结果存成一份可离线归档的文件"，而这是本轮要新增能力的核心。

### Why not 每行做成卡片（rank/身份一行，网络与评分折行）？

这是本轮的第一版实现。它的优势很实在：窄屏天然友好，不需要横向滚动，靠留白就能完成分组，视觉上比表格柔和，也让"一行 9 项"在手机上一屏可见。否掉的原因是**密度**：每行两段文字高度，12 行要 700px 以上，扫读同一列数值时视线必须走 Z 字；而这类榜单的第一价值就是纵向扫读一列数字。用户明确要求"用表格展示更多的信息密度"，卡片不是答案。

### Why not 用详情抽屉或二级详情页替代弹窗？

它能承载更多信息，还支持深链与分享，是弹窗的正统升级路径。否掉的原因有二：用户明确要求彻底无二级页、无展开；而且抽屉仍是"点击才可见"，违反"一屏可见"这条硬要求。

### Why not 把六项场景评分收进 tooltip / hover 浮层，主表只留总分？

把主表压到 8 列，行更短更干净，桌面观感确实更好。否掉的原因：hover 在触屏上不存在；而且"IPure 六项场景评分"是验收里明确要一屏可见的一项，藏起来就是减配，不是精简。

### Why not 只导出 `.html` 单文件，不做 `.mhtml`？

`.html` 在所有浏览器里都能打开，兼容性最好，而且实现更简单（只有一个产物、一条路径）。否掉的原因是制品形态：用户要的是"整页离线快照"，而 mhtml 的多部件结构保留了样式表部件边界，更接近浏览器原生的"保存页面"。结论是两个都产出，`.html` 当兜底。

### Why not 导出 PDF 或整页截图？

所见即所得，完全不依赖浏览器对 mhtml 的支持，适合归档。否掉的原因：产物里的文本不可复制、不可搜索、不可选中，与"快照内的复制按钮仍然可用"这条验收直接冲突。

### Why not MHTML 的样式部件用 RFC 标准的 `Content-ID` + `cid:` 引用？

`cid:` 是 MHTML 规范里关联部件的正统写法，理论上更标准。否掉的原因是实测跟随主流实现更可靠：Chrome 自身"保存页面"用的是 `Content-Location` + 相对 `href`，浏览器的样式部件匹配逻辑就是按这条路径实现的，用标准写法反而可能命中不了。

## Acceptance criteria

1. **分支与隔离**：`git branch --show-current` 输出 `design/new-frontend`；`git rev-parse main^{tree}` 与开工前一致（main 未被改动）；`git log main..design/new-frontend --oneline` 至少 1 条提交。不 push、不合并。
2. **示例可查看且自包含**：`frontend-next/index.html` 经本地静态服务打开即完整渲染；页面加载**零外部网络请求**（无 CDN、无外部字体、无图标库、无第三方 JS 依赖），数据为内嵌合成数据。
3. **减法到位（机械可复现）**：对 `frontend-next/` 的检查输出证明下列项 0 命中——顶部导航栏、页面说明段、个人网关模式提示、页脚、主题切换按钮、逐列表头筛选行、`<dialog>`/弹窗、`<details>` 原始 JSON 折叠块、二级页跳转。页面输入控件只剩搜索框、状态筛选、排序切换、导出按钮、复制按钮。
4. **有用内容一屏可见、零点击**：搜索（如输入"日本"）、切状态、切换排序（Coffee / IPure 总分）均即时生效；任意一行在**不点击行**的情况下同时呈现 9 项内容。失败节点不呈现为空白（显示失败原因）。
5. **导出 mhtml 且离线可用**：产物是单个 `.mhtml`，`Content-Type` 为 `multipart/related`，CSS 以独立部件靠 `Content-Location` 命中（与仓库 `styles.css` 逐字节一致），正文不含任何 `http(s)://` 外链；Node 侧序列化往返测试通过；断网条件下从 `file://` 打开，`.mhtml` 与 `.html` 两个产物在行数、表头、控件、色带、对比度上与在线视图一致。**剪贴板条款**：Chrome 把 `file://` 的 `.mhtml` 放进不设 `allow-scripts` 的沙箱 frame，快照内脚本一律不执行，`navigator.clipboard` 与 `execCommand` 在 `.mhtml` 里都不可达——这条改由「单击出口 IP 即全选 + Ctrl/⌘+C」承担（有头 Chromium、真鼠标、`Page.bringToFront` 拿到焦点后，系统剪贴板实测拿到 `192.0.2.18`），快照顶部同时写明按钮不可用并指向 `.html`。`.html` 兜底脚本可用：去掉 `navigator.clipboard` 后走 `execCommand` 回退，系统剪贴板实测内容正确。
6. **笔记门禁**：本笔记落在 `.agents/notes/proposed/feature/`，含 `## Problem` / `## Proposal` / `## Alternatives considered` / `## Acceptance criteria` / `## Risks`，`npm run verify-notes` 退出码 0；既有笔记不做删除或迁移。
7. **语法门禁**：`npm run check` 退出码 0，且扫描范围已包含 `frontend-next/`（唯一的既有文件改动是 `scripts/check_js.mjs` 的目录列表）。
8. **交付说明**：给出新前端示例的查看方式（命令 + 地址）并实际打开演示；给出上述各项验收的实际运行证据；写明第二步"接真实链路"的范围；列明仍存在的限制。

## Risks

- **`file://` 直接打开页面时导出会失败**。`fetch('./styles.css')` 与 `cssRules` 都被同源策略拒，这不是代码能绕开的事，只能把"请用本地静态服务打开"写进报错文案。本轮把它作为已知限制，不做本地文件专用路径。
- **快照内色带依赖 CSSOM 写出的自定义属性**。若快照在带 CSP `style-src 'self'` 的 http 环境下打开，`style` 属性会被拦掉，色带退化为兜底灰。手工双击离线打开不受影响。
- **十列在窄屏放不下**。可用宽度低于 1350px 就整张表横向滚动：1366 视口滚 26px、1280 滚 112px、1100 滚 292px、901 滚 491px。≤900px 折成卡片后行高 216–326px，一屏只看到 2 行。"一屏 12 行"这个卖点只在 ≥1440px 成立。这是"绝不压列宽"的代价：滚动至少不藏信息（把代价交给滚动条），压列宽则会把代价转成肉眼可见的排版崩坏（6 个 chip 折成三行、行高 149px）。
- **`.mhtml` 里的复制按钮在 Chrome 下永久不可用**，这是浏览器级限制不是缺陷：`file://` 打开的 `.mhtml` 被放进不设 `allow-scripts` 的沙箱 frame，脚本一律不执行。补救是 `.ip { user-select: all }` 的零 JS 路径 + 快照顶部的说明条 + 同批导出的 `.html` 兜底，但"快照里的复制按钮"这件事本身无法两全。
- **失败行用 `colspan=5` 跨列，屏幕阅读器读到的行内列数与表头不一致**。已用 `data-label` 与失败原因文本补偿，但不完美；表格语义与"有些行少五格"的张力是本方案的结构性代价。
- **两套前端短期共存**。新建 `frontend-next/` 而不是改造 `frontend/`，意味着同样的取色与归一化逻辑会短暂存在两份。第二步接真实链路时，示例数据与真实产物字段的映射还没有验证过。
- **删掉逐列筛选器后，复杂查询能力靠"全局搜索 + 状态筛选"兜**。全局搜索覆盖节点名、协议、IP、国家、城市、ISP、ASN、公司类型、原生性、失败原因，够日常用；但真实数据里若要按 ISP 或 ASN 精确过滤并统计，这个白名单会不够用。
- **表格语义 + 无二级页意味着信息量被物理限制在十列内**。以后每增加一项"值得一眼看见"的字段，都要在"加列变窄"和"删别的列"之间做一次取舍，扩展空间比卡片布局小。

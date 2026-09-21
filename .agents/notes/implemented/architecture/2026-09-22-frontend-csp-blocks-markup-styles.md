# Agent Note: 生产 CSP 只认 CSSOM——标记里的 style 属性在线上会被静默拦掉

Status: implemented

## Problem

`worker/responses.js` 的 `secureResponse()` 给所有 `Content-Type: text/html` 的响应挂 CSP，其中 `style-src 'self'`
（不含 `'unsafe-inline'`）。这条指令对两种写法的判定不一样：

- **由标记解析出来的 `style` 属性算内联样式，会被拦掉。** 范围包括 `innerHTML` / `insertAdjacentHTML` 拼进去的，
  也包括写在静态 HTML 里的；被拦的属性被**丢弃**（不是报错、不是部分生效），元素于是落回样式表里的规则。
- **通过 CSSOM 写入的不算内联样式，不受限制**：`element.style.cssText`、`element.style.setProperty()`、
  `element.style.color = …`。整段颜色写进去也照生效。

也就是说，同一句「给这个元素一个颜色」，拼进标记在线上静默失效，进 DOM 之后用 CSSOM 写则生效——而**两者在本地表现完全相同**：
`scripts/dev.py` 是纯静态文件服务器，不经过 Worker、也不发任何 CSP 头（`grep -i content-security scripts/dev.py` 无命中），
本地浏览器对两种写法一样放行。这个差异只在生产成立。

这次就撞上了。详情弹窗的 IPure 分数节点是把 `color` / `border-color` / `background` 拼进 `innerHTML` 的
（`frontend/src/views/detail-view.js`），**线上从来没上过色**：`data-ipure-score` 还不存在的时候，
分数胶囊在线上是样式表里的兜底灰。表格分数格（`frontend/src/views/table-view.js`）用的是
`badge.style.cssText`，因此一直正常。同一份色带、同一个取色函数，在一个视图里有效、在另一个视图里从第一天起就是坏的，
而本地怎么翻都看不出来。

## Decision

**前端由 JS 算出来的样式，一律在节点进入 DOM 之后用 CSSOM 写；标记只承载数据（`data-*`），不承载 `style`。**

具体约定：

- 颜色与通道由 `frontend/src/results.js` 生产，视图层只做搬运。详情视图用 `data-ipure-score="<分数>"` 把分数带进标记，
  在 `elements.detailContent.replaceChildren(content)` **之后**由 `applyIpureScoreStyles(container)` 统一写
  `element.style.cssText = ipureScoreInlineStyle(element.dataset.ipureScore)`。表格分数格与场景 chip
  维持既有的 `badge.style.cssText` 写法。`frontend/` 下当前 `style=` 出现 **0 次**。
- **`data-*` 属性本身不受 `style-src` 约束，CSSOM 赋值也不受**——受约束的只有「把样式写进标记」这一种做法。这是这条规则可用的前提。
- **主题相关的选择留在样式表里**，不写进内联样式：`ui.js` 切主题只改 `documentElement.dataset.theme`，不重渲染节点，
  内联写死的颜色会停在旧主题。详见 [IPure 色带改用 Coffee 色调配方](../bug-fix/2026-09-22-ipure-score-band-coffee-tone.md)。
- **`worker/responses.js` 的 CSP 是唯一真值，前端不得为推动某种写法要求放宽它。** `style-src` 这道防线存在的前提正是
  「标记里不可能混进任意 CSS」；这条头同时是部署后自证要核对的线上约束之一（`scripts/verify_deploy.mjs` 核对 `connect-src`）。
- **新增着色点的写法**：先给节点一个能表达的 `data-*`，再在插入 DOM 之后写样式。**漏掉后一步不会报错**，
  只会退回样式表的兜底色——这正是本缺陷潜伏这么久的原因，所以这条约束的机械形态是「源码里不出现 `style=`」，
  而不是「线上分数看着有色」。

## 为什么不是「让本地也发 CSP」

`scripts/dev.py` 不发 CSP 是它作为静态服务器的事实，不是遗漏：要让本地也拦，就得在 dev 侧复刻「哪些响应算 `text/html`」
这条判断，等于立起第二份 CSP 真值，两份必然漂移。dev 不经过 Worker 的路由与鉴权，dev/prod 的差异本来就不止一处，
逐个补齐是把 dev 变成半个 Worker。**正确的收敛方向是消掉分叉本身**：改成 CSP 下两种环境都合法的 CSSOM 写法之后，
本地与线上的行为一致，dev 侧不需要任何 CSP。

## Alternatives considered

**给 `style-src` 补 `'unsafe-inline'`，让原来的 `innerHTML` 写法直接生效。** 最强理由：一个头的改动，前端一行都不用动，
也不必引入 `data-ipure-score` 这层数据属性，详情弹窗立刻就能上色；而且「把样式拼进标记」本来是这版前端一直在用的写法，
放行它等于让线上与本地一致。否定理由：`style-src` 整体失效之后，任何将来注入到标记里的 CSS 都会生效，
而这条头同时被部署后自证当作线上约束核对；更要紧的是它**没有解决分歧**——本地不发 CSP、线上发，
下一次「拼 style 属性」仍然会在本地看着正常、线上静默失效。

**把放行范围收窄到属性内联样式（`style-src-attr 'unsafe-inline'`，或 `'unsafe-hashes'` + 属性内容哈希白名单），
`<style>` 元素仍锁在 `'self'`。** 最强理由：比整体放行精确，属性内联正是唯一需要的那个口子；
`'unsafe-hashes'` 还只放行事先算过哈希的具体值，看起来能把注入面压到最小。否定理由：
前者的攻击面与整体放行区别不大（标记注入即得 CSS 执行），后者在本场景**根本用不上**——通道值由分数连续插值而来，
0–100 有上百个不同字符串，没有有限的白名单可枚举，改一次色带就得重算哈希。而两者同样留着 dev/prod 分叉。

**把颜色离散化成类名（`.sc-0` … `.sc-100`）挂上去，彻底不碰内联样式。** 最强理由：纯类名方案在任何 CSP 下都合法，
连 CSSOM 那一行都省了，样式还能进缓存、可被静态审查；这也是同类项目最常走的路。否定理由：
分数是 0–100 的整数，取整后要 101 个类 × 2 套主题 = 202 条规则，改成连续色带就必须同时改样式表与类名生成逻辑；
而「通道写在元素上、配方写在样式表里」只多一行 CSSOM 代码，仍然保持插值与取色的单一实现。

**不改写法，只在部署后自证里加一条「线上分数必须是彩色」的检查。** 最强理由：承认这是已知的、影响面有限的缺陷，
用 `verify:deploy` 把它变成可观测的回归，比动前端代码风险低，且不必引入新的写法约定。否定理由：
自证只能证明**当前这一个**着色点有色，证明不了下一条新增的着色分支也有色；它验证不了「写法」，
而这次的分歧恰恰出在写法上。把已知缺陷写成预期，等于给下一个改前端的人留了同一个坑。

## Consequences

- 收益：详情弹窗的 IPure 分数在生产上**第一次真正带上色**；表格分数格、场景 chip、详情 hero 三个出口第一次一致。
- 收益：规则可机械判定——`frontend/` 下 `style=` 为 0 处。这条目前靠在本文与
  [IPure 色带笔记](../bug-fix/2026-09-22-ipure-score-band-coffee-tone.md) 里写明的约定，
  **没有进 `npm run check`**（那支脚本只做 `node --check` 语法检查）；要变成门禁需要在 `scripts/check_js.mjs` 加一条扫描。
- 代价：视图层的「一步渲染」被拆成两步——先插标记，再写样式。新增着色点必须记得写第二步，
  漏写不会报错，只会退回兜底灰，与本缺陷的失效形态相同（这也是为什么兜底通道要选一个能看的颜色，而不是透明的无效值）。
- 代价：CSSOM 写法要求节点先在 DOM 里。本仓库没有服务端渲染，故无影响；若将来引入 SSR 或把视图当字符串生成，
  这条约束需要重新处理。
- 未处理（相邻发现，未纳入本次改动）：`style-src` 与 `script-src` 在**本地开发环境下都不存在**，
  因此任何「拼标记样式」或「依赖内联脚本」的新代码都不会在本地报错。是否给 `scripts/dev.py` 加一层
  与生产同构的 CSP 是独立决定，本文只把写法约束定下来。

## Testing

探针页 `frontend/_csp-probe.html` + `_csp-probe.js`（临时文件，确认后已删除、未提交）：用 `<meta http-equiv="Content-Security-Policy">`
写上生产 `worker/responses.js` 发出的同一串 CSP（去掉 meta 不支持的 `frame-ancestors`），
**import 真实的 `frontend/src/views/detail-view.js` 与 `results.js`，调真实的 `createDetailView(...).renderDetails(result)`**，
用 `getComputedStyle` 读回计算值。四组对照：

| 组 | 写法 | 期望 | 实测（浅色） |
| --- | --- | --- | --- |
| 对照组 A | `innerHTML` 里拼 `style="color: rgb(179,32,89); …"`（改前的 detail-view 写法） | 被拦 | `rgb(85, 99, 114)` = 兜底通道 |
| 对照组 B | `innerHTML` 里拼 `style="--sc-l: 179 32 89; …"`（只写通道的标记写法） | 被拦 | `rgb(85, 99, 114)` |
| 对照组 C | 进 DOM 后用 `style.cssText = ipureScoreInlineStyle(96)`（现在的写法） | 生效 | `rgb(30, 109, 82)` |
| 对照组 D | 进 DOM 后 `style.cssText = "color: rgb(179,32,89); …"`（CSSOM 写完整颜色） | 生效 | `rgb(179, 32, 89)` |

A 组是 0 处残留 `style` 的关键反证：标记里写的颜色**和标记里写的自定义属性**都被丢弃，
退化成 `.score-band` 的兜底通道——即 A/B 组的灰不是「没写」，而是写上去又被删掉了。

真实 detail 视图的 7 个 `data-ipure-score` 节点全部拿到颜色：

| 分数 | 浅色计算值 | 深色计算值 |
| --- | --- | --- |
| hero 96 / chip 96 | `rgb(30, 109, 82)` | `rgb(55, 179, 136)` |
| `-1`（受限） | `rgb(85, 99, 114)` | `rgb(147, 163, 179)` |
| 88 | `rgb(38, 109, 59)` | — |
| 61 | `rgb(91, 100, 23)` | — |
| 34 | `rgb(152, 71, 23)` | — |
| 8 | `rgb(176, 41, 68)` | — |

深色一列是在节点已经渲染完之后只改 `documentElement.dataset.theme` 读到的，**没有重渲染**——
证明主题分发确实落在 CSS 而不是内联样式上。同屏对照：Coffee 92 → `rgb(29, 122, 58)`、
Coffee 8 → `rgb(161, 49, 49)`、`.score-none` 的「—」浅色 `rgb(106, 114, 124)` / 深色 `rgb(139, 148, 158)`。

探针经 `file://` 加载，`meta` CSP 对该来源下 `style-src` 的拦截已由 A/B 组自证生效；生产是真实响应头加在
`https://` 响应上，约束只强不弱。`npm test`（`node --check`）在同一次改动里通过。

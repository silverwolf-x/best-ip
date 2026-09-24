# Agent Note: 把前端约定变成机器门禁——scripts/check_frontend_contracts.mjs 的四条断言

Status: implemented

## Problem

[生产 CSP 只认 CSSOM](../architecture/2026-09-22-frontend-csp-blocks-markup-styles.md) 那篇笔记已经写明了一条硬约定：`frontend-next/` 的源码里不得出现标记形式的 `style=` 属性。但它当时只是**约定**——笔记里自己记了缺口：「这条目前靠在本文与 IPure 色带笔记里写明的约定，**没有进 `npm run check`**（那支脚本只做 `node --check` 语法检查）」。

同一类「只写在笔记与源码注释里、靠人记住」的约定还有三条：`index.html` 的 `<thead>` 区间内零控件（单视图设计的硬要求）、`index.html` 无内联 `<script>`（`script-src 'self'`）、出网请求必须有超时（不允许裸 `fetch(`，见 [前端出网超时契约](../architecture/2026-09-24-frontend-outbound-timeout-contract.md)）。

这些约定被违反时的共同表现是**不报错**：标记里的 `style` 属性被浏览器静默丢弃（元素退回样式表兜底色）、内联脚本被拦（功能消失但页面照常渲染）、裸 `fetch` 挂住（promise 永不 settle，页面永久停在加载中）。也就是说，靠人记住是不够的——记忆的失败模式恰好与缺陷的失效模式一样安静。

## Decision

新增 `scripts/check_frontend_contracts.mjs`，四条契约断言，接进 `npm run check`：

```json
"check": "node scripts/check_js.mjs && node scripts/check_frontend_contracts.mjs && node frontend-next/tools/mhtml-roundtrip.mjs"
```

`ci.yml` 与 `worker.yml` 本来就跑 `npm run check`，所以这四条自动进 CI 与发布前置（两条 workflow 里的步骤名同步改成 `Check JavaScript syntax, frontend contracts and mhtml roundtrip`，并在注释里说明「新断言接在 check 里，不必在这里逐条罗列」）。失败输出统一是 `文件:行号 — 违反了哪条 — 怎么修`，任何一条命中即以非 0 退出；全绿时逐条打印 `PASS 契约 x：…`。

**契约 a：标记形式的 `style=` 属性。**

- 扫描范围 = `frontend-next/index.html` + `frontend-next/app/`、`export/`、`tools/` 下所有 `.js` / `.cjs` / `.mjs`（`listScripts()` 递归，新文件自动纳入、不靠手工登记）。当前实测 18 个源码文件。
- 正则 `/` + `(?<![\w$.-])style\s*=\s*(?=["'`]|\$\{)` + `/gu`，能抓 `style="…"` / `style='…'` / 模板串里拼出来的 `style=${…}`。
- **实际边界**（脚本注释里自己列了，宁窄勿宽）：负向断言排掉前面是标识符字符 / `.` / `$` / `-` 的情况，于是 `element.style.width = …`、`element.style = …`、`data-style="…"` 都不算（CSSOM 赋值是本地与线上唯一合法的着色通道，见 `app/render.js` 的 `applyScoreStyles`）；赋值号后面必须紧跟引号或 `${`，所以注释/文档里「不要写 style 属性」这种提及不匹配。**已知未覆盖**：`setAttribute("style", …)` 单独成句时不匹配（当前 `app/` 下所有 `setAttribute` 都用于 `aria-*` / svg 属性）；无引号的 `style=width:1px` 也不在射程内（HTML 里合法、但当前代码没有，要不要收进来是另一个决定）。
- 扫描前用 `maskComments()` 把注释内容替换成等长空格（行号列号不变）。这是**有意保守**的近似：`//` 只有出现在行首或空白之后才算行注释、未配对的 `/*` 整段按代码处理、字符串状态与模板串的 `${}` 嵌套不解析——最坏结果是漏报一处，不会凭空造出违规。

**契约 b：`index.html` 的 `<thead>…</thead>` 区间内不得出现 `input` / `select` / `button`。** 正则为 `/<(?:input|select|button)\b/giu`，只在这个区间里匹配。取的是第一个 `<thead\b` 与它之后的第一个 `</thead>`；**两者缺一时打印 `SKIP` 并按通过处理**（如实说明这条断言当时没有对象，不假装检查过，也不因为「找不到」就变红）。

**契约 c：`index.html` 的每个 `<script>` 都必须带 `src`。** 匹配所有 `<script\b[^>]*>` 开标签，没有 `\bsrc\s*=` 就报。快照（`app/snapshot.js` 生成的离线文件）**不受这条约束**——它不带 CSP，是另一条通路，它自己的脚本内联策略见 [离线 .mhtml 不再内联 copy.js](../simplification/2026-09-24-offline-mhtml-drops-copyjs-inline.md)。

**契约 d：`frontend-next/app/` 下除 `app/net.js` 外不得出现裸 `fetch(`。** 正则 `(?<![\w$])fetch\s*\(`。实际边界：注入式的 `fetchImpl(…)` / 把 `fetch` 当参数传不被判违规（`app/` 里绝大多数调用点都是注入形态）；必须紧跟 `(`，所以 `fetchWithTimeout(…)`、`fetchText(…)` 这类名字不匹配；反过来 `.fetch(` / `globalThis.fetch(` **会被抓到**（前面不是标识符字符），那同样是绕过封装的网络调用，应当红。范围只到 `app/`（构建/测试脚本不在契约里）。落地时 `app/snapshot.js` 的 `fetchText()` 已经从裸 `fetch(url, …)` 改成 `fetchWithTimeout(globalThis.fetch, …)`，于是原先按「按行内容登记一条带理由的例外」的设计整条删掉了——门禁宁可窄，也不要为了一处已经修好的写法留长期后门。

职责边界写在文件头，刻意保持分工：语法 = `scripts/check_js.mjs`（对 `frontend/`、`frontend-next/`、`worker/`、`scripts/` 逐个 `node --check`）、**合同 = 本脚本**、序列化往返 = `frontend-next/tools/mhtml-roundtrip.mjs`。

## Alternatives considered

**只加自证（部署后检查线上确实有色 / 脚本确实生效），不加源码断言。** 最强理由：不引入源码扫描、不动 `npm run check`，直接验证用户真正看得见的结果——「线上分数是彩色」「线上没有 404 脚本」是最终事实，而源码正则永远只是代理；而且这条方案的既有论证已经在 CSP 笔记里写过。否定原因沿用那篇的原话：自证只能证明**当前这一个**着色点有色，证明不了下一条新增的着色分支也有色——它验证不了「写法」，而当年的分歧恰恰出在写法上。另外三条契约里有两类根本没有「线上看着有色」这样的可观测代理（内联脚本只会让某个功能静默不工作；裸 `fetch` 只在超时那一次才现形），自证接不住它们。

**把四条断言散进 `scripts/check_js.mjs`，而不是新开脚本。** 最强理由：`check_js.mjs` 是当时 `npm run check` 唯一成员，本地与 CI 的命令完全不变，少一个文件、少一行 `package.json`，也不会有「两个检查脚本谁管什么」这个问题；20 行的脚本继续当那个"顺手就能跑"的入口。否定原因（读代码后的判断）：`check_js.mjs` 的形状是「递归列文件 → 对每个文件 `spawnSync(node, ["--check", path])`」，它的输入是**文件清单 + 语法**，输出是逐文件 `Checked …`；这四条断言的输入是**源码文本与结构**（注释抹平、行号定位、HTML 区间、正则），失败输出需要「文件:行号 + 违反了哪条 + 怎么修」，而 `node --check` 给不了行号以外的任何东西。混在一起会让「语法失败」与「契约失败」在输出里分不开（CI 日志里只看到一堆 `Checked`），也会把 `check_js.mjs` 从一个 22 行的文件清单器变成需要维护注释抹平与正则的工具。分开之后职责边界才能写进各自的文件头。

**只写进笔记与源码注释（即现状），等下次真的有人犯错再说。** 最强理由：零成本、零维护，而且不会制造「有门禁保护」的假安全感——一条宁窄勿宽的正则确实拦不住所有形态，把它当护栏反而可能让人放松警惕。否定原因：这四条约定在此之前从没有拦住过任何一次违反，因为违反的表现是静默的（CSP 丢弃不提任何错、脚本被拦只报在 console 里），人不会在做别的事情时想起它。门禁的价值在于把「记得」换成「跑得到」，而它的边界也已经写在同一条注释里。

## Consequences

收益：

- 四条写在笔记/注释里的约定第一次有机器形态，且**进 CI 与发布前置**（`npm run check` 是两条 workflow 的同一命令）；CSP 笔记里记的那个缺口就此结清。
- 新文件自动纳入扫描（`listScripts()` 递归），加文件不用登记；契约 d 的「例外」机制被整条删除，没有后门可漏。
- 失败输出是可执行的：文件名 + 行号 + 违规行为 + 怎么修（例如指向 `element.style.<prop> = …` 与 `styles.css` 里的配方）。
- 增量成本可忽略：实测 `node scripts/check_frontend_contracts.mjs` 约 61ms、`node frontend-next/tools/mhtml-roundtrip.mjs` 约 77ms（`npm run check` 整体约 2.2s，其中大部分是 `node --check` 的逐文件进程开销）。

代价：

- 正则门禁是**近似**：`setAttribute("style", …)` 与无引号 `style=…` 抓不到；契约 b/c 只看 `index.html`，契约 d 只看 `frontend-next/app/`。`PASS` 的含义是"这四条在各自射程内没有命中"，不是"整个仓库不存在这些写法"。
- `npm run check` 现在同时包含语法、合同与 MHTML 往返三类检查。任何一条红了，输出里得先分清是哪一类（三条命令用 `&&` 串联，逐个的 PASS/FAIL 行是唯一的线索）。
- 契约 b 在 `<thead>` 不存在时按通过处理（打印 `SKIP`）。这是"不假装检查过"的取舍，但结构一旦搬进 JS，这条断言会静默失去对象，只留一行 `SKIP` 在日志里。
- 注释抹平是"宁可窄不要宽"的近似实现（不解析字符串与模板串状态）。它对当前代码是安全的，但对将来的写法不保证：例如把一个真的违规写进字符串字面量（`const s = 'style="x"'`）会漏报。

## Testing

- 本轮实跑：`npm run check` 全绿，四条契约的输出为
  `PASS 契约 a：18 个源码文件里没有标记形式的 style= 属性`、
  `PASS 契约 b：frontend-next/index.html 的 <thead> 区间内没有 input/select/button`、
  `PASS 契约 c：frontend-next/index.html 的 <script> 全部带 src（无内联脚本）`、
  `PASS 契约 d：14 个 app/ 模块（除 net.js）没有裸 fetch(`，随后 `全部前端契约通过` 与 mhtml 往返的 `全部断言通过`。
- 契约 a 的正则边界与「宁窄勿宽」的取向已在脚本注释里逐条登记（见 Decision 里的边界清单）。
- **负向夹具实跑（在 `$PI_SCRATCH_DIR` 的镜像副本上做，仓库未动）**：四类违规各注入一处，四条断言逐条都命中并给出「文件:行号 + 怎么修」——`4 处前端契约违规`、exit 1（`index.html:19` 标记 style、`index.html:109` 表头内控件、`index.html:124` 内联 script、`app/api.js:252` 裸 `fetch(`）；同批放入的合法写法（`el.style.width = …`、`data-style="…"`、注释里写 `style="x"` 与 `fetch(`、注入式 `fetchImpl(…)`）**一条都没误报**，违规总数恰好 4。干净镜像则 `全部前端契约通过`、exit 0。
- 未验证（如实记）：没有在 CI 里加重负向夹具的自动化（上面那次是人工在镜像上跑的，仓库不带自测）；契约 b 在 `<thead>` 整段缺失时的 `SKIP` 分支只从代码上确认过，没有实跑。

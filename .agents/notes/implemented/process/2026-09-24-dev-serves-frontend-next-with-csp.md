# Agent Note: 本地 dev 改指 frontend-next，并发出与生产同源的 CSP

Status: implemented

## Problem

`scripts/dev.py` 有两处与线上对不上的事实：

1. **静态根指着不部署的那份前端**。本地服务器以 `ROOT_DIR / "frontend"` 为目录（旧版前端，已不部署、作为回退留在仓库里），而线上由 `wrangler.jsonc` 的 `assets.directory` 指向 `frontend-next`。于是「本地打开看着一切正常」根本不构成对线上那份源码的证据，本地窗口里跑的也不是要发布的字节。
2. **本地不发任何 CSP**。生产是 `worker/responses.js` 的 `secureResponse()` 给每个 `text/html` 响应挂上 `style-src 'self'` / `script-src 'self'`，本地静态服务器只发文件。这条差异的后果在 [生产 CSP 只认 CSSOM](../architecture/2026-09-22-frontend-csp-blocks-markup-styles.md) 里已经有过完整记录：把样式拼进标记在本地放行、线上被静默丢弃，而且本地看不出任何区别——那篇笔记的 Problem 全部建立在「只有本地无 CSP」这一条上。

## Decision

**一、静态根改指 `frontend-next`。** 新增常量 `FRONTEND_DIR_NAME = "frontend-next"`（`scripts/dev.py:29`），`_create_frontend_server()` 的 `partial(FrontendHandler, directory=…)` 改用它（`scripts/dev.py:215`）。旧 `frontend/` 目录保留不动（回退用），只是本地不再指向它。

**二、给 dev 的 `text/html` 响应挂上与 Worker 同源的 CSP。**

- `_worker_content_security_policy()`（`scripts/dev.py:36-61`）**从 `worker/responses.js` 里读出生产那串字面量**，不在 dev 侧抄第二份：以 `"Content-Security-Policy"` 为锚点，在紧随其后的 600 字符窗口里取第一个以 `default-src` 开头的字符串字面量，再断言它同时含 `connect-src` 与 `frame-ancestors 'none'` 这两个特征串。读不到（主串缺失、没有 `default-src` 字面量、或形状不像完整那串）一律 `SystemExit`，**不降级成「本地无 CSP」**：宁可 dev 起不来，也不要给一个看起来对齐、其实没对齐的本地环境。
- `_dev_content_security_policy(api_url)`（`scripts/dev.py:64-82`）把 worker 那串按 `;` 拆开，**只往 `connect-src` 追加本次真实的 apiBase origin**，其余指令逐字保留、顺序不变，再用 `; ` 拼回。
- 挂头的位置：`FrontendHandler` 覆写 `send_header()`（`scripts/dev.py:190-193`）与 `end_headers()`（`scripts/dev.py:195-199`），只有当本次响应发出的 `Content-Type` 里含 `text/html` 时才在收尾前补上 `Content-Security-Policy`。判断口径与 Worker 相同（`worker/responses.js:34` 同样是 `Content-Type?.includes("text/html")`），静态服务器不做内容协商，因此只看 `SimpleHTTPRequestHandler` 实际发出的类型。`/site-config.js` 是 `application/javascript`，不加头；`SimpleHTTPRequestHandler` 的 404 错误页用 `text/html;charset=utf-8`，因此同样带头。

本轮实测两个函数的输出（不启动后端，直接调用）：

```text
WORKER: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.blob.core.windows.net; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
DEV   : default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.blob.core.windows.net http://127.0.0.1:8000; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

`api_url` 就是写进 `/site-config.js` 的那个 `apiBase`（`scripts/dev.py:259` 生成、`scripts/dev.py:180` 注入，形如 `http://127.0.0.1:8000`），所以放开的恰好是页面真会去连的那一个 origin，不是通配符。页面在 `127.0.0.1:5173`、后端在另一个端口——端口不同就是另一个 origin，既不在 `'self'` 里，也不在生产那串 `connect-src` 里；不放行它，dev 会变成「静默坏掉」。

## 一个被翻转的决定：为什么现在接受「让本地也发 CSP」

[CSP 笔记](../architecture/2026-09-22-frontend-csp-blocks-markup-styles.md) 里有一节标题就叫「为什么不是『让本地也发 CSP』」，它的原文是：

> `scripts/dev.py` 不发 CSP 是它作为静态服务器的事实，不是遗漏：要让本地也拦，就得在 dev 侧复刻「哪些响应算 `text/html`」这条判断，等于立起第二份 CSP 真值，两份必然漂移。dev 不经过 Worker 的路由与鉴权，dev/prod 的差异本来就不止一处，逐个补齐是把 dev 变成半个 Worker。**正确的收敛方向是消掉分叉本身**：改成 CSP 下两种环境都合法的 CSSOM 写法之后，本地与线上的行为一致，dev 侧不需要任何 CSP。

这段理由**仍然是这条做法最强的反对意见**（下面 Alternatives 里按原意保留），本轮翻转的三个依据是：

1. **「第二份真值」这个主要风险已经不成立**：dev 侧不硬编码，而是运行期从 `worker/responses.js` 读同一串字面量；读不到就 `SystemExit`。原来担心的"两份必然漂移"的前提是"抄一份"，现在抄写这一步根本不存在——dev 与 prod 的差值只剩一处有意为之的 `connect-src` 追加。
2. **「消掉写法分叉」这件事本身已经落地**，而且是另一条独立的路：源码门禁（`scripts/check_frontend_contracts.mjs` 的契约 a / c / d，见 [前端契约门禁进 npm run check](2026-09-24-frontend-contract-gates-in-check.md)）把「标记里不出现 `style=`」「index.html 无内联脚本」「出网必有超时」变成机器检查。也就是说，本地 CSP 不是主要防线，而是**运行期兜底**。
3. **兜底能抓到源码扫描抓不到的东西**：门禁是宁窄勿宽的正则（脚本注释自己登记了 `setAttribute("style", …)`、无引号 `style=…` 抓不到），CSP 是浏览器实施的硬约束，对"任何进入标记的样式"一体生效——包括运行时注入的 `<style>`、`setAttribute` 写进去的样式、以及将来任何绕过正则的写法。两道防线管同一个不变量的两个面：门禁管「源码里没有这种写法」，CSP 管「就算进了标记也不会生效」。

## Alternatives considered

**维持现状：本地不发 CSP，只靠源码门禁守着写法。** 最强理由就是上面引用的那段原文：少一份运行期配置、dev 保持「纯静态服务器」这个简单事实、启动路径上没有新的失败可能；而且写法分叉已经由门禁消除，"本地看不出差异"这个具体误导已经被机械检查接住，CSP 在这里是重复防线。否定原因：门禁是正则近似（边界写在它自己的注释里），而 CSP 是硬约束；只留门禁等于把"能不能着色/脚本能不能跑"全押在一个宁窄勿宽的正则上，而它自己声明了两种漏报形态。另外门禁只覆盖 `frontend-next/index.html` 与 `app/` / `export/` / `tools/`，本地 CSP 覆盖的是运行时真正发生的事。

**在 dev 侧硬编码一份 CSP 字面量（或只抄指令清单）。** 最强理由：最简单、零解析、零失败路径——dev.py 不去读另一个模块的源文件，启动更快也更少惊喜，而且读一眼就能看到本地到底发什么。否定原因：这正是旧理由担心的"第二份真值"。worker 那边以后加一个 `connect-src` 主机（这一族改动在 CSP 笔记与在线只读通路里都发生过）本地不会跟着变，漂移的表现恰好是"本地看着正常、线上样式或请求被静默拦掉"——也就是本轮要消掉的那个分叉换了个位置。运行期读同一份字面量是这次翻转能成立的前提，不是实现细节。

**只把静态根改指 `frontend-next`，CSP 的事留到下次、仍由门禁负责。** 最强理由：两件事可以分开做，静态根那一半风险几乎为零、收益明显（本地窗口里跑的就是线上那份源码）；CSP 那一半有失败路径（读不到就起不来）与"dev 不再是纯静态服务器"的代价，可以等一个更合适的时机。否定原因：静态根改完之后，分叉反而更刺眼——本地正在跑的就是要上线的那份源码，此时"本地一切正常、线上样式被丢"就只剩本地不发 CSP 这一个解释不清的地方，而这正好是最容易被误读成"线上坏了"的位置（CSP 笔记里详情弹窗从第一天起就没上色就是这么活了很久的）。两件事一起做，分叉才算真的消掉。

## Consequences

收益：

- 本地静态根等于线上部署的那份源码（`frontend-next/`），"本地正常"第一次是对要发布的字节取证。
- 本地就能观察到 CSP 造成的失效：标记里的 `style` 属性在本地也被丢弃、内联脚本在本地也被拦——以前这只在线上成立，本地"怎么看都是对的"。同一份源码在两个环境的约束于是同构。
- CSP 真值仍只有一份（`worker/responses.js`）：worker 改了指令，dev 自动跟着改；读不到就起不来而不是悄悄少一条头。
- 这四条前端约定同时有了源码门禁与运行期 CSP 两道防线，各自的盲区互补（见上）。

代价：

- dev 不再是"纯静态服务器"：它多了一条响应头，并多了一条启动时的失败路径（`worker/responses.js` 被改名/改结构 → `SystemExit`，报错信息指向 `scripts/dev.py`）。这是有意选的响亮失败。
- dev 与 prod 的 CSP **不完全逐字相同**：`connect-src` 多一个本地 API origin。这是让本地页面仍能连本机后端的最小放开（放开的是 `site-config.js` 里那个真实 `apiBase`，不是通配符），但严格说它是一处有意差异——逐字节比对两份响应头的人会看到它。
- 解析方式很朴素（锚点 + 600 字符窗口 + 正则取第一个 `default-src` 字面量，不解析 JS）：`worker/responses.js` 的写法一变（把 CSP 挪走、或在那窗口里再放一个 CSP 字面量），就可能读不到或读到别的那一个。读不到会因此变成 dev 起不来（响亮），读到别的那一个则表现为"dev CSP 不是生产那串，需要人看一眼"——这一步没有断言能挡住，只靠 `_worker_content_security_policy()` 里的两个特征串（`connect-src`、`frame-ancestors 'none'`）做最低限度的形状校验。
- 本地看到的内联脚本被拦，可能让人误以为"页面坏了"而不是"写法违规"：CSP 报错只出现在浏览器 console 里，页面本身照常渲染。

## Testing

- 本轮实测（不启动后端）：`uv run --no-dev python` 直接 `importlib` 加载 `scripts/dev.py` 并调用 `_worker_content_security_policy()` / `_dev_content_security_policy("http://127.0.0.1:8000")`，逐指令比对，唯一差异是 `connect-src` 末尾多了 `http://127.0.0.1:8000`（完整输出见 Decision）。
- 生产那串的出处：`worker/responses.js:34-41`（只有 `Content-Type` 含 `text/html` 才挂），字面量在第 39 行。
- `npm run check` 全绿（含前端契约门禁与 MHTML 往返）。
- 未验证（如实记）：没有起真实 dev 服务器用浏览器读回响应头确认 `index.html` 拿到了这一串 CSP，也没有验证 404 错误页带头这一条（两条都只在代码层面确认：`send_header` 只看 `Content-Type`，`SimpleHTTPRequestHandler` 的错误页用 `text/html;charset=utf-8`）。

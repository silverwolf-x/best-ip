# Agent Note: frontend-next 的出网超时契约收敛到 app/net.js

Status: implemented

## Problem

`frontend-next/app/` 里每个文件自己管自己的出网超时，三处的写法是同一条表达式：

```js
typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
  ? AbortSignal.timeout(ms)
  : undefined
```

`app/scan.js` 与 `app/gateway.js` 各有一个**逐字相同**的同名函数 `timeoutSignal(ms)`，`app/api.js` 把它内联在 `fetchExport()` 的 `init` 里（没有函数名，同一个表达式第三份）。

这个表达式在缺少 `AbortSignal.timeout` 的环境里返回 `undefined`，于是 `signal` 参数等于没传——**超时静默消失**。它正好与这三个文件头注释里反复写的那句话相反：没有超时的话，后端/Worker 卡住时 promise 永不 settle，页面永久停在加载中，既没有报错也没有重试入口。同一段理由被抄了三遍，缺陷也被抄了三遍（合并成模块之后，这类漂移才第一次可以被"数出来"：三份代码里两份同名、一份内联）。

另有一处相邻缺口：取加密公钥的那次请求（`app/scan-crypto.js` 的 `importPublicKey()` 里 `fetchImpl(url, { cache: "no-store" })`）**原来完全没有超时**。它挂住时页面停在「正在加密订阅地址并交给扫描网关…」，此时一个可以点的按钮都没有（扫描会话还没建立，连「停止」都没有对象）。`app/scan-crypto.js` 与旧前端的 `frontend/src/crypto.js` 是人工同步的副本，本轮不改它。

## Decision

新增 `frontend-next/app/net.js`，作为 frontend-next 唯一的出网封装：所有出网请求要么走它的 `fetchWithTimeout()`，要么用 `timeoutPair()` 自己拿信号并在 `finally` 里 `release()`。

四个导出（`app/net.js`）：

- `DEFAULT_TIMEOUT_MS = 15_000`。取值偏宽松：这几条请求里最慢的是拉签名产物地址，快就在几百毫秒内返回，慢就是 Worker 那边卡住了——15 秒足以区分两种情况，又不至于让人以为页面坏了。
- `timeoutPair(ms = DEFAULT_TIMEOUT_MS)` → `{ signal, release }`。`AbortSignal.timeout` 可用时直接给平台的 signal，`release` 是空函数；不可用时**退化成 `AbortController` + `setTimeout`**（`controller.abort(timeoutReason(ms))`，`app/net.js:57`），`release` 清掉那个定时器；连 `AbortController` 都没有的环境返回空信号 + 空 `release`，按「没有取消能力」继续跑，而不是假装有超时。
- `timeoutReason(ms)`（`app/net.js:76-82`，模块内私有）：退化路径中止请求时用的 reason，**`name` 必须是 `TimeoutError`**——优先 `new DOMException("请求超过 N 毫秒未返回", "TimeoutError")`，拿不到 `DOMException` 时退回手改 `name` 的 `Error`。理由见下面的「退化路径的 reason」。
- `isTimeoutError(error)`：`name` 为 `TimeoutError` 或 `AbortError`。调用方用它决定文案（「N 秒内没有返回」而不是「连不上」/「读不到」）。
- `fetchWithTimeout(fetchImpl, input, init = {}, ms = DEFAULT_TIMEOUT_MS)`：`init` 里的 `signal` 会被超时信号**覆盖**。需要同时保留调用方取消权时不要用这个函数，改用 `timeoutPair()` 自己拼 `init`。

为什么 `timeoutPair()` 不返回裸 signal 而是返回一对：退化分支用的是 `setTimeout`，平台不持有它，不清掉就会在最坏情况下拖着整个页面（导出、扫描轮询这类一秒多次的路径上更明显）。**调用方必须在 `finally` 里 `release()`**，把清理义务写进返回值是让它不容易被忘掉的唯一手段。

调用点（本轮全部改完）：

- `app/gateway.js`：`fetchLatestState()`（`LATEST_TIMEOUT_MS = 30_000`）与 `downloadArtifact()`（`ARTIFACT_TIMEOUT_MS = 30_000`）都改走 `fetchWithTimeout()`；两处 catch 里的 `cause.name === "TimeoutError" || "AbortError"` 手写判断换成 `isTimeoutError()`。
- `app/api.js`：`fetchExport()`（`EXPORT_TIMEOUT_MS = 15_000`）改走 `fetchWithTimeout()`，catch 里的同样判断换成 `isTimeoutError()`。这一条超时不能省：没有它的话，后端活着但导出卡住时 promise 永不 settle。
- `app/scan.js`：`requestJson()` 用 `timeoutPair(timeout)` + `finally { release(); }`（它的 `init` 要自己拼，`headers`/`body`/`cache` 都在里面，所以不用 `fetchWithTimeout()`）。
- `app/scan.js` 的注入点 `withPublicKeyTimeout(fetchImpl)`：给交给 `encryptSubscriptionUrl()` 的 `fetchImpl` 套一层 `fetchWithTimeout(…, PUBLIC_KEY_TIMEOUT_MS = 15_000)`。取公钥打的是本站同源的一份约 1KB PEM，与别的请求同量级，但只有这一步需要单独收口——`scan-crypto.js` 自己只会为「没配 / 格式无效 / 指纹不符」给文案，它那条请求没有超时，所以超时错误要在 `startScan()` 里翻译成 `failure("public_key_timeout", "GitHub Actions 加密公钥 15 秒内没有返回", { retryable: true })`。
- `app/snapshot.js` 的 `fetchText()`：导出时读同源的 `styles.css` / `copy.js`，原先也是裸 `fetch(url, { cache: "no-store" })`；现在走 `fetchWithTimeout(globalThis.fetch, …)`，超时与「读不到」分开说（见 [离线快照拼装层三处转义缺口](../bug-fix/2026-09-24-snapshot-escape-double-escaping.md) 那篇里 `isTimeoutFailure()` 的落地）。

### 退化路径的 reason（这是本轮修掉的一条缺陷）

**要求：退化分支 `controller.abort()` 的 reason，`name` 必须是 `TimeoutError`。** 实现就是 `timeoutReason(ms)`：能拿到 `DOMException` 就 `new DOMException("请求超过 N 毫秒未返回", "TimeoutError")`，拿不到就退回一个手改 `name` 的 `Error`——**不交出一个 `isTimeoutError()` 认不出来的错误**。

这条一开始写的是 `controller.abort(new Error("请求超过 N 毫秒未返回"))`，是缺陷：`new Error(...)` 的 `name` 是 `"Error"`，而 `isTimeoutError()` 认的是 `name`。后果不是「超时没发生」（超时照常发生、请求照常被中止），而是**退化环境里的超时被下游说成另一种故障**：

- `app/gateway.js:126` 的兜底分支说「读不到本站的扫描网关（Error）」（`reasonOf(cause)` 取的就是 `name`），`app/api.js` 说「连不上本地扫描服务 …：请先启动 backend（npm run dev）」——后者是**错误的下一步动作**，用户去重启后端也不会好；`app/scan.js:118` 说「连不上本站的扫描网关（Error）」。
- `app/scan.js` 的轮询路径（`main.js:717` 的 `error.retryable !== true` 判据）会把这次超时当成 `gateway_unreachable` 继续退避重试，于是进度行一直显示「读取扫描状态失败，正在重试：连不上本站的扫描网关（Error）」，而正确分类（`gateway_timeout`）说的是「30 秒内没有响应」——两者的成因与用户该做的事完全不同。
- `app/snapshot.js` 当时只能自己补一条消息匹配来绕开它（`isTimeoutFailure()` = `isTimeoutError(error) || /毫秒未返回/u.test(error?.message)`，`app/snapshot.js:61`）。**修完之后这条兜底对 net.js 的错误已不再必要**（`isTimeoutError()` 在退化路径上也命中）；它的注释仍描述着旧的 reason 形状，属于遗留措辞，改动风险为零但需要在下次动那个文件时顺手清掉。

为什么不用「在调用点补消息匹配」当通用解：那等于把「怎么认超时」变成每个调用点各一份正则——正是本轮把三份 `timeoutSignal` 收敛成 `app/net.js` 要消掉的那种漂移。判据只能有一条：超时的错误，`name` 就是 `TimeoutError`。

## 谁来保证新调用点也走这里

裸 `fetch(` 由 `scripts/check_frontend_contracts.mjs` 的**契约 d** 把关：`frontend-next/app/` 下除 `app/net.js` 外不允许出现裸 `fetch(`，随 `npm run check` 进 CI 与发布前置。所以「加一个请求就是加一处超时」这条不只是注释里的承诺，写错了会红。门禁本身的范围与边界见 [前端契约门禁进 npm run check](../process/2026-09-24-frontend-contract-gates-in-check.md)。

## Alternatives considered

**继续在每个调用点各写一份 `timeoutSignal`。** 最强理由：改动最小，不需要新模块、不引入 `release()` 这种「调用方必须记得清理」的新协议；三份里当时有两份逐字相同，看起来就是无成本的复制，而且每个文件自带一份还能让文件自己读得完整。否定原因：退化的那个分支是从同一份源里复制出来的，**缺陷会继续被复制**；而且三份已经实际漂移了形态（`scan.js` / `gateway.js` 各有同名函数，`api.js` 内联在 `init` 里），"哪几处有超时"这件事没有任何地方可以数一遍。

**用 `AbortSignal.any()` 合并调用方的 signal 与超时 signal。** 最强理由：一次拿到「调用方取消 + 超时」两个来源，不必要求每个调用方自己管 `release()`，也不会出现「`fetchWithTimeout` 覆盖 `init.signal`」这个必须靠注释提醒的语义。否定原因：`AbortSignal.any()` 在本项目要照顾的浏览器里覆盖不足。需要取消权的地方（例如停止扫描）由调用方自己持有 controller，把它的 signal 当 `fetchImpl` 的一部分传进来即可（`scan.js` 就是这么做的）。

**只加超时、不收敛实现。** 最强理由：本轮真正的问题只有「取公钥那次没超时」，补上它就够；把三份已经在生产里跑过的实现搬来搬去是纯重构，功能增量为零，却带来回归面（三个文件的 catch 分支、`init` 拼装、信号语义全都要重新对一遍）。否定原因：三份漂移已经实际发生，退化分支的缺陷在三份里各有一份——不收敛就意味着这个缺陷继续以「三份」为单位存在，而下次再加一条出网请求时，人是照着最近一份抄的。

## Consequences

收益：

- 超时在缺 `AbortSignal.timeout` 的环境里不再静默消失（退化成 `AbortController` + `setTimeout`），也不会因为没有 `AbortController` 而假装有超时。
- 一处实现同时覆盖 scan / gateway / api 三条通路的全部出网点；超时上限集中可见（15s / 30s / 30s），改一处就是改全部。
- 取公钥那次从「完全没有超时」变成 15 秒上限，失败文案是「GitHub Actions 加密公钥 15 秒内没有返回」且可重试；导出时读 `styles.css` / `copy.js` 也一样。
- 「超时」与「失败」在文案与重试判据上共用同一条线（单判据 `isTimeoutError()`）：超时告诉用户等一会儿再试，连不上/读不到告诉他去启动 backend 或换浏览器——而且这条判据在原生与退化两条路径上都成立，两种说法不会互相冒充。
- 语义边界被写下来了：`fetchWithTimeout()` 覆盖 `init.signal`，需要保留调用方取消权就走 `timeoutPair()`——这条以前是隐性知识。
- 新调用点有门禁兜底（契约 d），不是靠人记得。

代价：

- 多了一条调用方必须遵守的协议：`release()` 必须在 `finally` 里调用。漏了不会报错，只会在退化分支留下一个 `setTimeout`（最坏拖着页面）。这是为「不返回裸 signal」付的价。
- `signal` 仍可能是 `undefined`（连 `AbortController` 都没有的环境；本项目不打算支持），那种环境里超时依然不存在——只是这次是明说的，不再伪装成「已设置超时」。
- **已修（本轮）**：`isTimeoutError()` 一开始在退化分支上认不出超时（reason 是普通 `Error`），现在 `timeoutReason(ms)` 让 `name` 就是 `TimeoutError`，退化路径与原生路径都能命中；见 Decision 的「退化路径的 reason」。
- 门禁只保证「不是裸 `fetch(`」，保证不了「上限选得对」；范围也只到 `frontend-next/app/`（构建/测试脚本不在射程内，例如 `app/snapshot.js` 之外的 `tools/` 脚本仍可裸用 `fetch`）。

## Testing

- 门禁：`npm run check` 全绿，其中 `scripts/check_frontend_contracts.mjs` 的契约 d 报 `PASS 契约 d：14 个 app/ 模块（除 net.js）没有裸 fetch(`。
- 代码级核对（本轮）：`grep -n "fetchWithTimeout\|timeoutPair\|isTimeoutError\|timeoutSignal" frontend-next/app/*.js frontend-next/app/artifact/*.js` 命中只剩 `net.js` 的四处定义、各调用方的 import 与六个出网调用点（`api.js` 1、`gateway.js` 2、`scan.js` 2、`snapshot.js` 1），`timeoutSignal` 已无命中。
- 未验证（如实记）：退化分支（`AbortSignal.timeout` 不可用）没有在真实旧浏览器里跑过——`timeoutReason()` 让 `isTimeoutError()` 在退化路径上命中的这条，是从代码（`name` 的赋值）读出来的，没有在缺 `AbortSignal.timeout` 的环境里实跑取证。

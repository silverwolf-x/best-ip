# Agent Note: 两条网关通路的失败对象与状态码文案收成 app/failure.js

Status: implemented

## Problem

`frontend-next/app/` 里两条出网通路各自维护一份**同形**的失败工厂与一张**几乎逐字相同**的状态码文案表：

- `app/scan.js` 的 `failure(code, message, { retryable, title })`：`Object.assign(new Error(message), { code })`，`error.retryable = retryable === true`，可选 `title`。**不接收 `cause`**。
- `app/gateway.js` 的 `error(code, message, cause, title)`：`Object.assign(new Error(message, cause ? { cause } : undefined), { code })`，可选 `title`。**不设 `retryable`**，`cause` 是按位置传的。

两个名字、两种参数形状、同一个语义。文案表更明显，401 / 403 / 503 三句两边各抄一份，只差一两个词：

| 状态 | `scan.js` 的 `httpMessage()`（改前） | `gateway.js` 的 `httpTextFor()`（改前） |
| --- | --- | --- |
| 401 | 登录已过期：请重新用访问密码登录本站**后再发起扫描**。 | 登录已过期：请重新用访问密码登录本站**。** |
| 403 | 本站拒绝了这次**请求**（403）：会话与请求来源不匹配。 | 本站拒绝了这次**读取**（403）：会话与请求来源不匹配。 |
| 503 | 本站的扫描网关尚未配置完成（503）**：缺少 GitHub Actions 相关的密钥**。 | 本站的扫描网关尚未配置完成（503）**。** |
| 兜底 | 扫描网关返回 HTTP N | 本站的扫描网关返回 HTTP N |

代价不是代码重复，而是**同一个故障在两条路上说得不一样**：改文案时只改一处，就会留下「同一个 403 在发起扫描与读取最近一次扫描时措辞不同」这种不一致，而错误文案是用户在这个页面上唯一能看到的诊断信息。

## Decision

新建 `frontend-next/app/failure.js`（唯一真源），`app/scan.js` 与 `app/gateway.js` 都 `import { failure, gatewayStatusText } from "./failure.js"`（两条通路各自只保留自己独有的那几张状态码）。

**一、失败对象只有一个工厂。**

```js
failure(code, message, { cause = null, retryable, title } = {})
```

- `code` 是机器可读的失败码，挂在 `error.code` 上。`main.js` 只在一处读它：`main.js:719` 的 `keepSession = error.code === "cancel_timeout" || error.code === "scan_deadline"`（这两种情形任务可能还在后台跑，会话必须留着让用户能按「停止」）。其余 code 值只用于诊断与人读。`app/gateway.js` 用到的：`artifact_url_invalid` / `gateway_timeout` / `gateway_unreachable` / `gateway_http` / `gateway_json` / `gateway_shape` / `gateway_status` / `artifact_timeout` / `artifact_blocked` / `artifact_http` / `artifact_truncated` / `artifact_too_large` / `artifact_invalid` / `no_fetch`，其中 `gateway_status` 与上游写明的状态名（`app/gateway.js:142` 直接把 `payload.status` 当 code）共用同一条路径。`app/scan.js` 用到的：`subscription_url_invalid` / `gateway_timeout` / `gateway_unreachable` / `gateway_json` / `run_identity_invalid` / `run_identity_mismatch` / `cancel_timeout` / `scan_deadline` / `no_fetch` / `public_key_timeout` / `start_shape`，以及 HTTP 失败时的 `http_${status}`（服务端给了 `error` 字段就用它，否则用状态码，`app/scan.js:134`）。
- `cause` **为空时不传第二个参数**（`Object.assign(new Error(message, cause ? { cause } : undefined), { code })`，`app/failure.js:27`）：显式传 `{ cause: undefined }` 会让错误多出一个值为 `undefined` 的自有属性，与原先"只有 `gateway.js` 才带 `cause`"的行为对不上。
- `retryable = retryable === true`（默认不给重试余地，由调用点判断）——这一条来自 `scan.js` 的原实现，判据仍然是「只有明确的瞬时故障才留重试余地」：`app/scan.js:118`（`gateway_unreachable`）与 `app/scan.js:142`（200 却不是 JSON）给 `true`，`app/scan.js:137` 按 `status >= 500 || status === 429` 给；唯一读它的地方是轮询路径 `main.js:717` 的 `error.retryable !== true`。
- `title` 是空状态标题，仍然是可选字段（`app/gateway.js:142` 那处把 `statusReport()` 得到的标题挂上去）。

**二、状态码文案只有一张表，两条路的差异当参数传。**

```js
const STATUS_TEXT = {
  401: ({ sessionTail }) => `登录已过期：请重新用访问密码登录本站${sessionTail}。`,
  403: ({ action }) => `本站拒绝了这次${action}（403）：会话与请求来源不匹配。`,
  503: ({ detail }) => `本站的扫描网关尚未配置完成（503）${detail}。`,
};
export function gatewayStatusText(status, voice) {
  const template = STATUS_TEXT[status];
  return template ? template(voice) : voice.fallback(status);
}
```

`voice` 是调用方自己的说法，四个字段：`sessionTail`（401 那句的后缀）、`action`（403 那句里「这一次动作」的叫法）、`detail`（503 那句要不要补原因）、`fallback`（表里没有的状态码的兜底句，**两条路的兜底句本来就不同**，所以它必须是函数而不是字符串）。

两条路各自的 `voice`（与改前的文案逐字一致）：

| | `scan.js` 的 `httpMessage()`（`app/scan.js:148-159`） | `gateway.js` 的 `httpTextFor()`（`app/gateway.js:99-106`） |
| --- | --- | --- |
| `sessionTail` | `"后再发起扫描"` | `""` |
| `action` | `"请求"` | `"读取"` |
| `detail` | `"：缺少 GitHub Actions 相关的密钥"` | `""` |
| `fallback` | `` `扫描网关返回 HTTP ${value}` `` | `` `本站的扫描网关返回 HTTP ${value}` `` |

**为什么这些差异必须当参数传，而不是把文案统一成一句**：它们是**用户可见文案**，统一等于改变行为。401 那条后缀回答的是「登录之后要做什么」（重新登录后要不要再发起一次扫描）；403 里的「请求 / 读取」是这次动作的名字（读取根本没有发起任何动作，说「请求」会让用户以为自己做错了什么）；503 的 `detail` 只在发起扫描那条路上成立（读取那条路没发起任何动作，说「缺少密钥」等于给一个他没做的操作解释原因）；兜底句的差别更直接——一条说自己是在**通过扫描网关**做事，另一条说自己也**是**那个扫描网关的客户端。把这些合并成一句话，代价是抹掉上下文，收益只是少四个字符串。

`scan.js` 里那张表未覆盖的状态码留在本文件：404 `本站不认识这个扫描任务（404）。`、409 `这次扫描的状态与请求对不上（409）。`、413 `加密后的订阅地址超过本站上限（413）。`、429 `本站正在限流（429）：稍等一会儿再发起扫描。`——它们是扫描路独有的，`gateway.js` 没有对应概念。

配套的同类收敛见 [frontend-next 的出网超时契约收敛到 app/net.js](2026-09-24-frontend-outbound-timeout-contract.md)：那边收敛的是超时信号与 `isTimeoutError()`，两篇合起来是「scan / gateway 两条路的共用机制各自只有一份实现」。

## Alternatives considered

**把 401 / 403 / 503 的文案统一成一句，不再区分两条路。** 最强理由：这是真正的「唯一真源」——表里三个函数都不需要参数，`gatewayStatusText(status)` 就够了，调用方各传一个 `voice` 对象本身就说明差异还在（只是从代码里搬到了调用参数里）；同一个故障在页面上的说法完全一致，也不会有「以后新人给某一条路加个后缀、另一条忘了」的机会。否定原因：这四条差异都是**用户可见文案**，统一就是改行为——403 说「请求」在读取路径上是错的（用户什么都没请求），503 补「缺少 GitHub Actions 密钥」在读取路径上是给一个没发生的动作解释原因，401 丢掉「后再发起扫描」会让用户以为重新登录就够了（他真正要重做的那步是重新发起扫描）。收敛的对象是**机制**（怎么造错误、怎么按状态码取文案），不是用户能读到的那几句话；把后者也收敛，等于用一次不可见的措辞变化换掉「改动应该可验证」这条性质。

**把工厂留在 `scan.js` 里，让 `gateway.js` import 它（或反过来）。** 最强理由：一步到位、零新文件，`npm run check` 的文件清单不变，也不用决定这个模块该叫什么、归在哪一类模块里；两条路里总有一条是"先写出来的"，另一条复用它看起来是自然的。否定原因（读代码后的判断）：现成的依赖方向是 `scan.js → gateway.js`（`app/scan.js:27` 的 `import { readArtifactFrom, artifactUrlOf } from "./gateway.js"`），让 `gateway.js` 去 import `scan.js` 会造出循环依赖；反过来把 `failure()` 放进 `gateway.js`，等于让"失败对象工厂"这个两条路共用的东西挂在其中一条路的模块名下——将来 `gateway.js` 被替换或拆开时，另一条路的错误形状会跟着被动。共用的机制放在双方都依赖的第三个小模块里，依赖方向是单向的、名字也说明了它是什么。

**两个函数各自保留，只在 `failure.js` 里放文案表（或反之）。** 最强理由：只收敛其中一半、改动面最小——文案不一致是用户能看见的（值得修），而两个同形工厂只是"看起来重复"（参数形状不同，合并时反而要处理 `cause` 按位置传与 `retryable` 只有一边有的差异），不动它们可以完全避免"改错一条路的错误对象形状"这类风险。否定原因：两件事的代价是同一个——"同一个语义有两份实现，改一处就漂"。只收敛文案表，等于承认工厂可以有两份；下次再加一条网关通路时，人照样会照着最近一份抄一个 `error()`/`failure()` 出来，而文案表那次的收敛经验并不能阻止它。实际差异只有两条（`cause` 与 `retryable`），处理成本远小于再维护一份同形工厂。

## Consequences

收益：

- 401 / 403 / 503 三句话只有一处定义，两条路只能通过 `voice` 表达语境差异——同一个 403 不会再因为只改了一处而在两条路上措辞不同。
- 失败对象的形状（`code` 永远有，`cause` 只在其存在时挂上，`retryable` 默认 `false`，`title` 可选）只有一个地方决定；`scan.js` 与 `gateway.js` 的调用点从「两种参数形状」变成同一种。
- `app/gateway.js` 里那个 5 行的 `error()` 消失了，`app/failure.js` 顶上写明了差异各自的理由（文件头的注释就是这份决定的浓缩版）——新增状态码时能直接看出该往表里加还是留在调用点。

代价：

- 多了一个模块：`frontend-next/app/` 下现有 14 个顶层模块 + `artifact/` 2 个（`git show HEAD:frontend-next/app` 时是 11 + 2），契约 d 的扫描范围因此从 13 个变成 14 个（新增的 `net.js` 被排除在扫描外）。失败对象与文案的阅读路径变长：看一句话要跳到 `failure.js`，再看调用点传进来的 `voice` 才能拼出完整文案。
- `voice` 的四个字段是**约定**而不是类型：少传一个不会报错，会得到 `undefined` 拼进文案（例如 `sessionTail` 忘传就变成「登录已过期：请重新用访问密码登录本站undefined。」）。没有类型系统也没有夹具在挡这个（`scripts/check_js.mjs` 只做 `node --check`）。
- 一处行为差异（无意的、但存在）：`gateway.js` 的错误现在也带一个值为 `false` 的 `retryable` 自有属性（改前它根本没有这个键）。今天没有读者会因此改变行为——`main.js:717` 的判据是 `error.retryable !== true`，缺键与 `false` 等价——但任何将来做「有没有这个键」判断的代码会看到差异。
- `STATUS_TEXT` 只覆盖 401 / 403 / 503，兜底句留在调用方：这是刻意的（两条路的兜底句本来就不同），但它意味着「网关返回的状态码 → 一句话」这件事仍然要在两个文件里各看一眼才知道完整覆盖面。

## Testing

- 只读核对（本轮）：逐条比对 `app/failure.js` 的 `STATUS_TEXT` 与两个 `voice`，确认拼出来的 5 类文案（401 / 403 / 503 / 两条兜底句）与本轮改动前的字符串逐字一致；`scan.js` 独有状态码（404 / 409 / 413 / 429）仍在 `app/scan.js:149-152`。
- 门禁：`npm run check` 全绿，`scripts/check_frontend_contracts.mjs` 的契约 d 现在报 `PASS 契约 d：14 个 app/ 模块（除 net.js）没有裸 fetch(`（多出来的那一个就是新模块）。
- 未验证（如实记）：`voice` 少传字段时拼出 `undefined` 这条代价是从代码读出来的，没有造夹具复现；两条通路的错误文案也没有端到端跑过（既有的端到端闭环是真实扫描/真实产物，不在本轮的验证范围里）。

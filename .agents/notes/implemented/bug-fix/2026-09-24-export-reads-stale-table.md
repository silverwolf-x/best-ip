# Agent Note: 导出快照会读到上一帧的表格——runExport 开头必须 flush 排队中的渲染

Status: implemented

## Problem

导出快照的正文、行数与摘要分别从三个地方取（`frontend-next/app/main.js` 的 `runExport`）：

- **正文**：`rowsHtml: elements.grid.outerHTML`（`main.js:517`）——读的是**当前 DOM**，也就是**上一次渲染**写进去的那张表。
- **行数**：`shown: results.length`，`results` 是 `lastVisibleRows`（`main.js:512`）——渲染时算出来的缓存，只在 `render()` 里更新（`main.js:306`）。
- **摘要里的筛选词**：`query: state.query.trim()`（`main.js:521`）——读的是**内存里的 `state`**。

问题在于这三者的更新时刻不同。输入事件的接线是：

```js
elements.query.addEventListener("input", () => {
  state.query = elements.query.value;   // ← 当下就写进 state
  scheduleRender();                      // ← 表格重建排在下一个 rAF 里
});
```

`scheduleRender()`（`main.js:334-341`）只把 `render()` 排进 `requestAnimationFrame`；`render()` 里那张 `lastVisibleRows` 缓存与整表重建都发生在那一帧（`main.js:302-321`）。于是存在一个真实窗口：**刚敲完字、那一帧还没跑，此时点导出**——`state.query` 已经是新词，而 `elements.grid.outerHTML` 与 `lastVisibleRows` 还是上一帧的旧表。产出的快照会写成「筛选：\<新词\>」配一张旧表，`shown` 与正文也自相矛盾。

同一条窗口对状态下拉与排序同样成立（它们的 `change` 处理也走 `scheduleRender()`，`main.js:822-832`），只是那两处的摘要文案读的是 `elements.status` / `elements.sort` 的**当下值**，与**已同步更新**的 `state` 一致，所以症状最明显的是筛选词。`render()` 的脏检查（`renderKey()` = 数据版本 + 查询 + 状态 + 排序，`main.js:295-297`）恰好放大了这件事：它保证「输入没变就不重建」，但**不保证**「重建已经发生」——导出读的正是那个"还没发生"的中间态。

## Decision

**`runExport()` 的第一件事是 `flushPendingRender()`**（`main.js:504-509`）：

```js
async function runExport(format, button) {
  if (dataset.nodes.length === 0) return;
  flushPendingRender();
  const results = lastVisibleRows;   // 与正文同一时刻
  ...
  rowsHtml: elements.grid.outerHTML,
  shown: results.length,
  state: { query: state.query.trim(), ... },
```

`flushPendingRender()`（`main.js:348-353`）就是「把排队中的那一帧立刻落下来」：若没有排队的帧就原样返回；有就 `cancelAnimationFrame(frame)`、把 `frame` 置回 `null`、同步跑一次 `render()`。它之所以单独成一个函数、而不是让 `runExport` 自己调 `render()`，是因为调用方必须走同一套调度记账（`frame` 这个变量是唯一的"有没有排队的帧"的真值，直接 `render()` 会让那个已排队的回调随后再跑一次，等于同一帧重建两遍）。

**不变量：导出的三个部分（正文、行数、摘要）必须取自同一时刻。** 具体到实现就是「读 DOM 之前，先把所有排队的渲染落下来」。这条不变量现在只由 `runExport` 开头这一行守着——它是这个函数里唯一能同时看到 `state`、`lastVisibleRows` 与 `elements.grid` 的位置。

**为什么不能在 `snapshot.js` 一侧修**：那一层只拿到字符串（`rowsHtml`、`summary.title` / `statsHtml` / `stateHtml`）与数字，看不到 DOM，也无法知道「调用方传进来的这串 HTML 是不是当前状态对应的那一份」——它连 `state.query` 与正文的对应关系都拿不到（`buildSnapshotDocument()` 的入参是拼好的 `summary` 对象）。时序是调用方的事实，只能在调用方处收口；`snapshot.js` 能做的只有"拼装层自己保证拼进去的东西不会是标记"，那是另一条不变量（见 [离线快照拼装层三处转义缺口](2026-09-24-snapshot-escape-double-escaping.md)）。

同一函数里另一处按格式区分的文案也在这轮对齐（`main.js:534-539`）：导出成功的提示里，「但快照内未内联复制脚本，复制按钮不可用」现在只在 `format === "html"` 且真的没读到 `copy.js` 时才出现。`.mhtml` 从不内联复制脚本是**决策**而不是失败（见 [离线 .mhtml 不再内联 app/copy.js](../simplification/2026-09-24-offline-mhtml-drops-copyjs-inline.md)），原先把两种格式共用这一句，等于给 `.mhtml` 的用户报一个假成因。

## Alternatives considered

**在 `snapshot.js` 一侧修：拼装前比对摘要与正文，不一致就报错或拒绝导出。** 最强理由：把这条不变量放进唯一产出文件的模块里，谁调它都受同一份保护，不必指望每个调用方记得 flush；而且"宁可导出失败也不要导出一份自相矛盾的文件"与那份快照要能自证的性质是同向的。否定原因：`buildSnapshotDocument()` 只拿到拼好的字符串与数字，它没有任何办法判断「筛选：东京」这串字与 `rowsHtml` 里那张表是否同源——要比对就得让拼装层去解析表格标记、或者让调用方额外传一份"当时的筛选词"（那就是把同一个问题推给调用方并在拼装层复述一遍）。而且这条不属于拼装层的职责边界：它的不变量的"拼进去的东西不会是标记"，时序属于调用方。这条方案还会把一次**可恢复的时序问题**变成一次用户可见的失败（点了导出被告知不能导出，而他只是快了一点点）。

**让输入事件同步渲染，取消 rAF 合并。** 最强理由：最直接——`state` 与 DOM 永远同步，任何时刻读 DOM 都是当前状态，导出、以后新增的任何"读 DOM"功能都自动安全，也不必记住"读之前先 flush"这条协议；而且一行改动（把 `scheduleRender()` 换成 `render()`）。否定原因：`scheduleRender()` 的合并是为输入事件本身服务的（`main.js:336` 的注释：IME 组合期间输入事件很密，合并到一帧里重建列表），同步渲染等于每敲一个字就重建整表 29 行 + 重写色带 + 重接复制（`main.js:308-320`），而输入框在 IME 组合期间尤其敏感。为一个只在"点导出"这一刻出现的问题，把每次按键都变成一次整表重建，代价方向反了。

**把 `frame` 暴露出去（或让 `scheduleRender` 返回一个可 await 的 promise），由 `runExport` 等这一帧跑完再读。** 最强理由：`runExport` 是 `async` 的，`await nextFrame()` 读起来比"取消排队中的帧并同步跑一次"更顺，也不会让 `render()` 在同一帧里以同步方式重入（那是 `flushPendingRender()` 必须做的、最容易出错的一步）；而且不引入"取消"这个额外的动作语义。否定原因：等待下一帧会把导出的第一步推到一个不确定的时刻（下一帧什么时候来取决于浏览器），而 `runExport` 的第一件事是**同步**判空并禁用按钮（`main.js:505`、`main.js:514`）——把这几步拆到两个时刻只会让"点下去到按钮变灰"之间出现一个空窗，用户连点两次会跑两遍导出。取消并同步落帧是同一个 tick 里完成的，状态转移更少。

## Consequences

收益：

- 快照的正文、行数、摘要第一次保证取自同一时刻：刚敲完字就点导出，产出的也是新词配新表，不会写出「筛选：词」配旧表的自相矛盾文件（这种文件会被转发/归档，错误很难在事后发现，因为两半各自看着都合理）。
- 「导出前先 flush」这条不变量被写在 `runExport` 开头（`main.js:506-508` 的注释就是它），与 `flushPendingRender()` 的存在理由连在一起——`main.js:346` 的注释直接指向 `runExport`。
- 同一函数里 `.mhtml` 的导出提示不再报「未内联复制脚本」这个假成因，用户看到的提示与实际产物一致。

代价：

- `runExport` 现在会在**自己的同步段里跑一次 `render()`**（当确实有排队的帧时）：导出按钮点击处理的第一件事变成了整表重建（29 行 `replaceChildren` + 色带 + 复制接线）。正常情况下这一帧本来就要跑，只是被提前了同一个 tick；但在"用户正在连续输入"时点导出，会把那次合并顺带落地。
- `flushPendingRender()` 有两条路径（无排队帧 / 有排队帧），只有后者会调 `render()`。这条分支的逻辑没有自动化覆盖（见 Testing），将来若有人把 `render()` 改成"自己再排一帧"或让 `frame` 的记账换个变量，flush 会静默失效——症状（旧表配新词）与本次缺陷一模一样，而且只在"手比帧快"时出现。
- 「读 DOM 之前先 flush」是一个**必须记住的协议**：将来任何新的读 DOM 的功能（不只导出）都得照做，否则同一个窗口会在别处重新出现。现在没有任何机制强制它。

## Testing

- 本轮改动**没有自动化覆盖**：`frontend-next/tools/mhtml-roundtrip.mjs` 第 7 节测的是拼装层与 MIME 序列化（它直接调 `buildSnapshotDocument()` / `serializeSnapshot()`，不碰 `main.js` 的渲染调度），仓库里也早已没有前端测试套件（见 [CI 门禁不再引用已删除的测试用例](../process/2026-09-21-ci-gates-without-tests.md) 记录的「不用 tests」决定）。因此这条缺陷是**复核阶段读代码发现的**：`state` 在输入事件里同步写、`render()` 排 rAF、`runExport` 读 DOM 与渲染缓存——三件事放在一起就能看出窗口存在，不需要跑起来。
- 门禁：`npm run check` 全绿（`scripts/check_js.mjs` 对 `main.js` 做 `node --check`，属语法级）。
- 未验证（如实记）：没有在真实浏览器里以「刚敲完字立刻点导出」的时序复现过修复前后的差别（需要构造"点得比一帧快"的输入，人工操作很难稳定复现；这一条是本次没有自动化覆盖的直接后果）。

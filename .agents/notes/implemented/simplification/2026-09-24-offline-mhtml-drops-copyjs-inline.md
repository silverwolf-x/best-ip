# Agent Note: 离线 .mhtml 不再内联 app/copy.js

Status: implemented

## Problem

导出的两种产物（`.mhtml` 与 `.html`）原先**都**内联 `app/copy.js` 的原文：`exportSnapshot()` 读资源，`buildSnapshotDocument()` 把 `copyScript` 拼成 `<script>…copy.js 原文…</script>` 加 `<script>BestIpCopy.attach(document);</script>`。

而 Chrome 把 `file://` 打开的 `.mhtml` 放进**不设 `allow-scripts` 的沙箱 frame**（实测日志 `Blocked script execution … the document's frame is sandboxed and the 'allow-scripts' permission is not set`），脚本一律不执行。于是每一份 `.mhtml` 里都白塞着约 6.9KB 永远不会运行的代码：复制按钮照样按不动，产物却白白变大，而且"里面明明有脚本"这件事还会让人以为按钮应该能用。（这条限制本身早就记录在 [新前端改成单视图十列宽表，并把整页存成可离线打开的 mhtml 快照](../feature/2026-09-22-frontend-single-view-redesign.md) 里，那条笔记同时记着"快照内联 `app/copy.js` 的**原文**"这个当时的决定——本轮部分取代它。）

## Decision

**`.mhtml` 一律不内联 `copy.js`，`.html` 照旧内联。**

- 内联门只开在 `buildSnapshotDocument()` 一处（`frontend-next/app/snapshot.js:192`）：

  ```js
  const inlineScript = format === "mhtml" ? "" : copyScript;
  ```

  即使上游把 `copy.js` 原文递进来，`.mhtml` 这份也丢掉；脚本块为空时写一行注释占位（`<!-- 快照内未内联 copy.js，复制按钮不可用 -->`，`app/snapshot.js:193-195`）。`format` 现在是"样式怎么放 + 脚本要不要内联"这两件事的唯一分叉点。
- **`.mhtml` 的零 JS 复制路径不变**：`styles.css` 里 `.ip { user-select: all }`（本轮核对在 `frontend-next/styles.css:429`；该文件仍在被编辑，行号会漂，按选择器找），单击出口 IP 即全选，再按 Ctrl/⌘+C。所以砍掉脚本**没有让 `.mhtml` 少掉任何功能**——它本来就靠这条路径复制。
- **免责说明必须原样保留**（`buildSnapshotDocument()` 的 `scriptNote`，`app/snapshot.js:171-175`）：`.mhtml` 版顶部照旧写「浏览器会把 .mhtml 里的脚本置于沙箱、不执行，因此本文件的复制按钮不可用：**单击出口 IP 即全选**，再按 Ctrl/⌘+C 复制；要按钮可用请打开同批导出的 .html 版本。」不内联脚本之后这段文字更该留着——按钮确实仍然按不动。`frontend-next/tools/mhtml-roundtrip.mjs` 第 7.1 节把这段文案逐字冻结成期望值，改写就会红。
- `exportSnapshot()` 那一层照旧读 `copy.js`（`collectCopyScript()`），因为返回给调用方的 `scriptSource` / `scriptWarning` 要如实反映"这段脚本到底取到没有"；"要不要内联"的判断只在 `buildSnapshotDocument()` 一处，不在两层各判一次。
- **导出提示也跟着分了格式**（`app/main.js:534-539`）：「但快照内未内联复制脚本，复制按钮不可用」这句只在 `format === "html"` 且真的没读到 `copy.js` 时才出现。`.mhtml` 不内联是决策、不是失败，原来两种格式共用这一句等于给 `.mhtml` 的用户报一个假成因。导出通路里同一批改动的另一处（`runExport` 与渲染帧的时序）见 [导出快照会读到上一帧的表格](../bug-fix/2026-09-24-export-reads-stale-table.md)。

## Alternatives considered

**两种格式都保留内联，把脚本当"万一某个浏览器会执行"的对冲。** 最强理由：成本只有几 KB，而"沙箱不执行"是 Chrome 的实现细节、不是 MHTML 规范的承诺——同一个文件在别的浏览器、旧版本或第三方 MHTML 查看器里可能就会执行；那时内联的那份 `copy.js` 是唯一能让复制按钮真的可用的东西，代价近乎为零，属于便宜的保险。否定原因（依据在代码与既有笔记里）：在要照顾的主要查看器里它是被实测拦掉的（日志写在 `app/snapshot.js` 文件头与单视图笔记里），而"内联了脚本"这个事实与快照顶部那句"按钮不可用"的说明**互相矛盾**——快照的全部价值是离开站点后自证是什么，一段永远不会跑、却让按钮看起来有能力的代码正好在破坏这件事；同时每个产物白增约 6.9KB。`.html` 分支已经把"按钮真的能用"这条需求完整接住了。

**把 `.html` 升为主推、`.mhtml` 降级（或干脆只留 `.html`）。** 最强理由：所有浏览器都能打开 `.html`，脚本真的会执行，实现只剩一条路径——连"哪种格式内联脚本"这个判断都不需要，那段免责说明也可以删掉；而 `.mhtml` 本来就被部分浏览器冷落（Firefox 早已不支持），单视图笔记里也已经把 `.html` 定义为兜底。否定原因（本次）：这是产物主次关系（以及"快照要像浏览器自己保存的页面"那条制品形态决定）的改动，面比删一段死代码大得多，不是本轮要解决的问题——**本轮没动主次关系**：`.mhtml` 仍是主、`.html` 仍是兜底，`exportSnapshot()` 的两条分支只是共用了同一条组装路径。

## Consequences

收益：

- 每份 `.mhtml` 少约 6.9KB 不会执行的脚本，产物更小；也不再带着一段会让人误以为按钮能用的代码。
- 两种格式的差异第一次被写全、也只剩两处，都由 `format` 决定：样式（`<link>` 部件 vs 内联 `<style>`）与脚本（不内联 vs 内联）。测试可以按这两处逐个断言（第 7.1 节就是）。
- 免责说明与"零 JS 复制路径"的关系被显式绑定：不内联脚本 ⇒ 必须保留那句说明。

代价：

- `.mhtml` 的复制能力完全落在 `.ip { user-select: all }` + 用户手上的 Ctrl/⌘+C 上。样式表里那条规则哪天被去掉或被别的规则覆盖，`.mhtml` 就真的没有任何复制路径了——脚本这条退路是有意砍掉的，唯一的对冲是 `.html`。
- `exportSnapshot()` 仍然每次都读 `copy.js`（对 `.mhtml` 是白读一次，还会白跑一次超时封装的取数），这是为把 `scriptSource` / `scriptWarning` 如实回给调用方而留的。读者容易误以为 `.mhtml` 也内联了脚本，所以文件头、`collectCopyScript()` 与 `exportSnapshot()` 的注释都得写清"决策在 `buildSnapshotDocument`，这里是白读"（已写）。
- `.html` 分支的"按钮真的能用"依赖 `copy.js` 的 `execCommand` 回退（`file://` 下没有 `navigator.clipboard`），这条路径没有被本轮改动覆盖到：本轮新增的断言只到字节与拼装层，没有真的在浏览器里点过按钮。

## Testing

- 本轮实跑 `npm run check` 全绿，以上各条均为 `PASS`（详细输出见 [前端契约门禁那篇](../process/2026-09-24-frontend-contract-gates-in-check.md) 的 Testing）。
- `frontend-next/tools/mhtml-roundtrip.mjs` 第 7.1 节（本轮新增，且该脚本现在由 `npm run check` 串起）直接调生产函数 `buildSnapshotDocument()` / `serializeSnapshot()`，断言：`.mhtml` 产物不含任何 `<script>`、不含 `copy.js` 的标记（`BestIpCopy` 与 `execCommand` 都不出现）、免责说明逐字保留、仍带 `<link rel="stylesheet">` 与 `<main class="table-wrap">`；`.html` 产物含内联 `copy.js` 与 `BestIpCopy.attach(document);`、不含 mhtml 专用的免责说明、CSS 内联进 `<style>`。
- 未验证（如实记）：没有在真实浏览器里双击打开新的 `.mhtml` 复核"按钮按不动 + 单击 IP 全选仍有效"（零 JS 路径本身在单视图笔记里实测过，但那是脚本仍被内联的版本）。

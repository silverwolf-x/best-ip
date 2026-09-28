# Agent Note: 修复工作区编辑时丢失的 CSS 选择器前导

Status: implemented

## Problem

本轮修复手机卡片布局时，还发现了一个工作区编辑缺陷（布局决策见 [窄屏卡片改成流式自适应](../feature/2026-09-28-frontend-narrow-card-fluid-layout.md)）：`frontend-next/styles.css` 里 `.row > td` 这条规则丢了选择器前导，只剩一段声明块躺在 `tr:nth-child(even)` 那条规则后面。HEAD 中这条规则完整，因此不能把它归因成原有页面问题的根因：

```css
.row:nth-child(even) { background: var(--surface-row); }
  padding: 7px 9px;                       /* ← 这段没有前导，整段被丢弃 */
  border-bottom: 1px solid var(--line);
  color: var(--ink-2);
  font-size: 12.5px;
  vertical-align: middle;
}
```

浏览器遇到没有前导的选择器不会报错：整个 qualified rule 按非法规则**静默丢弃**。于是所有 tbody 单元格的内边距、分隔线、字号、颜色、垂直居中同时消失。页面照常渲染、控制台干净、DOM 不变——只有"看起来不对"这一个信号，而它落在一个 900px 以下的窄屏上，很容易被归到"响应式写得不好"。

## Decision

- 恢复 `.row > td {` 前导，并在原位留一条注释说明这一层为什么不能省（给单元格设 `display: flex` 会让整行错位，而这层前导一旦丢失就是整段静默消失）。
- 因果用运行期证据钉住，而不是靠推理：在 1440 视口下用 CSSOM 把这条规则 `deleteRule` 掉再量，同一行 `paddingTop` 7px→1px、`borderBottomWidth` 1px→0、`fontSize` 12.5px→14px、`color` `rgb(63,71,83)`→`rgb(16,21,27)`、行高 52.25px→39.25px。
- 检测手段：逐行扫描样式表，报告 `missing-selector`（一段声明块前面不是选择器）、`orphan-declaration`、`unbalanced-braces`。当前 `frontend-next/styles.css` 与 HEAD 版都通过（`OK: frontend-next/styles.css 无孤块/无丢失选择器`）。

## Alternatives considered

- **只靠人工 review diff** — 最强理由：这次就是一次编辑造成的，改回一行就完事，工具是多余的。否掉的原因：这类缺陷在 diff 里长得像"删掉一行"，没有任何自动信号，而它的失效形态（整段声明消失）与"故意改样式"在 diff 里无法区分。实测把整段声明删掉后页面仍然渲染、控制台依然干净，只有几何测量能发现。
- **把扫描器提进 `scripts/` 并接进 `npm run check`** — 最强理由：与前端契约 a–d 同一条逻辑——把"靠人记得"变成机器检查，而这次已经证明它能抓到。否掉的原因：本轮的改动范围限定在 `frontend-next/**` 与 `.agents/notes/**`，加仓库级脚本超出范围。

## Consequences

- **收益**：这类"整段声明静默消失"被定位到具体行；窄屏与宽表的分隔线、字号、单元格内边距回到设计值，而不是退回浏览器默认（14px、无分隔线）。
- **代价与已知上限**：扫描器在会话临时目录里，**没有门禁**——它不会在 CI 里拦住下一次同款编辑。下一批允许动工具链的工作应当把它收进 `npm run check`，或直接在前端契约脚本里加一条等价检查。

## Verification

- `node <scratch>/css-orphan-scan.mjs frontend-next/styles.css` → `OK: frontend-next/styles.css 无孤块/无丢失选择器`；对 HEAD 版同样通过（说明丢失发生在工作区，不是历史遗留）。
- 运行期对照（1440）：带该规则 vs 用 CSSOM 删掉该规则，几何差异见 Decision。
- 修复后在 375 / 414 / 620 / 768 / 900 / 1024 / 1280 / 1440 八个宽度上重新测量，`npm run check` 与 `npm run verify-notes` 全绿。

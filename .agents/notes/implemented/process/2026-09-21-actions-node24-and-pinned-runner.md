# Agent Note: Actions 升到 Node 24 版 action 并把 runner 固定到 Ubuntu 24.04

Status: implemented

## Problem

一次 scan 运行（run 35607531797）在运行页留下两条 annotation：

第一条是硬弃用：这些 action 声明 `runs.using: node20`，被 runner 强制跑在 Node 24 上，属于未经测试的组合，而 Node 20 已不再收安全补丁（每个被点名的 action 还在日志里带出 `punycode` / `url.parse()` 弃用告警）。第二条会让扫描镜像在某天无声换掉，而这个仓库把 Mihomo 归档按 SHA-256 固定、把 IPure 请求头按内容固定，扫描结果的可复现性是显式目标。
- `The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026.`

第一条是硬弃用：这些 action 声明 `runs.using: node20`，被 runner 强制跑在 Node 24 上，属于未经测试的组合，而 Node 20 已不再收安全补丁（每个被点名的 action 还在日志里带出 `punycode` / `url.parse()` 弃用告警）。第二条会让扫描镜像在某天无声换掉，而这个仓库把 Mhomo 归档按 SHA-256 固定、把 IPure 请求头按内容固定，扫描结果的可复现性是显式目标。

## Decision

三个 workflow 统一升到声明 `node24` 的 action 版本，并把 `runs-on` 固定为 `ubuntu-24.04`。

| action | 原 | 现 | `runs.using` |
| --- | --- | --- | --- |
| `actions/checkout` | v4 | v5 | node24 |
| `actions/cache` | v4 | v5 | node24 |
| `actions/upload-artifact` | v4 | **v6** | node24（**v5 仍是 node20**，不能停在 v5） |
| `actions/setup-node` | v4 | v5 | node24 |

`astral-sh/setup-uv` 保持按 commit SHA 固定（`20cfd1bf947f4377ade1205e4dbc17946fc9a30d`），它没有出现在弃用名单里。

用到的输入在新版本里都存在：checkout 的 `ref` / `persist-credentials`，cache 的 `path` / `key`，upload-artifact 的 `name` / `path` / `if-no-files-found` / `retention-days`，setup-node 的 `node-version` / `cache`。升级前后 `scan.yml` 的上传步骤参数（`if-no-files-found: error`、`retention-days: 1`）逐项不变。

## Alternatives considered

1. **设 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true` 继续用 Node 20**。这是官方给出的临时开关，一行就能消掉警告。放弃原因：它只是把警告压掉，Node 20 已停止安全更新，等于把“未经测试的强制组合”变成“明确选择的不受支持组合”。
2. **保持 `ubuntu-latest`**。放弃原因：这个仓库已经把 Mihomo 归档与 IPure 请求头都固定成内容寻址，runner 镜像却跟着浮动标签走，等于把最大的一个变量留给日历。
3. **直接升到 `actions/upload-artifact@v7`**。放弃原因：v6 已经满足 node24，v7 的新变化与我们要用的输入无关；按最小跨度升级，少一个变量。
4. **只改 `scan.yml`**（这次 annotation 只出自它）。放弃原因：`ci.yml` 与 `worker.yml` 用的是同一批 action，同样会告警；`worker.yml` 还是部署门，不该留在弃用组合上。

## Consequences

- 收益：运行页不再出现 Node 20 强制运行警告，扫描不再依赖“被强制降级”的执行环境。
- 收益：`ubuntu-24.04` 让扫描镜像可预期，Ubuntu 26 迁移通知不再适用于本仓库。
- 代价：`ubuntu-24.04` 退役时需要人工再改一次；GitHub 若下线该标签，扫描会直接失败而不是静默降级——这是刻意的取舍，可复现性优先于自动跟随。
- 代价：`upload-artifact` 跨了两个大版本（v4 → v6）。本次运行只在 v4 上验证过，v6 需要在下一次真实运行里复核运行页不再告警且 artifact 仍可被 Worker 取到。
- 事实：本仓库在 `928c770 chore(tests): delete test suite and ignore tests directory`（2026-09-09，HEAD 的祖先）之后**没有任何测试文件**，`/tests/` 也在 `.gitignore` 里。因此 `ci.yml` 的 `uv run pytest` 收集不到用例（exit 5）、`npm test` 找不到 `tests/frontend_modules.test.mjs`，`worker.yml` 里作为部署前置的 `npm test` 同样会失败。这是本次改动之前就存在的状态，与 action 版本无关；本次只做了版本与镜像替换，没有顺带恢复或删除这些门禁——那需要单独决定。

## Testing

- 逐 tag 核对 `runs.using`：`checkout@v5`、`cache@v5`、`setup-node@v5`、`upload-artifact@v6` 均为 `node24`；`upload-artifact@v5` 仍是 `node20`，因此没有选它。
- 逐 tag 核对我们实际使用的输入是否存在。
- `node --check` 与 `npm run check` 覆盖改动过的 JS 文件。
- 运行页验证要在下一次 dispatch 后确认：两条 annotation 消失、artifact 仍能上传并被 Worker 取到（后者见 [artifact 转发笔记](../architecture/2026-09-21-artifact-relay-integrity.md)）。

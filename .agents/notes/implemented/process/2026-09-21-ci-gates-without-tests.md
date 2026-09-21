# Agent Note: CI 门禁不再引用已删除的测试用例

Status: implemented

## Problem

`928c770 chore(tests): delete test suite and ignore tests directory`（2026-09-09）删掉了测试套件并把 `/tests/` 加进 `.gitignore`，但门禁还指着它：

- `ci.yml` 跑 `uv run pytest`，收集不到任何用例 → exit 5，红。
- `ci.yml` 与 `worker.yml` 跑 `npm test`，而 `npm test` 指向 `tests/frontend_modules.test.mjs`、`tests/worker/*.test.mjs`、`tests/contracts/*`，这些文件都不存在 → 红。
- `worker.yml` 还把这个 `npm test` 当**部署前置**，于是 Worker 的自动部署门也是红的。

也就是说 CI 长期红在一次「永远不可能再变绿」的检查上；红得久了，这个信号就不再被阅读。[Actions 版本笔记](2026-09-21-actions-node24-and-pinned-runner.md) 当时只换了 action 版本，把门禁本身的去留明确留成单独决定。

## Decision

这个仓库不再维护测试套件（用户决定："不用tests"）。因此删掉指向已删用例的门禁，只留下能真跑通的检查：

- `ci.yml`：删除 `Test Python / uv run pytest` 步骤；`Check and test JavaScript/Worker` 改名为 `Check JavaScript and Worker syntax`，跑 `npm run check`。
- `worker.yml`：部署前置 `Verify build and tests / npm test` 改成 `Verify Worker syntax / npm run check`。
- `package.json`：删除 `test:frontend` / `test:worker` / `test:contracts`；`test` 改成 `npm run check`。保留 `dev`、`dev:no-reload`、`check`（`node scripts/check_js.mjs`）、`verify-notes`、`deploy`（`wrangler deploy`）、`dry-run`。
- `README.md`：验证段的门禁清单与「语法检查命令」一节的措辞同步，明确写出「本仓库不再有 Python 或 JavaScript 用例，`npm test` 只做语法检查」。

`npm test` 这个名字被保留下来（而不是删掉），因为它已经被 CI、`worker.yml`、README 和外部习惯引用；改成等价的语法检查比留一个空步骤更有意义。

## Alternatives considered

1. **恢复测试套件**（最强理由：门禁变红不是检查本身写错了，而是用例被删了；恢复 `tests/` 能让 `npm test` 重新有意义，也让这次改动不必去动 CI）。放弃原因：用户的指令是不再维护测试，恢复等于把刚删掉的维护负担原样搬回来——而且写回来的用例多半只能复述实现。
2. **保留 `npm test` 的名字，让它内部跑 `pytest` 或占用例**（最强理由：改动最小，一行都不用删）。放弃原因：那是把红门禁改成一个永远通过的空壳，比直接删掉更难被发现——下一个人会以为这里有回归保护。
3. **把失败的步骤设成 `continue-on-error: true`**（最强理由：不删任何东西，CI 立刻变绿）。放弃原因：信号还在页面上，但没人能从中读出东西；告警疲劳就是这么来的。
4. **把 `npm run verify-notes` 并进 `npm test`**（最强理由：本地只跑一个命令就能过全部门禁）。放弃原因：两件事的失败面不同，合并后本地改代码会被笔记格式挡下来，反之 CI 也无法单独定位是哪一类门禁失败。`verify-notes` 保持独立步骤。
5. **连 `worker.yml` 的部署门一起删掉**（最强理由：既然没有测试，就不该有测试前置）。放弃原因：部署前至少该确认 Worker 语法没过期；`npm run check` 是一条真能跑通的检查，留着它比留空有意义。

## Consequences

- 收益：CI 与 `worker.yml` 的部署前置第一次都变成真能通过的检查；`d226fb7` push 后运行 completed/success，`scan` 与 `test` 两个 check-run 的 annotations 都是 0。
- 收益：README 不再宣称存在测试，本地验证步骤与真实门禁一致。
- 代价：这个仓库不再有任何回归保护。语法检查只能拦下 `node --check` 级别的问题，行为、契约、格式错误全靠人工与生产闭环。
- 代价：`npm test` 现在只表示 `node --check`，名字与实际能力不一致；这是刻意保留的兼容，README 里已写明，但如果将来有人按名字推断覆盖度就会误判。
- 事实：`.github/workflows/scan.yml` 不受影响——它跑的是扫描本身，没有测试步骤。
- 事实：这次改动没有碰 `tests/` 目录本身（它早已不存在，且仍在 `.gitignore` 里）。

## Testing

- 本地：`npm run check`（exit 0）、`npm test`（= check，OK）、`uv run --no-dev ruff check .`（`All checks passed!`）、三个 workflow YAML 用 `yaml.safe_load` 解析后 jobs 为 `test` / `scan` / `deploy`、`npm run verify-notes`（6 篇笔记，三线全 ok）。
- 线上：`d226fb7` push 触发的运行 `35611548341` → completed/success；`gh api .../commits/d226fb7.../check-runs` 显示 `scan | annotations=0 | success`（两次）与 `test | annotations=0 | success`。
- 变更后仍走真实生产闭环取件（见 [artifact 字节改由浏览器直取笔记](../architecture/2026-09-21-artifact-bytes-delegated-to-browser.md)）。

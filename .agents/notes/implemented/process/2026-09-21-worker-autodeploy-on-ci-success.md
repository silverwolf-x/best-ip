# Agent Note: push 到 main 通过 CI 后自动发布 Worker

Status: implemented

## Problem

发布这一步原来是断的，而且没人拥有它：

- `.github/workflows/worker.yml` 的触发条件只有 `workflow_dispatch`——也就是说，云端**只会**在有人手动点 "Run workflow" 时发布。
- `.github/workflows/ci.yml` 只做 lint、语法检查与 `wrangler deploy --dry-run`，不发布。
- Cloudflare Workers Builds（原生 git 集成）没有接入这个仓库：最近的 deployment 记录停在 2026-09-09，push 不会有任何发布动作。

于是「改完 → 上线」的最后一跳实际上是在某台机器上手工跑 `npx wrangler@4 deploy`。这不是假设：本轮排查里真实发生了仓库与线上漂移——线上还在跑旧资产，直到手工发布之前，部署新鲜度预检里的 `/src/transport/http.js 直取签名 blob` 与 `首页 CSP 放行 blob` 两项都是 FAIL。用户要的「发布形成闭环」正是这一跳：push → CI → 上线，不需要人工。

## Decision

`worker.yml` 在保留 `workflow_dispatch` 的同时，增加 `workflow_run` 触发：CI 工作流在 `main` 上跑完且结论为 `success`、且触发事件是 `push` 时，自动发布。

- `if: github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push')` —— 手动派发照旧可用；PR 上的 CI 成功不会发布。
- checkout 用 `ref: ${{ github.event.workflow_run.head_sha || github.sha }}`：发布的就是 CI 验过的那一个 commit，而不是「触发时 main 上最新的那个」。
- 既有的 `concurrency: cloudflare-worker-production` + `cancel-in-progress: true` 不动：连着推两次时后一次取消前一次，最终上线的仍是最后那个通过 CI 的 commit。
- 发布前置仍然是 `npm run check`（语法），而 CI 里已经跑过 `wrangler deploy --dry-run`，所以语法或 wrangler 配置坏了会在 CI 阶段失败，根本不会把发布触发起来。

## Alternatives considered

1. **接入 Cloudflare Workers Builds（原生 git 集成）**（最强理由：不用维护 workflow，push 即上线，构建历史在控制台里一目了然，连 API token 都不用放 GitHub）。放弃原因：它在 push 时直接跑部署，**绕开 CI 的门禁**（lint、语法、dry-run），等于把「只有验过的提交才上线」这条性质换掉；而且它的配置在控制台侧而不是仓库里，改不动、也 review 不了。
2. **把 deploy 并进 `ci.yml` 作为第二个 job（`needs: test` + `if: push && main`）**（最强理由：一个文件搞定，依赖关系最直白，不用跨 workflow 传递 sha）。放弃原因：`worker.yml` 已经是既有的部署入口与并发组，并进去等于同时存在两个部署入口，人工重发会和自动发布在同一个并发组里互相取消；保住一个入口更好读。
3. **维持全手动**（最强理由：发布是显式动作，不会有「推一下代码就进生产」的意外，符合小项目的谨慎习惯）。放弃原因：本轮真实漂移证明手动的最后一跳没人拥有；而且这正是用户要求补上的闭环。
4. **`workflow_run` 不指定 sha，直接 checkout 默认分支**（最强理由：更少的表达式，更容易懂）。放弃原因：连推两次时可能发布一个 CI 还没验完的提交；显式 `head_sha` 才让「发布的就是验过的那个」在语义上成立。
5. **用 `cloudflare/wrangler-action` 替换 `npm run deploy`**（最强理由：官方 action，日志与注解更规整）。放弃原因：现有步骤已经是 `npm ci` + `npm run check` + `wrangler deploy`，换 action 只多引入一个需要跟版本的三方依赖，不带来新能力。

## Consequences

- 收益：发布不再依赖任何人的本地机器；线上版本与 `main` 上通过 CI 的提交对齐，仓库与生产不会继续漂移。
- 收益：发布沿用同一条 CI（lint + 语法 + dry-run）作为前置，坏提交进不了生产。
- 代价：`main` 上任何通过 CI 的 push 都会直接进生产，没有人工确认闸。若将来需要「发布以人的判断为准」，要么退回手动派发，要么给 job 加 GitHub Environment 的审批保护——那是有意为之的另一个决定。
- 代价：发布依赖 GitHub secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`。轮换 token 时本地与线上要同时改；token 权限不足时失败面从「本地命令报错」变成「CI 红」。
- 事实：`scan.yml` 不受影响——扫描运行的是订阅扫描本身，不参与发布。
- 事实：`workflow_run` 用的是**默认分支上**的那份 workflow 定义，所以这条改动必须先落到 `main` 才会生效。

## Testing

- 结构验证（本地）：三个 workflow YAML 解析通过；`worker.yml` 的 `on` 块确认为 `workflow_run{workflows:[CI],types:[completed],branches:[main]}` + `workflow_dispatch`；deploy 步骤列表为 Checkout → Setup Node → Install dependencies → Verify Worker syntax → Deploy Worker and static assets。
- 线上验证：push 到 `main` 后，CI 成功后应自动出现一次 `Deploy Cloudflare Worker` 运行；需确认它 success、线上版本 ID 变化、发布后部署新鲜度预检 10 项全 OK。本节结论在首次自动发布跑完后补进本篇。
- 人工路径：`workflow_dispatch` 仍然可用，用于绕过 CI 直接重发一次。

# Agent Note: 发布后自证：线上内容必须与 CI 验过的 commit 逐字节一致

Status: implemented

## Problem

发布链在 `384259d` 之后已经是 push → CI → 自动上线（见 [push 到 main 通过 CI 后自动发布 Worker](2026-09-21-worker-autodeploy-on-ci-success.md)），但它止于「上传成功」：

- `wrangler deploy` 的回报只有 `Total Upload: … / Current Version ID: …`。它证明有人往 Cloudflare 推了一份产物，不证明线上正在提供的就是这一个 commit 的内容，也不证明 Worker 还能正常应答、CSP 还放行静态资源所依赖的签名 blob 主机。
- 仓库与线上的漂移在这个项目里真实发生过一次：线上跑着旧资产，发现手段是有人在本机手工发布。自动发布之后更坏的一种变体还没被堵住——**发布本身静默地发错或发半，而工作流全绿**。
- 当时的部署新鲜度预检是会话里的一个临时脚本（`WORKER_LOOP_PREFLIGHT=1`）：不在仓库里、不在流水线上，随会话消失，因此不构成门禁。

## Decision

`worker.yml` 在 `Deploy Worker and static assets` 之后增加一步 `Verify deployed release`，跑仓库里的 `scripts/verify_deploy.mjs`（`npm run verify:deploy`），失败即让这次发布变红。脚本分两层，都不依赖部署方的自述：

1. **无凭据可达性**（任何环境都能跑）：`GET /login` 为 200 且页面含密码表单；`Content-Security-Policy` 仍含 `connect-src 'self' https://*.blob.core.windows.net`；未登录 `GET /` 是 401 `login_required`；未登录访问静态资源（取当前 assets 目录里真实存在的第一个文件）是 401。
2. **有凭据字节比对**：用 `SITE_PASSWORD` 走一遍真实登录表单（读 `name="csrf"` 的令牌与 `__Host-best-ip-login-csrf` cookie，POST 之后取 `__Host-best-ip-session`），再把**当前 assets 目录**（`wrangler.jsonc` 的 `assets.directory`）下每一个被 git 跟踪的文件与它在该 commit 里的 blob 做字节比对（`index.html` 比对根路径 `/`；`/site-config.js` 不在清单里——它由 `worker/router.js` 现算，没有可比对的 blob）。

规则：

- 比对基准必须是 `git show <commit>:<assets 目录>/<path>` 的 blob，**不是本地工作区文件**：`core.autocrlf=true` 的 Windows 检出在工作区里是 CRLF，拿工作区字节比会得到一堆假不一致（已实测）。
- **比对根不写死**：目录从 `wrangler.jsonc` 的 `assets.directory` 读（`--assets` 可覆盖），未登录那条静态资源探测也取目录里真实存在的第一个文件。写死某一个目录会让换了部署根之后的门禁恒绿——线上每个文件都 404，而「404」在结论里和「内容不一致」长得一样，只是更难查（见 [新前端的在线只读通路](../architecture/2026-09-22-frontend-next-online-readonly-gateway.md)）。
- 工作流里的 `SITE_PASSWORD` **必须存在**：缺失时该步骤先 `::error::` 再 `exit 1`。脚本自身在没有密码时只跑第 1 层，并打印「本次**没有**验证线上内容与 commit 一致」——这种降级只允许出现在本地，不允许出现在发布门禁里。
- 只对 5xx 与网络错误重试（3 次、1.5s×n 退避）；4xx 是确定答复，直接判定。每次请求带 20s 超时。**唯一的例外是字节比对前的资产生效等待**：新版本切到边缘有个窗口，2026-09-22 那次发布实测——版本创建后约 2 秒去比对，15 个文件里嵌套目录下的 13 个全报 404（根目录的 `/` 与 `/styles.css` 当时已是 200，所以不是「站点没了」，是「新资产还没铺开」），而 3 分钟后同一批 URL 全是 200 且字节正确（`/app/api.js` 12089 B、`/app/main.js` 20001 B，Content-Type 正常）。那不是漂移，是还没生效，但足以把一次正确的发布判红，所以比对前先用目录里第一个非 index.html 的文件探一次，404 就等 5 秒重探、最多 6 轮（上界 30 秒）。等满 6 轮仍是 404 就照常逐字节比对——真漂移必须继续被这条门禁抓住，不允许用「等一等」把红变绿。

## Alternatives considered

1. **不加校验，靠 `wrangler deploy` 的退出码**（最强理由：零成本，上传失败本来就会让工作流红，不必再走一遍公网）。放弃原因：退出码只覆盖「上传」这一跳，不覆盖「线上提供的内容」与「Worker 还能应答」。真正昂贵的漂移类型——发了个旧版本、静态资源绑定坏了、CSP 收窄到把 blob 挡了——在它眼里全是绿的。
2. **只做无凭据 smoke test，不引入 `SITE_PASSWORD`**（最强理由：站点密码不进 GitHub secrets，攻击面更小）。放弃原因：没有会话就取不到任何被门保护的内容（`/src/*.js` 全是 401），字节比对这一层立不起来，而那正是唯一能发现漂移的证据。用「多一个只读校验用的 secret」换这一层是划算的。
3. **比对本地工作区文件而不是 git blob**（最强理由：一句话写完，不用起 `git` 子进程）。放弃原因：`core.autocrlf=true` 下结论会变成噪声（21/21 假不一致），恒红的门禁等于没有门禁。
4. **继续把新鲜度预检留在会话里的临时脚本**（最强理由：已经写好了，立刻可用）。放弃原因：临时脚本不构成可复用、可 review 的门禁；它的有效检查项已经移植进仓库脚本。
5. **用 Cloudflare 部署 API 查当前版本号再比对构建元数据**（最强理由：直接问「线上是哪个版本」，不必下载全部资源，也更快）。放弃原因：这个账号上 `wrangler deployments list` 只显示 2026-09-09 的一条旧记录（versions-based 部署不落那张表），拿不到可信的当前版本；而且「版本号对」不等价于「资源内容对」。比字节是唯一不依赖平台元数据可信性的做法。

## Consequences

- 收益：自动发布从「发出去就算」变成「发出去并自证」。坏发布在发布工作流里当场变红，不用等到有人发现线上不对。
- 收益：校验跑在公网、用真实会话与真实 CSP，覆盖的是发布系统自己的输出面，而不是本地构建产物。
- 代价：发布多约 10–20 秒（一次登录 + assets 目录里每个文件一个请求；`frontend-next` 下是 15 个文件），GitHub secrets 多一个 `SITE_PASSWORD`。轮换 Worker 的 `SITE_PASSWORD` 时 GitHub 侧必须同批改，否则发布会在最后一步红。
- 代价：这一步依赖公网可达性与 Cloudflare 边缘；`workers.dev` 边缘抖动会让发布红掉（3 次重试 + 20s 超时兜底，超出重试预算仍会红）。这是有意的取舍：宁可红，也不要绿着上线。
- 事实：`ci.yml` 不跑这一步——它验的是生产，PR 阶段没有对应的生产可验。
- 事实：脚本只读，不写任何状态；不打印密码，也不把密码落盘。

## Testing

- 本地对生产跑通（当时 assets 根是 `frontend/`，21 个文件）：`SITE_PASSWORD=… node scripts/verify_deploy.mjs --site https://best-ip.silverwolfx.workers.dev` → 7/7 通过（4 项无凭据 + CSRF/会话 2 项 + `21/21 个文件` 逐字节一致）。
- 无密码降级路径：同一命令不带 `SITE_PASSWORD` → 4/4 通过，并明确打印「本次**没有**验证线上内容与 commit 一致」，退出码 0。
- `npm run check` 覆盖 `scripts/*.mjs`（`node --check`），新脚本在语法门禁内。
- 流水线（真实证据）：`SITE_PASSWORD` secret 于 2026-09-21T16:14:42Z 设置；提交 `d764365` 推送后，CI 运行 `35624457863` success，`Deploy Cloudflare Worker` 运行 `35624491765` 于 16:15:57Z 由 `workflow_run` **自动**创建并 success（`Current Version ID: 798e728e-c381-4753-9bd3-449e20c7f831`），其中第 7 步 `Verify deployed release` success：`登录页可达 / CSP 仍放行签名 blob / 未登录访问被会话门挡住 / 静态资源未登录不可读 / 登录页下发 CSRF 令牌 / 登录换取会话 / 线上内容与 HEAD 逐字节一致（21/21 个文件）`，`结果：7/7 项通过`，`SITE_PASSWORD` 在日志里被掩码为 `***`，校验本身耗时约 4.5 秒。
- 宽限逻辑的确定性验证（离线假站点，不在生产上赌）：2/2 通过——A 场景让探针前 2 次 404、第 3 轮才生效，最终照常得到 `7/7` 与 `15/15 个文件` 一致；B 场景让探针永远 404，等满 6 轮后如实判红（`结果：6/7 项通过`，退出码 1，输出含「等满 6 轮仍是 404：按真实漂移处理」）。这条测试存在的意义是证明宽限**只**吸收传播窗口，不会把真漂移吞成绿。假站点按 `git show HEAD:frontend-next/<path>` 逐字节回文件，并复刻了真实登录流程（页面含 `name="csrf"` 字段、下发 `__Host-*` cookie、无会话一律 401）与生产 CSP 头。
- 发布实录（比对根已切到 `frontend-next`，即 15 个文件）：`2a0a280` 的 `worker.yml` run `35742442216` success，版本 `28222f32-f622-49bd-8662-29f26ef3d51d`，第 7 步 7/7 项通过（含「线上内容与 HEAD 逐字节一致（15/15 个文件）」）。上一轮 `6ce88bd` 是这个门禁第一次判红，红因是边缘传播窗口而不是漂移，证伪过程见 [新前端的在线只读通路](../architecture/2026-09-22-frontend-next-online-readonly-gateway.md)。

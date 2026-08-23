# Best IP 当前实现计划与验收账本

> 本文以当前代码为准：后端保留 Coffee、ChatGPT/Codex 探测，默认 8 个节点 worker；前端同时支持本地 FastAPI 和 Cloudflare Worker gateway。订阅凭据只通过忽略的 `.env` 或浏览器到 Worker 的 WebCrypto 密文链路注入，不写入仓库。

## 1. 目标与边界

- 单个任务默认最多 8 个并发节点，`BEST_IP_MAX_PARALLEL_JOBS=2`，进程有效节点上限为 16。
- 每个节点尝试使用独立 Mihomo 进程、工作目录、mixed-port、controller-port、selector、连接池和日志游标；重试前确认进程退出和目录清理。
- Coffee、ChatGPT、Codex 请求均固定经当前节点 mixed-port，HTTP 客户端使用 `trust_env=False`，不提供 direct fallback。
- 每个真实节点必须落一条 success/partial/failed 终态记录；出口 IP、selector 身份、trace/lookup、代理证据和 manifest hash 必须可复核。
- 运行中只返回已持久化的安全摘要；完整详情和导出必须等全部节点写入、manifest 完整校验后开放。
- Cloudflare Worker 同源托管前端和专用 API；生产入口由 Cloudflare Access 单用户策略保护。
- 浏览器不输入 GitHub PAT。订阅 URL 在浏览器端用 AES-256-GCM 加密，再用 RSA-OAEP-3072 包裹 AES key；Worker 只接收绑定 request ID/key ID 的 envelope。
- Worker 通过仅安装到 `silverwolf-x/best-ip` 的 GitHub App 调度固定 `main` 分支 `scan.yml`，读取 Job/Step，代理唯一终态 artifact，并执行取消。
- 本地 FastAPI 仍用于 loopback 开发和正式本地扫描；远程 Worker 模式的节点结果必须等待终态 artifact 完整校验。

## 2. 后端并发实现

### Mihomo 启动

`backend/app/mihomo.py` 使用短生命周期端口分配锁和进程内 reservation set。锁只覆盖两个 OS-free 端口的选择和 reservation；YAML 写入、日志打开、进程 spawn 和 readiness 等待在锁外运行。取消时会等待已经提交的同步配置/文件线程结束，再停止进程或释放 reservation，避免后台线程与清理竞态。

### Job worker pool

`backend/app/jobs.py` 使用每任务固定大小的 `asyncio.Queue` worker pool，而不是为每个节点先创建 task 再等待 semaphore。每个 worker 内的 retry 串行，最多 `max_node_attempts` 次；active/peak metrics 在 `try/finally` 中维护。ResultStore 的初始化、节点写入、进度、manifest、导出相关同步 I/O 移出事件循环，并在取消期间等待已启动的线程操作完成。

运行中摘要由 manager 内存 cache 提供，只有节点原子写入成功后才发布摘要和递增计数。进度写入按 job 加锁，并对非终态写入做 200ms coalescing；终态强制写入。完成态仍从磁盘重新读取所有节点，校验字段、状态、出口 IP、代理证据、文件大小和 SHA-256 后才生成 manifest。

### Scanner

`CoffeeCollector` 保留原有页面/trace 依赖、lookup、global ping、portscan、pingcheck、related 轮询和 ChatGPT/Codex 探测，只增加每节点连接池上限；不以性能名义删除探测或放宽 URL allowlist。

## 3. 前端与 GitHub Actions

### Worker gateway 与 Actions 密文 dispatch

- 页面使用同源 Worker API；`frontend/action-client.js` 不读取或发送 GitHub 用户凭据。
- 每次请求生成 request ID、AES-256-GCM key/IV 和 15 分钟 envelope；AAD 绑定 request ID、key ID 和过期时间，RSA-OAEP 使用 SHA-256 包裹 AES key。
- Worker 通过 Cloudflare Access 校验允许邮箱，再由 GitHub App JWT 换取仅限 `silverwolf-x/best-ip` 的 installation token；workflow input 不携带明文 URL、PAT 或代理凭据。
- `scan-public.pem` 的 SPKI DER SHA-256 指纹必须等于 Worker 动态 `/site-config.js` 与 Actions variable `SCAN_KEY_ID`。
- Actions 通过 `SCAN_PRIVATE_KEY_PEM` 在 runner 临时目录解密，错误输出不包含明文；清理步骤删除私钥、订阅和运行目录。

### 精确关联与 artifact

- workflow 仅 `workflow_dispatch`，固定 `main` ref，单一 concurrency group，30 分钟超时。
- Worker 只接受 exact request ID 的 run title、workflow path、workflow_dispatch event、main branch、创建时间窗口和唯一 run/attempt。
- artifact 名称绑定 request ID、run ID、run attempt，保留 1 天；Worker 只代理未过期且唯一的匹配 artifact。
- sanitizer 只写 `status.json` 和 `result.json`，并拒绝 URL query/path token、凭据字段和凭据值；结果 JSON 的实际 UTF-8 bytes SHA-256 写入 status。
- 浏览器 ZIP reader 限制压缩/解压大小，拒绝目录、路径穿越、重复文件、加密 ZIP、不支持算法、CRC 错误和解压炸弹；随后校验 result digest、manifest summaries、节点 identity、状态计数和可用性。
- Actions Job/Step 是扫描期间唯一的实时进度；节点计数在终态 artifact 之前显示等待状态，不能伪造为 `0/0`。

## 4. 已验证性能证据

同一 `.env` 注入的订阅 URL、同一 22 节点快照口径：

| 版本 | worker | 三次 wall 秒 | 中位数 | 节点/s 中位数 | 状态 | peak | cleanup |
|---|---:|---|---:|---:|---|---:|---|
| HEAD 基线 | 4 | 36.238 / 34.989 / 27.105 | 34.989 | 0.6288 | 22 success，0 partial，0 failed，0 retry | 4 | true |
| 优化后最新复测 | 8 | 20.320 / 17.351 / 18.301 | 18.301 | 1.2021 | 2 次 22 success；1 次 21 success + 1 partial；0 failed，0 retry | 8 | true |

中位数 wall speedup = `34.989 / 18.301 = 1.912x`，节点吞吐比约 `1.912x`。优化结果同时记录了 `prepare/start/select/collect/stop/write/finalize` phase metrics；外部节点网络有波动，不能把单次失败误报成提速。

## 5. 验证命令

```powershell
uv run ruff check .
uv run pytest -q
node --check frontend/app.js
node --check frontend/action-client.js
node --check frontend/zip-reader.js
node --check scripts/decrypt_subscription.mjs
node --test tests/frontend_modules.test.mjs
git diff --check
```

真实本地闭环使用被忽略的 `.env`，不把订阅 URL 写进命令行：

```powershell
uv run --env-file .env python scripts/verify_real_scan.py
```

性能复测需显式指定非敏感 API 地址：

```powershell
$env:BEST_IP_API_BASE = 'http://127.0.0.1:8765'
uv run --env-file .env python scripts/benchmark_scan.py --label optimized-8 --warmup 1 --runs 3
```

## 6. Worker 生产发布与验收清单

- [x] Worker gateway 代码、前端同源 API、GitHub App 调度、Access 校验、Job/Step 状态和 artifact 完整校验已实现。
- [x] 本地门禁已通过：`uv run pytest -q`、`uv run ruff check .`、`npm test`、`npm run dry-run`、`git diff --check`。
- [ ] 将迁移提交通过 PR 合并到默认 `main`；PR 必须通过 Python、Node、Worker tests 和 Wrangler dry-run，且不包含 `C.md` 或本地 settings 修改。
- [ ] 配置 GitHub App：仅 `Metadata: read` 与 `Actions: read/write`，且只安装到 `silverwolf-x/best-ip`；将 App ID、Installation ID、PEM 写入 Worker secrets 后删除临时 PEM。
- [ ] 配置 GitHub Actions 的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，确认 main push 的 Worker deployment workflow 成功。
- [ ] 在 Access 浏览器会话中验证 Worker `/api/health`、动态 `/site-config.js` 和无 PAT 页面。
- [ ] 完成两次真实浏览器验收：一次成功扫描（Job/Step、唯一 artifact、ZIP/manifest/results/export），一次已建立 run 后取消（GitHub cancelled、无完成 artifact/manifest）。
- [ ] 成功与取消验收均通过后，关闭旧 GitHub Pages 设置并确认 Worker 是唯一生产入口。

## 7. 发布回滚与已知限制

- PR/CI、App、secret 或 Worker 部署失败时不关闭 Pages；Worker 运行时可回滚到上一已知版本，代码回滚使用 revert PR，不直接推送 `main`。
- 真实 E2E 只能由 Access 登录浏览器证明；本地 mock 测试和 GitHub CLI 只能作为契约/平台侧佐证，不能替代浏览器的同源 WebCrypto、Job/Step UI、artifact 下载和取消链路。
- artifact 只保留 1 天；成功验收应保存脱敏的 run/artifact 关联信息，禁止保存 scan token、Access cookie/JWT、App token、私钥或订阅 URL。

不要提交或修改用户的 `C.md`。不要把 `.env`、私钥、runtime/jobs、runtime/results、Mihomo 日志或原始配置加入仓库、Pages bundle、workflow artifact 或公开日志。

# Best IP 当前实现计划与验收账本

> 本文以当前代码为准：后端保留 Coffee、ChatGPT/Codex 探测，默认 8 个节点 worker；前端同时支持本地 FastAPI 和 GitHub Pages 静态模式。订阅凭据只通过忽略的 `.env` 或浏览器到 Actions 的密文链路注入，不写入仓库。

## 1. 目标与边界

- 单个任务默认最多 8 个并发节点，`BEST_IP_MAX_PARALLEL_JOBS=2`，进程有效节点上限为 16。
- 每个节点尝试使用独立 Mihomo 进程、工作目录、mixed-port、controller-port、selector、连接池和日志游标；重试前确认进程退出和目录清理。
- Coffee、ChatGPT、Codex 请求均固定经当前节点 mixed-port，HTTP 客户端使用 `trust_env=False`，不提供 direct fallback。
- 每个真实节点必须落一条 success/partial/failed 终态记录；出口 IP、selector 身份、trace/lookup、代理证据和 manifest hash 必须可复核。
- 运行中只返回已持久化的安全摘要；完整详情和导出必须等全部节点写入、manifest 完整校验后开放。
- GitHub Pages 在没有后端时仍可导入 JSON/CSV、筛选、查看详情和导出；输入订阅后用临时 Fine-grained PAT dispatch Actions。

## 2. 后端并发实现

### Mihomo 启动

`backend/app/mihomo.py` 使用短生命周期端口分配锁和进程内 reservation set。锁只覆盖两个 OS-free 端口的选择和 reservation；YAML 写入、日志打开、进程 spawn 和 readiness 等待在锁外运行。取消时会等待已经提交的同步配置/文件线程结束，再停止进程或释放 reservation，避免后台线程与清理竞态。

### Job worker pool

`backend/app/jobs.py` 使用每任务固定大小的 `asyncio.Queue` worker pool，而不是为每个节点先创建 task 再等待 semaphore。每个 worker 内的 retry 串行，最多 `max_node_attempts` 次；active/peak metrics 在 `try/finally` 中维护。ResultStore 的初始化、节点写入、进度、manifest、导出相关同步 I/O 移出事件循环，并在取消期间等待已启动的线程操作完成。

运行中摘要由 manager 内存 cache 提供，只有节点原子写入成功后才发布摘要和递增计数。进度写入按 job 加锁，并对非终态写入做 200ms coalescing；终态强制写入。完成态仍从磁盘重新读取所有节点，校验字段、状态、出口 IP、代理证据、文件大小和 SHA-256 后才生成 manifest。

### Scanner

`CoffeeCollector` 保留原有页面/trace 依赖、lookup、global ping、portscan、pingcheck、related 轮询和 ChatGPT/Codex 探测，只增加每节点连接池上限；不以性能名义删除探测或放宽 URL allowlist。

## 3. 前端与 GitHub Actions

### Pages

- `frontend/index.html`、CSS、JS 使用项目相对路径，适配 `/best-ip/`。
- `site-config.js` 只含仓库、workflow、分支、公钥路径和 key ID 等非秘密元数据。
- Pages host 自动使用 Actions provider；localhost/127.0.0.1 仍使用本地 FastAPI provider。
- PAT 只在页面内存中保存；主题是唯一允许写 localStorage 的值。订阅输入在 dispatch 后清空，并提供显式 PAT 清除操作。

### 密文 dispatch

- 每次请求生成 request ID、AES-256-GCM key/IV 和 15 分钟 envelope。
- envelope 的 AAD 绑定 request ID、key ID、过期时间；RSA-OAEP 使用 SHA-256 包裹 AES key。
- workflow input 不携带明文 URL、PAT 或代理凭据。
- `scan-public.pem` 的 SPKI DER SHA-256 指纹必须等于 `site-config.js` 与 Actions variable `SCAN_KEY_ID`。
- Actions 通过 `SCAN_PRIVATE_KEY_PEM` 在 runner 临时目录解密，错误输出不包含明文。

### 精确关联与 artifact

- workflow 仅 `workflow_dispatch`，固定 `main` ref，单一 concurrency group，30 分钟超时。
- 页面只接受 exact request ID 的 run name、workflow_dispatch event、main branch、创建时间窗口和唯一 run；不按最新 run 猜测。
- artifact 名称绑定 request ID、run ID、run attempt，保留 1 天。
- sanitizer 只写 `status.json` 和 `result.json`，并拒绝 URL query/path token、凭据字段和凭据值；结果 JSON 的实际 UTF-8 bytes SHA-256 写入 status。
- 浏览器 ZIP reader 限制压缩/解压大小，拒绝目录、路径穿越、重复文件、加密 ZIP、不支持算法、CRC 错误和解压炸弹；随后校验 result digest、manifest summaries、节点 identity、状态计数和可用性。
- workflow 使用用户选择的 major action tags（如 checkout@v4、upload-artifact@v4），不把 PAT 交给 workflow。

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

## 6. 发布前清单

- [x] 用 `gh` 配置 `SCAN_PRIVATE_KEY_PEM`、`SCAN_KEY_ID`，只提交公钥；配置 Pages source 为 GitHub Actions。
- [x] 推送 `main` 后检查 `https://silverwolf-x.github.io/best-ip/` 的相对资源；首页、CSS、JS、公钥资源均 HTTPS 200，静态导入代码已由本地 Node 测试覆盖。
- [x] 使用密文 workflow input 完成一次真实 Actions scan rerun：run `32552269467` attempt `2` 成功，artifact 精确匹配并验收为 22/22 success、manifest/digest/敏感字段校验通过；该步骤使用 GitHub CLI 会话，不等价于浏览器内 Fine-grained PAT 输入。
- [ ] 使用短期仓库级 PAT 做真实 Pages-origin dispatch、精确 run polling、artifact 下载、ZIP 校验、表格/详情/导出，并在完成后撤销 PAT。
- [ ] 在真实浏览器验证 GitHub API artifact 的重定向下载是否允许 Pages origin CORS；若失败，必须报告为平台限制，不增加未批准的外部 broker。
- [x] 已删除仓库外临时私钥和 E2E helper；用户已有的 `.env` 与未跟踪 `C.md` 未擅自删除或修改。

## 7. 已知限制

- PAT 仍可被当前页面、浏览器扩展、DevTools 或 XSS 读取，必须短期、仓库 scoped、用后撤销。
- GitHub 会保存 workflow input 的密文历史；私钥泄露会使历史密文具备解密风险，因此 envelope 过期和 key rotation 必须执行。
- 每个 Mihomo 实例加载完整代理定义，8 worker 会增加 CPU/RSS；资源受限机器可通过环境变量下调。
- Actions 只提供 workflow 级进度，不能在无外部状态服务时伪造逐节点实时进度。
- artifact 只保留 1 天；用户应在完成后导出结果。
- Pages artifact 的 GitHub signed-redirect CORS 行为仍需真实 Pages origin 浏览器验收，本地 curl/Node 不能替代该门禁。

## 8. 工作树约束

不要提交或修改用户的 `C.md`。不要把 `.env`、私钥、runtime/jobs、runtime/results、Mihomo 日志或原始配置加入仓库、Pages bundle、workflow artifact 或公开日志。

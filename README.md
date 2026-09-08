# Best IP

Cloudflare Worker 托管前端与同源 API，通过 GitHub App 调度固定的 GitHub Actions `scan.yml`。Actions runner 使用独立 Mihomo 工作区并发检测订阅节点，生成经过脱敏和完整性校验的短期 artifact；浏览器只在 artifact 完整通过 ZIP、CRC、SHA-256、运行身份、manifest 和节点记录校验后展示结果。

本仓库只支持这一条生产路径：

```text
浏览器
  └─ Cloudflare Access
      └─ Cloudflare Worker + Static Assets
          └─ GitHub App → GitHub Actions scan.yml
              ├─ Mihomo 节点扫描
              └─ sanitized artifact → Worker → 浏览器
```

Python FastAPI 仅是 `scan.yml` 在临时 runner 内部使用的 loopback 扫描接口，不是独立部署入口。仓库不再提供 Docker、Compose、本地浏览器直连 FastAPI 或 GitHub Pages 模式。

## 生产行为

- 输入必须是顶部含 `proxies` 的 UTF-8 Mihomo/Clash YAML 公开 HTTP/HTTPS 地址。
- 浏览器使用 AES-256-GCM 加密订阅 URL，再用 `frontend/scan-public.pem` 对应的 RSA-OAEP-3072 公钥包裹 AES key；明文 URL 不进入 Worker API、GitHub workflow input 或 artifact。
- Worker 固定调度 `silverwolf-x/best-ip` 的 `main` 分支和 `scan.yml`，不提供通用 GitHub API 代理。
- 每个节点尝试使用独立 Mihomo 进程、端口、连接池和临时目录；默认最多 8 个节点并发，每节点最多 3 次尝试。
- Coffee 页面与 trace 并行；确认出口 IP 后，lookup、global ping、portscan、pingcheck、related、IPure 评分及 ChatGPT/Codex 探测按既定依赖并发执行。
- mixed-port 与 controller 只监听 `127.0.0.1`；Coffee 与 IPure 请求固定 `trust_env=False`、禁用重定向且不提供 direct fallback。
- 每个真实节点恰好产生一条 `success`、`partial` 或 `failed` 记录。失败记录的 `exit_ip` 必须为 JSON `null`。
- 节点文件原子写入；只有节点集合、字段、状态、出口 IP、代理证据、文件大小和 SHA-256 全部通过后才生成 manifest。
- Actions 运行期间前端只显示 Job/Step，不伪造节点 `0/0` 进度；节点统计以终态 artifact 为唯一事实源。

## 部署

要求：Node.js 22、npm，以及一个已启用 Workers 的 Cloudflare 账户。

```powershell
npm ci
npm test
npm run dry-run
npm run deploy
```

也可以把以下 GitHub Actions secrets 配好后推送 `main`，由 `.github/workflows/worker.yml` 自动发布：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Worker 使用 Static Assets 托管 `frontend/`；当前配置不使用 Cloudflare Pages 或 GitHub Pages。

## 平台配置

1. 创建 GitHub App，只授予当前仓库 `Actions: Read and write` 与 `Metadata: Read`，并只安装到 `silverwolf-x/best-ip`。
2. 在 Cloudflare Access 为 Worker hostname 建立单用户策略，只允许指定邮箱。
3. 配置 Worker secrets/variables：

   - `SCAN_KEY_ID`：`frontend/scan-public.pem` 的 SPKI DER SHA-256 指纹。
   - `GITHUB_APP_ID`
   - `GITHUB_APP_INSTALLATION_ID`
   - `GITHUB_APP_PRIVATE_KEY`
   - `SCAN_TOKEN_SECRET`
   - `ACCESS_TEAM_DOMAIN`
   - `ACCESS_POLICY_AUD`
   - `ACCESS_ALLOWED_EMAIL`

4. 配置 Actions secret `SCAN_PRIVATE_KEY_PEM`，并配置 Actions variable `SCAN_KEY_ID`。

缺少任一生产配置时 Worker 失败关闭。scan token 有效期两小时，只存在页面内存并通过 `X-Best-IP-Scan-Token` 请求头发送，不进入 URL 或 localStorage。

## API

除健康检查外，所有请求都需要内存中的 scan token；状态变更还需要同源 Origin/Fetch-Metadata。

```http
POST /api/scans
GET /api/scans/{request_id}?run_id={run_id}
GET /api/scans/{request_id}/artifact?run_id={run_id}&run_attempt={attempt}
DELETE /api/scans/{request_id}?run_id={run_id}
GET /api/health
```

Worker 会精确核对 request ID、workflow path、事件、分支、run/attempt、创建时间窗和唯一 artifact 名称。artifact 只保留 1 天。

## 验证

```powershell
uv sync --dev
uv run ruff check .
uv run pytest -q
npm ci
npm test
npm run dry-run
git diff --check
```

`scan.yml` 的生产运行只安装锁定的运行时依赖，并缓存已固定 SHA-256 的 Mihomo 压缩包；缓存命中后仍重新校验摘要再解压。

## 配置

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `BEST_IP_MIHOMO_PATH` | `runtime/mihomo/mihomo(.exe)` | Mihomo 核心路径 |
| `BEST_IP_MAX_NODES` | `500` | 单订阅真实节点上限 |
| `BEST_IP_MAX_PARALLEL_JOBS` | `2` | runner 内同时运行的扫描任务数 |
| `BEST_IP_MAX_PARALLEL_NODES` | `8` | 单任务并发节点数 |
| `BEST_IP_MAX_NODE_ATTEMPTS` | `3` | 单节点最大尝试次数 |
| `BEST_IP_NODE_RETRY_BACKOFF_MS` | `500` | 重试基础退避毫秒数 |
| `BEST_IP_PAGE_TIMEOUT_MS` | `45000` | 单次节点采集预算；IPure 查询单独限制为最多 30 秒并与其他请求并发 |
| `BEST_IP_SUBSCRIPTION_MAX_BYTES` | `5242880` | 订阅最大字节数 |
| `BEST_IP_SUBSCRIPTION_TIMEOUT_SECONDS` | `30` | 订阅下载超时 |

## 已知限制

- 只支持顶部含 `proxies` 列表的 Mihomo YAML；不支持 URI 列表或只有远程 `proxy-providers` 的配置。
- 如果全部节点服务器都是域名且没有可用的字面 IP 引导节点，严格 DNS 隔离可能导致节点明确失败，不会回退宿主代理。
- Coffee 接口以及 IPure 报告页结构、字段和限流属于外部服务，改版时必须同步 URL allowlist、解析器与契约测试。
- Cloudflare Worker 不执行扫描本身；扫描延迟仍包含 GitHub Actions 排队、runner 初始化、Mihomo 启动和节点网络耗时。

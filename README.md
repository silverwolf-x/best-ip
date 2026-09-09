# Best IP

Cloudflare Worker 托管前端与同源 API，通过 GitHub App 调度固定的 GitHub Actions `scan.yml`。Actions runner 使用独立 Mihomo 工作区并发检测订阅节点，生成经过脱敏和完整性校验的短期 artifact；浏览器只在 artifact 完整通过 ZIP、CRC、SHA-256、运行身份、manifest 和节点记录校验后展示结果。

本仓库只支持这一条生产路径：

```text
浏览器
  └─ 访问密码登录（签名 Cookie）
      └─ Cloudflare Worker + Static Assets
          └─ GitHub App → GitHub Actions scan.yml
              ├─ Mihomo 节点扫描
              └─ sanitized artifact → Worker → 浏览器
```

生产扫描由 `scan.yml` 直接运行 `scripts/run_scan.py`，不启动 FastAPI。FastAPI 仅用于本地 loopback API：独立静态服务提供页面，前后端分离。仓库不提供 Docker、Compose 或 GitHub Pages 模式。

## 本地调试

结果默认采用 Coffee 风格的双列节点卡片，小屏幕自动切换为单列；可切换到表格进行逐列筛选和排序。两种视图使用相同结果，点击节点名称查看完整详情，导入、导出与完整性校验保持不变。

本地调试模式复用同一套 Mihomo、扫描器、结果存储和前端，只替换任务传输层；启动器分别运行前端静态服务与 FastAPI API。生产环境仍使用 Cloudflare Worker → GitHub Actions，保留密码登录、密文订阅与 artifact 校验。

安装 [uv](https://docs.astral.sh/uv/) 后，在仓库根目录运行：

```powershell
npm run dev
```

也可以不经过 npm：

```powershell
uv run --no-dev python scripts/dev.py
```

首次启动会自动下载当前固定版本的 Mihomo；前端默认监听 `127.0.0.1:5173`，后端 API 默认监听 `127.0.0.1:8000`，端口占用时各自自动选择空闲端口。准备就绪后浏览器只打开前端地址，前端通过动态的 loopback API Base 调用后端。Windows 下自动关闭后端热重载，因为 Uvicorn 的重载模式使用不支持异步子进程的 SelectorEventLoop，会导致 Mihomo 无法启动；修改后端代码后需重启。其他系统默认启用热重载；需要稳定执行长扫描时使用：

```powershell
npm run dev:no-reload
```

可用 `--port 8080` 更换后端 API 端口、`--frontend-port 5174` 更换前端端口、`--no-open` 禁止自动打开浏览器。手动启动时必须同时设置 `BEST_IP_LOCAL_DEV=1` 与精确的 `BEST_IP_LOCAL_FRONTEND_ORIGIN=http://127.0.0.1:<前端端口>`；不要将任一服务绑定到局域网或公网地址，因为本地模式有意跳过生产 Worker 的密码登录与 scan token，只用于本机调试。

固定正式版本（如 `v1.19.30`）安装遇到 GitHub API `403`/`429` 时，自动改用官方 Release 直链，不依赖第三方镜像。`latest` 与非标准 tag 不猜测下载地址。设置 `BEST_IP_MIHOMO_ARCHIVE_SHA256` 可强制校验归档；回退时若未指定摘要，则仅依赖官方 HTTPS，计算出的 SHA-256 不代表真实性校验。已有核心可通过 `BEST_IP_MIHOMO_PATH` 指定路径，跳过下载。

## 生产行为

- 输入必须是顶部含 `proxies` 的 UTF-8 Mihomo/Clash YAML 公开 HTTP/HTTPS 地址。
- 浏览器使用 AES-256-GCM 加密订阅 URL，再用 `frontend/scan-public.pem` 对应的 RSA-OAEP-3072 公钥包裹 AES key；明文 URL 不进入 Worker API、GitHub workflow input 或 artifact。
- Worker 固定调度 `silverwolf-x/best-ip` 的 `main` 分支和 `scan.yml`，不提供通用 GitHub API 代理。
- 每个节点尝试使用独立 Mihomo 进程、端口、连接池和临时目录；默认最多 8 个节点并发，每节点最多 3 次尝试。
- Coffee 页面与 trace 并行；确认出口 IP 后，lookup、global ping、portscan、pingcheck、related、IPure 官方 `/api/lookup` 评分及 ChatGPT/Codex 探测按既定依赖并发执行。IPure 总分或四项场景评分缺失时，节点会如实标记为“部分”。
- IPure 每次实际 HTTP 请求（包括代理、重试和直连查询）都会重新读取 `config/ipure.yml` 的 `headers`，修改后无需重启。文件保存浏览器请求头与 `ipure_verified` Cookie，已排除出 Git；无凭据示例见 `config/ipure.example.yml`。未配置的请求头使用 JSON / `MyIPChecker/1.0` 默认值；仅在 YAML 未指定 Cookie 时兼容 `BEST_IP_IPURE_COOKIE`。代理查询遇到 `429` 最多尝试 3 次，按 1、2 秒退避并遵守秒数形式的 `Retry-After`，等待不会超出查询时间预算。`429` 不切换出口重试，`403` 不盲目重试。
- mixed-port 与 controller 只监听 `127.0.0.1`；所有请求固定 `trust_env=False` 并禁用重定向。IPure 对未缓存 IP 要求人机验证；配置 `BEST_IP_IPURE_COOKIE` 后，代理请求被验证墙拒绝时会使用该已验证会话直连查询，并在结果中明确标记 `direct_fallback`。
- 每个真实节点恰好产生一条 `success`、`partial` 或 `failed` 记录。失败记录的 `exit_ip` 必须为 JSON `null`。
- 节点文件原子写入；只有节点集合、字段、状态、出口 IP、代理证据、文件大小和 SHA-256 全部通过后才生成 manifest。
- Actions 运行期间前端只显示 Job/Step，不伪造节点 `0/0` 进度；节点统计以终态 artifact 为唯一事实源。

## 部署

推荐使用 Cloudflare Workers Builds：在现有 Worker 的 Settings → Builds 连接 GitHub 仓库，生产分支选 `main`，根目录留空，Build command 留空，Deploy command 填 `npx wrangler deploy`，Preview deploy command 填 `npx wrangler versions upload`，构建变量设 `NODE_VERSION=22`。依赖安装由构建机处理，本机只需提交并推送代码。

Worker 没有第三方运行时 npm 依赖；密码会话和 GitHub App RS256 签名都使用原生 Web Crypto。`package.json` 与锁文件保留模块声明、测试命令和 Wrangler 部署工具。

也可在安装 Node.js 22 和 npm 的电脑上手动部署：

```powershell
npm ci
npm test
npm run dry-run
npm run deploy
```

备用部署工作流 `.github/workflows/worker.yml` 仅支持手动触发，避免与 Workers Builds 重复部署。使用该备用工作流需要以下 GitHub Actions secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Worker 使用 Static Assets 托管 `frontend/`；当前配置不使用 Cloudflare Pages 或 GitHub Pages。

## 平台配置

1. 创建 GitHub App，只授予当前仓库 `Actions: Read and write` 与 `Metadata: Read`，并只安装到 `silverwolf-x/best-ip`。
2. 在 Worker 的 Settings → Variables and Secrets 添加 Secret `SITE_PASSWORD`：使用密码管理器生成至少 16 个字符的随机密码（最多 1024 字符）。无需 Cloudflare Access；如果之前启用了 Worker 域名的 Access 保护，请关闭该保护，并移除覆盖该域名的 Zero Trust Access Application。原来的三个 `ACCESS_*` 变量可以删除。
3. 配置 Worker secrets/variables：

   - `SCAN_KEY_ID`：`frontend/scan-public.pem` 的 SPKI DER SHA-256 指纹。
   - `GITHUB_APP_ID`
   - `GITHUB_APP_INSTALLATION_ID`
   - `GITHUB_APP_PRIVATE_KEY`
   - `SCAN_TOKEN_SECRET`
   - `SITE_PASSWORD`

4. 配置 Actions secrets `SCAN_PRIVATE_KEY_PEM`、`IPURE_CONFIG_YAML`，并配置 Actions variable `SCAN_KEY_ID`。`IPURE_CONFIG_YAML` 保存与本地 `config/ipure.yml` 相同的完整 YAML 内容；Actions 扫描前生成该文件，结束时清理，不上传到结果 artifact。Worker 仅调度扫描，不查询 IPure，也不向前端提供 Cookie。可用 `gh secret set IPURE_CONFIG_YAML --repo silverwolf-x/best-ip < config/ipure.yml` 同步本地配置到云端。Cookie 过期后需更新本地 YAML 并重新同步 Secret；修改本地文件不会自动更新 GitHub Secret。

打开网站后输入访问密码。登录会话有效期 12 小时，保存在 Secure、HttpOnly、SameSite=Strict 的主机专属 Cookie 中；页面提供退出登录入口。修改 `SITE_PASSWORD` 或 `SCAN_TOKEN_SECRET` 后旧会话失效。退出登录清除当前浏览器 Cookie，其他浏览器的会话不受影响。密码和签名密钥只放 Worker 运行时 Secrets，不放 Build variables 或仓库。

登录接口为 `POST /login`，没有内置分布式尝试次数限制；如需限制在线猜测，可在 Cloudflare 为该路径配置限流规则。缺少登录配置时 Worker 返回 503；扫描配置在调用扫描功能时检查。scan token 有效期两小时，只存在页面内存并通过 `X-Best-IP-Scan-Token` 请求头发送，不进入 URL 或 localStorage。

## API

除登录、退出页面及登录样式外，所有生产请求都需要密码登录会话。浏览器页面导航未登录时跳转 `/login`，API 未登录时返回 401。创建扫描时签发 scan token，不要求预先持有 token；后续查询、下载和取消请求需要内存中的 scan token。状态变更（包括登录和退出）还需要同源 Origin/Fetch-Metadata。

```http
POST /api/scans
GET /api/scans/{request_id}?run_id={run_id}
GET /api/scans/{request_id}/artifact?run_id={run_id}&run_attempt={attempt}
DELETE /api/scans/{request_id}?run_id={run_id}
GET /api/health
```

Worker 会精确核对 request ID、workflow path、事件、分支、run/attempt、创建时间窗和唯一 artifact 名称。artifact 只保留 1 天。

## 验证

仓库保留运行源码、部署配置、依赖锁文件和回归测试；本地工具状态、凭据、Mihomo 二进制和扫描结果不进入 Git。本地启动使用 `--no-dev`，不安装 pytest、Ruff 等测试工具。生产 CLI 用法见 [docs/CLI.md](docs/CLI.md)，接口与结果格式见 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

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

真实订阅集成测试不会把订阅地址写入仓库，运行前通过环境变量注入：

```powershell
$env:RUN_REAL_SUBSCRIPTION = "1"
$env:BEST_IP_REAL_SUBSCRIPTION_URL = "https://example.invalid/subscription?token=..."
uv run pytest tests/test_real_subscription.py::test_real_subscription_download_and_parse -q
```

完整本地扫描验收还需要先启动 `127.0.0.1:8000` 的 API，并设置 `RUN_REAL_LOCAL_SCAN=1`；若 IPure 返回人机验证，需额外提供已验证的 `BEST_IP_IPURE_COOKIE`。

## 配置

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `BEST_IP_MIHOMO_PATH` | `runtime/mihomo/mihomo(.exe)` | Mihomo 核心路径 |
| `BEST_IP_MAX_NODES` | `500` | 单订阅真实节点上限 |
| `BEST_IP_MAX_PARALLEL_JOBS` | `2` | runner 内同时运行的扫描任务数 |
| `BEST_IP_MAX_PARALLEL_NODES` | `8` | 单任务并发节点数 |
| `BEST_IP_MAX_NODE_ATTEMPTS` | `3` | 单节点最大尝试次数 |
| `BEST_IP_NODE_RETRY_BACKOFF_MS` | `500` | 重试基础退避毫秒数 |
| `BEST_IP_PAGE_TIMEOUT_MS` | `45000` | 单次节点采集预算；IPure 查询单独限制为最多 8 秒并与其他请求并发 |
| `BEST_IP_SUBSCRIPTION_MAX_BYTES` | `5242880` | 订阅最大字节数 |
| `BEST_IP_SUBSCRIPTION_TIMEOUT_SECONDS` | `30` | 订阅下载超时 |
| `BEST_IP_IPURE_COOKIE` | 空 | 浏览器在 IPure 官网完成人机验证后得到的完整 Cookie 请求头；仅用于查询未缓存 IP，不写入扫描结果 |

## 已知限制

- 只支持顶部含 `proxies` 列表的 Mihomo YAML；不支持 URI 列表或只有远程 `proxy-providers` 的配置。
- 如果全部节点服务器都是域名且没有可用的字面 IP 引导节点，严格 DNS 隔离可能导致节点明确失败，不会回退宿主代理。
- Coffee 接口以及 IPure `/api/lookup` 的字段和限流属于外部服务，改版时必须同步 URL allowlist、解析器与契约测试。
- IPure 未缓存 IP 的评分依赖官方人机验证会话；未配置有效 `BEST_IP_IPURE_COOKIE` 时无法合法生成该第三方的总分和四项场景评分。
- Cloudflare Worker 不执行扫描本身；扫描延迟仍包含 GitHub Actions 排队、runner 初始化、Mihomo 启动和节点网络耗时。

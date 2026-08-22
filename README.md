# Best IP

通过独立工作区 Mihomo 实例有界并发检测订阅节点，只经各自的本地 mixed-port 访问 `ip.net.coffee` IP 页面及其明确的同源结构化接口。后端为每个真实节点写入原子 JSON；前端在轮询中立即展示已完成节点的安全摘要，全部节点校验后再生成 `manifest.json`，详情与导出仍以最终 manifest 为门禁。

## 核心行为

- 输入必须是顶部含 `proxies` 的 UTF-8 Mihomo/Clash YAML 公开订阅地址。
- 订阅 metadata（流量、重置、到期等信息项）不会作为节点；每个真实节点恰好产生一条成功、部分或失败终态记录。
- 每个并发节点最多执行 `BEST_IP_MAX_NODE_ATTEMPTS` 次；每次尝试都使用新的 Mihomo 进程、mixed-port、controller、连接池和临时工作目录，失败实例完整退出并清理后才退避重试。每个实例只暴露当前检测节点，同时保留完整代理定义以支持节点间拨号依赖。
- 单节点内，页面与 trace 并行请求；取得并核验出口 IP 后，global ping、portscan、pingcheck 和 related 查询并行调度，related 的轮询仍按顺序执行。
- Mihomo mixed-port 和 controller 只监听 `127.0.0.1`，selector 切换后由 Controller GET 确认实际节点身份；并发 worker 只在端口分配阶段持有短锁，配置写入、进程启动和 readiness 等待可以重叠，避免把 8 个 worker 串行化。
- Windows worker 会从活动 IPv4 默认路由中自动选择物理网卡，并通过 Mihomo 顶层 `interface-name` 绑定所有出站套接字；可用 `BEST_IP_OUTBOUND_INTERFACE` 显式覆盖，无法确认物理出口时失败关闭，不回落到本机 TUN。
- Coffee 业务客户端固定 `trust_env=False`、禁用重定向，并且只允许 `https://ip.net.coffee` 的页面、trace、lookup、related、被动 portscan、pingcheck 和固定八地 global ping 路径；在当前节点 mixed-port 上并行探测 ChatGPT 与 Codex 可用性，并把结果作为节点字段保存。
- GPT/Codex 探测只经当前 Mihomo mixed-port，并受现有国家/地区限制与 allowlist 约束；不会为了性能优化而删除已有探测字段。
- 不执行 Coffee 页面 JavaScript，因此不会触发页面中的第三方外链；ChatGPT/Codex 仅按 scanner allowlist 经当前 Mihomo mixed-port 探测，结果不扩展到其他站外数据源。
- 节点扫描阶段不做 Coffee 的宿主 DNS、固定 IP 连接或 direct fallback；所有 Coffee HTTP 请求都交给当前 Mihomo mixed-port。
- 失败节点的 `exit_ip` 始终为 JSON `null`；后端只从 Mihomo 日志映射固定、脱敏的 DNS、REALITY、超时、拒绝连接、TLS、连接重置、EOF 或网络不可达原因，不保存原始节点日志。
- 节点扫描不会原样启动订阅中的 `url-test`、`fallback`、通用规则或 DNS 规则；这些配置可能主动探测其他节点、继承宿主 fake-ip 或让 DNS 重新进入规则链，破坏当前 worker 的单节点归属。worker 只复用代理定义，使用固定 IP DoH、`redir-host` 和 Coffee 规则隔离检测流量；域名型节点会选择订阅内服务器为公网字面 IP 的节点作为 `BEST-IP-DNS` 引导代理，重试时轮换引导节点，Coffee 数据面仍只经待测节点。
- 节点文件和进度文件都使用显式字段集合；节点写入、manifest 读取和导出会重新校验记录结构、代理证据、状态/出口 IP 约束、文件大小和 SHA-256。
- `runtime/jobs/<job_id>` 只用于 Mihomo 临时配置和日志；每次重试的子进程退出且尝试目录删除后才允许下一次尝试，所有节点结束且任务目录删除后后端才返回 `cleanup_confirmed=true`。
- 显式 `/ip/{ip}` 页面最终仍调用与当前采集器相同的 `/api/ip/lookup/{ip}`，HTML 摘要字段反而更少；入口服务器 IP 不得冒充出口 IP，因此不增加显式 IP 或站外回显 fallback。

## 结果生命周期

每个任务使用独立目录：

```text
runtime/results/<job_id>/
  nodes/0000.json
  nodes/0001.json
  progress.json
  manifest.json
```

节点文件和进度文件使用同目录临时文件、`flush`、`fsync`、`os.replace` 原子发布。`manifest.json` 只有在节点索引完整、状态/出口 IP 约束、文件大小和 SHA-256 校验都通过后才生成。任务 API 在 manifest 出现前返回进度与已完成节点的安全摘要；单节点详情和导出在此之前返回 HTTP 409。

`runtime/jobs/<job_id>` 只用于 Mihomo 临时配置和日志，任务结束后清理；运行目录不提交 Git。Windows 用户态程序通过 Mihomo 的 `IP_UNICAST_IF`/`IPV6_UNICAST_IF` 出站网卡绑定绕过宿主默认 TUN 路由，但这仍是进程套接字级隔离，不能隔离物理网卡、路由器或其他进程。

## Windows 本地运行

要求：Windows x64、[uv](https://docs.astral.sh/uv/)。

```powershell
uv sync --dev
uv run python scripts/download_mihomo.py
uv run uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000>。前端默认使用同源 `/api/...`，不会自动改写到固定 loopback API；分离开发时请在 HTML 的 `meta[name="api-base"]` 中显式配置后端地址。

## GitHub Pages 与 Actions 扫描

推送 `main` 后，`.github/workflows/pages.yml` 会把 `frontend/` 发布为项目站点：

```text
https://<owner>.github.io/best-ip/
```

Pages 模式仍然是一个可独立使用的静态前端：不填写 PAT 时可以导入此前导出的 JSON/CSV、筛选、查看详情并导出。输入订阅 URL 并开始扫描时，页面要求一个临时的 Fine-grained PAT（仓库 Actions Read and write）：

1. PAT 只保存在当前页面 JavaScript 内存，清除任务/页面后不写入 localStorage、URL、仓库或 artifact。
2. 浏览器使用 WebCrypto 的 AES-256-GCM 加密订阅 URL，再用仓库提交的 RSA-OAEP-3072 公钥包裹 AES key；Actions workflow input 只包含 request ID、key ID 和密文 envelope。
3. Actions 用仓库 Secret `SCAN_PRIVATE_KEY_PEM` 在 runner 临时目录解密，运行后端正式验收，并只上传 `status.json` 与 `result.json`。结果 artifact 保留 1 天，浏览器会校验 request/run identity、SHA-256、ZIP CRC、manifest、节点计数和敏感字段边界。
4. 页面只接受与 request ID、`main` 分支、workflow_dispatch 事件和 run name 完全匹配的运行，不按“最新运行”猜测；结束后会清除 PAT。扫描中只展示 workflow 级状态，不伪造逐节点实时进度。

仓库管理员需要配置：

- Actions Secret `SCAN_PRIVATE_KEY_PEM`：与 `frontend/scan-public.pem` 配对的私钥，只存在 GitHub Secret。
- Actions/Repository variable `SCAN_KEY_ID`：公钥 SPKI DER 的 SHA-256 指纹，必须与 `frontend/site-config.js` 中的 `keyId` 相同。
- Pages source：GitHub Actions。

PAT 是临时授权而不是用户认证；建议只授予当前仓库 Actions 读写、设置短过期时间，并在扫描后立即撤销。GitHub 仍会保存 workflow input 的密文历史，私钥轮换和 envelope 短过期时间是必要的安全边界。

## 验证

```powershell
uv run pytest -q
uv run ruff check .
node --check frontend/app.js
node --check frontend/action-client.js
node --check frontend/zip-reader.js
node --check scripts/decrypt_subscription.mjs
node --test tests/frontend_modules.test.mjs
git diff --check
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

正式订阅闭环（订阅 token 放在 Git 忽略的工作区 `.env`，不写入源码或命令行）：

```powershell
uv run --env-file .env python scripts/verify_real_scan.py
```

脚本会先取得一次订阅快照，并把其 SHA-256 与客户端生成的任务 ID 绑定到创建请求；后端实际下载内容若不同会直接失败。扫描过程中还会核对 `results` 摘要数量始终等于 `completed`。终态时逐节点核对订阅顺序、metadata 数、trace/lookup 出口一致性、selector 和代理证据、manifest 本地文件 hash、完整导出、临时工作目录清理及订阅 URL/节点凭据不泄露；只有 `failed_count=0` 才通过正式可用性验收，不能再用“都有终态记录”掩盖真实节点失败。异常或超时会取消并确认后台任务与 Mihomo 清理终态。`BEST_IP_REAL_SCAN_TIMEOUT_SECONDS` 是从订阅预取到终态 API 核验的总预算；超时后的取消清理另有最多 35 秒安全宽限期，不会被伪装为验收通过。

`BEST_IP_API_BASE` 只能指向与脚本共享当前 `runtime/results` 和 `runtime/jobs` 的本机后端；正式闭环会强制读取本地节点文件重算 hash，因此不支持无共享文件系统的远程或容器后端。

### 性能证据

在同一 22 节点订阅快照上，旧 HEAD 的 4-worker 三次 wall 为 `36.238 / 34.989 / 27.105s`，中位数 `34.989s`；最新 8-worker 三次 wall 为 `20.320 / 17.351 / 18.301s`，中位数 `18.301s`。中位数 speedup 为 `1.912x`，节点吞吐中位数从 `0.6288` 提升到 `1.2021 nodes/s`，峰值 active node 为 8。最新三次均无 failed、无 retry，成功分布为两次 `22 success`、一次 `21 success + 1 partial`，且每次 `cleanup_confirmed=true`；同一最新代码的严格真实闭环另验收为 `22/22 success`。

复测命令（API 地址是非敏感的本机端口，订阅仍只由 `.env` 注入）：

```powershell
$env:BEST_IP_API_BASE = 'http://127.0.0.1:8765'
uv run --env-file .env python scripts/benchmark_scan.py --label optimized-8 --warmup 1 --runs 3
```

## API

### 创建扫描

```http
POST /api/scans
Content-Type: application/json

{"subscription_url":"https://example.com/subscription"}
```

响应 `202` 和任务 ID。订阅地址不会写入任务状态、manifest 或导出。正式验收脚本还会传入可选的 64 位 `subscription_sha256` 和 32 位 `request_id`，用于把实际扫描绑定到预取快照，并在创建响应丢失时仍可取消确定的任务；普通客户端无需提供。

### 查询进度/完成摘要

```http
GET /api/scans/{id}
```

扫描中返回状态、计数、阶段信息以及所有已原子暂存节点的轻量摘要；状态为 `completed` 且 `manifest_ready=true` 后，额外返回经完整校验的最终 manifest。

### 查询单节点完整结果

```http
GET /api/scans/{id}/results/{index}
```

仅在完成 manifest 后可用；结果直接从已校验节点 JSON 读取。

### 导出完整任务 JSON

```http
GET /api/scans/{id}/export
```

仅在 manifest 完整校验通过后返回。导出包含 Coffee 原始结构化 payload、请求证据、完整性状态和每节点记录。

### 停止任务

```http
DELETE /api/scans/{id}
```

取消任务不会生成 completed manifest，也不会把未完成扫描伪装为完成。

## 安全边界

- 订阅 URL 仅允许公开 HTTP/HTTPS，拒绝认证信息、本机、内网、回环和保留地址；重定向逐跳重新验证。
- 订阅下载和 Mihomo 节点连接属于准备/传输控制面；Coffee 数据面不复用其直连客户端或 DNS 解析路径。
- 节点配置可能含代理凭据，只写入临时 Mihomo 目录并在任务结束清理；结果文件使用字段 allowlist，不保存订阅 URL。
- 本项目没有用户认证。若部署到公网，必须在反向代理层增加认证、HTTPS、限速和并发限制。

## 配置

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `BEST_IP_MIHOMO_PATH` | `runtime/mihomo/mihomo(.exe)` | Mihomo 核心路径 |
| `BEST_IP_MAX_NODES` | `500` | 单订阅真实节点上限 |
| `BEST_IP_MAX_PARALLEL_JOBS` | `2` | 同时运行的扫描任务数 |
| `BEST_IP_MAX_PARALLEL_NODES` | `8` | 单个扫描任务同时检测的节点数；每个并发槽位内的重试串行执行，两个任务的有效节点上限为 16 |
| `BEST_IP_MAX_NODE_ATTEMPTS` | `3` | 单节点最大尝试次数；每次使用全新的 Mihomo 进程、端口和目录 |
| `BEST_IP_NODE_RETRY_BACKOFF_MS` | `500` | 重试基础退避毫秒数；第 N 次失败后等待 `N ×` 该值 |
| `BEST_IP_OUTBOUND_INTERFACE` | 自动检测 | Windows Mihomo 物理出站网卡名称；不设置时按活动物理默认路由检测，无法确认则失败关闭 |
| `BEST_IP_PAGE_TIMEOUT_MS` | `45000` | 单次尝试的 Coffee 采集总时间预算；page、trace、lookup 和 related 共用该上限 |
| `BEST_IP_SUBSCRIPTION_MAX_BYTES` | `5242880` | 订阅最大字节数 |
| `BEST_IP_SUBSCRIPTION_TIMEOUT_SECONDS` | `30` | 订阅下载超时 |

## 已知限制

- 若订阅全部节点的服务器都是域名，且宿主 TUN 的严格路由同时阻断物理接口直连 DNS，则没有可用于打破“先解析节点、再通过节点访问 DoH”循环的公网字面 IP 引导节点；此时会按配置重试并明确返回 DNS 失败，不回落到宿主代理路径。
- 只支持顶部含 `proxies` 列表的 Mihomo YAML；URI 列表和仅含远程 `proxy-providers` 的配置返回明确错误。
- 不启动浏览器，不采集浏览器专属的 DNS 泄漏、WebRTC 或设备指纹结果。
- Coffee 接口、字段、限流和异步 pending 语义属于外部服务，改版时必须先更新页面证据和 URL allowlist。
- 节点并发受 `BEST_IP_MAX_PARALLEL_NODES` 限制，单节点重试受 `BEST_IP_MAX_NODE_ATTEMPTS` 限制；每个并发节点同一时刻只有一个独立 Mihomo，但每个实例仍会加载订阅的完整代理定义，内存峰值随并发数增加，失败任务总时长随尝试数增加。
- 扫描中只返回已完成节点的安全摘要；单节点完整详情与导出必须等待最终 manifest，避免把进行中状态误认为最终事实。

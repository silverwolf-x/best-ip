# Best IP

通过独立工作区 Mihomo 实例有界并发检测订阅节点，只经各自的本地 mixed-port 访问 `ip.net.coffee` IP 页面及其明确的同源结构化接口。后端为每个真实节点写入原子 JSON，校验所有节点并生成 `manifest.json`；前端读取时机属于单独的展示层契约。

## 核心行为

- 输入必须是顶部含 `proxies` 的 UTF-8 Mihomo/Clash YAML 公开订阅地址。
- 订阅 metadata（流量、重置、到期等信息项）不会作为节点；每个真实节点恰好产生一条成功、部分或失败终态记录。
- 每个并发节点使用独立的 Mihomo 进程、mixed-port、controller、selector、连接池和临时工作目录；selector 只暴露当前检测节点，同时保留完整代理定义以支持节点间拨号依赖。
- 单节点内，页面与 trace 并行请求；取得并核验出口 IP 后，global ping、portscan、pingcheck 和 related 查询并行调度，related 的轮询仍按顺序执行。
- Mihomo mixed-port 和 controller 只监听 `127.0.0.1`，selector 切换后由 Controller GET 确认实际节点身份。
- Coffee 业务客户端固定 `trust_env=False`、禁用重定向，并且只允许 `https://ip.net.coffee` 的页面、trace、lookup、related、被动 portscan、pingcheck 和固定八地 global ping 路径。
- 不访问 GPT、Claude、OpenAI、Anthropic 或其他站外数据源；不执行 Coffee 页面 JavaScript，因此不会触发页面中的第三方外链。
- 节点扫描阶段不做 Coffee 的宿主 DNS、固定 IP 连接或 direct fallback；所有 Coffee HTTP 请求都交给当前 Mihomo mixed-port。
- 失败节点的 `exit_ip` 始终为 JSON `null`；后端只从 Mihomo 日志映射固定、脱敏的 DNS、REALITY、超时、拒绝连接、TLS、连接重置、EOF 或网络不可达原因，不保存原始节点日志。
- 节点扫描不会原样启动订阅中的 `url-test`、`fallback` 和通用规则；这些配置可能主动探测其他节点，破坏当前 worker 的单节点归属。worker 只复用代理定义和 DNS 数据，并用固定 Coffee 规则隔离检测流量。
- 节点文件和进度文件都使用显式字段集合；节点写入、manifest 读取和导出会重新校验记录结构、代理证据、状态/出口 IP 约束、文件大小和 SHA-256。
- `runtime/jobs/<job_id>` 只用于 Mihomo 临时配置和日志；后端只有在子进程退出且工作目录删除后才返回 `cleanup_confirmed=true`。
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

节点文件和进度文件使用同目录临时文件、`flush`、`fsync`、`os.replace` 原子发布。`manifest.json` 只有在节点索引完整、状态/出口 IP 约束、文件大小和 SHA-256 校验都通过后才生成。任务 API 在 manifest 出现前只返回进度；单节点详情和导出在此之前返回 HTTP 409。

`runtime/jobs/<job_id>` 只用于 Mihomo 临时配置和日志，任务结束后清理；运行目录不提交 Git。Windows 用户态程序能保证的是应用层 Coffee 请求边界，不能声称隔离宿主物理网卡或其他进程的网络。

## Windows 本地运行

要求：Windows x64、[uv](https://docs.astral.sh/uv/)。

```powershell
uv sync --dev
uv run python scripts/download_mihomo.py
uv run uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000>。前端默认使用同源 `/api/...`，不会自动改写到固定 loopback API；分离开发时请在 HTML 的 `meta[name="api-base"]` 中显式配置后端地址。

## 验证

```powershell
uv run pytest -q
uv run ruff check .
node --check frontend/app.js
git diff --check
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

正式订阅闭环（订阅 token 只通过环境变量注入，不写入 Git）：

```powershell
$env:BEST_IP_TEST_SUBSCRIPTION_URL = "<正式订阅 URL>"
uv run python scripts/verify_real_scan.py
Remove-Item Env:BEST_IP_TEST_SUBSCRIPTION_URL
```

脚本会先取得一次订阅快照，并把其 SHA-256 与客户端生成的任务 ID 绑定到创建请求；后端实际下载内容若不同会直接失败。随后脚本逐节点核对订阅顺序、metadata 数、trace/lookup 出口一致性、selector 和代理证据、manifest 本地文件 hash、完整导出、临时工作目录清理及订阅 URL/节点凭据不泄露；异常或超时会取消并确认后台任务与 Mihomo 清理终态。`BEST_IP_REAL_SCAN_TIMEOUT_SECONDS` 是从订阅预取到终态 API 核验的总预算；超时后的取消清理另有最多 35 秒安全宽限期，不会被伪装为验收通过。

`BEST_IP_API_BASE` 只能指向与脚本共享当前 `runtime/results` 和 `runtime/jobs` 的本机后端；正式闭环会强制读取本地节点文件重算 hash，因此不支持无共享文件系统的远程或容器后端。

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

扫描中返回状态、计数和阶段信息以及空 `results`；状态为 `completed` 且 `manifest_ready=true` 后，才返回暂存 manifest 的轻量摘要。

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
| `BEST_IP_MAX_PARALLEL_NODES` | `2` | 单个扫描任务同时启动的独立 Mihomo 节点检测数 |
| `BEST_IP_PAGE_TIMEOUT_MS` | `45000` | 单节点 Coffee 采集总时间预算；page、trace、lookup 和 related 共用该上限 |
| `BEST_IP_SUBSCRIPTION_MAX_BYTES` | `5242880` | 订阅最大字节数 |
| `BEST_IP_SUBSCRIPTION_TIMEOUT_SECONDS` | `30` | 订阅下载超时 |

## 已知限制

- 只支持顶部含 `proxies` 列表的 Mihomo YAML；URI 列表和仅含远程 `proxy-providers` 的配置返回明确错误。
- 不启动浏览器，不采集浏览器专属的 DNS 泄漏、WebRTC 或设备指纹结果。
- Coffee 接口、字段、限流和异步 pending 语义属于外部服务，改版时必须先更新页面证据和 URL allowlist。
- 节点并发受 `BEST_IP_MAX_PARALLEL_NODES` 限制；每个并发节点都有独立 Mihomo，但每个实例仍会加载该订阅的完整代理定义，因此节点很多时内存和进程开销会随并发数增加。
- 当前改动只覆盖后端采集与暂存；扫描中的节点级前端展示仍需单独设计 API 读取边界和事实状态。

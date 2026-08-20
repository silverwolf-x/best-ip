# Best IP

通过工作区内的 Mihomo 核心逐个切换订阅节点，后端经 Mihomo 本地端口以 `ip.net.coffee/ip/` 的 IP lookup 为评分与基础信息主源，同时检测 GPT/Claude 实际服务端点延迟及 Coffee 全球 Ping，并把结果汇总到一个表格。扫描过程只使用 HTTP 请求，不下载或启动浏览器运行时。

## 功能

- 粘贴一个顶部含 `proxies` 的 Mihomo/Clash YAML 订阅地址。
- Mihomo 只在 `127.0.0.1` 开启随机 mixed-port 和控制端口。
- 节点之间依次切换；每个节点创建全新的 HTTP 连接池，避免旧代理隧道串线。
- 每个节点直接请求：
  - `https://ip.net.coffee/ip/` 与 `/api/ip/lookup/{ip}`，作为评分、地理、ASN、网络属性和风险字段的唯一主数据源。
  - `chatgpt.com`、`api.openai.com`、`claude.ai` 与 `anthropic.com`，只记录实际接入状态和请求延迟。
  - IP 页使用的全球 8 地 Ping、端口扫描和 Pingcheck 辅助接口。
- 表格汇总出口 IP、位置、唯一 IP 评分、GPT/Claude 接入状态与 Coffee 全球 Ping；不再从 GPT/Claude 风险接口重复获取基础信息或评分。
- 点击节点按需读取完整 HTTP 检测 JSON，轮询接口只返回轻量摘要。
- 支持实时进度、停止任务、搜索、状态筛选、排序和明暗主题。

## 目录

```text
backend/app/                 FastAPI API 与 HTTP 扫描服务
frontend/                    独立静态前端
runtime/mihomo/mihomo.exe    本地 Windows x64 核心（不提交 Git）
scripts/download_mihomo.py   跨平台核心下载与 SHA-256 校验
tests/                       单元与 API 测试
PLAN.md                      跨会话计划、进度与验证账本
```

## Windows 本地运行

要求：Windows x64、[uv](https://docs.astral.sh/uv/)。项目使用工作区 `.venv`，不需要全局安装 Python 包。

```powershell
# 安装/同步 Python 依赖到 .venv
uv sync --dev

# 若 runtime/mihomo/mihomo.exe 不存在，下载并校验官方最新核心
uv run python scripts/download_mihomo.py

# 启动本地前后端（后端同时托管 frontend 静态文件）
uv run uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000>。没有任何浏览器组件安装步骤。

开发时也可单独托管前端：

```powershell
uv run python -m http.server 5173 --directory frontend
```

## 验证

```powershell
uv run ruff check .
uv run pytest
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

## API

### 创建任务

```http
POST /api/scans
Content-Type: application/json

{"subscription_url":"https://example.com/subscription"}
```

返回 `202` 和任务 ID。订阅 URL 不会出现在任务查询结果中。

### 查询进度与摘要

```http
GET /api/scans/{id}
```

状态可能为 `queued`、`preparing`、`running`、`completed`、`failed` 或 `cancelled`。`results` 随进度增量增加，但不包含体积较大的完整详情。

### 查询单节点完整结果

```http
GET /api/scans/{id}/results/{index}
```

### 停止任务

```http
DELETE /api/scans/{id}
```

## 隐私和安全

- 订阅仅允许公开 HTTP/HTTPS 地址；后端拒绝本机、内网、回环和保留地址，降低 SSRF 风险。
- 用户提交的订阅 URL 不写日志、不存浏览器存储，也不返回扫描 API。前端按当前验收要求预填了公开测试 URL，正式部署前应替换或清空该默认值。
- 节点凭据仅写入 `runtime/jobs/<任务 ID>` 临时目录，任务结束后删除。
- Mihomo mixed-port 和 External Controller 都只监听 `127.0.0.1`，Controller 使用随机密钥。
- 本项目没有用户认证。若部署到公网，必须在反向代理层增加认证、HTTPS、请求限速和并发限制。

## 配置

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `BEST_IP_MIHOMO_PATH` | `runtime/mihomo/mihomo(.exe)` | Mihomo 核心路径 |
| `BEST_IP_MAX_NODES` | `500` | 单订阅节点上限；超过时明确报错 |
| `BEST_IP_MAX_PARALLEL_JOBS` | `2` | 同时运行的扫描任务数 |
| `BEST_IP_PAGE_TIMEOUT_MS` | `45000` | 单次 HTTP 检测超时 |
| `BEST_IP_SUBSCRIPTION_MAX_BYTES` | `5242880` | 订阅最大字节数 |
| `BEST_IP_SUBSCRIPTION_TIMEOUT_SECONDS` | `30` | 下载订阅超时 |

## Docker / GitHub 部署

Docker 构建会下载并校验当前最新 Linux x64 Mihomo，不安装浏览器运行时：

```bash
docker build -t best-ip .
docker run --rm -p 8000:8000 best-ip
```

仓库包含 `.github/workflows/ci.yml`，推送或提交 PR 时执行 Ruff 和 Pytest。GitHub 仓库本身不能常驻 Python 服务；可将容器部署到支持长进程的平台。

## 已知限制

- 当前直接支持顶部含 `proxies` 列表的 UTF-8 Mihomo YAML。Base64 URI 列表和仅含远程 `proxy-providers` 的配置不会发送到第三方转换服务，而是返回明确错误。
- 按要求不使用自动化浏览器，因此不采集必须由浏览器执行的 DNS 泄漏、WebRTC 和设备指纹；IP 风险、地理和评分由 IP lookup 采集，AI 页面只保留服务端点接入状态与延迟。
- Coffee 全球 Ping 当前对 IPv6 可能返回 `no_request_id` 而没有延迟值；前端会明确标为上游未返回，不会误报成 8 地全部超时。
- `ip.net.coffee` 是外部服务；网络波动、频率限制或接口改动可能产生部分结果。
- 完整扫描耗时取决于节点数量和最慢节点。节点按顺序切换以保证结果属于正确出口。
- 未提供真实订阅时，自动测试无法证明特定订阅节点的实际可用性。

# Best IP 实施计划与进度

> 该文档是跨会话的唯一任务账本。每次实现或验证后同步更新。

## 目标

构建一个前后端分离的本地 Web 项目：用户粘贴 Mihomo YAML 订阅地址，后端下载其中的节点并调用工作区 Mihomo 核心逐个切换出口；后端经 Mihomo 本地 mixed-port 以 IP 页 lookup 作为评分和基础信息唯一主源，GPT/Claude 只采集实际服务端点接入状态与延迟，并汇总 Coffee 全球 Ping、端口和可达性结果。

- `https://ip.net.coffee/ip/`
- `https://ip.net.coffee/gpt/`
- `https://ip.net.coffee/claude/`

## 推荐实现

- 后端：FastAPI、HTTPX、PyYAML；不下载或启动自动化浏览器。
- 核心：`runtime/mihomo/mihomo.exe`（Windows x64，v1.19.30，已核验官方 SHA-256）。
- 扫描：每个任务生成临时 Mihomo 配置；通过 External Controller 依次选择节点；HTTPX 经随机本地 mixed-port 请求 IP 页出口 trace 与 `/api/ip/lookup/{ip}`，以其作为评分、地理、ASN、网络属性和风险字段的唯一主数据源。GPT/Claude 只请求实际服务端点并记录接入状态与延迟；全球 Ping 使用 IP 页真实 `/api/ping/global` 8 节点接口。每个节点使用全新连接池，避免切换后复用旧隧道。
- 任务：启动接口立即返回任务 ID，前端轮询任务状态并增量渲染，避免长请求超时。
- 前端：独立原生 HTML/CSS/JS，无构建依赖；提供地址输入、进度、搜索过滤、结果表、每节点详情和亮/暗主题。
- 隐私：扫描 API 不回显或记录用户提交的订阅 URL；前端按当前验收要求预填指定测试 URL，正式部署前应替换或清空。订阅内容和节点凭据仅存在扫描临时目录，任务结束删除。
- 部署：本地统一使用 `uv sync`、`uv run`；提供核心下载脚本、Dockerfile 和 GitHub Actions。

## 文件范围

- `backend/app/`：API、任务管理、订阅下载、Mihomo 生命周期、HTTP 检测采集。
- `frontend/`：静态前端。
- `tests/`：订阅解析、结果摘要和 API 测试。
- `scripts/download_mihomo.py`：按当前平台下载并校验最新 Mihomo。
- `pyproject.toml` / `uv.lock`：uv 环境。
- `README.md`：安装、运行、限制、部署。
- `.github/workflows/ci.yml` / `Dockerfile`：GitHub CI 与容器部署。

## 进度

- [x] 核实工作区初始状态和工具链
- [x] 下载 Windows x64 Mihomo v1.19.30 并通过官方 SHA-256 校验
- [x] 调查三个目标页面的动态结果容器和接口行为
- [x] 创建后端与扫描流水线
- [x] 创建前端与交互
- [x] 添加测试和部署文件
- [x] 使用 uv 同步 Python 依赖（不含浏览器）
- [x] 运行单元测试、静态检查和真实应用验收
- [x] 完成 Coffee 三页全量字段对接、同类项合并与前端全景展示重构
- [x] 调整为 IP lookup 单一主数据源、AI 仅测接入延迟，并改用 Coffee 真实全球 Ping 接口
- [x] 检查最终 diff 与文档

## 已确认的页面采集点

- IP 评分：`#result`；页面先经 `/cdn-cgi/trace` 识别当前出口，再调用 `/api/ip/lookup/{ip}`。全量字段覆盖 CIDR、range、company_type、datacenter_name、ASN 属性（kind、tbps、ipv4_count、allocated）、RPKI、rDNS、Bogon、任播、Reddit 状态、AI 判定（label/confidence/reasoning）、多源地理（g1/g2/g3/g7 等）、威胁情报（intelligence）、关联域名（related_domains）等。
- GPT：仅用 `chatgpt.com/cdn-cgi/trace` 与 `api.openai.com` 检测实际接入状态和延迟；不再调用 GPT 页的 IP 风险、GeoIP 或重复评分接口。
- Claude：仅用 `claude.ai/cdn-cgi/trace` 与 `anthropic.com` 检测实际接入状态和延迟；不再调用 Claude 页的 IP 风险、GeoIP 或重复评分接口。
- 全球 Ping：使用 IP 页同款 `GET /api/ping/global?host={ip}&node=n01&node=n02&node=n03&node=n04&node=n09&node=n11&node=n13&node=n15`；IPv6 上游可能返回 `no_request_id`，此时标为“上游未返回”而非误报超时。

## 长期测试用例

- **用户指定默认测试订阅**：`https://sub.nekocloud.host/nekocloud/token=/05d194d5a0f47593060b9fe951a6313b`
  - 当前返回 25 条 VLESS 配置，其中包含流量/到期/官网/群组提示项及香港、台湾、新加坡、日本、美国节点；节点本身可能随供应商状态变化。
  - 用于端到端回归验证：出口 IP 切换隔离、IPv4/IPv6 识别、IP lookup 单一主数据源、GPT/Claude 接入延迟及 Coffee 全球 8 地 Ping。

## 验证清单

1. `uv sync --dev`
2. `uv run ruff check .`
3. `uv run pytest`
4. `uv run uvicorn backend.app.main:app --host 127.0.0.1 --port 8000`
5. 浏览器打开本地应用，验证健康检查、错误订阅提示、扫描状态轮询、表格与详情、暗色主题和窄屏布局。
6. 使用本地测试配置，在至少两个节点上确认 mixed-port 出口切换正确且三个页面及检测接口均经对应节点请求。

## 实际验证记录（2026-08-20）

- `uv sync --dev --offline`：成功；自动化浏览器相关的 3 个缓存包已卸载。
- `uv run --offline ruff check .`：通过。
- `uv run --offline pytest`：21 个测试全部通过；仅有 FastAPI TestClient 上游弃用警告。
- `node --check frontend/app.js`：通过。
- 本地服务：`http://127.0.0.1:8000`，健康检查和前端静态资源均返回 HTTP 200。
- 用户提供的真实订阅：解析 4 个 VLESS 节点，逐个切换后均成功；四个出口 IP 各不相同，IP/GPT/Claude 页面与风险接口均成功。
- 真实扫描出口：`2602:f656:6::11a`、`2001:df6:40c0::720a`、`189.24.112.112`、`154.21.199.149`；分数分别为 93、89、72、96。
- 完整结果接口已抽查：三类结果状态均为 success，IP lookup、GPT risk、Claude risk 均返回 HTTP 200。
- 前端评分去重回归：主表与详情均只显示一个 Coffee 综合评分，GPT/Claude 仅保留各自可用性与连通延迟；摘要 API 只返回 `score`，不再返回 `ip_score`、`gpt_score`、`claude_score` 三个重复字段。
- 前端 UI 与文案严格对标 `https://ip.net.coffee/ip/`：完成 Net.Coffee 经典导航、H1 标题与说明文案、标准配色与芯片色彩体系（`.score-high/mid/low`、`.chip-ok/warn/bad/info`）、搜索输入栏与 10px 圆角卡片设计，并支持移动端响应式断点。
- 重启本地服务后再次使用长期订阅实扫：4/4 节点 success，综合评分为 93、89、72、96，旧评分字段数量为 0，合并安全状态与 8 个延迟点均成功返回；实时托管 HTML 仅含 1 个综合评分列。
- 已处理本机 Mihomo Fake-IP DNS：域名落入 `198.18.0.0/15` 时通过固定 IP 的公共 DoH 核验真实 A/AAAA；直接输入保留 IP 仍拒绝。
- 新默认订阅实测：HTTP 200、约 35 KB YAML，解析 25 条 VLESS 配置；完整扫描 25/25 结束，其中 8 条 IP 完整、2 条 IP 部分、15 条节点自身连接失败，10 条取得 IP 评分（46–89）。失败节点在 Mihomo 日志中为供应商端连接 EOF；其中 `aws-yes.nekocloud.host` 的公开 DNS CNAME 目标当前为 NXDOMAIN，不伪造评分。
- IP 主数据源实测：成功节点 `🇭🇰香港•电信01` 的摘要评分与 `pages.ip.score` 同为 76，位置、ASN、ISP 均来自 IP lookup；GPT/Claude 详情只含 `trace`、`connectivity`、`access`，不存在 score/risk/geo 字段。
- 全球 Ping 根因与修复实测：旧 8 个区域 `*.speed.cloudflare.com` 域名均无公共 DNS 记录，异常被错误折叠成“超时”；改为 IP 页真实 `/api/ping/global` 后，上述香港节点 8 地中 7 地返回 2–199 ms、仅上海超时。IPv6 的 `no_request_id` 会明确显示为“上游未返回”。
- 最终验证：`uv run pytest -q` 为 21 passed；`uv run ruff check .` 与 `node --check frontend/app.js` 均通过；重启后的 HTML、JS、健康检查均返回 HTTP 200。

## 当前限制

- 首版接收顶部含 `proxies` 列表的 Mihomo/Clash YAML；不调用第三方订阅转换服务。
- 节点按顺序扫描以确保切换期间不串线；同一节点的 IP 主查询、GPT/Claude 服务端点与辅助检测并发。
- IP 评分、基础信息与全球 Ping 来自 `ip.net.coffee` 当前 HTTP 接口；GPT/Claude 仅记录目标服务端点的 HTTP 接入状态和延迟。DNS 泄漏、WebRTC 和设备指纹属于浏览器能力，按用户要求不下载浏览器，因此不采集。
- 工作区现有核心仅能在 Windows x64 运行；容器构建时会自动下载 Linux 核心。

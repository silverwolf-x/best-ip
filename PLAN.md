# Best IP 实施计划与进度

> 该文档是跨会话的唯一任务账本。每次实现或验证后同步更新。

## 目标

构建一个前后端分离的本地 Web 项目：用户粘贴 Mihomo YAML 订阅地址，后端下载其中的节点并调用工作区 Mihomo 核心逐个切换出口；后端经 Mihomo 本地 mixed-port 直接请求以下网页及其实际检测接口，汇总结构化结果与原始 JSON 供前端表格查看。

- `https://ip.net.coffee/ip/`
- `https://ip.net.coffee/gpt/`
- `https://ip.net.coffee/claude/`

## 推荐实现

- 后端：FastAPI、HTTPX、PyYAML；不下载或启动自动化浏览器。
- 核心：`runtime/mihomo/mihomo.exe`（Windows x64，v1.19.30，已核验官方 SHA-256）。
- 扫描：每个任务生成临时 Mihomo 配置；通过 External Controller 依次选择节点；HTTPX 经随机本地 mixed-port 请求三个页面、出口 trace、IP 评分、IP 风险、地理和服务连通接口。每个节点使用全新连接池，避免切换后复用旧隧道。
- 任务：启动接口立即返回任务 ID，前端轮询任务状态并增量渲染，避免长请求超时。
- 前端：独立原生 HTML/CSS/JS，无构建依赖；提供地址输入、进度、搜索过滤、结果表、每节点详情和亮/暗主题。
- 隐私：订阅 URL 不返回前端、不写日志；订阅内容和节点凭据仅存在扫描临时目录，任务结束删除。
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
- [x] 检查最终 diff 与文档

## 已确认的页面采集点

- IP 评分：`#result`；页面先经 `/cdn-cgi/trace` 识别当前出口，再调用 `/api/ip/lookup/{ip}`。全量字段覆盖 CIDR、range、company_type、datacenter_name、ASN 属性（kind、tbps、ipv4_count、allocated）、RPKI、rDNS、Bogon、任播、Reddit 状态、AI 判定（label/confidence/reasoning）、多源地理（g1/g2/g3/g7 等）、威胁情报（intelligence）、关联域名（related_domains）等。
- GPT：`#gaugeScore`、`#ipAddrChatGPT`、`#ipGeoChatGPT`、`#propsContent`、`#securityContent`、`#chatgptAvailContent`；接口 `/cdn-cgi/trace`、`/api/iprisk/{ip}`、`/api/geoip/{ip}`、`chatgpt.com/cdn-cgi/trace`、`api.openai.com`、`/gpt/status.json`。
- Claude：`#gaugeScore`、`#ipAddrClaude`、`#ipGeoClaude`、`#propsContent`、`#securityContent`、`#claudeAvailContent`；接口 `/cdn-cgi/trace`、`/api/iprisk/{ip}`、`/api/geoip/{ip}`、`claude.ai/cdn-cgi/trace`、`anthropic.com`、`/claude/status.json`。

## 长期测试用例

- **用户实测订阅**：`https://my.inet.im/x/x6fG5XkO?t=auto`
  - 包含 4 个优质代理节点（`🇺🇸 US美国-Tri｜AI解锁`、`🇭🇰 HK香港-A｜低延迟`、`🇩🇪 DE德国-S｜顶级备用`、`🇺🇸 US美国-Z｜AI解锁`）。
  - 用于端到端回归验证：出口 IP 切换隔离、IPv4/IPv6 双栈识别、IP 纯净度、双 AI（GPT & Claude）可用性检测及全球 Ping 延迟测量。

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
- `uv run --offline pytest`：19 个测试全部通过；仅有 FastAPI TestClient 上游弃用警告。
- `node --check frontend/app.js`：通过。
- 本地服务：`http://127.0.0.1:8000`，健康检查和前端静态资源均返回 HTTP 200。
- 用户提供的真实订阅：解析 4 个 VLESS 节点，逐个切换后均成功；四个出口 IP 各不相同，IP/GPT/Claude 页面与风险接口均成功。
- 真实扫描出口：`2602:f656:6::11a`、`2001:df6:40c0::720a`、`189.24.112.112`、`154.21.199.149`；分数分别为 93、89、72、96。
- 完整结果接口已抽查：三类结果状态均为 success，IP lookup、GPT risk、Claude risk 均返回 HTTP 200。
- 前端评分去重回归：主表与详情均只显示一个 Coffee 综合评分，GPT/Claude 仅保留各自可用性与连通延迟；摘要 API 只返回 `score`，不再返回 `ip_score`、`gpt_score`、`claude_score` 三个重复字段。
- 重启本地服务后再次使用长期订阅实扫：4/4 节点 success，综合评分为 93、89、72、96，旧评分字段数量为 0，合并安全状态与 8 个延迟点均成功返回；实时托管 HTML 仅含 1 个综合评分列。
- 已处理本机 Mihomo Fake-IP DNS：域名落入 `198.18.0.0/15` 时通过公共 DoH 核验真实 A/AAAA；直接输入保留 IP 仍拒绝。

## 当前限制

- 首版接收顶部含 `proxies` 列表的 Mihomo/Clash YAML；不调用第三方订阅转换服务。
- 节点按顺序扫描以确保切换期间不串线；同一节点的三个检测页并发。
- 检测结论来自 `ip.net.coffee` 当前 HTTP 接口；DNS 泄漏、WebRTC 和设备指纹属于浏览器能力，按用户要求不下载浏览器，因此不采集。
- 工作区现有核心仅能在 Windows x64 运行；容器构建时会自动下载 Linux 核心。

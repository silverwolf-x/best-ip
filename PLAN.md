# Best IP Coffee-only 重构计划

> 该文档是本轮重构的执行账本。先保证节点归属和结果完整性，再优化并发；历史混合扫描结果不作为本轮验收依据。

## 1. 最终目标

用户提交 Mihomo YAML 订阅后，后端只使用工作区内启动的 Mihomo 访问 Coffee IP 页面及该页面真实依赖的 `ip.net.coffee` 同源结构化接口。后端为每个真实节点采集并原子暂存一份完整记录；前端轮询时立即读取已完成节点的安全摘要，扫描完成后再生成只读 manifest，详情与导出仍等待最终 manifest。

### 必须满足

- 所有 Coffee HTTP/HTTPS 请求必须通过当前节点对应的工作区 Mihomo mixed-port。
- HTTP 客户端固定 `trust_env=False`，不继承宿主 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 或直连回退。
- 不再访问 GPT、Claude、OpenAI、Anthropic 或其他 AI 端点。
- 订阅中的 metadata 不作为节点；每个真实节点恰好产生一份结构化暂存记录。
- 成功记录必须包含由 Coffee trace 返回并通过 IP 格式校验的真实出口 IP。
- 隧道无法建立时也必须原子写入失败记录，但出口 IP 必须为 `null`，不得使用入口 IP、节点名称、地区标签或宿主 IP 伪造。
- 活动扫描状态与结果读取分离：扫描器只负责采集和落盘，前端/API 只消费暂存文件与最终 manifest。
- 所有真实节点均产生一份结构化暂存记录；节点之间可使用独立 Mihomo worker 做有界并发，但单个 worker 内不得重叠 selector 切换与 Coffee 请求。

### 网络隔离边界

本项目能保证**应用层隔离**：Coffee 请求只能交给工作区 Mihomo，代理内的远端 DNS/节点协议由 Mihomo 处理，应用不直接解析或连接 Coffee。物理网络仍由 Windows 宿主网卡承载；若要求操作系统网络命名空间级隔离，需要另行放入容器或虚拟机。应用代码不得以该物理边界为理由增加任何宿主直连路径。

## 2. Coffee 页面数据链路门控

先经工作区 Mihomo 实测检查 `https://ip.net.coffee/ip/` 当前 HTML 与内联脚本。页面本身不包含当前出口的结构化结果：浏览器先取 trace，再调用 lookup；页面还引用以下 Coffee 同源接口。实测页面只有 Google Tag Manager 外部脚本，采集器不会执行或请求该脚本。

1. `GET https://ip.net.coffee/ip/`：证明目标页面本身可经当前节点访问，并记录响应状态、最终 URL、耗时和内容摘要。
2. `GET https://ip.net.coffee/cdn-cgi/trace`：取得当前代理出口 IP；仅接受合法 IPv4/IPv6。
3. `GET https://ip.net.coffee/api/ip/lookup/{exit_ip}`：取得评分、ASN、地理、网络属性、风险与其他 IP 页结构化字段。
4. `GET https://ip.net.coffee/api/ping/global?host={exit_ip}&node=n01&node=n02&node=n03&node=n04&node=n09&node=n11&node=n13&node=n15`：页面全球 8 地 Ping。
5. `GET https://ip.net.coffee/api/ip/portscan/{exit_ip}?probe=0` 与 `GET https://ip.net.coffee/api/ip/pingcheck/{exit_ip}`：页面端口缓存状态与 Ping 判断。
6. lookup 返回关联域名仍在扫描时，按页面行为轮询 `GET https://ip.net.coffee/api/ip/related/{exit_ip}`，最多 10 次、间隔 1.5 秒。

所有这些请求都必须经当前节点对应的 mixed-port。采集器只下载 Coffee HTML，不执行页面 JavaScript，因此不会请求 Google Tag Manager。

禁止为补齐字段调用 Coffee 之外的数据源。任一 Coffee 请求不得把主机替换成宿主解析出的固定地址，也不得设置 direct fallback。

## 3. 分阶段实施

### 阶段 A：严格顺序正确性

1. 下载订阅，解析 DNS 与节点，过滤 metadata。
2. 启动一个工作区 Mihomo 实例和一个 selector。
3. 对每个节点严格执行：
   - selector 切换并等待确认；
   - 记录所选 proxy identity；
   - 为该节点创建全新的、强制走当前 mixed-port 的 HTTP 客户端；
   - 完成 Coffee 页面及同源结构化采集；
   - 关闭客户端，确保连接池不能跨节点复用；
   - 原子写入该节点 JSON；
   - 再切换下一节点。
4. 20 个节点均产生记录后，原子生成 completed manifest。
5. 前端轮询时展示已原子暂存的节点摘要；completed manifest 出现后开放节点详情与导出。

单 selector 上禁止重叠节点请求，因为 selector 在请求期间切换会造成出口串线。

### 阶段 B：后端暂存仓

每个任务使用独立目录：

```text
runtime/results/<job_id>/
  nodes/
    0000.json
    0001.json
    ...
  progress.json
  manifest.json
```

所有 JSON 先写同目录临时文件，再用 `os.replace()` 原子替换。节点记录至少包含：

- `schema_version`、`job_id`、`node_index`、`node`、`node_type`
- `selected_proxy` 与 selector 确认值
- `coffee_page_url`
- `status`、`started_at`、`finished_at`、`elapsed_ms`
- `exit_ip`
- `requests`：页面、trace、lookup 及经确认的同源辅助接口状态/耗时/错误
- `coffee`：原始结构化 payload
- `transport_error`：Mihomo 隧道层失败原因
- `completeness`：必需步骤逐项布尔值及缺失项
- `proxy_evidence`：mixed-port、Mihomo 实例标识和节点切换确认；不保存订阅凭据

`manifest.json` 只在所有真实节点均有记录后生成，包含总数、成功/失败数、记录索引、完整性检查和完成时间。任务导出必须从该 manifest 组装，不能从内存扫描对象拼装。

### 阶段 C：Coffee-only 前端

- 删除 GPT/Claude 列、筛选标签、详情卡、CSV/JSON 字段和文案。
- 只展示暂存 Coffee 结果：出口 IP、评分、位置/ASN/ISP、网络属性、风险、全球 Ping、耗时与完整性。
- 失败行直接展示结构化 Mihomo 隧道错误。
- 完成前禁止导出；完成后 JSON/CSV 均从暂存结果 API 获取。

### 阶段 D：独立 Mihomo 有界并发

节点级有界并发已实现：

- 每个并发节点使用独立 Mihomo 进程、配置目录、mixed-port、controller-port、selector、连接池和日志游标。
- 每个实例的 selector 只暴露当前检测节点，但保留完整代理定义以支持节点间拨号依赖。
- 默认并发为 4（正式订阅 A/B 中相对 2 workers 降低约 46% 墙钟时间），可通过 `BEST_IP_MAX_PARALLEL_NODES` 按资源下调；单个 worker 内仍严格执行 `select + collect`，不重叠切换。
- 单节点内的页面/trace，以及出口 IP 依赖的 lookup、global ping、portscan、pingcheck 已按依赖关系并行调度；related 仍按页面语义顺序轮询。
- 正式订阅已完成 20 节点并发实测；后续订阅内容会由供应商动态变化，验收结果必须绑定具体任务 ID 和当次节点总数。

### 阶段 E：显式 IP 与失败根因探索

探索结论：

- `GET /ip/{ip}` 的路径参数只会跳过当前出口 trace，再调用同一个 `/api/ip/lookup/{ip}`；其 HTML 服务端摘要少于现有 lookup JSON，不能补充更多结构化字段。
- 订阅中的服务器地址及其 DNS 解析结果是节点入口，不是代理出口，禁止用于 Coffee 查询结果中的 `exit_ip`。
- 对失败代表节点分别经 Coffee trace、Cloudflare trace 和 ipify 查询出口 IP，三者均在节点握手阶段返回连接错误；无法先取得可信出口 IP，显式 IP fallback 不能修复这类失败。
- 当前重建配置与保留原生订阅 DNS、proxy-groups、rules 的三节点 A/B 返回相同错误类别：REALITY 认证失败、节点连接超时和上游 EOF。原生配置没有增加可用数据，也不是这些失败的主因。
- 不把完整原生 `url-test`、`fallback` 和数百条通用规则直接带入扫描 worker：这些组会主动探测其他节点，且原生规则可能引入非当前节点流量，破坏“一 worker 一节点”的归属证据。worker 继续使用订阅的代理定义和 DNS 数据，只保留 Coffee 检测所需的隔离配置。
- 不增加站外出口回显或宿主直连 Coffee fallback；失败记录改为从 Mihomo 日志提取固定、脱敏的传输层原因，同时保持 `exit_ip=null`。

收敛实现：

- 单节点 Coffee 采集由 `BEST_IP_PAGE_TIMEOUT_MS` 约束总 wall-clock 预算；related 自身仍有 20 秒硬上限。
- 正式验收先固定订阅快照，并用 SHA-256 与客户端任务 ID 绑定实际扫描；动态订阅发生变化时失败而不是用两个快照做凭据和节点数核验。
- 结果仓采用显式字段集合；写入、manifest 读取和导出都会重新校验节点结构、代理证据、完成字段、文件大小与 SHA-256。导出顶层总数和计数只来自已校验 manifest。
- 取消和完成响应只有在 Mihomo 子进程退出且临时工作目录删除后才设置 `cleanup_confirmed=true`；正式验收会检查该事实和 `runtime/jobs/<job_id>` 不存在。

## 4. 验收标准

### 静态与单元测试

- 扫描路径不存在 GPT/Claude/OpenAI/Anthropic URL。
- 扫描器不存在 direct Coffee client、固定 Coffee IP、DoH 解析或代理失败后的 direct fallback。
- 每个 Coffee request 都由唯一的 proxied client 发出，且代理 URL 等于当前工作区 Mihomo mixed-port。
- 切换节点后必须新建并关闭连接池。
- manifest 缺任一节点记录时不得标记 completed 或导出。
- 失败记录的 `exit_ip` 必须为 `null`。
- 前端契约中不存在 AI 字段。

### 真实全量扫描

使用正式订阅测试连接完成网站端到端验收；订阅 URL 只放在 Git 忽略的工作区 `.env` 的 `BEST_IP_TEST_SUBSCRIPTION_URL`，禁止把 token 写入本仓库或命令行。执行：

```powershell
uv run --env-file .env python scripts/verify_real_scan.py
```

验收要求：

- 原始配置数、metadata 数和当前真实节点数以本次订阅实际返回为准，并记录实测值。
- 暂存记录：真实节点数 / 真实节点数，不允许缺失。
- 每个成功或部分节点都有合法 Coffee trace 出口 IP、lookup 结构化结果和代理证据；失败节点的出口 IP 为 `null`。
- 从网站 `GET /api/scans/{job_id}/export` 得到新的完整 JSON；导出 manifest 和逐节点结果必须与前面核验的快照完全一致，并通过本地 `ResultStore` 重算节点文件大小和 SHA-256。
- API 返回、导出和持久化暂存文件不包含订阅 URL、其 query/path token 或节点凭据；原始 Mihomo 日志只在临时目录内使用，任务结束即删除，不写入结果。
- 脚本会逐节点读取结果、核对 trace/lookup、selector/代理证据、manifest hash、导出数量和凭据边界，作为每次后端采集改动后的闭环验收入口。

### 验证命令

1. `uv run pytest -q`
2. `uv run ruff check .`
3. `node --check frontend/app.js`
4. `git diff --check`
5. 启动本地网站，从工作区 `.env` 读取正式订阅并运行 `uv run --env-file .env python scripts/verify_real_scan.py`。
6. 脚本核对 manifest、节点文件数、出口 IP 格式、selector 身份、失败真实性、敏感信息和导出完整性。

## 5. 执行清单

- [x] 重新定义 Coffee-only 目标、隔离边界、暂存契约和阶段门控
- [x] 复核 Coffee IP 页当前同源请求集合
- [x] 实现 Mihomo 强制代理 Coffee collector
- [x] 实现每节点原子暂存仓与 completed manifest
- [x] 解耦 JobManager、结果读取 API 和扫描器活动状态
- [x] 删除前端 GPT/Claude 展示与筛选
- [x] 更新测试与 README
- [x] 完成正式订阅全量网站扫描并导出新 JSON（历史任务 `9984538c804a4a14995b90618292412b`：20/20，完整 8，部分 0，失败 12；探索诊断任务 `a31a580343aa4c9a8769240f4f3e3fe7`：11/11，均以脱敏传输错误终态落盘；最终收敛任务 `25327ad825d54268a88f2d2e4aba1c6e`：9/9，完整 0，部分 0，失败 9，manifest/export/hash/凭据与清理闭环通过；订阅内容由供应商动态变化）
- [x] 实现独立 Mihomo 有界并发和单节点内 Coffee 请求并行（默认 4 workers；2/4 workers 正式订阅 A/B 已验证）
- [x] 完成显式 IP、原生配置 A/B 和失败根因探索，不引入无事实收益的 fallback
- [x] 将 Mihomo DNS、REALITY、超时、拒绝连接、TLS、连接重置、EOF 和网络不可达日志映射为固定脱敏错误
- [x] 将正式验收绑定到订阅 SHA-256/确定任务 ID，强制核对节点顺序、metadata、manifest/export、本地 hash、凭据和 Mihomo 清理终态
- [x] 收紧 ResultStore 显式字段与完成事实校验，并使单节点 Coffee 采集遵守总 wall-clock 预算

## 6. 历史结果说明

`best-ip-results-2026-08-21.json` 及任务 `1aff3b23ea9f405b84e01919ed13229d` 属于旧架构：包含 GPT/Claude，并允许显式出口 IP 的 Coffee 请求走宿主直连。它只能作为旧行为基线，不能作为本轮 Coffee-only、强制代理、后端暂存架构的验收结果。

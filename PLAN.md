# Best IP 重构与清理计划

日期：2026-09-08

状态：待实施。本文件是重构方案，不表示下列功能已经完成。

目标：一套静态前端、一套 Python 扫描核心；本地通过 uv 启动调试，线上通过 Cloudflare Worker + GitHub Actions 提供相同的扫描能力。

## 1. 结论与范围

**不推倒重写，不先换框架。先固定行为，再沿职责拆分，最后删除旧实现。**

当前已经有前后端独立启动与 Worker 部署路径。主要问题不是“没有前后端分离”，而是大文件承担多种职责、运行模式渗入 UI、生产执行依赖验收脚本，以及错误分类和真实验收不够清楚。

本次重构要完成：

1. 前端只负责页面交互、展示与用户侧结果处理，不承担扫描任务调度细节。
2. Python 扫描核心不依赖 FastAPI、浏览器或 GitHub Actions；本地 API 与生产 CLI 复用它。
3. Worker 只负责访问控制、静态资源、GitHub 调度和结果网关，不放入 Python 扫描逻辑。
4. 保留 `uv run python scripts/dev.py` 一键本地启动，不要求先运行 npm。
5. 保留 Worker Static Assets 部署，生产扫描继续在 GitHub Actions runner 中运行 Mihomo。
6. 修复过程中建立的节点隔离、取消清理、错误脱敏、结果校验不得退化。

本次不做：

- 不引入 React/Vue、Vite、TypeScript 全量迁移、ORM、数据库、Redis、消息队列或 Docker。
- 不增加第二套生产部署方式，不把 FastAPI 作为公网服务暴露。
- 不扩展订阅格式、节点协议、评分算法或第三方数据源。
- 不通过关闭认证、完整性校验、代理隔离或伪造分数来让测试通过。
- 不因“文件长”机械拆分；只有存在独立职责、独立测试或真实复用时才建模块。

## 2. 当前问题与证据

以下定位以方案编写时的代码为准；行数用于识别热点，不作为重构 KPI。

| 位置 | 现状 | 重构动作 |
| --- | --- | --- |
| `frontend/app.js`，约 1,800 行 | 扫描状态、提交轮询、导入导出、过滤排序、表格与详情渲染集中；UI 内仍判断 local/gateway | 拆控制器、结果模型和视图；模式差异收敛到 transport |
| `frontend/action-client.js:399`、`:469` | 本地 API 与 Actions API 已有分支，但认证、加密、进度归一化也放在同一文件 | 保留现有行为，拆成两种适配器与明确的公共接口 |
| `frontend/app.js:96`、`frontend/action-client.js:312` | 等待节点进度等逻辑重复 | 由统一的快照模型生成，UI 不再次猜测进度 |
| `backend/app/jobs.py:59`，约 940 行 | 状态管理、下载订阅、并发队列、节点重试、核心进程、落盘和结果构造混在一起 | 分离任务管理与单节点执行；状态和失败记录集中定义 |
| `backend/app/scanner.py:66`，约 1,426 行 | HTTP 请求、多个数据源、解析、评分和完整性判定混合 | 传输层与数据源模块分离，采集器只编排依赖 |
| `backend/app/result_store.py`，约 568 行 | 文件操作、业务记录校验、manifest 和导出耦合 | 拆存储、记录校验、artifact 组装，保留稳定入口 |
| `worker/index.js:761`，约 832 行 | 路由、Access、扫描 token、GitHub App、run 关联、artifact 下载集中 | 按安全边界与业务职责拆模块，入口只分发和处理错误 |
| `scripts/sanitize_action_artifact.py:19` | 生产 artifact 脚本导入 `verify_real_scan.py` 的私有函数 | 将脱敏和结果验证移到正式模块，脚本只处理参数与退出码 |
| `.github/workflows/scan.yml:102`、`:119` | Actions 先启动临时 FastAPI，再通过“验收脚本”完成正式扫描 | 后期迁移为生产 CLI 直接调用扫描核心，验收脚本回归测试用途 |
| `scripts/dev.py:141`、`backend/app/mihomo.py:315` | Windows 热重载曾导致子进程不支持，统一错误又掩盖了实际阶段 | 保留兼容处理，补运行时能力与错误分类测试 |

保留已有的小模块，不为目录整齐强拆：`schemas.py`、`subscription.py`、`decrypt_subscription.mjs`；`mihomo.py` 先保持独立适配器，仅在节点执行边界稳定后处理内部重复。

## 3. 目标运行架构

### 3.1 本地调试

```text
uv run python scripts/dev.py
  ├─ 静态前端服务 127.0.0.1:5173
  │    ├─ frontend/index.html + ES modules
  │    └─ /site-config.js → mode=local、实际 apiBase
  └─ FastAPI 127.0.0.1:8000
       └─ ScanService / JobManager
            └─ NodeRunner → 独立 Mihomo → 数据源采集 → 结果存储

浏览器 ── 精确 CORS ──> FastAPI /api/*
```

- 前后端是独立 HTTP 服务；可由同一个启动器管理，不要求为“分离”再增加构建服务。
- 默认端口被占用时，各自选择空闲端口；动态配置必须使用最终端口。
- FastAPI 根路径保持 404，不挂载前端目录。
- 本地启动不依赖 Cloudflare、GitHub App 或生产密钥。
- 首次启动按既有方式准备 Mihomo；下载失败时给出明确错误，不假报健康。
- Windows 默认关闭 Uvicorn 热重载；其他平台保留现有行为。修改 Windows 后端代码后手动重启。
- Ctrl+C 必须结束本次启动的服务和扫描子进程；不得清理其他应用或其他扫描实例。

### 3.2 线上部署

```text
浏览器
  └─ Cloudflare Access
       └─ Worker
            ├─ Static Assets：同一份 frontend/
            ├─ /site-config.js：mode=gateway、公钥配置
            └─ /api/*：认证、任务身份、GitHub 调度、artifact 网关
                 └─ GitHub Actions scan.yml
                      ├─ 解密订阅到 runner 临时目录
                      ├─ Python Scan CLI
                      │    └─ 同一个扫描核心 → Mihomo → 采集与存储
                      └─ 生成脱敏 artifact → 浏览器校验后展示
```

“可部署到 Worker”指前端和网关部署到 Worker；Mihomo 执行位置仍是 Actions runner。**本地和线上共享扫描实现，不强行共享同一套 HTTP 传输与认证方式。**

生产 CLI 是后期迁移目标。前几个阶段继续使用现有 runner API 路径，避免同时修改模块结构与执行方式。

## 4. 模块边界与拟定目录

以下是职责落点，不要求一次创建所有文件。小而内聚的实现可合并；禁止建立只有转发作用的空壳层。

```text
frontend/
  index.html
  styles.css                     # 保留现有样式入口；不同时重做视觉
  scan-public.pem
  src/
    main.js                      # 读配置、装配适配器与 UI
    scan-controller.js           # 提交、轮询、取消、会话生命周期
    state.js                     # 明确的页面状态；不碰网络和 DOM
    results.js                   # 结果归一化、筛选、排序等纯函数
    import-export.js             # 用户导入导出，与扫描传输分开
    views/
      scan-view.js               # 表单、进度、错误
      table-view.js
      detail-view.js
    transport/
      index.js                   # 仅此处选择 local/gateway
      local.js
      gateway.js
      http.js
    artifact/
      reader.js                  # 迁入现有 ZIP 与 artifact 校验实现
    crypto.js                    # 仅 gateway 适配器使用

backend/app/
  main.py                        # create_app、lifespan、CORS、依赖装配
  api.py                         # HTTP 路由与错误映射
  config.py
  schemas.py                     # HTTP 边界模型
  scan/
    jobs.py                      # 接收任务、状态、并发、取消与等待
    node_runner.py               # 单节点重试、代理依赖、核心生命周期
    models.py                    # 扫描结果与进度的内部类型
    errors.py                    # 错误码、阶段、可重试性、安全消息
  sources/
    collector.py                 # page/trace/lookup/enrichment 依赖编排
    http.py                      # 代理 HTTP、超时、响应限制、URL policy
    coffee.py                    # Coffee 请求与字段解析
    ipure.py                     # IPure 请求、总分与场景评分解析
    gpt_checks.py                # 原有 ChatGPT/API 探测逻辑
  results/
    store.py                     # 原子写盘与读取
    validation.py                # 节点、manifest、计数及证据一致性
    artifact.py                  # 脱敏、artifact 组装、凭据排除
  mihomo.py                      # 核心配置、端口、进程、selector
  subscription.py                # 订阅下载与解析；暂不继续拆分

worker/
  index.js                       # fetch 入口与统一错误边界
  router.js
  config.js                      # 固定仓库/workflow 与配置校验
  auth.js                        # Access、同源约束、扫描 token
  github.js                      # App JWT、installation token、API client
  scans.js                       # dispatch、查询、取消、run 关联
  artifacts.js                   # 唯一 artifact 查找和有界下载
  responses.js                   # 安全响应头和公开错误格式

scripts/
  dev.py                         # 保留 uv 本地启动入口
  run_scan.py                    # 新增生产 CLI，后期切换 workflow 使用
  verify_real_scan.py             # 真实验收入口，不再被生产模块反向导入
  sanitize_action_artifact.py     # 迁移为薄入口；无调用后再删除
  download_mihomo.py
  decrypt_subscription.mjs

tests/
  fixtures/contracts/            # Python、浏览器与 Worker 共用的静态样例
  ...                            # 按被测职责渐进拆分现有测试
```

目录中的样式文件名以现有实际文件为准，不为本方案强行改名。保留根目录 `pyproject.toml`、`uv.lock`、`package.json`、锁文件和 `wrangler.jsonc`，不新增 monorepo 管理工具。

### 依赖规则

- `main/api → scan → sources/mihomo/subscription/results`，不允许反向导入 FastAPI。
- 正式模块不得导入 `scripts/verify_*`、测试模块或它们的私有函数。
- 浏览器视图不得拼 API URL、持有扫描 token、解析 GitHub run 或解压 ZIP。
- Worker 不导入 Python 代码，也不复制 Python 扫描规则。
- Python 与 JavaScript 各自校验所在信任边界；共享协议样例，不通过一个抽象包强行共用语言实现。

## 5. 先固定契约，再移动实现

### 5.1 前端 transport 接口

两种适配器提供相同的 UI 接口，名称在第一阶段确定并固定：

```text
health()               → 服务可用性与可展示能力
start(subscriptionUrl) → session
poll(session)          → ScanSnapshot
cancel(session)        → 取消请求结果
```

`session` 是适配器管理的句柄；token、run ID 和 dispatch 时间只在 transport 内存中处理。UI 不把它持久化或直接渲染。

`ScanSnapshot` 至少区分：

- 执行状态：排队、运行、取消中、已取消、执行完毕、任务失败。
- 阶段与安全错误：启动、选择节点、采集、写入、验证、清理。
- 进度来源：本地节点进度或 Actions Job/Step；未知节点数量保持未知，不能补成 0/0。
- 结果可用性：尚不可用、验证通过且有可用节点、全部节点失败、结果无效。
- 节点终态统计：`success / partial / failed`，不能用 workflow 成功代替节点成功。

本地仍使用明文订阅到 loopback API；线上仍使用加密 envelope。**统一 UI 接口，不强改两种网络协议为同一个请求体。**

### 5.2 Python 扫描入口

将扫描服务的创建、状态查询、取消、等待结束整理为公开接口。FastAPI 和 CLI 只使用这些接口，不访问 `manager.tasks` 等内部字典。

- 配置通过装配入口传入；逐步移除深层模块对全局 `settings`、`result_store` 的隐式依赖。
- 节点执行器返回标准结果；任务管理器只负责聚合、调度、终态和资源所有权。
- 用明确类型承接当前重复的结果字典；优先复用已有依赖，不为类型建第二套验证框架。
- 对外导出的 schema v1 在纯拆分阶段保持不变。必须变更字段时另列契约迁移，不夹带在文件搬迁中。

### 5.3 错误与数据缺失

错误需包含稳定 `code`、`phase`、安全消息和可重试性；原始异常、订阅 URL、密码不得进入前端或 artifact。

至少区分：

| 情况 | 归类与行为 |
| --- | --- |
| Mihomo 缺失、事件循环不支持子进程 | 运行环境失败，停止任务，不对所有节点重复尝试 |
| 某节点配置不受支持 | 当前节点配置失败，不影响其他节点 |
| selector 未确认 | 核心选择失败，不伪装成远端服务器不可达 |
| 节点 DNS、连接、TLS 失败 | 节点传输错误，按既有有界策略重试 |
| IPure 403、人机验证、限流或超时 | enrichment 不可用；已有出口 IP 保留，标为 partial |
| artifact 校验不通过 | 结果不可用，禁止展示为可信扫描结果 |
| 子进程或目录未清理完成 | 清理失败，不宣称任务已正常结束 |

错误类型到 UI 文案只维护一个映射入口；前端不靠匹配中文字符串推断任务阶段。

## 6. 必须保留的行为

### 扫描与结果

- 每次尝试使用独立 Mihomo 进程、工作目录、mixed-port、controller 和连接池。
- 只装入当前节点、其 `dialer-proxy` 依赖与需要的 DNS 引导节点；无关坏节点不能阻断订阅。
- 选中结果经过 selector 确认，才开始数据采集。
- 所有采集经工作区代理，继续 `trust_env=False`，不回退宿主代理或直连来伪造成功。
- 并发上限、超时预算、重试次数和取消清理保持有界。
- 每个真实节点恰好一条终态记录；失败节点 `exit_ip=null`。
- 保留原子写入、manifest、计数、身份和证据校验；已经有明确用途的校验不能以“去屎山”为由删除。

### 本地与生产边界

- 本地仅监听 `127.0.0.1`，精确 CORS 跟随实际前端端口。
- 本地开发开关不能让生产 Worker 绕过 Access 或接受明文订阅 envelope。
- 保留订阅加密、公钥指纹核验、内存扫描 token、同源请求限制和生产配置缺失时的拒绝行为。
- 保留固定 repository、workflow、branch、request/run/attempt 关联以及唯一 artifact 校验。
- 保留 ZIP 路径、大小、CRC、SHA-256、manifest 与节点记录检查；本地 JSON 和生产 ZIP 共用业务记录规则，但不强迫本地绕一遍 ZIP。
- `wrangler.jsonc` 的静态资源绑定与 `run_worker_first` 行为不能因前端目录搬迁而绕过访问控制。

## 7. 分阶段实施清单

每阶段保持可运行，单次变更只处理一个主要职责。不要先把所有文件搬走，再集中修测试。

### P0：冻结行为与协议基线

- [ ] 记录当前启动入口、HTTP 路由、请求体、响应、artifact schema 和环境变量。
- [ ] 运行现有 Python、前端、Worker 测试和 dry-run；记录失败，不把历史失败算作重构引入。
- [ ] 补充成功、partial、全部失败、环境失败、取消、无效 artifact 的无凭据样例。
- [ ] 建立同一组记录样例的 Python/JS 契约测试；建立 Worker dispatch 与 workflow inputs/artifact 命名的一致性测试。

交付：协议样例与测试基线。退出条件：能明确区分“行为保持”和“有意改行为”。

### P1：前端先统一适配器边界

- [ ] 从 `action-client.js` 提取 local/gateway、HTTP、加密与结果读取职责。
- [ ] 固定 `ScanSnapshot`，把等待进度、终态统计和错误归一化从 UI 移到适配器边界。
- [ ] UI 不再判断 `localMode`、设置 credentials 或拼接 gateway 路径。
- [ ] 保持两条现有网络协议；本地和 Worker 的提交、轮询、取消各跑一组契约测试。

交付：统一的 UI transport 接口。退出条件：切换模式只改变运行时配置和适配器，视图无需修改。

### P2：拆前端状态、纯函数与视图

- [ ] 将 app.js 中过滤、排序、结果归一化、导入导出抽成可独立测试的函数。
- [ ] 将表格、详情、扫描进度渲染拆分；DOM 事件统一在入口或控制器绑定。
- [ ] 迁移为浏览器原生 ES modules，去掉最终不再需要的 `window.BestIp*` 全局装配。
- [ ] 将依赖 VM 内部顶层函数的测试改为模块测试；保留用户交互层的 DOM 冒烟测试。
- [ ] 检查静态服务与 Worker 均能正确提供 module 路径和 MIME，不引入前端构建步骤。

交付：薄入口与职责清晰的前端。退出条件：筛选、排序、导入导出、取消和详情行为不退化。

### P3：拆 Python 任务编排与单节点执行

- [ ] 将 `jobs.py` 中单节点尝试循环、代理依赖选择和清理移到 `node_runner.py`。
- [ ] JobManager 保留任务级状态、并发、取消、等待、统计和 finalize。
- [ ] 统一结果构造、错误分类和运行环境故障处理，防止环境错误被复制为整订阅节点失败。
- [ ] 对确有重复的取消安全线程包装做一次提取，不新建通用“工具大全”。
- [ ] 将依赖从模块全局读取改为明确注入，保证测试与多个任务互不污染。

交付：可由 API/CLI 调用的扫描服务。退出条件：坏节点隔离、链式代理、重试新进程、并发上限、取消无残留全部通过。

### P4：拆数据源与结果模块

- [ ] 从 scanner.py 分离代理 HTTP 策略、Coffee、IPure、GPT 探测与采集编排。
- [ ] 每个数据源保留自己的解析器与响应样例；数据源异常不能抹掉已取得的出口证据。
- [ ] 从 result_store.py 分离纯校验与 artifact 脱敏/组装，磁盘操作留在 store。
- [ ] 去除 artifact 脚本对验收脚本私有函数的导入。
- [ ] API 路由保持薄层，将内部类型序列化为现有公共结果格式。

交付：可以离线测试的数据源解析与结果协议。退出条件：同一份固定输入产生等价结果，403/缺字段/部分失败有明确表现。

### P5：拆 Worker，保持现有部署协议

- [ ] 将 worker/index.js 拆为路由、auth、GitHub client、scan、artifact 和响应模块。
- [ ] 认证缓存和 token 刷新归属 GitHub client，不散落到各路由。
- [ ] 将 repository/workflow/branch 常量集中，不改成可被请求指定的通用代理。
- [ ] 补完整 fetch 路由测试：dispatch body、状态查询、取消、artifact 下载、动态配置与静态资源认证。
- [ ] 同步 `package.json` 的检查覆盖、Worker 测试导入及必要的 workflow 路径过滤。

交付：模块化网关。退出条件：原有认证与身份校验测试通过，`npm run dry-run` 成功，现有 scan.yml 无需配合改协议即可运行。

### P6：生产扫描与验收解耦

- [ ] 新增 `scripts/run_scan.py`，接受 request ID、订阅文件路径和输出目录；调用 P3/P4 的正式接口。
- [ ] CLI 直接运行共享扫描核心、验证结果、生成脱敏 artifact；不创建前端或临时 HTTP 服务。
- [ ] 生产配置允许有出口 IP 的 partial 结果，但全部节点失败不能作为成功业务结果通过。
- [ ] 区分输入/环境错误、扫描不可用、校验失败、清理失败的退出原因；工作流展示安全说明。
- [ ] `verify_real_scan.py` 只负责真实验收，可测试本地 API 和 CLI 产物，不再承担正式执行入口。
- [ ] 切换 scan.yml，删除临时 API 启动、健康轮询、PID 管理和对应环境变量；保留密钥临时文件、固定核心版本、清理与 artifact 身份。
- [ ] 保持 Worker dispatch inputs、run-name、artifact 名称和 schema，避免 Worker 与 runner 同时切协议。

交付：不依赖 API 绕行的 Actions 扫描。退出条件：同一固定测试订阅在 API 和 CLI 下通过相同结构/节点证据校验；真实公网 IP、延迟和外部评分不要求逐字相等。

### P7：删除迁移残留，完成双环境验收

- [ ] 全仓查找旧 imports、全局对象、脚本调用与 workflow 引用，再删除兼容转发入口。
- [ ] 核查 `HttpScanner`、旧 GPT 常量别名、`_request_external` 等候选；确认无生产/测试/脚本调用后才删除。
- [ ] 删除已经替代的重复进度逻辑、重复错误映射和废弃 runner API 管理脚本。
- [ ] 不删除仍用于信任边界的重复校验；不为降低行数移除测试。
- [ ] 更新 README：uv 启动、Windows 限制、目录职责、Worker 配置、部署和真实验收。
- [ ] 完成本节后的验收矩阵，保留一份脱敏验收记录。

交付：旧实现已退出、无双轨长期维护。退出条件：新路径是默认路径，文档命令与实际入口一致。

## 8. 验收矩阵

| 范围 | 必测场景 | 通过标准 |
| --- | --- | --- |
| 本地启动 | Windows、Linux；默认端口；两端口占用 | uv 一条命令启动两服务，页面使用实际 API 地址 |
| 服务边界 | 前端资源、FastAPI `/`、允许/拒绝的 Origin | 前端资源正常，后端根路径 404，CORS 精确匹配 |
| 运行能力 | Windows 默认启动后实际创建 Mihomo | 不能只检查核心文件存在或健康接口 200 |
| 生命周期 | 扫描中取消、Ctrl+C、启动失败 | 子进程、端口与任务目录清理有确认，无跨任务误清理 |
| 节点隔离 | 有效节点与无关坏配置共存、dialer-proxy 链 | 有效节点照常执行，依赖齐全，无整份订阅配置失败 |
| 任务统计 | success、partial、failed、全失败 | 每节点一条终态；全失败显示不可用而非验收通过 |
| 数据源 | 正常响应、IPure 403/限流、缺评分、连接异常 | 保留真实出口，partial 原因可见，不填假分数 |
| 前端 | 筛选、排序、导入导出、详情、取消后重扫 | 行为与基线一致，错误内容按文本显示 |
| Worker | 无权限、错误 token、过期、错 run/attempt、错 artifact | 拒绝错误身份，不返回无关任务数据 |
| 协议 | Python 输出→JS 校验；损坏 ZIP/manifest/记录 | 有效样例通过，无效样例拒绝，两端业务规则一致 |
| CLI | 正常完成、全部失败、环境错误、超时取消 | 退出结果真实、产物符合协议、敏感文件和核心已清理 |
| 线上端到端 | Worker 页面→Actions→artifact→页面 | 用专用测试订阅实际跑通，至少一个真实节点取得出口 IP |

“页面能打开”“health=ok”“单元测试全绿”“Wrangler dry-run 成功”分别只证明各自那一层，不能替代线上端到端验收。

最近一次本地排障中，真实订阅的 22 个节点均取得出口 IP，但 IPure 出现 403 和连接异常，结果为 partial。这是应保留的真实场景，不是重构后的自动成功基线；重构结束必须重新运行验收。

## 9. 命令与交付要求

### 现有命令继续保持可用

```bash
uv sync --dev
uv run python scripts/dev.py
uv run python scripts/dev.py --no-open --no-reload

uv run ruff check .
uv run pytest -q

npm ci
npm test
npm run dry-run
git diff --check
```

本地日常启动只需 uv 路径；npm 用于 JavaScript 测试和 Worker 部署。各阶段迁移后同步更新 `npm run check` 与测试入口，不能让新模块游离于检查之外。

### P6 待实现的生产 CLI

```bash
uv run python scripts/run_scan.py \
  --request-id <request-id> \
  --subscription-file <runner-temp/subscription-url> \
  --output-dir <runner-temp/action-artifact>
```

CLI 从临时文件读取订阅，不要求用户把 URL/令牌写在命令参数中。run ID 和 attempt 由 Actions 环境提供并验证。本地 CLI 验收使用明确的测试身份，不伪装成真实 GitHub run。

### 部署与发布

```bash
npm run deploy
```

- 实施前记录现有 Worker/App/Actions 配置，不在模块重构期间顺便轮换密钥或改变访问策略。
- 部署到 Worker 前先通过测试和 dry-run；实际部署与真实 Actions 扫描是单独的发布验收步骤。
- P6 首次切换保留上一版 workflow 与代码的可回退版本；失败时回退完整阶段，不混用新旧 artifact 协议。
- 阶段内短期兼容入口只能单向转发，不允许维护两套扫描实现；P7 删除已完成迁移的入口。

## 10. 最终完成定义

- [ ] 一条 uv 命令可本地调试，Windows 能真正启动 Mihomo，不依赖生产账号配置。
- [ ] 同一套前端资源可由本地静态服务和 Worker Static Assets 提供。
- [ ] UI 不知道 GitHub 传输细节；Python 扫描核心不知道 HTTP 和 Actions。
- [ ] Worker 可部署，Actions 调用正式 CLI，同一条线上链路真实跑通。
- [ ] 环境失败、节点失败、数据源缺失和结果校验失败可明确区分。
- [ ] 关键隔离与安全契约没有退化，取消清理有实测证据。
- [ ] 旧调用链和重复实现已经移除，验收脚本不再被生产模块导入。
- [ ] 每个阶段都有对应测试与结果，不用“文件变短”或“测试数量增加”代替功能验收。

推荐实施顺序：**P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7**。前端、扫描核心和 Worker 的内部拆分可以分别审阅，但跨边界契约先固定；执行方式切换必须晚于共享核心稳定。

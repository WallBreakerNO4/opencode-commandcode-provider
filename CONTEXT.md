# CommandCode → OpenCode Provider

把 Command Code Go plan 专用的 `/alpha/generate` 网关转成 OpenCode 原生 provider 的插件项目术语表。

## Language

### 服务与订阅

**Command Code**:
commandcode.ai 的 AI 编码订阅服务；官方 CLI 以 npm 包 `command-code` 发布。
_Avoid_: CC（仅限口语）

**Go plan**:
Command Code 订阅档位之一（含 GOAT / Pro）。无权调用 Provider API，只能经 `/alpha/generate` 使用模型。
_Avoid_: 免费档、API plan

**Provider API**:
Command Code 的标准 OpenAI 兼容端点（`/provider/v1/*`）。Go plan 调用返回 403 upgrade_required。

### 协议

**`/alpha/generate`**:
官方 CLI 专用生成网关。请求为 CLI 信封，响应为 NDJSON 事件流，恒为流式。
_Avoid_: 反代端点、私有 API

**CLI 信封**:
`/alpha/generate` 的请求体七键结构 `{config, memory, taste, skills, permissionMode, threadId, params}`；语义集中在 `params`（模型、消息、工具、采样参数），`threadId` 与 `x-session-id` 同值（#9 抓包定案），`memory` / `taste` / `skills` 为官方硬编码 `null` 死键（#25 源码定案）。

**config 块**:
CLI 信封顶部的工作环境简报，九字段 `workingDir / date / environment / structure / isGitRepo / currentBranch / mainBranch / gitStatus / recentCommits`；逐字段照抄官方 CLI 采集实现，非 git 仓库显式空值、不省略字段。规格见 `docs/spec/disguise.md` §9。
_Avoid_: 环境上报、上下文块、环境简报

**NDJSON 事件流**:
`/alpha/generate` 的响应格式——每行一个 JSON 事件对象（`text-delta` / `tool-call` / `finish-step` / `finish` 等），非 SSE `data:` 帧。
_Avoid_: SSE 流

**伪装层**:
让请求在网络特征上贴近真实官方 CLI 的组件集合：设备指纹、lifecycle 事件、会话标识、project-slug、CLI 版本头、traceparent。
_Avoid_: 反检测、作弊层

**设备指纹**:
伪装层经 `/alpha/fingerprint/record` 向网关申报的设备档案（15 个 components 字段 + thumbmark 联合哈希）。per-key 一份，进程内稳定。
_Avoid_: 硬件指纹、机器码、设备 ID

**预请求**:
主请求之前发出的伪装上报统称（设备指纹记录 + lifecycle 事件）。是画像加分项，不是主请求可用的前置条件。
_Avoid_: 初始化请求、预热请求、遥测前置

**协议核心**:
插件内负责协议翻译的模块：CLI 信封构造、NDJSON 事件流解析、错误映射、超时与取消。规格见 `docs/spec/protocol.md`。
_Avoid_: 转换层、协议层（泛称时）

**错误映射**:
把上游 HTTP 错误与流异常翻译成 AI SDK 错误对象的规则表；每类错误标注可否重试，是否重试由 OpenCode 决定，provider 不自行重试也不吞错。
_Avoid_: 状态码透传、错误透传

**空闲看门狗**:
判定上游失联的机制：持续 300 秒未收到任何新事件即断开上游并报可重试错误；连接等待计入空闲，无总超时。
_Avoid_: 总超时、请求超时

**零输出防护**:
流正常结束但用量为零（模型一个字未吐）时合成可重试错误的防护，避免白跑一回合。
_Avoid_: 空响应、防计费（订阅制下理由已弱化）

**伪装人格**:
伪装层对外呈现的设备形态：**如实上报用户真实机器**——平台、内核版本、CPU/内存、时区、网卡哈希均取真值，不构造假人格。指纹、environment、lifecycle 的 os 字段同源取真实值（#9 抓包校准，win32 假人格已弃用）。
_Avoid_: 假身份、多平台伪装、win32 假人格（已弃用）

### 模型

**模型清单**:
某订阅 plan 实际可用的模型 id 集合。来源：`GET /provider/v1/models`。

**模型元数据**:
单个模型的上下文窗口、价格、能力（视觉 / 工具）、reasoning 档位等配置参数。来源：官方 CLI 模型目录（构建侧解析进构建产物）、`/provider/v1/models`、models.dev（仅构建侧补 limits 缺口）、包内快照。
_Avoid_: 模型配置、模型信息

**构建产物**:
构建侧（GitHub Action，随官方 CLI 发版自动触发）从官方 CLI 包解析出的 JSON（schema 见 `docs/spec/model-pipeline.md`），经分发渠道（默认 URL 列表）供插件运行时拉取。绝不在用户机器上解析或生成。
_Avoid_: 解析产物（旧称）、逆向结果、gist JSON

**Go plan 过滤**:
把 `/provider/v1/models` 的全量列表筛成 Go plan 实际可用子集的规则：Min plan 归一化后等于 Go 的模型保留，在构建侧完成，客户端不做过滤。
_Avoid_: isGoModel 前缀白名单（jiesou 式，已漂移弃用）、客户端过滤

**Min plan**:
官方 CLI models.md 标注的、能调用某模型的最便宜订阅档位；套餐序 Go < GOAT < Pro < Max，高档包含低档全部模型。Go plan 过滤的判定依据。
_Avoid_: 最低套餐列

**包内快照**:
随插件一起发布的构建产物副本（同 schema），代表发版时刻的最后已知良好产物，是运行时永远可用的兜底层。
_Avoid_: 内置目录、静态目录

**数据包**:
只承载构建产物的独立 npm 包（`@wallbreakerno4/opencode-commandcode-models`），与插件主包分离发版，为构建产物提供大陆直连可达的分发副本。
_Avoid_: models 包、数据 npm 包

**files 白名单**:
npmmirror 对 files 端点（`registry.npmmirror.com/<pkg>/latest/files/*`）的按包准入机制：仅放行 cnpm/unpkg-white-list 仓库登记的包（PR 制，合并后约 5 分钟生效），未登记包一律 403；数据包登记后方能充任默认 URL 列表的 npmmirror 渠道。
_Avoid_: CDN 限流、同步黑名单

**默认 URL 列表**:
客户端内置的构建产物拉取地址序列，按序尝试、首个成功者胜；用户可经 v1 `provider…options.modelsUrls` / v2 `providers…settings.modelsUrls` / 环境变量 `COMMANDCODE_MODELS_URLS` 以**整列表替换**方式覆盖（config > env > 默认），非法值回退默认列表并告警、不阻断启动。包内快照独立于列表，始终是最后兜底层。
_Avoid_: 源列表、fallback 链、URL 追加/插位

**变体**:
同一模型按推理档位派生的可选形态（如 low / high / max），来自构建产物的 efforts 字段；缺档位不造变体，未选变体即基础形态（不发送 reasoning_effort）。
_Avoid_: reasoning variants（中英混用）、档位补全

**合并级联**:
运行时对多来源模型数据按「每字段单一天窗」取值的规则：`/provider/v1/models`（发现、context）× 构建产物（其余元数据）× 包内快照（兜底）。
_Avoid_: 来源优先级矩阵

### 插件与安装

**插件自举**:
插件在运行时自己注入 provider 配置、模型清单与认证方式（v1 经 config/auth hook，v2 经 catalog.transform 与 integration），使用户除安装插件与登录外无需手写任何配置。
_Avoid_: 自动配置、零配置魔法

**provider id（`commandcode-go`）**:
插件注册的 provider 唯一标识：v1 config 注入键、v2 `opencode.json` 空壳键、integrationID、模型 id 前缀 `commandcode-go/<wire>` 四处同名；模型 reference 按首个 `/` 切分，wire id 可含 `/` 原样透传。
_Avoid_: CCProto（原型残留）、`commandcode`（brent 包占用）

**Command Code (Go)**:
provider 的显示名，v1 `/connect` 列表项、v2 目录与 provider 列表、v2 integration name 三处同用。
_Avoid_: CCProto、Command Code (proto)（原型残留）

**认证方法 label**:
`/connect` 认证输入框的标题文案，固定为「Command Code API Key」，v1 auth hook 与 v2 integration key method 同文案；env 方法不使用 label。
_Avoid_: API Key 文案（泛称时）

### 测试

**人工验收**:
真宿主人工验收——真实 OpenCode 宿主、真实 key、真实网络上由人执行的验收层，覆盖不入 bun test 的 glue 模块、分发连通性与端到端行为；与自动化测试互不重复。清单：`docs/spec/acceptance.md`。
_Avoid_: 真机测试、集成测试、冒烟测试

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
`/alpha/generate` 的请求体结构 `{config, memory, taste, skills, permissionMode, params}`；语义集中在 `params`（模型、消息、工具、采样参数）。

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

**伪装人格**:
伪装层对外呈现的单一设备形态（win32-x64 + 固定 osRelease + 时区池）。指纹、environment、lifecycle 的 os 字段均取自同一人格。
_Avoid_: 假身份、多平台伪装

### 模型

**模型清单**:
某订阅 plan 实际可用的模型 id 集合。来源：`GET /provider/v1/models`。

**模型元数据**:
单个模型的上下文窗口、价格、能力（视觉 / 工具）、reasoning 档位等配置参数。来源：官方 CLI 模型目录（构建侧解析进构建产物）、`/provider/v1/models`、models.dev（仅构建侧补 limits 缺口）、包内快照。
_Avoid_: 模型配置、模型信息

**构建产物**:
构建侧（GitHub Action，随官方 CLI 发版自动触发）从官方 CLI 包解析出的 JSON（schema 见 `docs/spec/model-pipeline.md`），经分发渠道供插件运行时拉取；渠道未定，gist 只是候选之一。绝不在用户机器上解析或生成。
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

**合并级联**:
运行时对多来源模型数据按「每字段单一天窗」取值的规则：`/provider/v1/models`（发现、context）× 构建产物（其余元数据）× 包内快照（兜底）。
_Avoid_: 来源优先级矩阵

### 插件与安装

**插件自举**:
插件在运行时自己注入 provider 配置、模型清单与认证方式（v1 经 config/auth hook，v2 经 catalog.transform 与 integration），使用户除安装插件与登录外无需手写任何配置。
_Avoid_: 自动配置、零配置魔法

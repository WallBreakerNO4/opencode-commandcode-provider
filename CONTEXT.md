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

### 模型

**模型清单**:
某订阅 plan 实际可用的模型 id 集合。来源：`GET /provider/v1/models`。

**模型元数据**:
单个模型的上下文窗口、价格、能力（视觉 / 工具）、reasoning 档位等配置参数。来源：models.dev、官方 CLI 模型目录、包内快照。
_Avoid_: 模型配置、模型信息

**解析产物**:
构建侧（维护者发布时或 GitHub Action）从官方 CLI 模型目录解析出的 JSON，托管于 gist 供插件运行时拉取。绝不在用户机器上生成。
_Avoid_: 逆向结果

**Go plan 过滤**:
把 `/provider/v1/models` 的全量列表筛成 Go plan 实际可用子集的规则（开源 provider 全保留，品牌 premium 模型剔除）。

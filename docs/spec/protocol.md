# 协议核心规格：信封构造、流解析与错误映射

> 状态：定稿（2026-08-30）。决策票：[WallBreakerNO4/opencode-commandcode-provider#8](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/8)。
> 事实输入：`docs/research/reference-projects.md`（四项目协议速查与差异对比）、OpenCode 源码 `packages/opencode/src/session/llm.ts`（调用参数实证，sst/opencode 仓库）。
> 范围：协议核心模块——`/alpha/generate` 请求信封构造、NDJSON 流解析、AI SDK 错误映射、调用参数处理、超时与取消、图片输入转换。伪装头（版本头 / session / slug / traceparent）由伪装模块负责（`docs/spec/disguise.md`），本文只约定请求头接口边界；模型参数元数据（maxOutput / inputModalities / efforts）来源见 `docs/spec/model-pipeline.md`。

## 0. 模块定位

协议核心是插件内的翻译官：请求方向把 AI SDK 标准调用翻译成 CLI 信封，响应方向把 NDJSON 事件流翻译回 AI SDK stream part。上游恒为流式，非流式 `doGenerate` = `doStream` 聚合（地图既定判例，本文不再展开）。

```text
OpenCode ──AI SDK 调用──▶ 协议核心 ──CLI 信封──▶ /alpha/generate
OpenCode ◀─stream part── 协议核心 ◀─NDJSON 事件── 上游网关
```

## 1. 请求信封

- `POST https://api.commandcode.ai/alpha/generate`，`stream: true` 恒真。
- 信封骨架为 **7 键** `{config, memory, taste, skills, permissionMode, threadId, params}`（#9 抓包定案：`threadId` 为真协议字段、与 `x-session-id` 同值，由伪装模块的会话身份提供；MAXeaglet 的「死代码 threadId」实为真字段，见 `docs/research/disguise-spec.md` §11.2）。骨架中除 `threadId` 外的伪装字段（`config.*`、顶层 `permissionMode`，以及恒 `null` 的 `memory`/`taste`/`skills`）取值均由伪装模块提供，逐字段规格见 `docs/spec/disguise.md` §9（三键死键定案见其三键取证），协议核心只留填充点。
- `params` 语义字段：`model`（wire id）、`messages`、`system`、`tools`、`tool_choice`、`max_tokens`、`stream`、`temperature`、`top_p`、`top_k`、`reasoning_effort`。

### 1.1 消息转换

| AI SDK 侧 | CLI 信封侧 |
|---|---|
| system 消息 | 提升进 `params.system`；多条以 `\n\n` 连接（四项目一致） |
| user 文本 part | `{type:"text", text}` |
| user 图片 part | `{type:"image", image:"data:image/<fmt>;base64,..."}`（见 §5） |
| assistant 文本 / reasoning / tool-call | `{type:"text"}` / `{type:"reasoning", text}` / `{type:"tool-call", toolCallId, toolName, input}`，`input` 为对象 |
| tool 结果消息 | `{role:"tool", content:[{type:"tool-result", toolCallId, toolName, output:{type:"text"│"error-text", value}}]}`，`isError` 时用 `error-text` |
| tools 定义 | Anthropic 风格 `{type:"function", name, description, input_schema}` |

### 1.2 参数处理

| 参数 | 规则 |
|---|---|
| `max_tokens` | `min(调用方值 ?? 64000, 级联 maxOutput, 200000)`。缺省复刻官方 CLI 常量 `tk = 64e3`（1.49.1 源码 + 抓包互证，ADR 0002）；级联 `maxOutput` 降级为裁剪参考（models.dev 第三方视角值，非网关真值，仅小于缺省时生效）；200000 为网关 zod 校验硬上限（#42 冒烟 400 实证，官方缺省 64e3 永不触及） |
| `temperature` / `top_p` / `top_k` | 有则透传，无则不发，不注入默认值 |
| `reasoning_effort` | 仅当变体被选中时发送。**接收通道为 `providerOptions.reasoningEffort`**——OpenCode 源码实证：variant 配置被合并进 options → `providerOptions` 传入 LanguageModel，这是变体档位到达协议核心的唯一路径；未选变体（base 模型）不发该字段，`off` 档不存在变体（#4 既定） |
| `tool_choice` | 调用方映射：`auto`→`{type:"auto"}`、`none`→`{type:"none"}`、`required`→`{type:"any"}`、指定工具→`{type:"tool", name}`；`tools` 非空且调用方未指定时显式发 `{type:"auto"}`（MAXeaglet 抓包验证的信封形状，不赌网关默认值） |

### 1.3 不支持的调用参数

- 实证结论：OpenCode 调用 `streamText` 时**不传** `frequencyPenalty` / `presencePenalty` / `stopSequences` / `seed`（源码全量核对），当前不存在「信封没有的参数被塞进来」的实际场景。
- 前向策略：将来若 AI SDK / OpenCode 新增透传参数，协议核心**不得**塞进信封、**不得**静默吞掉，一律按 AI SDK 规格经 **warnings 机制**上报（`LanguageModelV3` 的 call warnings，调用方在结果中可见）。

## 2. 流解析

- **严格 NDJSON**：按行切分、逐行 `JSON.parse`；跳过空行与 `:` 开头注释行。**不做** SSE 双兼容（不剥 `data:` 前缀、不处理 `[DONE]`、不做 `\r\n` 归一）——上游格式真变更时修改本项目适配，不预做兼容（老板裁决，见 §6）。
- 半行残片：EOF 时收到未完结的行——已收到 `finish-step` 则忽略，未收到则并入截断错误（§3 行 8）。
- 事件消费清单（jiesou × brent 并集）：

| 事件 | 处理 |
|---|---|
| `start` / `start-step` | 流开始（映射 AI SDK 对应 part） |
| `text-start` / `text-delta` / `text-end` | 正文块生命周期 |
| `reasoning-start` / `reasoning-delta` / `reasoning-end` | 思考块生命周期 |
| `tool-input-start` / `tool-input-delta` / `tool-input-end` | **增量工具参数，必做**（上游对长参数只发增量时，一次性解析会丢参） |
| `tool-call` | 一次性完整工具调用；字段名兼容 `input│args│arguments` 与 `toolCallId│id`（jiesou 变体） |
| `finish-step` | 收据：`finishReason│rawFinishReason` + `usage` |
| `finish` | 总账单 `totalUsage` |
| `response-metadata` | 元信息照收 |
| `error` | → error stream part（见 §3 行 9 注） |
| 未知 type | **静默忽略**——消费端向前兼容基本功，与 §6 否决的「预做格式兼容」不同类：前者是新增事件不炸，后者是给现有格式造别名 |

- usage 映射：camelCase 与 snake_case 双兼容（brent 实证两种都出现过）；`inputTokens` 取 `noCacheTokens` 优先、否则 `total − cacheRead`（jiesou 规则）；`cacheReadTokens` / `reasoningTokens` 映射到 AI SDK usage 对应字段。
- finishReason 词表（含变体归一）：`stop│end_turn`、`tool_calls│tool-calls`、`length│max_tokens│max_output_tokens`。

## 3. 错误映射表

错误对象为 AI SDK `APICallError` 形态：透传/合成状态码、标注「可重试吗」（重试由 OpenCode 决定，provider 不自行重试）、message 含 model id 与上游 message。错误信封按 `{"error":{"message":"..."}}` 解析，兜底 `parsed.message`（brent）。

| # | 上游情形 | 处理 | 可重试 |
|---|---|---|---|
| 1 | 401/403 + body 含 `MODEL_NOT_IN_PLAN` | 权限错误：「模型 X 不在当前套餐内」——**区别于认证失败**，防止用户白跑重新登录 | 否 |
| 2 | 401/403 其他 | 认证错误：提示 key 无效/过期，去 `/connect` 重新登录 | 否 |
| 3 | 402 payment required | 按配额窗口恢复假设处理（MAXeaglet 路线），但退避拉长 | 是（默认 retry-after 60s） |
| 4 | 429 | 限流；透传上游 `retry-after`，缺省用默认退避 | 是 |
| 5 | 400 + body 命中 context 超限特征 | 明确报「上下文窗口超限」，帮用户与压缩机制对上号（jiesou） | 否 |
| 6 | 5xx | 透传状态码 | 是 |
| 7 | 零输出：`finish-step` 到达但 outputTokens=0 且无 tool-call | 合成 429 防白跑一回合（MAXeaglet 技巧；订阅制下「防计费」理由弱化，「防浪费回合」保留） | 是（retry-after 10s） |
| 8 | 流关闭但无 `finish-step` | 截断错误（jiesou 的 STREAM_CLOSED）——无法确认回复完整 | 是 |
| 9 | `error` 事件（流中） | error stream part（附上游 message + model id），已收 delta 保留；**不吞错**——吞了用户会看到「正常结束但啥也没发生」 | 交 OpenCode |
| 10 | 客户端断连（abort） | 传播 abort 到上游 fetch，**不合成错误**（调用方自己取消的） | — |
| 11 | 响应前网络错误（DNS / 连接拒绝 / TLS） | 网络错误 | 是 |

## 4. 超时与取消

- **300 秒空闲看门狗**（jiesou 路线；常量，暂不配置化）：持续 300s 未收到任何新事件即判定上游失联 → abort 上游 + 抛可重试错误（retry-after 5s）。
- **无总超时**——Go plan 有 max 档推理模型与最长 200k token 输出，健康长回合可能超过任何固定总时限，总超时必然误杀（brent 5min 弃用）；MAXeaglet 30s 空闲对推理停顿太激进，亦弃用。
- 连接阶段计入空闲：「连首字节都没等到」本身就是最大的空闲，看门狗天然覆盖，无需单独连接超时。
- 取消合并：`AbortSignal.any(看门狗 signal, 调用方 abortSignal)` 统一控制上游 fetch——谁先响都生效，对应用户停止键（§3 行 10）与看门狗到点（本节）两条路径。
- `doGenerate` 聚合路径共用同一看门狗。

## 5. 图片输入

- **必须实现完整转换**（老板红线级裁决）：声明了 image 的模型（`inputModalities` 含 `image`，#4 管线数据）收到图片 part → 转 base64 data URL 进信封。声明了却转换 = #4 点名的「放行后静默丢弃」，禁止。
- AI SDK 图片 part（`Uint8Array` / URL）→ `data:image/<fmt>;base64,...`（MAXeaglet 验证的上游格式）。
- 未声明 image 的模型收到图片 → 丢弃 + warn 日志（防御路径：OpenCode UI 本就不会让用户往纯文本模型贴图，能到这里说明是异常流）。
- 尺寸不在客户端设限，超限由网关 400 按错误映射表（§3 行 5 同类的 400 处理）浮出。

## 6. 备选与否决记录

| 备选 | 否决理由 |
|---|---|
| NDJSON/SSE 双兼容解析（brent/MAXeaglet 式） | 为假想中的上游格式变更预做兼容没有意义：上游真改了，正确动作是修改本项目适配，不是提前替上游设想（老板裁决） |
| ~~固定 `max_tokens` 默认 + 200000 硬顶~~（原否决，#42 冒烟 + 官方 CLI 源码反转为现行方案） | 原否决的两个前提均不成立：级联 `maxOutput` 实为 models.dev 第三方视角值而非每模型真值；64000 非第三方发明，是官方 CLI 自身常量 `tk = 64e3`（抓包互证）。网关另有 `<= 200000` zod 硬校验（#42 冒烟 400），11/42 模型级联值超限、缺省直发必 400。现行算法见 §1.2 与 ADR 0002 |
| `error` 事件只记日志不传播（MAXeaglet） | 反代有自己的重试层才需要装死；provider 在 OpenCode 进程内，吞错 = 用户看到「正常结束但啥也没发生」 |
| 402 映射为 429 激进重试（MAXeaglet 原样） | 配额恢复假设成立但窗口未知，5-10s 级重试是浪费；60s 退避折中 |
| 总超时 5min（brent）/ 空闲 30s（MAXeaglet） | 前者误杀健康长回合（max 档 + 200k 输出可超 5min），后者误杀推理停顿 |
| penalty / stop / seed 预设丢弃策略 | OpenCode 源码实证根本不传这些参数，防的是假想敌；真传来时走 warnings 上报即可 |

# 测试规格：分层、范围与注入通道

> 状态：定稿（2026-09-01）。决策票：[WallBreakerNO4/opencode-commandcode-provider#20](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/20)。
> 事实输入：`docs/spec/protocol.md`、`docs/spec/disguise.md`、`docs/spec/model-pipeline.md`（被测行为契约）；#5/#11/#12（宿主实测定案）；bun:test 官方文档与源码（`useFakeTimers` / `advanceTimersByTime` / `setSystemTime` 能力核验，`AbortSignal.timeout` 定时器纳入 fake heap）。
> 范围：自动化测试（单测 + 集成）的范围与形态、mock 注入通道、时间与文件系统测试策略、CI、真宿主人工验收的边界（清单内容归端到端验收票 [#21](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/21)）。测试代码的文件布局、命名与切票粒度随地图移交 `/to-spec` 收敛，本文只定策略。

## 0. 三层形态

| 层 | 载体 | 对端 | fixture |
|---|---|---|---|
| 单测 | bun test | 无（纯函数） | 内联 |
| 集成 | bun test + mock fetch + fake timers + 本地 fixture server | 假上游（进程内） | `tests/fixtures/` 文件 |
| 真宿主人工验收 | 人工执行清单（#21） | 真实 OpenCode + 真实 key | 真机 |

原则：**bun test 全绿 = 自动化防线**；真宿主人工验收是 #21 的独立清单，两票互不重复。

## 1. 单测范围（纯函数 + 内联 fixture）

### 1.1 协议核心（契约：`protocol.md`）

- 信封构造：7 键骨架 `{config, memory, taste, skills, permissionMode, threadId, params}`，`threadId` 与 `x-session-id` 同值；伪装字段只留填充点。
- 消息转换：system 提升与多条 `\n\n` 连接；user 文本 / 图片 part；assistant 文本 / reasoning / tool-call；tool 结果 `isError` → `error-text`；tools 定义 Anthropic 风格。
- 图片转换：`Uint8Array` / URL → `data:image/<fmt>;base64,...`；未声明 image 的模型收到图片 → 丢弃 + warn（防御路径）。
- 参数处理：`max_tokens` 裁剪 `min(调用方值, maxOutput)`、缺省直接用 `maxOutput`、不发明固定默认值；`tool_choice` 四态映射（`auto`/`none`/`required`→`any`/指定工具）与 tools 非空未指定时显式 `{type:"auto"}`；`reasoning_effort` 仅变体被选中时经 `providerOptions.reasoningEffort` 发送、base 模型不发；越权参数走 AI SDK warnings。
- NDJSON 严格解析：逐行 `JSON.parse`；空行与 `:` 注释行跳过；半行残片两种结局（已收 `finish-step` 忽略 / 未收并入截断错误）；未知事件静默；usage 双 case 兼容与 `noCacheTokens` 优先规则；finishReason 词表归一（`stop│end_turn`、`tool_calls│tool-calls`、`length│max_tokens│max_output_tokens`）；事件消费清单全事件映射（含 `tool-input-*` 增量必做、`tool-call` 字段名变体兼容）。
- 错误映射：`protocol.md` §3 **十一行表全行**——含 401/403 的 `MODEL_NOT_IN_PLAN` 与认证错误区分、402 退避拉长、429 透传 retry-after、context 超限识别、5xx 透传、零输出合成 429、截断 STREAM_CLOSED、流中 `error` 不吞、abort 不合成错误、响应前网络错误。
- 取消合并形状：`AbortSignal.any(看门狗, 调用方)` 两路信号谁先响都生效。

### 1.2 伪装模块（契约：`disguise.md`）

- 指纹哈希：15 字段 components 结构、拼接序、「五字段不入哈希」结构、thumbmark 联合哈希——**注入固定输入**断言输出。
- 会话身份：主路径确定性派生（sha256 → 32 hex → 修补 uuid v4 版本/变体位）；回退路径 per-key 随机 uuid 12h + 0~1h 抖动惰性轮换。
- slug：workingDir 哈希近似 + 形状断言（小写字母数字短横分组 ×8 组、组长 4–11）。
- traceparent：`00-<32hex>-<16hex>-01` 逐请求新造。
- 版本头：1.5s 竞速（抢到用新值 / 超时先放行兜底值、查询转后台）、24h 惰性刷新（不挂 `setInterval`、不加抖动）、兜底链（落盘 → 包内快照）、数据源顺序 npm registry → jsDelivr。
- 退避状态机：成功 `nextInitAt = now + 8h + rand×2h`、`failCount = 0`；瞬时失败 60s × 2^failCount 封顶 15min 且 `failCount++`；4xx 长冷却 8h + rand×2h；主请求永不因预请求受阻。
- 日志脱敏：apiKey 只以 `cc-key#` + sha256 前 8 位出现；伪标识符截断 12 位 + `…`；Authorization / 完整 key 永不输出。
- 预请求：指纹 + lifecycle 并行（同一 `Promise.all`）、独立 3s 超时（`AbortSignal.timeout`）、超时/失败照常放行主请求、头集合（#9 校准全集，不带 `x-session-id` / `x-project-slug` / `traceparent`）、lifecycle 事件形状（`sess_<16hex>` 无关随机、`mode: "interactive"` 恒定、`os` 报真实 `platform-arch`）。

### 1.3 模型管线（契约：`model-pipeline.md`）

- 三层级联合并：每字段单一天窗——发现与 `context` 听 API，`efforts` / variants 听产物，`reasoning` / `inputModalities` / `maxOutput` 产物 → 快照兜底，`tool_call` 常量 `true`。
- 暴露规则：API 有产物无 → 隐藏；产物有 API 无 → 隐藏；快照兜发现时同规则。
- variants：产物有 `efforts` 按档位生成（v1 map 形状 / v2 数组形状）；无 `efforts` 不造任何变体；不做任何档位词过滤。
- `schemaVersion` 演进：同版本只许新增可选字段、未知字段忽略（向前兼容）、超已知上限整体弃用该产物降快照 + 告警。
- /models 变更签名：排序后 `(id, context_length)` 序列、**剔除 `created`**；API TTL 5min；产物按 URL 列表 TTL 1h + 抖动 + 内容 hash 变化才触发下游动作。
- 消费映射：v1 entry 与 v2 `Model.Info` 形状（均不含 `cost`）。

### 1.4 包形状防回归（判据：#11/#12 定案）

- 入口模块导出断言：`default` 含 `id` / `setup` / `server`；「第一个 `create*` 前缀导出」判据存在。
- 目的：防止重构破坏 v1 加载器决策树与 v1/v2 工厂判据依赖的导出形状（#11 实测：default 带 `id` 缺 `server` 则整模块跳过）。

### 1.5 不测：指纹采集器

- 「读真机」（平台 / 内核 / CPU / 内存 / 时区 / 网卡）**不单测**：#9 校准后指纹 = 真机真值，每台机器答案不同，自动检查无断言标准；采集逻辑为几行系统 API 调用，出错面小。
- 其正确性由真机验收（#21）覆盖；哈希 / 派生纯函数照 §1.2 以注入固定输入测试。

## 2. 集成范围（mock 全链 + 本地 fixture server）

- **HTTP 注入通道**：全部出网路径——`/alpha/generate`、`/provider/v1/models`、产物 URL 列表、npm / jsDelivr 版本查询、指纹与 lifecycle 预请求——统一经工厂 `options.fetch` 接缝注入 mock（#5/#11 实测的 v1/v2 官方接缝）；个别拿不到接缝的路径以 bun:test `mock.module` 替换 `globalThis.fetch` 兜底。
- **LanguageModelV3 全链**：`doStream` 对照事件消费清单全事件映射；`doGenerate` 聚合与流一致；abort 传播（用户取消 → 上游 fetch 收到 abort、不合成错误）；错误映射端到端（假 fetch 回 4xx / 5xx / 流中 `error` / 半行 EOF）；300s 空闲看门狗到点（fake timers 瞬推 300s）abort 上游 + 抛可重试错误。
- **级联降级**：本地 `Bun.serve` 扮演默认 URL 列表的多渠道（4 条 URL 指向 localhost 不同端口），验证：首成功者胜；部分失败按序回退；全失败落包内快照；`schemaVersion` 超限弃用产物降快照；/models API 失败退化产物清单；全离线快照全量注册 + 指数退避重试（30s 起上限 30min）。
- **时间**：bun:test fake timers（`advanceTimersByTime` / `runAllTimers` / `setSystemTime`）驱动看门狗、版本竞速、24h 惰性刷新、退避、会话轮换；生产代码不加时钟参数或环境变量。
- **落盘与日志**：`XDG_CACHE_HOME` 重定向至测试临时目录（判定见 §3）；logger 注 no-op（`disguise.md` §7 注入式）；断言版本缓存原子写形状（临时文件 + rename）与 `{version, fetchedAt}` 内容。
- **fixture**：NDJSON 事件流（全事件 / 截断 / 半行 / 错误事件 / 未知事件等场景）与产物 / 快照 JSON 置于 `tests/fixtures/`；快照内容在测试侧替换为 fixture，不依赖真快照的具体数据。

## 3. 「测试后门」判定标准（#20 拍板）

| 判定 | 结果 |
|---|---|
| 生产代码自定义测试专用环境变量（base URL 覆盖、行为开关等） | ❌ 禁止 |
| 为测试存在的分支代码路径 / 死代码开关 | ❌ 禁止 |
| mock 经既有官方接缝注入（工厂 `options.fetch`、注入式 logger） | ✅ 允许 |
| 系统标准环境变量重定向（`XDG_CACHE_HOME` 指向临时目录） | ✅ 允许——`disguise.md` §6 本就 XDG 优先，属标准行为，非测试机关 |
| fake timers 替换测试进程内全局时钟 | ✅ 允许——仅测试进程，不进生产路径 |

## 4. 不入自动化：真宿主边界（移交 #21）

- **v1/v2 glue**：三合一入口的 `server()` / config / auth hooks、v2 `catalog.transform` 自指注册、integration 认证、`/connect` TUI——**不入 bun test**。mock 整个宿主等于重写宿主，成本远超收益；该路径已由 #5/#11/#12 三次真机实测定案，回归防线 = #21 人工验收。**glue 是全项目唯一无自动化测试的模块**（老板知情拍板）。
- **真实网络与真实凭据**：真实 key、真实网关、真实分发渠道连通性不入 bun test——网络依赖测试必 flaky；渠道连通性归人工验收。
- **看门狗与预请求时序**：不入 #21 人工清单（该票草案已如此预判）——其逻辑由本规格集成层 fake timers 全覆盖，真机验证时序成本不成比例。
- #21 现有 10 项草案为人工验收清单底稿，增删归该票。

## 5. CI 与工程面

- **GitHub Actions**：push + PR 触发 `bun test`；单矩阵 ubuntu + bun latest——测试全注入化（无真机敏感路径、无网络依赖），多平台矩阵无增益。
- **覆盖率**：不设硬门槛；`bun test --coverage` 可查不卡关——模块少、边界清晰，以 §1 清单驱动优于数字指标。
- **fixture 布局**：单测内联；集成 fixture 文件置 `tests/fixtures/`。

## 6. 备选与否决记录

| 备选 | 否决理由 |
|---|---|
| 为指纹采集器抽象测试接口（注入假机器档案） | 接口层只为测试存在；采集逻辑几行系统 API 调用，出错面小；真机验收可兜 |
| 生产代码加时钟 / 超时注入参数 | bun:test fake timers 全覆盖（含 `AbortSignal.timeout`），无需为测试改生产代码 |
| glue 写宿主 mock 进 bun test | 重写宿主成本远超收益；#5/#11/#12 已真机实测；回归防线归 #21 |
| base URL 类测试环境变量 | 老板红线：生产代码零测试后门（#20 拍板） |
| 覆盖率硬门槛 | 清单驱动优于数字；防「为覆盖率写测试」的伪覆盖 |
| 真实网络 smoke 进 CI | 网络依赖必 flaky；渠道连通性归 #21 人工验收 |
| 看门狗 / 预请求时序入人工验收清单 | mock 已覆盖逻辑，真机验证时序成本不成比例（#21 草案同判） |

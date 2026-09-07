# Command Code 反代参考项目调研

> 调研日期：2026-08-28。调研对象为 4 个 GitHub 开源项目，全部结论均直接来自各仓库的 README 与源码（已逐文件核对），关键文件路径在每节列出。

## 背景：Command Code 订阅的两轨制

Command Code（commandcode.ai）的订阅分两类，这决定了反代项目的两种技术路线：

1. **Provider API**：提供标准 OpenAI 兼容端点（`/provider/v1/chat/completions`、`/provider/v1/models`），任何 agent harness 可直接接入，无需第三方插件。
2. **Go / GOAT / Pro Plan**：调用 Provider API 端点返回 `403 upgrade_required`，只能通过官方 CLI 专用的私有网关 `POST /alpha/generate` 使用（vendor lock-in）。

（来源：jiesou 仓库 README 及 `src/index.ts` 模块注释）

因此 4 个参考项目分成两派：

- **走 `/alpha/generate`**（本项目的目标场景）：MAXeaglet、jiesou、brent-weatherall
- **走 Provider API**（OpenAI 兼容直连）：Breskott

---

## 一、MAXeaglet/commandcode-proxy

- 仓库：<https://github.com/MAXeaglet/commandcode-proxy>（master 分支，MIT，238 stars）
- 形态：**独立反代服务器**（Node.js 单文件 `proxy.mjs`，约 1900 行，零外部依赖，支持 Docker/GHCR 部署）
- 对外暴露：OpenAI Chat Completions（`POST /v1/chat/completions`）+ Anthropic Messages（`POST /v1/messages`）+ `GET /v1/models` + `GET /health`
- 基于对官方 CLI 的网络抓包逆向（`captured-requests/` 目录存抓包数据），是 4 个项目中协议还原最完整的

### 关键文件

| 文件 | 内容 |
|---|---|
| `proxy.mjs` | 全部逻辑：协议、指纹、会话、双协议转换、重试 |
| `README_zh.md` / `README.md` | 协议细节文档（信封格式、反检测机制表） |
| `config.json` | 端口 / apiBase / projectSlug / 日志 |

### `/alpha/generate` 请求实现（`proxy.mjs` 的 `forwardToCC`，约 L755-778）

请求头（最完整的伪装集）：

```
Content-Type: application/json
Authorization: Bearer user_xxx          # 从客户端 Authorization: Bearer 或 x-api-key 提取，正则 user_[a-zA-Z0-9_-]+
x-cli-environment: production
x-command-code-version: <动态>          # 启动时从 https://registry.npmjs.org/command-code/latest 拉取（当前 0.32.3），24h 刷新
x-session-id: <uuid>                    # per-key 独立 session，12h 过期 + 1h 随机抖动；优先透传客户端 x-session-id / x-claude-code-session-id
x-co-flag: "false"
x-taste-learning: "false"
x-project-slug: <伪造>                  # 从 sessionId 派生假工作目录再按真实 CLI 规则生成 slug（如 c-users-dev-projects-web-app-a3f2）
traceparent: 00-<32hex>-<16hex>-01     # W3C Trace Context
```

请求体（CLI 信封格式，`buildCcRequest`，约 L367-503）：

```json
{
  "config": {
    "workingDir": "<cwd>", "date": "YYYY-MM-DD",
    "environment": "win32-x64, Node.js v24.16.0",
    "structure": [], "isGitRepo": false, "currentBranch": "",
    "mainBranch": "", "gitStatus": "", "recentCommits": []
  },
  "memory": null, "taste": null, "skills": "",
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [ ... ],
    "system": "（条件字段：从 system 消息提取）",
    "tools": [ { "type": "function", "name", "description", "input_schema" } ],
    "tool_choice": { "type": "auto" },
    "max_tokens": 64000,
    "stream": true,
    "temperature": 0.7,
    "reasoning_effort": "low|medium|high|max"
  }
}
```

要点：
- `stream` 恒为 `true`（上游只出流式）；`max_tokens` 上限裁到 200000。
- 消息格式：user 消息 content 为 `[{type:"text",text}]` 或含图片 `[{type:"image",image:"data:image/jpeg;base64,..."},{type:"text",...}]`（OpenAI `image_url` 自动转此格式）；assistant 消息 content 含 `{type:"text"}` / `{type:"tool-call",toolCallId,toolName,input}`（input 为对象，OpenAI 的字符串 arguments 会 JSON.parse）；tool 结果为 `{role:"tool",content:[{type:"tool-result",toolCallId,toolName,output:{type:"text",value}}]}`，toolName 通过 `tool_call_id → name` 反查表还原。
- `tool_choice` 字符串映射 auto/none/required → `{type:"auto"/"none"/"any"}`，对象 → `{type:"tool",name}`。

### 响应解析（`createSseTranslator`，约 L511-631）

- 上游响应是 **NDJSON（每行一个 JSON 对象）**，按 `\n` 切行解析（代码同时兼容剥 `data:` 前缀与忽略 `[DONE]`）。
- 事件类型及处理：`text-delta {text|delta}` → OpenAI content delta；`reasoning-delta {text}` → `reasoning_content` delta；`tool-call {toolCallId, toolName, input}` → OpenAI `tool_calls` delta；`finish-step {finishReason, usage}` 记录用量；`finish {totalUsage}` → 发终止 chunk（finish_reason + usage）；`error` 只记日志**不发 finish chunk**（防止下游 agent loop 在第一个 finish_reason 就停止）；`tool-input-start/delta/end`、`text-end`、`reasoning-end`、`provider-metadata` 等静默忽略。
- usage 字段为 camelCase：`{inputTokens, outputTokens, cachedInputTokens}`；映射为 OpenAI 的 `prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens`。
- finishReason 映射：`tool-calls → tool_calls`、`length → length`、`stop → stop`。

### 反检测预处理（4 个项目中独有，`ensureInitialized` 约 L235-287）

每个 API Key 首次请求前（之后每 8h + 2h 抖动）并行发送两个预请求：

1. `POST /alpha/fingerprint/record`：设备指纹。随机池生成（15 种 CPU 型号、内存 8-64G、15 个全球时区、2-5 个 MAC），所有组件 SHA-256 哈希后联合生成 `thumbmark`；components 含 `machineIdHash/macHashes/osUserHash/hostnameHash/gitEmailHash/platform/arch/osRelease/cpuModel/cpuCount/memGiB/isContainer/timezone/runtime:"cli"/collectorVersion:1`。指纹 per-key 绑定。
2. `POST /alpha/lifecycle-events`：`{eventType:"cli_session_exists", metadata:{sessionId:"sess_<16hex>", cliVersion, mode:"interactive", os}}`。

### 模型列表

- `GET /v1/models` 对外暴露；优先从 `GET {apiBase}/provider/v1/models` 动态拉取（带 Bearer 认证，5min 缓存），失败回退内置约 26 个模型的硬编码列表（`fetchModels`，约 L1827-1879）。

### 错误处理 / 重试技巧

- **零输出防护**：流结束但 `outputTokens === 0` → 返回 429 + `retry_after: 10`（借 SDK 自动重试，防异常计费）；`normalizeUsage` 还会把 outputTokens=0 时 inputTokens/cachedInputTokens 一并清零。
- **空闲超时**：流式 30s / 非流式 90s 无新数据 → 429 + `Retry-After: 5`；连续 3 次超时才返回"压缩上下文"提示（任意成功后重置计数）。
- **客户端断连**：`res.on('close')` → `AbortController.abort()` 打断上游请求，并抢发一个 usage=0 的终止 chunk + `[DONE]`，避免下游自行估算 token。
- 状态码映射：402→429（payment required 当限流处理）、403→401、500/502→502。
- 延迟写 200 响应头：首 chunk 到达才写 SSE header，超时/零输出时可以直接改返 JSON 429。

---

## 二、jiesou/dsh-commandcode-go-provider

- 仓库：<https://github.com/jiesou/dsh-commandcode-go-provider>（main 分支，MIT）
- 形态：**DSH（DeepSeek Harness）插件**——不是 OpenCode 也不是反代服务器，而是接入 `@deepseek-ai/dsh-llm` 的 `LlmAdapter`（cordis 插件体系）。README 自述"移植自 brent-weatherall/opencode-commandcode-provider 到 DSH"。
- 价值：协议层代码（`src/protocol.ts`）注释最严谨、类型最完整，且 README 交代了两轨制背景。

### 关键文件

| 文件 | 内容 |
|---|---|
| `src/protocol.ts` | 请求信封构建、NDJSON 流解析、事件→StreamChunk 转换 |
| `src/adapter.ts` | `CommandCodeGoAdapter`：fetch、请求头、错误码映射、空闲看门狗 |
| `src/models.ts` | 模型发现（Go plan 过滤规则）、reasoning efforts 合并 |
| `src/index.ts` | 插件注册、credential 解析、定时刷新 |

### `/alpha/generate` 请求实现（`adapter.ts` `request()`）

请求头（**最小化**——证明这些头即可工作）：

```
authorization: Bearer <key>
content-type: application/json
x-command-code-version: 0.26.20     # 固定 pin 到已知可用的 CLI 版本
x-cli-environment: production
x-co-flag: "false"
+ DSH 自身的 attributionHeaders()
```

注意：**没有** `x-session-id`、`x-project-slug`、`traceparent`、指纹/lifecycle 预请求，也能正常工作。协议模块注释明确："Gateway compatibility rides on the `x-command-code-version` header"。

请求体（`buildRequest`）与 MAXeaglet 信封一致，差异：
- `config.environment` 为纯字符串 `<os>-<arch>`（注释说明这是信奉 CLI 实际形状的简化，兼容性靠版本头）。
- `memory: ""`、`taste: ""`、`skills: null`（空串与 null 均可）。
- `reasoning_effort` 为 `off` 时不发送该字段。
- assistant 消息支持 `{type:"reasoning", text}` 回传思考内容；工具调用 input 为对象（`safeParseJson` 失败时保留原字符串）。
- tool 结果 output：`{type:"error-text", value}`（isError 时）或 `{type:"text", value}`，空输出兜底 `"(no output)"` / `"Execution denied"`。

### 响应解析（`protocol.ts`）

- 明确注释：**"Line-delimited JSON stream: one JSON object per line (not SSE `data:` framing)"**。跳过空行与 `:` 开头的注释行。
- 事件映射：`text-start/reasoning-start` → block-start（按到达顺序自增 blockIndex）；`text-delta/reasoning-delta {text}`；`tool-call`（兼容 `input|args|arguments` 与 `toolCallId|id` 字段名）；`finish-step {finishReason|rawFinishReason, usage}`。
- usage 结构（`CcUsage`）：`{inputTokens, outputTokens, inputTokenDetails:{noCacheTokens, cacheReadTokens}, outputTokenDetails:{textTokens, reasoningTokens}}`；inputTokens = noCacheTokens 优先，否则 total − cacheRead。
- finishReason 词表：`stop/end_turn`、`tool_calls/tool-calls`、`length/max_tokens/max-output-tokens`。
- **流截断检测**：上游关闭但没收到 `finish-step` → 抛 `STREAM_CLOSED` 错误（视为截断）。

### 模型列表（`models.ts`，最有特色）

- 从公开端点 `GET https://api.commandcode.ai/provider/v1/models` 拉取（**无需认证**，Go key 在这里也用不上）；返回 `{data:[{id, name, context_length}]}`。
- 按 Go Plan 规则过滤（`isGoModel`）：开源 provider（deepseek、Qwen、MiniMaxAI、xiaomi、stepfun、tencent、nvidia、moonshotai、zai-org 等）全保留；premium 例外 `gpt-5.6-luna`、`xai/grok-4.5`、`meta/muse-spark-1.2-contributor`；`google/`、`sakana/`、`anthropic/` 前缀及 claude-/gpt-/gemini-/grok-/fugu-/muse-spark- 品牌全部排除。
- **Reasoning efforts 动态合并**：Provider API 不返回 reasoning 元数据，改从官方 CLI 随包发布的模型目录 `https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md` 解析表格（第 2 列 id、第 5 列 efforts 逗号列表，`—` 表示模型自决）；拉取失败降级为暴露全档位（off + minimal~max），由网关决定默认深度。每 15 分钟刷新。

### 错误处理

- `httpErrorCode`：401/403 中 body 含 `MODEL_NOT_IN_PLAN` → `PERMISSION`（套餐不含该模型，不是 key 坏了），否则 `AUTH`；429 → `RATE_LIMIT`；400 且 body 命中 context window 超限特征 → `CONTEXT_WINDOW_EXCEEDED`；5xx → `SERVER`。
- 300s 空闲看门狗（`idleWatchdog`）+ `AbortSignal.any` 组合调用方取消。
- 错误 body 解析 `{"error":{"message":"..."}}` 提取人类可读信息。

---

## 三、Breskott/opencode-commandcode-plugin

- 仓库：<https://github.com/Breskott/opencode-commandcode-plugin>（main 分支，MIT）
- 形态：**OpenCode 插件**（两个单文件插件，放 `~/.config/opencode/plugin/` 自动加载），同时支持 OpenCode v1（stable）和 v2（beta）。
- **重要**：它走的是 Provider API（`BASE_URL = "https://api.commandcode.ai/provider/v1"`），用官方 `@ai-sdk/openai-compatible` 包直连，**不做任何 `/alpha/generate` 协议转换**。只适用于有 Provider API 权限的订阅；对 Go plan 无用（会 403）。它的参考价值在 OpenCode 插件的 provider 注册机制。

### 关键文件

| 文件 | 内容 |
|---|---|
| `commandcode-v1.ts` | OpenCode v1 插件（`config` hook 写 `config.provider`） |
| `commandcode-v2.ts` | OpenCode v2 插件（`define` + `ctx.catalog.transform`） |
| `README.md` | v1/v2 差异对照表（注册方式、cost/variants 形状等） |

### 模型与元数据策略（两个版本相同）

1. **动态发现**：`GET /provider/v1/models`（Bearer 认证，15s 超时，5min 缓存），取 `id / name / context_length`。响应**只有这三个字段**——没有 capabilities、没有 cost、没有 max output。
2. **内嵌静态 `CATALOG`**（58 个模型快照，取自 commandcode.ai/models，2026-08-25 校验）：补 `vision / reasoning / cost`（USD per 1M tokens，含 cache_read/cache_write）。
3. **`REASONING_EFFORTS` 表**：per-model 的档位列表（`low/medium/high/xhigh/max` 子集，如 `deepseek/deepseek-v4-flash: ["high","max"]`），有档位的模型生成 reasoning variants。
4. **决策级联**：`MODEL_OVERRIDES`（用户手动）→ `CATALOG`（快照）→ id 前缀启发式（vision 前缀：claude-/gpt-5/google\/gemini/moonshotai\/kimi/...）；快照外的新模型以保守默认进入并打日志警告。
5. `MAX_OUTPUT` 仅 2 个模型有硬编码值（API 不暴露），其余用 `DEFAULT_OUTPUT_TOKENS = 32000`；context 兜底 200k。

### v1 插件注册方式（`commandcode-v1.ts`）

- 入口 `Plugin = async ({client}) => {...}`，返回 `{ config }` hook——在 provider 解析前被 await（所以用 15s 超时 + 快照 fallback 防阻塞）。
- 直接写 `config.provider["commandcode"]`：`{ npm: "@ai-sdk/openai-compatible", name, options: { baseURL, apiKey }, models: {...} }`（非破坏合并，用户 opencode.json 的配置优先）。
- 每个模型 entry：`{ id, name, tool_call, reasoning, attachment: <bool>, modalities: {input, output}, limit: {context, output}, cost: {input, output, cache_read?, cache_write?}, variants: { low: {reasoningEffort:"low"}, ... } }`。
- 鉴权：`process.env.CMD_API_KEY`，缺失则告警"provider not loaded"并跳过，不崩 OpenCode。
- 日志：`client.app.log`，client 不可用时退回 `console.warn`。

### v2 插件注册方式（`commandcode-v2.ts`，对写 OpenCode 2.x 插件最有参考价值）

- `import { define, type CatalogDraft } from "@opencode-ai/plugin/v2/promise"`；导出 `define({ id, setup })`。
- **`aisdk:` 前缀强制**：package 必须写 `"aisdk:@ai-sdk/openai-compatible"`（opencode2 的 ModelResolver 用 `startsWith("aisdk:")` 校验，否则 `UnsupportedPackageError`、会话静默卡死）。
- **package/settings 必须同时写在 provider 和每个 model 的顶层**（resolver 读 `p.package`/`p.settings` 顶层字段，只写在 `api` 里不生效）。
- 注册：`ctx.catalog.transform(catalog => ...)` 同步执行、无 I/O；模型发现放后台，id 列表签名变化时才 `catalog.reload()`——启动永不阻塞在网络请求上。
- 数据形状差异：`cost` 是 `ModelCost[]` 数组（`[{input, output, cache: {read, write}}]`）；没有 `attachment` 标志，改用 `capabilities: {tools, input: ["text","image"], output:["text"]}`；`variants` 是数组 `[{id, headers:{}, body:{reasoningEffort}}]`。
- `/models` 失败的 fallback：v1 用内嵌快照 id 兜底；v2 保持空列表等 5min 后的下一次刷新。

---

## 四、brent-weatherall/opencode-commandcode-provider

- 仓库：<https://github.com/brent-weatherall/opencode-commandcode-provider>（main 分支，MIT，npm 包名 `commandcode-go-opencode-provider`）
- 形态：**OpenCode v1 插件 + 自定义 AI SDK provider 包**（`opencode plugin commandcode-go-opencode-provider` 一键安装）。走 `/alpha/generate`。
- 架构：`plugin.ts`（config + auth hook，从 models.json 静态注册模型）+ `index.ts`（导出 `createCommandCode()` 工厂）+ `src/`（AI SDK `LanguageModelV3` 实现）。`opencode.json` 里 `provider.commandcode.npm` 直接指向本包，OpenCode 加载包并用其导出的工厂创建模型实例。

### 关键文件

| 文件 | 内容 |
|---|---|
| `src/model.ts` | `CommandCodeLanguageModel`（LanguageModelV3）：请求头、fetch、超时 |
| `src/convert.ts` | AI SDK prompt → CC 信封请求体 |
| `src/stream.ts` | NDJSON/SSE 行解析 → AI SDK StreamPart |
| `src/auth.ts` | API key 多级解析 |
| `plugin.ts` | config hook（注入 models.json）+ auth hook（/connect 输入 key） |
| `models.json` | 静态模型目录（21 个模型，含 tier/cost/limit） |
| `scripts/sync-models.ts` | 从 npm 上官方 CLI bundle 逆向提取模型目录的脚本 |

### `/alpha/generate` 请求实现（`src/model.ts`）

请求头：

```
Content-Type: application/json
Authorization: Bearer <key>
x-command-code-version: 0.26.20    # pin 死（注释：必须与 CLI 版本匹配）
x-cli-environment: production
x-project-slug: "opencode"         # 固定字符串即可
```

- 5 分钟总超时 `AbortController`，合并调用方 abortSignal。
- `doGenerate`（非流式）= 调 `doStream` 聚合全部 delta（上游只有流式）。
- 错误 body 解析 `parsed.error?.message ?? parsed.message`。
- 默认 `max_tokens = 16384`（低于其他项目的 64000）。

### 请求体（`src/convert.ts`）与响应（`src/stream.ts`）

- 信封同上；`config.environment = "<platform>-<arch>"`；`memory:""`、`taste:""`、`skills:null`；支持 `temperature/top_p/top_k`；无图片支持（非文本 part 丢弃并警告）。
- 流解析同时兼容 **裸 NDJSON 和 `data:` 前缀 SSE**（剥前缀、忽略 `[DONE]` 与 `:` 行、处理 `\r\n`）。
- 事件覆盖最全：`start → stream-start`、`text-start/delta/end`、`reasoning-start/delta/end`、`tool-input-start/delta/end`（增量工具参数）、`tool-call`、`finish-step`（usage + finishReason）、`response-metadata`、`error`。
- finishReason 兼容 `max-tokens/max_output_tokens/content_filter` 等变体；usage 同时兼容 camelCase 和 snake_case（`prompt_tokens`）。

### 认证 token 获取（`src/auth.ts`，多级 fallback）

1. 显式传入的 `apiKey`
2. 环境变量 `COMMANDCODE_API_KEY`
3. `~/.commandcode/auth.json`：`apiKey` 字段 → `commandcode` 字符串字段 → `commandcode.access`（**oauth 类型**，说明官方 CLI 登录后的凭据落盘格式）
4. `~/.pi/agent/auth.json`（同上结构）

### plugin.ts（OpenCode v1 provider/auth hook）

- config hook：把 `models.json` 注入 `provider.commandcode.models`，模型配置键为 **id 去掉 `/` 前缀并小写**（`toConfigKey`：`deepseek/deepseek-v4-flash → deepseek-v4-flash`），entry 含 `{id, name, reasoning, tool_call, cost, limit}`。
- auth hook：实现 `authorize`（`/connect` 交互输入 API key）与 `loader`（从 OpenCode auth 存储读 key 注入 provider）——是"OpenCode 内置认证流"的参考实现。
- 模型元数据完全静态，由 `bun run sync` 离线更新。

### scripts/sync-models.ts（从官方 CLI 逆向元数据，独门技巧）

1. 从 npm registry 拉最新 `command-code` 包的 tarball 并解压，读 `dist/index.mjs`（混淆过的 bundle）。
2. 用锚点字符串 + 平衡括号扫描截取对象字面量：`ANTHROPIC:"anthropic"`（provider 枚举）、`SONNET_4_6:{id:"claude-sonnet-4-6"`（模型目录）、`{id:"anthropic:claude-sonnet-4-`（价格表）。
3. `normalizeForEval`（`!0→true`、`!1→false`、科学计数法还原）后用 `Function` eval 还原为 JS 对象。
4. 合并成本表（`promptCost/completionCost/cacheHitCost/cacheWrite5mCost`）与 contextWindow，缺价格的模型用 `FALLBACK_COSTS`，缺 limit 用 `FALLBACK_LIMITS`；产出 `models.json`，`--update-global` 时直接写 `~/.config/opencode/opencode.jsonc`。

---

## 五、`/alpha/generate` 协议速查（综合验证版）

四个项目（3 个直接实现 + Breskott 侧写 Provider API）交叉印证出的最小可行协议：

### 端点与认证

- `POST https://api.commandcode.ai/alpha/generate`
- 认证：`Authorization: Bearer user_xxx`（key 形如 `user_` 前缀；4 项目均无登录/设备注册流程，key 由用户从 Command Code 后台手动获取）
- 兼容性关键头：`x-command-code-version`（pin 已知版本 0.26.20 即可工作；MAXeaglet 动态拉 npm latest 更贴近真实 CLI）
- 常见伴随头：`x-cli-environment: production`、`x-co-flag: "false"`；可选伪装头：`x-session-id`、`x-project-slug`、`x-taste-learning`、`traceparent`
- 指纹/lifecycle 预请求（`/alpha/fingerprint/record`、`/alpha/lifecycle-events`）仅 MAXeaglet 实现——jiesou/brent 不发也能工作，属于风控强度问题而非协议必需

### 请求体

CLI 信封 `config/memory/taste/skills/permissionMode/params`；真正语义在 `params`：`model`（wire id 如 `deepseek/deepseek-v4-flash`）、`messages`（user 字符串或 content 块数组；assistant 含 `text/reasoning/tool-call` 块；tool 角色消息承载 `tool-result` 块）、`system`（从 system 消息提升）、`tools`（Anthropic 风格 `input_schema`）、`max_tokens`、`stream:true`（恒流式）、可选 `temperature/top_p/top_k/reasoning_effort(low~max)/tool_choice`。`config.environment` 字符串或带 Node 版本的字符串均可。

### 响应

- **NDJSON 行流**（每行一个 JSON 事件对象；非 `data:` 帧，但解析器兼容剥 `data:` 前缀）
- 事件序列：`start(/start-step)` → `text-start`/`reasoning-start` → `text-delta`/`reasoning-delta` → `tool-input-start/delta/end`（或一次性 `tool-call`）→ `finish-step {finishReason, usage}` → `finish {totalUsage}`；错误为 `error {error:{message}}` 行
- usage：`{inputTokens, outputTokens, inputTokenDetails:{noCacheTokens,cacheReadTokens,cacheWriteTokens}, outputTokenDetails:{textTokens,reasoningTokens}}`（camelCase 为主，snake_case 变体也出现过）
- finishReason：`stop/end_turn`、`tool_calls`、`length/max_tokens`；流中断而无 `finish-step` = 截断
- 错误：HTTP 层 `401/403`（body `{"error":{"message"}}`；`MODEL_NOT_IN_PLAN` 表示套餐不含该模型）、`429`、`400`（可能 context 超限）；Provider API 对 Go plan 返回 `403 upgrade_required`

### 模型列表

- `GET https://api.commandcode.ai/provider/v1/models`：公开/带 Bearer 均可；返回 `{data:[{id, name, context_length}]}`，**没有** capabilities/cost/max-output/efforts
- 元数据补充渠道：内嵌静态表（Breskott/brent）、官方 CLI 的 `reference/models.md`（jsDelivr，jiesou）、npm bundle 逆向（brent sync 脚本）、npm registry 动态版本号（MAXeaglet）

---

## 六、差异对比表

| 维度 | MAXeaglet/commandcode-proxy | jiesou/dsh-commandcode-go-provider | Breskott/opencode-commandcode-plugin | brent-weatherall/opencode-commandcode-provider |
|---|---|---|---|---|
| 形态 | 独立反代服务器（Node 单文件） | DSH 插件（LlmAdapter） | OpenCode 插件（单文件 v1+v2） | OpenCode v1 插件 + npm provider 包 |
| 上游端点 | `/alpha/generate` | `/alpha/generate` | **`/provider/v1`（OpenAI 兼容直连）** | `/alpha/generate` |
| 对外协议 | OpenAI + Anthropic 双兼容 | DSH StreamChunk | OpenAI 兼容（@ai-sdk/openai-compatible） | AI SDK LanguageModelV3 自定义 provider |
| `x-command-code-version` | npm 动态拉取（24h 刷新） | pin 0.26.20 | 不涉及 | pin 0.26.20 |
| session/slug/traceparent 伪装 | 全套（per-key session 12h、伪 slug、W3C traceparent） | 无 | 不涉及 | 固定 `x-project-slug: "opencode"` |
| 指纹/lifecycle 预请求 | 有（随机指纹池，8h+2h 刷新） | 无 | 不涉及 | 无 |
| 模型列表 | `/provider/v1/models` 动态 + 硬编码兜底 | `/provider/v1/models` + Go 过滤 + CLI catalog efforts 合并（15min 刷新） | `/provider/v1/models`（5min 缓存）+ 内嵌 58 模型 CATALOG | 静态 `models.json`（sync 脚本从 npm bundle 逆向生成） |
| 上下文窗口来源 | 无（不配置） | API `context_length`，兜底 262144/1M | API `context_length`，兜底 200k | models.json（catalog 逆向） |
| 价格(cost) | 无 | 无 | 内嵌 CATALOG（USD/1M） | models.json（catalog 逆向价格表） |
| reasoning efforts | `reasoning_effort` 透传 | API 无 → CLI catalog 解析，兜底全档位 | `REASONING_EFFORTS` 静态表 → variants | models.json 的 `reasoning` 布尔 |
| 流解析 | NDJSON 行解析（兼容 data: 前缀） | 严格 NDJSON（明示非 SSE） | 不涉及 | NDJSON + SSE 双兼容（含 \r\n） |
| 非流式支持 | 有（聚合流，90s 超时） | 无（恒流） | OpenAI 端点原生 | 有（doGenerate 聚合流） |
| 错误处理亮点 | 零输出→429 防计费；空闲超时→429；断连 abort+补发 usage=0 chunk；402→429 | MODEL_NOT_IN_PLAN→PERMISSION 区分；无 finish-step→STREAM_CLOSED 截断检测；300s idle watchdog | 15s 超时；快照/空列表双 fallback | 5min 总超时；错误 message 提取 |
| 认证获取 | 每请求 header 传入（user_ 正则校验），config 兜底 | DSH credential 服务 / env | env `CMD_API_KEY` | env → `~/.commandcode/auth.json`（含 oauth access 字段）→ `~/.pi/agent/auth.json`；/connect auth hook |
| OpenCode 版本 | 不适用（外部服务，opencode.json 接 openai-compatible） | 不适用 | v1 config hook / v2 catalog.transform（aisdk: 前缀） | v1（npm provider 包 + config/auth hook） |
| 测试 | 无 | 无 | 无 | bun test 单测 + 集成测试 |

## 七、对本项目（OpenCode 插件反代 `/alpha/generate`）的直接启示

1. **最小可行实现**已被 brent 验证：`Authorization: Bearer` + `x-command-code-version`（pin 0.26.20）+ `x-cli-environment: production` + `x-co-flag: "false"` 四个头 + 标准信封体即可调用；指纹/session/slug 伪装是锦上添花（风控考量），不是协议门槛。
2. **上游恒为流式 NDJSON**：非流式必须自行聚合；解析器按行切、跳过空行/`:` 行、兼容 `data:` 前缀最稳。
3. **OpenCode 侧注册**建议同时参考两套：brent 的"npm 包 + config/auth hook + 静态 models.json"（v1，已验证可发布 npm 一键安装），以及 Breskott 的 v2 `catalog.transform` 路线（注意 `aisdk:` 前缀、package/settings 需同时写 provider 与 model 顶层、启动不阻塞网络的 background discovery + reload 模式）。
4. **模型元数据**：id/name/context_length 用 `/provider/v1/models` 动态拉；cost/vision/efforts 必须自备（静态表或 CLI catalog 合并）；Go plan 的模型过滤规则可直接搬 jiesou 的 `isGoModel`。
5. **健壮性**建议采纳：零输出→429（防异常计费）、空闲超时→可重试错误、`MODEL_NOT_IN_PLAN` 与认证失败区分、流无 `finish-step` 视为截断、客户端断连时 abort 上游。
6. **错误信封**统一按 `{"error":{"message":"..."}}` 解析；4xx 时尽量透传上游 message 并附上 model id。

### 参考链接

- <https://github.com/MAXeaglet/commandcode-proxy>（README_zh.md 的"反检测/协议细节"两节 + proxy.mjs）
- <https://github.com/jiesou/dsh-commandcode-go-provider>（README.md + src/protocol.ts、src/adapter.ts、src/models.ts、src/index.ts）
- <https://github.com/Breskott/opencode-commandcode-plugin>（README.md 的 v1/v2 对照表 + commandcode-v1.ts、commandcode-v2.ts）
- <https://github.com/brent-weatherall/opencode-commandcode-provider>（README.md + src/model.ts、src/convert.ts、src/stream.ts、src/auth.ts、plugin.ts、scripts/sync-models.ts）
- 官方 CLI 模型目录（jiesou 用于 efforts 合并）：<https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md>

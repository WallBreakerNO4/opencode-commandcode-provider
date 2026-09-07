# OpenCode 插件与 Provider 机制调研

> 目标：为「把只能通过专用客户端访问的 `/alpha/generate` 端点反代成 OpenCode provider」的插件选型提供依据。
> 调研日期：2026-08-28。信息源以官方一手资料为准：opencode.ai 官方文档（V2 beta 与 V1 各自独立站点）、npm 上的 `@opencode-ai/*` 包类型定义、GitHub `anomalyco/opencode` 源码、`opencode.ai/v2/openapi.json`、models.dev 仓库与 API。
> 注意：OpenCode 2 处于 beta，插件 API 与 server API 均未冻结（官方迁移指南明确警告）。

## 0. 结论速览

- **推荐路径（V2）**：写一个 V2 插件，在 `setup()` 里用 `ctx.catalog.transform()` 注册 provider 与模型元数据；用 `ctx.aisdk.hook("sdk", ...)`（或 `"language"`）为该 provider 注入自带自定义 `fetch` 的 AI SDK provider 实例，把请求转发到 `/alpha/generate`；凭证用 `ctx.integration.connect.key()` 写入或让用户走 `settings.apiKey: "{env:...}"`。
- **纯配置路径（不写插件）**：如果 `/alpha/generate` 兼容 OpenAI chat completions 协议，直接在 `opencode.jsonc` 的 `providers.<id>` 里配 `package: "@opencode-ai/ai/providers/openai-compatible"` + `settings.baseURL` + `models` 即可；请求级调整可用 provider 级 `headers`/`body`。
- **V1/V2 关键差异**：V1 插件（导出函数 + hooks 对象，含 `auth`/`provider`/`config` hook）**完全不能**在 V2 运行；V2 改为 `Plugin.define({ id, setup(ctx) })` + transform 模型。V2 配置把 V1 的 `provider`→`providers`、`npm`→`package`（AI SDK 包加 `aisdk:` 前缀）、`api`→`settings.baseURL`、`options`→拆分为 `settings`/`headers`/`body`。
- **「自动注册模型并配置参数」的实现入口**：V2 = 插件 `ctx.catalog.transform()`（模型元数据）+ `ctx.aisdk.hook()`（运行时行为）；V1 = 插件 `provider` hook 的 `models()`（动态模型）+ `auth` hook（凭证加载）+ `config` hook（改配置）。

---

## 1. 版本格局

| | OpenCode 1（V1） | OpenCode 2（V2，beta） |
|---|---|---|
| 命令 | `opencode` | `opencode2`（可并存） |
| 安装 | `@opencode-ai/cli`（latest） | `@opencode-ai/cli@beta` |
| 插件包 dist-tag | `@opencode-ai/plugin` `latest`（如 1.18.25） | `@opencode-ai/plugin` `beta` |
| 文档 | `https://opencode.ai/docs/` | `https://opencode.ai/v2/docs/` |

来源：[V2 迁移指南](https://opencode.ai/v2/docs/migrate-v1)、npm dist-tags 查询（`registry.npmjs.org/-/package/@opencode-ai/plugin/dist-tags`，2026-08-28 实测：`latest: 1.18.25`、`beta: 0.0.0-beta-18414`）。

V2 官方声明的**三大故意破坏性变更**：① 插件 API 全新；② server API 与 client 全新；③ 终端配置从分层 `tui.json` 收敛为全局 `cli.json`。其余 V1 功能（含 V1 语法的 config、`.opencode/` 文件）声明保持兼容，V2 在内存里做规范化。

---

## 2. V2 插件系统

### 2.1 编写与分发

一个 V2 插件是一个默认导出 `Plugin.define(...)` 的 JS/TS 模块（[V2 插件指南](https://opencode.ai/v2/docs/build/plugins)）：

```ts
// .opencode/plugins/example.ts
import { Plugin } from "@opencode-ai/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    // ctx: 插件上下文（见 2.2）
    return () => { /* cleanup：插件卸载时执行 */ }
  },
})
```

类型（来自 `@opencode-ai/plugin@beta/dist/promise/plugin.d.ts`）：

```ts
export interface Plugin {
  readonly id: string
  readonly tui?: boolean
  readonly vcs?: VcsDiscovery
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
export declare function define(plugin: Plugin): Plugin
```

**加载方式**（[V2 插件配置页](https://opencode.ai/v2/docs/plugins)）：

1. **本地自动发现**：`.opencode/plugins/*.ts|*.js`（项目级，V1 的 `.opencode/plugin/` 也兼容）和 `~/.config/opencode/plugins/`（全局）。
2. **`opencode.json(c)` 的 `plugins` 数组**：npm 包名（可带版本/tag/scope）、相对/绝对路径、`file://` URL、或对象形式传插件参数：

```jsonc
{
  "plugins": [
    "opencode-acme-plugin",            // npm 包
    "opencode-acme-plugin@1.2.0",      // 固定版本
    "@acme/opencode-plugin",
    "./plugins/local.ts",              // 相对 config 文件所在目录
    {
      "package": "@acme/opencode-plugin",
      "options": { "agent": "reviewer", "strict": true }   // 插件里用 ctx.options 读取
    }
  ]
}
```

3. **CLI 管理**：`opencode2 plugin add <pkg>[@ver|github:...|git+ssh:...]` / `plugin list [--builtin]` / `plugin remove`。
4. **禁用与通配**：条目前缀 `-` 禁用，`*` 匹配全部，`.*` 按 ID 前缀匹配；内置发现插件也是插件，可用 `"plugins": ["-opencode.provider.ollama"]` 关闭（见 providers 文档）。

多来源的 `plugins` 数组按 config 优先级从低到高**拼接**（不是覆盖）。启动时对未固定版本的包/Git 插件刷新一次；受监视目录下的文件变更自动热重载。

**npm 发布清单**（V2 指南 Publish 节）：

```json
{
  "name": "opencode-acme-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@opencode-ai/plugin": "beta" }
}
```

另存在 Effect 风格的插件入口 `@opencode-ai/plugin/effect`（包内 `dist/effect/*`），Promise 风格为 `@opencode-ai/plugin` 默认入口（`dist/promise/*`）。`ctx.location`（目录/workspace/project）、`ctx.options` 均两种风格一致。

### 2.2 插件 Context（能力域全景）

`setup(ctx)` 的 ctx 类型（`dist/promise/plugin.d.ts`）：`app`、`location`、`options` 三个基础字段，加上能力域：`agent`、`aisdk`、`catalog`、`command`、`event`、`integration`、`mcp`、`generate`、`permission`、`plugin`、`reference`、`session`、`shell`、`skill`、`storage`、`tool`、`vcs`、`websearch`。

与 provider 反代直接相关的三个域：

### 2.3 `ctx.catalog` — 模型目录的 transform（注册模型的主入口）

V2 引入了 **transform** 抽象：插件注册一个回调，OpenCode 按**插件加载顺序回放**所有 transform 构建最终目录；`reload()` 会重放全部 transform（后注册的策略依然生效）；`transform()` 返回 `Registration`，`dispose()` 撤销。

```ts
// 读
const providers = await ctx.catalog.provider.list()
const defaults  = await ctx.catalog.model.default()
// 写（transform 内，draft 可变）
await ctx.catalog.transform((catalog) => {
  catalog.provider.update("acme", (provider) => { provider.name = "Acme" })
  catalog.model.update("acme", "reasoner", (model) => {
    model.name = "Acme Reasoner"
    model.cost = [{ input: 2, output: 12, cache: { read: 0.2, write: 2 } }]
  })
  catalog.model.default.set("acme", "reasoner")
  catalog.model.remove("anthropic", "legacy-model")
})
```

要点（文档 + `dist/promise/catalog.d.ts`）：

- `provider.update(providerID, fn)` / `model.update(providerID, modelID, fn)` 是 **update-or-create** 语义：官方示例明确用它在非内置 provider `acme` 上「adds one model to the catalog」；schema 包中 `Provider.Info` 带 `empty(id)` 构造器，亦印证新 provider 可从空记录创建。
- `CatalogDraft.provider.list()` 返回 `readonly CatalogProviderRecord[]`，`CatalogProviderRecord = { provider: Provider.Info（可变）, models: ReadonlyMap<string, Model.Info（可变）> }`。
- `catalog.model.default.set(providerID, modelID)` 可改默认模型；`reload()` 后外部数据变化可重放。
- transform 同样适用于 agent / command / tool / skill / mcp / integration / reference / vcs / websearch 域。

### 2.4 `ctx.aisdk` — AI SDK 层 hook（自定义 fetch / 完全接管请求的正门）

`dist/promise/aisdk.d.ts`：

```ts
import type { LanguageModelV3 } from "@ai-sdk/provider"

export interface AISDKHooks {
  sdk: {
    readonly model: Model.Info
    readonly package: string           // 该 provider 配置的 package（如 @opencode-ai/ai/providers/openai-compatible）
    readonly options: Record<string, any>  // settings/settings 合并结果
    sdk?: any                          // ← 插件可以自己实例化并设置 provider SDK
  }
  language: {
    readonly model: Model.Info
    readonly sdk: any                  // 上一步（或默认流程）产生的 sdk
    readonly options: Record<string, any>
    language?: LanguageModelV3         // ← 插件可以直接给出 LanguageModelV3 实例
  }
}
export interface AISDKDomain {
  readonly hook: ModelHooks<AISDKHooks>
}
```

注册时可传 `{ providerID }` 把 hook **限定到单个 provider**（`ModelHookOptions`，见 `dist/promise/registration.d.ts`）。因此插件可以：

- `"sdk"` hook：忽略/包装默认包，用 `@ai-sdk/openai-compatible` 的 `createOpenAICompatible({ fetch: myFetch, ... })` 自建实例 → **自定义 fetch、改 URL、加签名，都在这里**。
- `"language"` hook：在 sdk 之上再包一层，直接返回自定义 `LanguageModelV3`（协议完全自定义时用，比如把 OpenCode 的请求翻译成 `/alpha/generate` 的私有格式）。

### 2.5 `ctx.session` hooks — 请求级拦截

V2 会话 hooks（[V2 插件指南 Hooks 节](https://opencode.ai/v2/docs/build/plugins)）：

| hook | 时机 | 能改什么 |
|---|---|---|
| `session.hook("prompt")` | 用户输入准入前 | text/files/agents/skills/metadata/delivery |
| `session.hook("context")` | 每次模型调用派发前 | system、messages、tools、`generation`（temperature/maxTokens/topP…）、`providerOptions`；可 `{ providerID }` 限定 |
| `session.hook("model.request")` | 模型请求设置阶段 | `event.headers` 等；可 `{ providerID: "anthropic" }` 限定 |
| `session.hook("http.request")` | 原生 HTTP 请求发出前 | `event.request`（Request 对象，body 是一次性流，读前要 clone） |
| `session.hook("http.response")` | 原生响应返回后 | `event.response`（可整个替换 Response） |

对反代而言：注入鉴权头用 `model.request`；更深的改写（重写 URL、换协议）用 `http.request/http.response` 或直接用 2.4 的 aisdk hook。

### 2.6 `ctx.integration` — 凭证与认证方法（V2 的 auth hook 替代品）

V2 把「provider 怎么登录」建模为 **Integration**（openapi.json schema 与插件指南）：

- `Integration.Info = { id, name, methods: Integration.Method[], connections: Connection.Info[] }`
- `Integration.Method` = `OAuthMethod | CommandMethod | KeyMethod | EnvMethod`：
  - `OAuthMethod`：浏览器 OAuth 流程；
  - `CommandMethod`：`{ id, type: "command", label, command: string[] }`（如 `acme login`）；
  - `KeyMethod`：`{ type: "key", label?, form? }`（粘贴 API key）；
  - `EnvMethod`：`{ type: "env", names: string[] }`（从环境变量解析，与 provider 的 `env` 字段呼应）。
- `Connection.Info` = `CredentialInfo { type:"credential", id, label } | EnvInfo { type:"env", name }`——连接要么是存储的凭证，要么是环境变量。

插件 API：

```ts
// 写凭证
await ctx.integration.connect.key({ integrationID: "acme", key: "..." })
// OAuth/命令式连接的发起、状态、完成、取消
await ctx.integration.oauth.connect({ integrationID, methodID })
// 注册/修改某 integration 的认证方法（transform）
await ctx.integration.transform((draft) => {
  draft.method.update({
    integrationID: "acme",
    method: { id: "cli", type: "command", label: "Sign in with Acme CLI", command: ["acme", "login"] },
  })
})
// 读当前活动连接与凭证值
const conn = await ctx.integration.connection.active("acme")
const cred = conn ? await ctx.integration.connection.resolve(conn) : undefined
```

`Provider.Info` 上有 `integrationID` 字段——provider 通过它关联到凭证系统（见 3.2）。注意：`IntegrationDraft` 只有 `list/get/update/remove`，**没有 `add`**；插件能否为全新自定义 provider 注册 integration 方法，文档未明示，实现时需实测（兜底方案：provider `settings.apiKey: "{env:...}"` 或 `env` 字段，见 3.1）。

### 2.7 其他 hooks（完整性）

`tool.hook("execute.before"/"execute.after")`、`permission.hook("evaluate")`（可改写 allow/ask/deny）、`shell.hook("create.before")`、`ctx.tool.transform()`（注册自定义工具）、`ctx.event.subscribe()`（服务器事件流）、`ctx.storage`（插件私有持久化 JSON）、`ctx.generate.text()`（无会话一次性生成）、`ctx.session.*`（建会话/发消息/切模型）等。

---

## 3. V2 Provider 系统

### 3.1 `opencode.json(c)` 里的 provider 配置（[V2 Providers 文档](https://opencode.ai/v2/docs/providers)）

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "acme/qwen3-coder",               // 默认模型，格式 provider/model[#variant]
  "providers": {
    "acme": {                                 // key 即 provider ID（自定义，不能含 / #）
      "name": "Acme",                         // 显示名
      "env": ["ACME_API_KEY"],                // 依序尝试的环境变量（形成 Env 连接）
      "package": "@opencode-ai/ai/providers/openai-compatible",  // 运行时包
      "settings": { "baseURL": "https://llm.acme.example/v1" },  // 传给运行时包的选项
      "headers": { "X-Gateway-Tenant": "engineering" },          // 追加 HTTP 头
      "body": { "metadata": { "application": "opencode" } },     // 合并进请求体
      "models": {
        "qwen3-coder": {                      // key = OpenCode 里的模型 ID
          "modelID": "qwen3-coder-480b",      // 发给上游的真实模型 ID
          "name": "Qwen 3 Coder",
          "capabilities": { "tools": true, "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 200000, "output": 32000 },
          "settings": {},                     // 模型级 settings/headers/body（provider → model → variant 依次叠加）
          "variants": [                       // 变体 = 具名请求覆盖层
            { "id": "high", "settings": { "reasoningEffort": "high" } }
          ],
          "compatibility": { "reasoningField": "reasoning_content" },
          "disabled": false
        }
      }
    }
  }
}
```

**`package` 的取值**：

- V2 原生包（`@opencode-ai/ai/providers/*`）：`openai`（及其 `/chat`、`/responses`）、`openai-compatible`（及 `/responses`）、`anthropic`、`anthropic-compatible`、`google`、`google-vertex`（及其子路径）、`azure`（及子路径）、`amazon-bedrock`（及 `/mantle` 等）、`openrouter`、`xai`；
- AI SDK npm 包：加 `aisdk:` 前缀，如 `"package": "aisdk:@ai-sdk/openai-compatible"`（[迁移指南](https://opencode.ai/v2/docs/migrate-v1)）；
- 任意 npm 包或 `file://` 绝对路径（自定义 provider 运行时包）。

**模型元数据回退**：不在目录里的模型若只给了名字，OpenCode 按假定填充——支持工具、text+image 输入、text 输出、context 200k / output 32k；官方要求「知道就显式写 `capabilities` 和 `limit`」。`compatibility.reasoningField` 可识别 `reasoning`/`reasoning_content`/`reasoning_text` 或任意字段名，用于读取流式思考内容并在回放 assistant 消息时带上。

**`settings` 是包相关的**：只有所选运行时包支持的字段才生效（如 `baseURL`、`apiKey`、OpenAI 的 `reasoningEffort`）。可用 `{env:VAR}` 替换引用环境变量，避免明文密钥。

**内置自动发现**：Ollama（`127.0.0.1:11434`）、LM Studio（`:1234`）、vLLM（`:8000`）由**内置插件**实现（provider ID 分别为 `ollama`/`lmstudio`/`vllm`），后台刷新清单、读取上下文长度/视觉/工具能力；可用 `"-opencode.provider.ollama"` 等禁用。本地 OpenAI 兼容服务器的手动配置示例见文档（`providers.local` + `package` + `models` + capabilities/limit）。

### 3.2 运行时 schema（`Model.Info` / `Provider.Info`）

来自 `@opencode-ai/schema@beta`（与 openapi.json 的 `Model.Info`/`Provider.Info` 一致）：

```ts
// Provider.Info（required: id, name, activation, package）
{
  id: string
  name: string
  package: string                        // 运行时包，必填
  activation: "auto" | "enabled" | "disabled"
  integrationID?: string                 // 关联凭证系统
  settings?: Record<string, any>
  headers?: Record<string, string>
  body?: Record<string, any>
}

// Model.Info
{
  id: string                             // 目录 ID（= providers.<id>.models 的 key）
  modelID: string                        // 发给上游的 ID
  providerID: string
  name: string
  family?: string
  capabilities: { tools: boolean; input: string[]; output: string[]; responsesWebsockets?: boolean }
  limit: { context: number; input?: number; output: number }
  cost: Array<{                          // 注意：V2 cost 是分档数组
    tier?: { type: "context"; size: number }
    input: number; output: number        // USD / 百万 token
    cache: { read: number; write: number }
  }>
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  variants: Array<{ id: string; settings?: Record<string, any>; headers?: ...; body?: ... }>
  settings?: Record<string, any>; headers?: ...; body?: ...
  time: { released: number }
  compatibility?: {
    reasoningField?: "reasoning" | "reasoning_content" | "reasoning_text" | (string & {})
    requireReasoning?: boolean
    maxTokensField?: "max_completion_tokens" | "max_tokens"
    requireFinishReason?: boolean
    requireAssistantAfterTool?: boolean
  }
  package?: string                       // 模型级覆盖运行时包
}
```

插件在 `catalog.transform` 里改的就是这些字段（`DeepMutable` 包装）。

### 3.3 模型引用

`provider/model`，变体 `provider/model#variant`；首个 `/` 分隔，模型 ID 可含 `/`；大小写敏感。展开形式：`"model": { "providerID": "openrouter", "model": "anthropic/claude-sonnet-4.5" }`。注意：根级 `model` 的变体目前**不会**存为目录默认（官方 Caveats 明示），变体请在 session/run/agent/command 层选择。

---

## 4. V1 对照

### 4.1 V1 provider 配置 schema（`opencode.json` → `provider.*`，[V1 config schema](https://opencode.ai/config.json)）

```jsonc
{
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",       // AI SDK 运行时包
      "name": "My Gateway",
      "api": "https://...",                      // openai-compatible 的默认 API 端点
      "env": ["MY_API_KEY"],
      "id": "my-gateway",                        // （V2 忽略）
      "options": {                               // 传给 AI SDK 包的选项
        "apiKey": "{env:MY_API_KEY}",            //   支持 {env:} {file:~/.secrets/key} 替换
        "baseURL": "https://gateway.example.com/v1",
        "timeout": 60000, "headerTimeout": 30000, "chunkTimeout": 10000
      },
      "whitelist": ["model-a"],                  // 只保留这些模型（V2 无原生等价字段）
      "blacklist": ["model-b"],                  // 隐藏这些模型
      "models": {
        "model-a": {
          "id": "upstream-name",                 // 发给上游的真实名（如 Bedrock ARN）
          "name": "Model A",
          "tool_call": true,
          "reasoning": true,
          "attachment": true,
          "temperature": true,
          "interleaved": { "field": "reasoning_content" },
          "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 },
          "limit": { "context": 200000, "output": 32000 },   // context+output 必填
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "status": "active",                    // alpha|beta|deprecated|active
          "options": {},                         // 模型级 provider 选项
          "headers": {},                         // 模型级头
          "variants": { "high": { "disabled": false } }
        }
      }
    }
  },
  "enabled_providers": ["my-gateway"],           // 可选：只启用这些
  "disabled_providers": [],
  "small_model": "my-gateway/model-a"            // 标题等小任务模型（V2 用 agents.title.model）
}
```

注意 V1 里**没有** `contextWindow` 这种字段——上下文长度在 `limit.context`。模型级 `reasoning`/`temperature`/`attachment` 等布尔在 V2 已被忽略（迁移指南「Accepted but unsupported fields」）。

### 4.2 V1 插件 API（`@opencode-ai/plugin@1.x`，[V1 插件文档](https://opencode.ai/docs/plugins)）

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    // hooks 对象，见下
  }
}
```

加载：`.opencode/plugins/` 与 `~/.config/opencode/plugins/` 自动加载；npm 包写进 `plugin: [...]`（Bun 启动时安装到 `~/.cache/opencode/node_modules/`）；本地插件的外部依赖要在 config 目录放 `package.json`（OpenCode 跑 `bun install`）。加载顺序：全局 config → 项目 config → 全局插件目录 → 项目插件目录。

**V1 hooks 全集**（自 `@opencode-ai/plugin` 1.18.25 的 `dist/index.d.ts`）：

- 生命周期/事件：`event`（订阅 `session.idle`、`message.part.updated`、`tool.execute.*` 等服务器事件）、`dispose`；
- **provider 相关（重点）**：
  - `auth: { provider, loader?(auth, provider) => providerOptions, methods: [{ type: "oauth"|"api", label, prompts, authorize }] }` —— **注册某个 provider 的登录方式**（`/connect` 里出现），`loader` 在构造 provider 时把 auth.json 里的凭证翻译成 provider options（如 apiKey/headers）；
  - `provider: { id, models?(provider, ctx: { auth? }) => Promise<Record<string, Model>> }` —— **为一个 provider 动态提供模型列表**（比如从远端 API 拉模型清单）；
  - `config?(config) => Promise<void>` —— 配置加载后回调（可变主 config 对象，社区常用来注入 provider/agent 配置）；
  - `chat.params` —— 改 temperature/topP/topK/maxOutputTokens 和 provider `options`；
  - `chat.headers` —— 给该次请求追加 headers；
- 工具/其他：`tool`（自定义工具）、`tool.definition`、`tool.execute.before/after`、`permission.ask`、`command.execute.before`、`shell.env`、`chat.message`、`experimental.*`（`chat.messages.transform`、`chat.system.transform`、`provider.small_model`、`session.compacting`、`compaction.autocontinue`、`text.complete`）。

V1 的自定义 fetch：**没有官方 hook 能替换 HTTP 层**。能做的只有 `options.baseURL` 指向代理、`chat.headers` 加头、或 `auth.loader` 返回的 provider options（仍是 JSON，不能带函数）。这就是 V1 时代「订阅制模型反代插件」普遍采用 `@ai-sdk/openai-compatible` + 本地/远程代理 URL + auth.json 写 token 的原因。V2 的 `aisdk.hook` / `http.request` 补上了这块。

### 4.3 V1 → V2 字段对照（provider 相关，[迁移指南](https://opencode.ai/v2/docs/migrate-v1)）

| V1 | V2 |
|---|---|
| `plugin: [...]`（项可为 `[pkg, options]`） | `plugins: [...]`（对象形式 `{ package, options }`） |
| `.opencode/plugin/` | `.opencode/plugins/`（两者都发现，推荐后者） |
| `provider`（单数 map） | `providers` |
| `provider.<id>.npm` | `providers.<id>.package`；AI SDK 包加 `aisdk:` 前缀 |
| `provider.<id>.api` | `providers.<id>.settings.baseURL` |
| `provider.<id>.options`（apiKey/baseURL/headers 混在一起） | 按用途拆分：`settings` / `headers` / `body` |
| `provider.<id>.whitelist` / `blacklist` | 无原生字段；规范化为内部 deny/allow 策略 |
| `enabled_providers` / `disabled_providers` | 内部 deny/allow 策略（可继续用 V1 语法，不警告） |
| 模型 `id` | 模型 `modelID` |
| 模型 `tool_call`、`modalities` | `capabilities.tools` / `capabilities.input` / `capabilities.output` |
| 模型 `cost.cache_read` / `cache_write` | `cost[].cache.read` / `cache.write`（cost 变数组、可分档） |
| 模型 `options` | `settings` |
| 模型 `status: "deprecated"` | `disabled: true`（非 deprecated 的 `status` 及 `release_date`/`attachment`/`reasoning`/`temperature`/`experimental`/布尔 `interleaved` 被 V2 忽略并警告） |
| 模型 `variants: { high: {...} }` | `variants: [{ id: "high", settings: {...} }]`（数组） |
| `small_model` | `agents.title.model` |
| `mode`/`agent` | `agents` |
| 插件 auth hook / provider hook | **无直接等价**：凭证走 `ctx.integration`，模型注册走 `ctx.catalog.transform` |

官方迁移口径：config 条目可自动翻译，但**「V1 插件在 V2 无法运行」，插件代码必须重写**；V2 插件 API 的详细迁移指引在 beta 期尚未发布。

---

## 5. models.dev

[models.dev](https://models.dev)（GitHub `anomalyco/models.dev`，原 sst/models.dev）是社区维护的 AI 模型开放数据库（TOML 数据 + 自动生成 JSON API），OpenCode 用它作为内置 provider/model 目录的元数据源（"OpenCode builds its model catalog from models.dev, provider integrations, and your configuration"）。

**API 端点**：

- `https://models.dev/api.json` —— 按 provider 组织的全量数据（2026-08-28 实测约 4.4MB、204 个 provider）；
- `https://models.dev/models.json` —— 跨 provider 的模型本体元数据；
- `https://models.dev/catalog.json` —— 两者合并；
- `https://models.dev/logos/{provider}.svg` —— provider 图标。

**api.json 结构**（顶层 `Record<providerID, Provider>`，以 anthropic 实测为例）：

```jsonc
{
  "anthropic": {
    "id": "anthropic",
    "name": "Anthropic",
    "env": ["ANTHROPIC_API_KEY"],        // 用于鉴权的环境变量
    "npm": "@ai-sdk/anthropic",          // AI SDK 运行时包；兼容端点型 provider 用 "@ai-sdk/openai-compatible" + "api"
    "doc": "https://docs.anthropic.com/...",
    "models": {
      "claude-sonnet-4-5": {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5 (latest)",
        "family": "claude-sonnet",
        "attachment": true, "reasoning": true, "tool_call": true,
        "structured_output": true, "temperature": true,
        "reasoning_options": [{ "type": "budget_tokens", "min": 1024 }],
        "knowledge": "2025-07-31", "release_date": "2025-09-29", "last_updated": "2025-09-29",
        "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
        "open_weights": false,
        "limit": { "context": 1000000, "output": 64000 },
        "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }
      }
    }
  }
}
```

provider 级还有可选 `api` 字段（`@ai-sdk/openai-compatible` 时必填的默认端点）。数据源是仓库内 TOML（`providers/<id>/provider.toml` + `providers/<id>/models/*.toml`，可 `base_model` 继承 `models/` 下的模型本体元数据）。V1 的 `OPENCODE_MODELS_PATH` 环境变量可指向本地 api.json 快照（models.dev README 的 opencode 联调方式）。

---

## 6. Auth 与凭证存储

**auth.json**（源码 `packages/opencode/src/auth/index.ts`，dev 分支）：

- 路径：`~/.local/share/opencode/auth.json`（`Global.Path.data`），写文件权限 `0600`；
- 结构：`{ [providerID]: Auth }`，`Auth` 三选一（Effect Schema 定义，按 `type` 判别）：
  - `{ type: "oauth", refresh, access, expires, accountId?, enterpriseUrl? }`
  - `{ type: "api", key, metadata?: Record<string,string> }`
  - `{ type: "wellknown", key, token }`
- 环境变量 `OPENCODE_AUTH_CONTENT` 可整体注入 JSON 内容替代文件读取；
- V1 的 `/connect`（TUI 内交互）写入同一文件（V1 providers 文档：「When you add a provider's API keys with the `/connect` command, they are stored in `~/.local/share/opencode/auth.json`」）。

**V2 的解析路径**：provider → `Provider.Info.integrationID` → Integration（`ctx.integration.*` / `/api/integration`）→ 连接 = 存储凭证（CredentialInfo）或环境变量（EnvInfo，对应 provider `env` 字段）。`/connect`、`/api/integration/{id}/connect/{key|oauth|command}` 负责建立连接；`/api/credential/{id}` 管理（patch/remove/activate）。

**插件写凭证**：`ctx.integration.connect.key({ integrationID, key })`；读：`ctx.integration.connection.active(id)` + `connection.resolve(conn)`。对纯自定义 provider，最省事的做法仍是 `settings: { apiKey: "{env:...}" }` 或配置 `env: [...]`（OpenCode 自动形成 env 连接）。

---

## 7. Provider 加载链路（V2）

综合 V2 models/providers 文档、插件指南与 schema：

1. **内置目录构建**：models.dev 元数据（provider、模型、价格、上下文）＋ 内置发现插件（`opencode.provider.ollama` / `.lmstudio` / `.vllm`，后台探测本地服务器并动态增删模型）＋ provider integrations。
2. **config 合并**：全局 → 项目 → `.opencode/` 的 `providers.<id>` 覆盖/新增 provider 与模型（V1 语法就地规范化）。
3. **插件 transform 回放**：按插件加载顺序重放 `ctx.catalog.transform()`，逐个 draft 上 update/remove/default.set —— **插件注册的新 provider/模型在这一步进入目录**；`catalog.reload()` 触发全量重放。
4. **可用性判定**：provider 需有可用连接（凭证/环境变量，`activation` + enabled 过滤），否则其模型不出现在可选目录（"Only enabled models whose provider is available for the current project are available for selection"）。
5. **运行时实例化（每次模型请求）**：确定 provider 的 `package` → `aisdk.hook("sdk")`（插件可替换为自带 fetch 的实例）→ `aisdk.hook("language")`（插件可给出 `LanguageModelV3`）→ 按 provider→model→variant 叠加 settings/headers/body → `session.hook("model.request")`/`"context"` 微调 → 原生 HTTP 层过 `http.request`/`http.response` hooks。

V1 链路（对照）：models.dev 目录 + `provider.*` 配置合并 → auth（auth.json + 插件 `auth.loader`）→ `npm` 指定的 AI SDK 包由 Bun 动态安装（缓存 `~/.cache/opencode/node_modules/`）并实例化 → `chat.params`/`chat.headers` 参与请求。

---

## 8. 对本项目的落地建议（反代 `/alpha/generate`）

**形态 A：纯配置（若 `/alpha/generate` 有 OpenAI 兼容面）**
`providers.<id>` + `package: "@opencode-ai/ai/providers/openai-compatible"` + `settings.baseURL` 指向反代 URL + 手写 `models`（capabilities/limit 照实填）；鉴权用 `settings.apiKey: "{env:...}"`。零代码，但没有自定义 fetch/协议转换能力。

**形态 B：V2 插件（推荐，覆盖私有协议）**
1. `setup()` 里 `ctx.catalog.transform()`：`provider.update("alpha", p => { p.package = ...; p.name = ... })`，对每个模型 `model.update("alpha", id, m => {...})` 填 capabilities/limit/cost/variants（模型清单可从远端拉取，变更后 `catalog.reload()`）；
2. `ctx.aisdk.hook("sdk", fn, { providerID: "alpha" })`：用 `createOpenAICompatible`（或自写 provider）注入自定义 `fetch`，把 OpenAI 形状的请求翻译成 `/alpha/generate` 的调用（或直接在 `"language"` hook 返回自定义 `LanguageModelV3`）；
3. 凭证：`ctx.integration.transform()` 注册 key/命令式登录方法（若可行），或退回 `{env:...}`；
4. 需要塞私有头（会话 ID、签名）时用 `ctx.session.hook("model.request", ..., { providerID: "alpha" })`。

**形态 C：兼容 V1 用户**：写 V1 插件（`auth` + `provider.models` + `chat.headers`，代理 URL 方案），与 V2 插件分成两个包或两个入口，因为 API 互不兼容。

**风险提示**：V2 beta 的插件 API「may continue to change」（官方原话），`@opencode-ai/plugin` 需锁 `beta` tag 并随 OpenCode 版本跟进；`catalog.provider.update` 的 upsert 行为、自定义 provider 的 integration 注册均有实测必要（后者文档未明示）。

---

## 9. 关键链接

**V2（beta）**
- 插件指南：https://opencode.ai/v2/docs/build/plugins
- 插件加载/CLI 管理：https://opencode.ai/v2/docs/plugins ；CLI 插件：https://opencode.ai/v2/docs/build/plugins/cli
- Providers：https://opencode.ai/v2/docs/providers ；Models：https://opencode.ai/v2/docs/models
- Config：https://opencode.ai/v2/docs/config ；V1 迁移：https://opencode.ai/v2/docs/migrate-v1
- API 总览：https://opencode.ai/v2/docs/api ；OpenAPI：https://opencode.ai/v2/openapi.json
- 客户端：https://opencode.ai/v2/docs/build/client

**V1**
- 插件：https://opencode.ai/docs/plugins ；Providers：https://opencode.ai/docs/providers ；Config schema：https://opencode.ai/config.json

**npm 类型定义（一手 schema 来源）**
- V2：https://unpkg.com/@opencode-ai/plugin@beta/dist/promise/plugin.d.ts （另 `catalog.d.ts`、`aisdk.d.ts`、`registration.d.ts`、`integration.d.ts`、`session.d.ts`）
- V2 schema：https://unpkg.com/@opencode-ai/schema@beta/dist/model.d.ts 、`provider.d.ts`
- V1：https://unpkg.com/@opencode-ai/plugin/dist/index.d.ts

**源码与 models.dev**
- 仓库：https://github.com/anomalyco/opencode （auth：`packages/opencode/src/auth/index.ts`）
- models.dev：https://models.dev 、https://github.com/anomalyco/models.dev 、API：https://models.dev/api.json 、https://models.dev/models.json 、https://models.dev/catalog.json

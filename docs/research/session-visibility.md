# OpenCode 会话标识在 LanguageModelV3 调用参数中的可见性 — 源码定案

> 调研问题：OpenCode 宿主调用自定义 `LanguageModelV3`（`doStream`/`doGenerate`）时，调用参数里能否看到 OpenCode 的会话标识（session id 或任何按会话稳定变化的标识符）？
> 用途：伪装模块把 `x-session-id` 绑定到 OpenCode 会话——若调用参数可见会话标识则确定性派生（主路径），否则退回 per-key 随机 uuid 轮换（回退路径）。
> 对应工单：[规格集完备性审计](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/17)（#7 遗留的「可见性验证」在 #11/#12 实测中均未被回答，本报告为审计补课）。
> 调研日期：2026-08-31。方法：shallow clone 一手源码逐行核对，AI SDK 侧用 npm 上与宿主锁定的同版本产物核对。全文只读调查。

## 0. 裁决速览

| 版本线 | 裁决 | 每会话稳定的标识（`doStream(options)` 可见） | 来源 |
|---|---|---|---|
| v1（tag v1.18.25，v1.18.21 同） | **可见** | `options.headers["X-Session-Id"]`、`options.headers["x-session-affinity"]`（值 = sessionID）；有父会话时另有 `options.headers["x-parent-session-id"]` | `packages/opencode/src/session/llm/request.ts:187-204` → `ai@6.0.168` doStream 转发 |
| v2 beta（beta 分支 HEAD `90fb6562`，2026-08-31，beta-18684 邻域） | **可见** | 同上两个键（值 = `session.id`）+ `options.headers["x-opencode-session"]`（= `session.id`）；另有 `x-parent-session-id`、`x-opencode-project`（= projectID，项目稳定） | `packages/core/src/session/model-request.ts:199-207, 328-330` → `packages/core/src/aisdk.ts:422, 622` |

两条线均为**主路径可行**：插件的自定义 `LanguageModelV3.doStream(options)` 在 `options.headers` 里能直接拿到与 OpenCode 会话一一对应、跨请求稳定的字符串。`doGenerate` 侧：v1 无独立 generateText 路径（同链路）；v2 宿主根本不调用 `doGenerate`（generate 由 doStream 折叠而来），因此只看 doStream 即可。

需要注意的"每请求唯一"干扰项（不能当会话标识用）：

- v1 `x-opencode-request`（仅 providerID 以 `opencode` 开头的分支）= `input.user.id`，即**消息 id**，每请求唯一。
- `abortSignal` 每次请求新建；AI SDK 重试共用同一个 options，但跨消息必换。
- `promptCacheKey` 通道（详见 §3.3 / §4.3）：v1 默认只对特定 AI SDK npm 包生效（自定义包需 provider 配置 `setCacheKey: true`）；v2 的 ai-sdk 路由**不**把 `LLMRequest.promptCacheKey` 放进 `LanguageModelV3CallOptions`。

---

## 1. 调查对象与版本确认

- **v1 线**：`anomalyco/opencode`（GitHub API 显示 sst/opencode 的 tags 已在 anomalyco 名下）tag `v1.18.25`（commit `cb7d8b2f5e44876ef98b661dc10590c915af3a9f`，2026-08-28），是 v1.18.x 最新 tag；另单独核对 `v1.18.21`（commit `826d9ad4…`）的目标文件。
- **v2 线**：`beta` 分支 HEAD `90fb6562ce09782c311040ba39a9d50edec6ad0e`（2026-08-31 16:53 +1000）。npm dist-tag 参照：8/28 为 `0.0.0-beta-18414`（见本仓库 `docs/research/opencode-plugin-provider.md:25`），三天后 HEAD 落在 beta-18684 邻域，符合题设。
- **AI SDK**：v1.18.25 `packages/opencode/package.json` 锁 `"ai": "catalog:"`（bun.lock 解析为 `ai@6.0.168`）与 `"@ai-sdk/provider": "3.0.8"`；v1 的 `wrapLanguageModel` middleware 已写 `specificationVersion: "v3"`（`session/llm.ts:329`）。故 **v1.18.x 与 v2 同属 LanguageModelV3 世代**，类型层面一致。

核对方法：

```
git clone --depth 1 --branch v1.18.25 https://github.com/anomalyco/opencode /tmp/opencode/v1
git clone --depth 1 --branch beta     https://github.com/anomalyco/opencode /tmp/opencode/v2
curl -sL https://unpkg.com/@ai-sdk/provider@3.0.8/dist/index.d.ts   # 类型定义
curl -sL https://unpkg.com/ai@6.0.168/dist/index.mjs               # streamText→doStream 转发
```

---

## 2. `LanguageModelV3CallOptions` 全字段（@ai-sdk/provider@3.0.8）

来源：`provider-3.0.8.d.ts:1445-1544`（`type LanguageModelV3CallOptions`），接口绑定在 `d.ts:2019/2028`（`doGenerate(options)` / `doStream(options)`）。

| 字段 | 类型 | 能否携带会话标识 |
|---|---|---|
| `prompt` | `LanguageModelV3Prompt` | 否（消息内容本身；OpenCode 不会把 id 写进 prompt 文本） |
| `maxOutputTokens` | `number?` | 否 |
| `temperature` | `number?` | 否 |
| `stopSequences` | `string[]?` | 否 |
| `topP` / `topK` | `number?` | 否 |
| `presencePenalty` / `frequencyPenalty` | `number?` | 否 |
| `responseFormat` | `{type:"text"} \| {type:"json", schema?, name?, description?}` | 否 |
| `seed` | `number?` | 否 |
| `tools` / `toolChoice` | `Array<FunctionTool\|ProviderTool>` / `ToolChoice?` | 否 |
| `includeRawChunks` | `boolean?` | 否 |
| `abortSignal` | `AbortSignal?` | 否（每请求新建，仅生命周期用途） |
| **`headers`** | `Record<string, string \| undefined>` | **是 —— HTTP 头通道** |
| **`providerOptions`** | `SharedV3ProviderOptions`（`Record<string, Record<string, JSONValue>>` 形） | **是 —— provider 私有选项通道** |

类型里没有任何 session/conversation/telemetry 字段。结论：**标识符只可能经 `headers` 或 `providerOptions` 进入调用参数**，下面两节分别核实两条线的这两处。

---

## 3. v1 线（tag v1.18.25 / v1.18.21）

### 3.1 调用链

```
session/prompt.ts / summary 等会话逻辑
  → LLM.stream(input)                        # 唯一 LLM 出口，全仓库仅一个 streamText 调用点
  → packages/opencode/src/session/llm.ts:280  streamText({ ... })
  → ai@6.0.168 streamText 内部               # ai-6.0.168.mjs:7205-7213
  → LanguageModelV3.doStream(options)
```

- v1 全 `packages/opencode/src` 只有 `session/llm.ts:280` 一处 `streamText`，无 `generateText` 调用点（`grep -rn "generateText\|streamText"` 实测）。标题生成等小模型请求走同一 `LLM.stream`（`session/prompt.ts:226`，带 `sessionID: input.session.id`、`small: true`）。
- LanguageModel 实例来源：`provider.getLanguage`（`packages/opencode/src/provider/provider.ts:1892-1921`）——插件 provider hook 的 `modelLoaders` 产物（即自定义 `LanguageModelV3`）或 `sdk.languageModel(...)`；实例化本身不注入会话信息，会话信息只在调用参数里。

### 3.2 `headers`：会话标识的正式通道 ✅

构造处 `packages/opencode/src/session/llm/request.ts`（`LLMRequestPrep.prepare` 返回值，v1.18.25 行号 187-204）：

```ts
headers: {
  ...(input.model.providerID.startsWith("opencode")
    ? {
        ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
        "x-opencode-session": input.sessionID,
        "x-opencode-request": input.user.id,      // ← 消息 id：每请求唯一，勿用
        "x-opencode-client": input.flags.client,
        "User-Agent": USER_AGENT,                 // `opencode/${InstallationVersion}` (request.ts:18)
      }
    : {
        "x-session-affinity": input.sessionID,    // ← 每会话稳定
        "X-Session-Id": input.sessionID,          // ← 每会话稳定
        "User-Agent": USER_AGENT,
      }),
  ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
  ...input.model.headers,     // 模型级配置头（可覆盖上面）
  ...headers,                 // 插件 chat.headers hook 结果（可覆盖上面）
}
```

- `input.sessionID` 的语义：`StreamInput.sessionID`（`session/llm.ts:37`）即 OpenCode 会话 ID，贯穿同一会话的所有请求——**每会话稳定**。
- **v1.18.21 差异**：与 v1.18.25 的 `request.ts` diff 仅有 `x-parent-session-id` 的位置——v1.18.21 把它放在非 `opencode` 分支内（只对第三方 provider 出现），v1.18.25 移到三元之外（两条分支都有）。`X-Session-Id` / `x-session-affinity` 在两个 tag 中完全一致。
- 该 `prepared.headers` 原样进入 `streamText({ headers: prepared.headers })`（`session/llm.ts:322`）。
- AI SDK 转发实测（`ai@6.0.168` `dist/index.mjs`，streamText 内部 doStream 调用点，行 7205-7213）：

```js
result: await stepModel.doStream({
  ...callSettings, tools, toolChoice,
  responseFormat, prompt: promptMessages,
  providerOptions: stepProviderOptions,
  abortSignal, headers,          // ← streamText 的 headers 原样进入 doStream options
  includeRawChunks
})
```

`callSettings = prepareCallSettings(settings)` 只抽取 8 个采样参数（`ai-6.0.168.mjs:1677-1686`：maxOutputTokens/temperature/topP/topK/presencePenalty/frequencyPenalty/seed/stopSequences），无任何标识符。**即：宿主没有任何字段被 AI SDK 丢弃或过滤，`options.headers` 就是 OpenCode 放进去的那份。**

### 3.3 `providerOptions`：条件性通道（受 npm 包名单限制）

构造链：`request.ts:84-90` `ProviderTransform.options({ model, sessionID, providerOptions: input.provider.options })` → `chat.params` 插件 hook（`request.ts:114-132`）→ `session/llm.ts:316` `providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options)` → doStream options。

`ProviderTransform.options` 中写入 sessionID 的唯一位置（`packages/opencode/src/provider/transform.ts:1259-1272`）：

```ts
if (input.providerOptions?.setCacheKey !== false) {
  if (npm === "@ai-sdk/deepinfra" || npm === "@ai-sdk/cerebras") {
    result["prompt_cache_key"] = input.sessionID
  } else if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure" || npm === "@ai-sdk/xai"
          || npm === "@ai-sdk/mistral" || npm === "venice-ai-sdk-provider"
          || input.providerOptions?.setCacheKey === true) {
    result["promptCacheKey"] = input.sessionID
  }
}
```

（`opencode` 前缀 provider 另有 `transform.ts:1316-1317` 的 `promptCacheKey = sessionID`。）

随后 `providerOptions()`（`transform.ts:1357-1415`）按包名把 options 归到 `providerOptions[<sdkKey>]` 命名空间下。**对自定义 npm 包的自定义 provider：默认不含 sessionID；仅当 provider 配置里显式 `options: { setCacheKey: true }` 时，`options.providerOptions[<providerID>].promptCacheKey` 才等于 sessionID**。因此 providerOptions 是备用通道，headers 才是无条件主通道。

### 3.4 不可见通道（排除项）

- `experimental_telemetry.metadata.sessionId = input.sessionID`（`session/llm.ts:344-352`）——**只进 OpenTelemetry span 属性**（`ai.telemetry.metadata.sessionId`），不出现在 doStream options：doStream 调用点（`ai-6.0.168.mjs:7205-7213`）无 telemetry 字段，且 `LanguageModelV3CallOptions` 类型无该字段（§2）。不要指望从这里取。
- prompt 构造（系统消息 + `ModelMessage[]`，`request.ts:101-112`；middleware `transformParams` 仅改写 prompt 内容，`session/llm.ts:325-343`）：不含会话 id。
- 实验性 native runtime（`flags.experimentalNativeLlm`，`session/llm.ts:226-253`）不经过 LanguageModelV3.doStream，与本调研无关；`workflowModel.sessionID = input.sessionID`（`session/llm.ts:125`）是 GitLab workflow 模型的实例属性 hack，不走 doStream 参数。

### 3.5 v1 小结

**(a) 可见，且无条件**：自定义 `LanguageModelV3.doStream(options)` / （经同一 `streamText` 链路的任何生成调用）的 `options.headers` 中：

- `X-Session-Id: <sessionID>` 与 `x-session-affinity: <sessionID>` —— 每会话稳定（`request.ts:197-198`）；
- `x-parent-session-id: <parentSessionID>`（v1.18.25 两分支通用；v1.18.21 仅第三方 provider 分支）。

**(b) 干扰项**：`x-opencode-request`（= 消息 id，仅 `opencode` 前缀 provider 分支，`request.ts:192`）为每请求唯一，不得当作会话标识。

---

## 4. v2 beta 线（beta 分支 HEAD `90fb6562`）

### 4.1 aisdk 加载链（自定义 LanguageModelV3 如何被宿主持有）

```
model-resolver.ts:130-141, 283   Provider.isAISDK(package) → aisdk.model(model)（loadAISDK）
packages/core/src/aisdk.ts:250-292  AISDK.language：
    runSDK({model, package, options})     ← 插件 ctx.aisdk.hook("sdk")，可换 sdk
    runLanguage({model, sdk, options})    ← 插件 ctx.aisdk.hook("language")，result.language 即自定义 LanguageModelV3
aisdk.ts:301-344  modelFromLanguage：把 language 包进 Route：
    route.body.from = (request) => callOptions(request, packageName, modelID, optionKey)   (330)
    route.streamPrepared = (prepared) => streamLanguage(language, prepared as LanguageModelV3CallOptions)  (336)
aisdk.ts:616-637  streamLanguage → Effect.tryPromise(() => language.doStream(options))      (622)
```

### 4.2 会话侧请求构造（`headers` 通道）✅

`packages/core/src/session/model-request.ts`（`SessionModelRequest.prepare`，283-375 行）：

```ts
// 行 199-207 —— 无 provider 前缀判断，对所有 provider 生效
const sessionHeaders = (session: Pick<SessionSchema.Info, "id" | "parentID" | "projectID">, app: App.Info) => ({
  "x-session-affinity": session.id,        // ← 每会话稳定
  "X-Session-Id": session.id,              // ← 每会话稳定
  ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
  "User-Agent": App.useragent(app),
  "x-opencode-project": session.projectID, // ← 项目稳定（非会话粒度）
  "x-opencode-session": session.id,        // ← 每会话稳定
  "x-opencode-client": app.name,
})

// 行 326-330 —— LLMRequest 携带
LLM.request({
  model,
  http: { headers: sessionHeaders(session, app) },      // ← 进入 request.http.headers
  promptCacheKey: promptCacheKey(session.fork?.sessionID ?? session.id),  // 行 332（见 4.3）
  ...
})

// 行 213-233 —— applyModelHooks：session.model.request 插件 hook 在此基础上改 headers/baseURL
```

下游合并与转发（`packages/ai/src/route/client.ts`）：

- `compile()`（451-473 行）：`applyCachePolicy(resolveRequestOptions(request))` → `route.body.from(resolved)` → `route.streamPrepared(prepared, ...)`；
- `resolveRequestOptions`（172-189 行）：`http: mergeHttpOptions(routeDefaults.http, modelDefaults?.http, normalized.http)` —— route defaults 的 headers 来自 provider/model 配置（`aisdk.ts:317-327` `defaults: { headers: info.headers, http: {…, headers: info.headers}, providerOptions: projected.settings }`），**request.http.headers（sessionHeaders）在后合并、优先级最高一档（配置 < hook < 无进一步覆盖）**；随后 `session.model.request` hook（model-request.ts:219-231）在 hook 事件里再叠加。
- `callOptions()`（`packages/core/src/aisdk.ts:404-425`）：

```ts
return {
  prompt: prompt(request),
  maxOutputTokens: request.generation?.maxTokens,
  temperature: request.generation?.temperature,
  /* …采样参数、tools、toolChoice… */
  headers: request.http?.headers,                    // ← 行 422：sessionHeaders 在此进入调用参数
  providerOptions: requestProviderOptions(request.providerOptions, packageName, modelID, optionKey),  // 行 423
}
```

- `streamLanguage`（616-637 行）把整个 `prepared as LanguageModelV3CallOptions` 交给 `language.doStream(options)`（622 行）。链路中无任何 headers 过滤/改名步骤。

**调用点覆盖**：主执行链（`session/runner/llm.ts`、`runner/step.ts`、`generate-node.ts`、`context.ts`）与标题生成（`session/title.ts:66-76`，经同一 `context.prepare`，仅 `contextHooks: false` 跳过 context hook，sessionHeaders 照常注入）全部经 `SessionModelRequest.prepare`，无一例外。

### 4.3 `providerOptions` 通道与 `promptCacheKey` 的下落（重要差异）

- `options.providerOptions` = `requestProviderOptions(request.providerOptions, …)`（`aisdk.ts:598-609`），其中 `request.providerOptions` 由三层合并（`client.ts:178-188`）：route defaults（= provider/model 配置 settings，经 `mapBodyToProviderOptions`，`aisdk.ts:388-402`）← model defaults ← session `context` hook 的 `providerOptions`（`model-request.ts:301-311, 338`）。**默认情况下不含 session id**。
- `LLMRequest.promptCacheKey`（`model-request.ts:332`，值为 sessionID，`ses_<64hex>` 形态会剥掉 `ses_` 前缀，`model-request.ts:209-210`）**不进入 ai-sdk 路由的 `LanguageModelV3CallOptions`**——`callOptions()` 全函数未引用该字段。它只被 v2 的**原生协议路由**消费：
  - `packages/ai/src/protocols/openai-chat.ts:714-721`（请求体 `prompt_cache_key`）、`protocols/open-responses.ts:695-706`（同）；
  - `packages/ai/src/providers/xai.ts:56`（原生 xai 路由的 HTTP 头 `x-grok-conv-id` = promptCacheKey）；
  - `packages/ai/src/schema/messages.ts:292,310`（schema 序列化）。
  - `packages/core/src/aisdk-native.ts:289` 的 `promptCacheKey` 是把**用户配置 settings** 映射为 native provider options，与 session 无关。

### 4.4 `doGenerate` 的下落

宿主侧**没有任何 `doGenerate` 调用**：`generateWith`（`client.ts:481-490`）把 `stream()` 折叠成 `LLMResponse`，即非流式请求也走 `doStream`。仓库内 `doGenerate` 只存在于 OpenCode 自带的 github-copilot 模型实现内部（`packages/core/src/github-copilot/*/…language-model.ts:192/378`），是"被调用方"而非"调用方"。**对插件自定义 LanguageModelV3，只需实现/观察 doStream。**

### 4.5 v2 小结

**(a) 可见，且无条件（对所有 provider）**：自定义 `LanguageModelV3.doStream(options)` 的 `options.headers` 含：

- `X-Session-Id: <session.id>`、`x-session-affinity: <session.id>`、`x-opencode-session: <session.id>` —— 每会话稳定；
- `x-parent-session-id`（有父会话时）、`x-opencode-project`（= projectID，项目稳定）、`User-Agent`、`x-opencode-client`（= app.name）。

**(b)** `options.providerOptions` 默认无 session id（除非配置 settings 或 session context hook 显式写入）；v1 时代"promptCacheKey = sessionID"的行为在 v2 只保留在原生协议路由体内，**不会**出现在 ai-sdk 路由的调用参数里。

---

## 5. 与既有调研笔记的核对

本仓库 `docs/research/opencode-plugin-provider.md` 记录了 V1 `chat.headers` hook（第 390 行）、V2 `session.hook("model.request")`（第 173 行）与 aisdk 加载链（第 491 行），与本次源码结论一致；但该文档**未涉及**「宿主自己往调用参数里放了什么」——本报告补充的正是这一层：OpenCode 在插件机制之外、于调用参数 `options.headers` 中无条件注入会话标识（v1/v2 均是），这是此前工单 #11/#12 实测未回答的部分。

## 6. 对伪装模块的落地结论

1. **主路径成立（v1 与 v2 都支持）**：在自定义 `LanguageModelV3.doStream(options)` 里读 `options.headers["X-Session-Id"]`（或 `x-session-affinity`；v2 还可加读 `x-opencode-session` 交叉验证），以其为种子确定性派生 `x-session-id` 绑定。该值跨请求稳定、与 OpenCode 会话一一对应，且**不依赖任何插件 hook**。
2. **健壮性建议**：读取时同时接受 `X-Session-Id` / `x-session-affinity`（/ v2 的 `x-opencode-session`）任一存在即走主路径，全部缺失才落回 per-key 随机 uuid 回退路径；这可容忍未来 OpenCode 改名头的风险（beta 期头部清单仍可能变动，建议在运行时对「主路径命中但值变化」做日志）。
3. **不要用**：v1 `x-opencode-request`（消息 id，每请求唯一）、`abortSignal`、telemetry（不进调用参数）、v1 `promptCacheKey`（需 `setCacheKey: true` 才有且仅限特定包）、v2 `LLMRequest.promptCacheKey`（不进 ai-sdk 路由）。
4. **语义提醒**：`headers` 在调用参数里对自定义 LanguageModelV3 只是数据；伪装模块自行发真实 HTTP 请求时是否原样转发这些头由插件决定（上游若可见 `X-Session-Id: ses_…` 可作为一致性校验点）。v2 的 `x-parent-session-id` / `x-opencode-project` 可用于把子会话（fork/子代理）归并到根会话或项目维度（v1.18.25 起父会话头两条分支都有）。

## 7. 引用清单

**v1（tag v1.18.25 `cb7d8b2f`；v1.18.21 `826d9ad4` 已单独 diff）**

- `packages/opencode/src/session/llm/request.ts:18, 84-90, 114-146, 187-204` —— headers 构造、chat.params/chat.headers hook、sessionID 进 options
- `packages/opencode/src/session/llm.ts:35-56, 95-103, 280-353`（streamText 参数：316 providerOptions、322 headers、325-343 wrapLanguageModel/transformParams、344-352 telemetry）、`226-269`（native runtime 旁路）
- `packages/opencode/src/provider/transform.ts:1156-1272, 1357-1415` —— ProviderTransform.options / providerOptions
- `packages/opencode/src/provider/provider.ts:1892-1921` —— getLanguage（modelLoaders / sdk.languageModel）
- `packages/opencode/src/session/prompt.ts:210-235` —— 标题生成复用 LLM.stream
- `ai@6.0.168 dist/index.mjs:1677-1686（prepareCallSettings）、7205-7213（streamText→doStream 转发）`；`@ai-sdk/provider@3.0.8 dist/index.d.ts:1445-1544, 2019-2028`

**v2（beta 分支 HEAD `90fb6562`，2026-08-31）**

- `packages/core/src/session/model-request.ts:193-233（HookScope/sessionHeaders/promptCacheKey/applyModelHooks）、283-375（prepare：328-330 headers、332 promptCacheKey、338 providerOptions）`
- `packages/core/src/aisdk.ts:250-292（AISDK.language：runSDK/runLanguage 插件 hook）、301-344（modelFromLanguage route：317-327 defaults、330 body.from、336 streamPrepared）、404-425（callOptions：422 headers、423 providerOptions）、598-614（requestProviderOptions）、616-637（streamLanguage → doStream:622）`
- `packages/ai/src/route/client.ts:118-130（mergeRouteDefaults）、172-189（resolveRequestOptions）、451-473（compile）、481-490（generateWith 折叠 stream）`
- `packages/core/src/model-resolver.ts:130-141, 273-283` —— AISDK 包判定与加载
- `packages/ai/src/protocols/openai-chat.ts:714-721`、`packages/ai/src/protocols/open-responses.ts:695-706`、`packages/ai/src/providers/xai.ts:56`、`packages/ai/src/schema/messages.ts:292-310` —— promptCacheKey 仅限原生路由
- `packages/core/src/session/title.ts:55-76`、`packages/core/src/session/runner/llm.ts:12`、`runner/step.ts:24`、`generate-node.ts:11`、`context.ts:87` —— 全部调用点经 SessionModelRequest

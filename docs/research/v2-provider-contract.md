# OpenCode v2 自定义 Provider 包契约（beta-18414 实测）

> 对应 wayfinder 票：[v2 自定义 provider 包契约验证（aisdk: 包 or aisdk.hook）](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/5)
> 验证日期：2026-08-28。环境：本机 opencode2 `0.0.0-beta-18414`（bun 1.3.6）。
> 原型代码（弃子，仅作 primary source）：仓库 `prototype/` 目录。
> 结论以 **beta-18414 二进制取证 + 真机运行** 为准；当前 opencode dev 分支源码的 config schema 已漂移（`api: {type:"aisdk", package}` 形态），与本地 beta 不一致，**以本文为准，等 v2 正式版再重新评估**。

## 0. 结论速览

1. **主路径（已验证 ✅）**：`providers.<id>.package = "aisdk:<包>"`，本地包用 `aisdk:file://<绝对路径>/index.js`，**免 npm 安装直接 import**。
2. **`aisdk:` 前缀强制**。漏写 → `SessionRunnerModel.UnsupportedPackageError`（Breskott 坑复现，见 §4）。
3. **模型级 `package`/`settings` 双写不是必需**（beta-18414）：只写 provider 级即可（fake-1 通过）；模型级覆盖字段存在且可用（fake-2 通过）。
4. **兜底路径（已验证 ✅）**：`ctx.aisdk.hook("language", fn, { providerID })` 直接注入 `LanguageModelV3`，且**优先于**包工厂的结果（hook 拿到的 `evt.sdk` 已是工厂实例，可整个替换 `evt.language`）。
5. **工厂签名**：模块第一个 `create*` 开头的导出被当作工厂，收到 `{ name: <providerID>, apiKey, headers, body, fetch }`，须返回 `{ languageModel(modelID) → LanguageModelV3 }`。
6. **LanguageModel 版本 = V3**（`specificationVersion: 'v3'`，`@ai-sdk/provider@3.0.8`）。**两个反直觉的点**：
   - `finishReason` 是**对象** `{ unified: "stop"|"length"|..., raw: string|undefined }`，不是字符串；写成字符串必炸 `StepFinish` schema 校验。
   - `usage` 是**嵌套**结构：`{ inputTokens: {total, noCache, cacheRead, cacheWrite}, outputTokens: {total, text, reasoning} }`。

## 1. 加载链路（beta-18414 二进制取证）

```
providers.<id>.package (config / catalog)
  → ModelResolver.resolveCatalogModel
      isAISDK(pkg)                     // pkg.startsWith("aisdk:")
      ├─ 已知 AI SDK 包（Gu.map 命中，如 aisdk:@ai-sdk/openai-compatible）
      │    → loadPackage(strip("aisdk:"))         // 映射到 @opencode-ai/ai/providers/* 自有包装包
      │    → 包模块必须导出 model(modelID, settings)
      └─ 未知包（自定义包走这里）
           → loadAISDK → AISDK.language(model)
                → isAISDK 校验（否则 "Unsupported package"）
                → packageName() 剥掉 "aisdk:" 前缀
                → sdk hooks：内置 dynamic-provider 插件
                    evt.package.startsWith("file://") → 直接 import（不装 npm）
                    否则 npm.add(包) 后 import
                    取模块第一个 create* 导出，以 options 调用 → evt.sdk
                → language hooks（可覆盖 evt.language）
                → 结果 = hook.language ?? sdk.languageModel(model.modelID ?? model.id)
```

要点：

- `options`（工厂入参）= provider `settings` 合并结果 + `name: providerID` + **包装过的 `fetch`**（超时/chunk 处理在 OpenCode 侧做）+ `apiKey`（provider `env` 解析出的连接凭证会注入进来，实测 `env: ["CCPROTO_FAKE_KEY"]` + 环境变量 → 工厂收到 `apiKey: "dummy"`）+ `headers` + `body`。
- 每次**模型请求**会走两遍工厂+doStream（主回复 + 标题/小任务），工厂无需缓存，OpenCode 侧对 sdk/language 实例有按 (provider, model, variant) 缓存。
- 模型注册：插件 `ctx.catalog.transform` 的 `draft.provider.update` / `draft.model.update` 均为 **upsert**；模型必填字段可用 `Model.Info` 默认基线（capabilities/variants/time/cost[]/status/enabled/limit{id→context,output}/id/modelID/providerID/name）。provider 侧注意 `activation`（`"auto"` 即无需显式启用）。

## 2. LanguageModelV3 最小可用实现（provider 3.0.8）

```ts
{
  specificationVersion: "v3",
  provider: string,            // 实测可任意；OpenCode 不校验与 providerID 一致
  modelId: string,             // = sdk.languageModel(modelID) 的入参
  supportedUrls: {},
  doStream(options): Promise<{ stream: ReadableStream<Part> }>,
  doGenerate(options): Promise<{ content, finishReason, usage }>,
}
// 流部件顺序：stream-start(warnings:[]) → text-start{id} → text-delta{id,delta} → text-end{id}
//            → finish{ finishReason: {unified, raw}, usage: 嵌套结构 }
// doGenerate 的 content: [{type:"text", text}]；finishReason 同为 {unified, raw} 对象
```

## 3. 验证矩阵（全部真机跑通）

| # | 场景 | 配置 | 结果 |
|---|---|---|---|
| A1 | `aisdk:file://` 包 + 仅 provider 级 package（fake-1） | config `package` 带前缀，模型无 `package` | ✅ stdout 收到假回复，exit=0 |
| A2 | 同上 + 模型级 package/settings 双写（fake-2） | 模型 `m.package = m.settings = …` | ✅ 同样跑通（证明双写非必需） |
| B | 无 `aisdk:` 前缀（`file://` 裸写） | config/plugin 均去前缀 | ❌ `UnsupportedPackageError`（预期复现） |
| C | `ctx.aisdk.hook("language", fn, {providerID})` | `CCPROTO_HOOK=1` | ✅ hook 输出直达 stdout；`evt.sdk` 已含工厂实例，hook 覆盖生效 |
| — | 选择器可见性 | `opencode2 models` | ✅ `ccproto/fake-1`、`ccproto/fake-2` 均列出 |

运行方式（原型 scratch 目录）：

```bash
cd <scratch> && CCPROTO_FAKE_KEY=dummy \
  opencode2 run "pong" --model ccproto/fake-1 --print-logs --log-level warning --standalone
```

## 4. Breskott 坑的准确机理（Test B）

`UnsupportedPackageError: Unsupported package for ccproto/fake-1: file:///…`，抛点 `ModelResolver.resolveCatalogModel`：

- 无 `aisdk:` 前缀 → `isAISDK` 为 false → 不走 AI SDK 加载链，改走 OpenCode **自有 provider 包**的 `loadPackage`（要求模块导出 `model(modelID, settings)`）；
- 自定义包没有 `model()` 导出 → 报 `Provider package X does not export model(modelID, settings)` → 被吞掉，对外只剩 `UnsupportedPackageError`；
- TUI 下表现为会话卡死/静默失败（Breskott 的描述），`--print-logs --standalone` 下可见完整堆栈。

**对照结论**：Breskott 时代「package/settings 必须同时写在 provider 与 model 顶层」在 beta-18414 **已不成立**——resolver 读的是 catalog 里的模型记录，模型级 `package` 只是可选覆盖字段。他的插件用 `config` hook 注入且模型记录字段不全，可能因此踩出双写惯例；用 `catalog.transform` 完整注册（照 `Model.Info` 必填字段填齐）则单写即可。

## 5. 对本插件（v2 glue）的落地指令

1. v2 侧采用**主判例原样落地**：发布一个带 `create*` 工厂导出的包（或本地 `file://` 路径先行），config `providers.commandcode-go.package = "aisdk:<包>"` + `env: ["COMMANDCODE_API_KEY"]`；插件 `setup()` 里 `catalog.transform` 注册模型清单。
2. `aisdk.hook("language")` 作为增强点保留（例如需要 per-request 换模型实例/调试时），不作为主路径。
3. 语言模型实现按 §2 的 V3 形状写；**不要**凭旧 AI SDK 记忆用字符串 finishReason。
4. 插件入口可零依赖：不 import `@opencode-ai/plugin`，直接默认导出 `{ id, setup }`（`define()` 是恒等函数）。插件包打包时这就免去把 plugin 包及其 Effect 系依赖带进 bundle 的问题——是否正式采用待实现阶段定。
5. beta-18414 与 dev 分支 schema 已漂移（dev 改成 `api: {type:"aisdk", package, url, settings}`）。锁定 beta 快照开发；v2 正式版出来后按地图既定票重新评估适配。

## 6. 原型资产

原型代码留在弃用分支 **`prototype/v2-provider-contract`**（不进 main；`node_modules` 已 gitignore）：

- `prototype/commandcode-proto/index.js` — 最小包：`createCommandCode()` + 假流 V3 模型，工厂/doStream 调用全留痕到 `CCPROTO_LOG`
- `prototype/plugin/cc-proto-plugin.js` — transform 注册 provider+双模型（单写/双写对照）+ 可选 language hook
- `prototype/README.md` — 跑法

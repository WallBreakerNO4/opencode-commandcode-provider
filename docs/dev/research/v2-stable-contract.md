# OpenCode 2 正式版 Provider 包契约调研（v2.0.1）

> 状态：已定稿。调研日期：2026-09-12。
> 环境：本机 `opencode` v2.0.1（`opencode --version` → `opencode v2.0.1`；`opencode2` 是官方安装器生成的同二进制兼容 shim）。
> 关系：本文兑现 [`v2-provider-contract.md`](./v2-provider-contract.md)（beta-18414 实测）§6 留下的「等 v2 正式版再重新评估」。beta 文档保持不动、作为历史基线；凡 beta 结论仍成立的本文只做确认并给出正式版出处，不重复叙述原型细节。
> 取证方式（全部只读）：官方 V2 文档、官方 OpenAPI、GitHub `anomalyco/opencode` v2.0.1（tag commit `afc3359e`，浅克隆于 `/tmp/opencode/repo`）、npm registry、本机 v2.0.1 二进制的 `--version` / `--help` / `plugin --help`、本仓库源码。未做真实 API 调用；未执行 `plugin add/remove/update`；未改动任何全局配置。

## 0. 结论速览

按调研问题 A–H 排列。影响标签：**无需改** / **需改** / **待实测**。

1. **A · 入口形状**：正式版接受本仓库的明文对象 default `{id, setup, server}`——加载器只按 `{id, setup}`（或 `{id, effect}`）解码 default，多余键被 Schema 剥离；`Plugin.define` 是恒等函数，运行时不 import `@opencode/plugin` 可行；`server` 被 V2 显式忽略。影响：**无需改**（`tests/package-shape.test.ts` 的三键形状继续有效）。
2. **A · id 约束**：`id` 无字符/格式约束（`Plugin.ID` 只是 `Schema.String` 的品牌类型；V2 解码只要求 string，空串技术上能通过，但不应使用——V1 侧显式拒绝空 id）；同一 location 内重复 id 会让插件激活失败（`Duplicate plugin ID`）。影响：**无需改**。
3. **B · provider 注册**：`catalog.transform` 的 `provider.update` 仍是 update-or-create；`package` / `activation` / `integrationID` 字段俱在（`Provider.Info` 必填 `id/name/activation/package`）。影响：**无需改**。
4. **B · 自指链路**：`provider.package = "aisdk:<入口文件 URL>"` 仍是正式版契约——`aisdk:` 前缀强制、`file://` 不经 npm 直接 `import()`、同 URL 命中同一模块实例、工厂判据仍是「模块第一个 `create*` 前缀导出」。影响：**无需改**。
5. **B · 空壳 config**：源码层面空壳已非硬性必需（transform 自举 provider + integration 已足够；`activation: "auto"` 下可见性由 integration 连接决定）；但写了空壳后，内置 config 插件会把 `activation` 覆写为 `"enabled"`（无凭证也可见）。空壳能否从安装步骤移除：**待实测**。
6. **C · 模型注册**：`Model.Info` 必填字段与 beta 相同；`model.update` 先放入宿主默认基线（cost `[]`、time `{released:0}`、status `active`、enabled `true`、limit 200k/32k、capabilities 默认），宿主在回调后回填 `id`/`providerID`。影响：**无需改**。
7. **C · reload**：`catalog.reload()` 语义未变——标记变更，下一次读按注册顺序重放全部 transform，不重跑插件 `setup`。影响：**无需改**。
8. **D · 工厂入参**：仍为 `{name: canonical ?? providerID, ...settings（含凭证注入的 apiKey）, headers, body, fetch}`；`chunkTimeout` 被宿主消费后从 options 删除，`timeout` 保留；`languageModel(...)` 仍用 wire id（`modelID`）调用。影响：**无需改**。
9. **D · LanguageModel 版本**：仍是 V3，宿主锚定 `@ai-sdk/provider@3.0.8`（与 beta 时期相同）。影响：**无需改**。
10. **D · 实例缓存**：v2.0.1 显式缓存 sdk 与 language 实例（key 含 settings/headers/body，language 另含 id/modelID/limit）：同 key 下工厂不会被重复调用——beta-18684「每次模型请求重调工厂（两遍/请求）」的假设在正式版源码中不成立。影响：**需改**（`src/provider/model.ts` 头注的调用节奏假设），实际调用次数走真机确认：**待实测**。
11. **E · 认证方法**：`integration.transform` + `method.update` 形状未变——key（`{type:"key", label?}`）与 env（`{type:"env", names}`）都不需要 `id`；只有 command/oauth 方法需要 `id`。影响：**无需改**。
12. **E · 凭证链路**：credential > env 优先级成立（连接解析顺序：active 凭证 → 其它凭证 → env）；env 也解析为 key 凭证，最终同样经 `apiKey` 注入工厂 options。`/connect` 用 `method.label` 作选项文案与输入提示（缺省 `"API key"`）；credential 未显式给 label 时默认取 integration name。影响：**无需改**。
13. **F · settings 通道**：插件 transform 回放顺序 = 内置 `pre` → 用户插件 → 内置 `post`（`opencode.config.provider`）；config `settings` 由 post 插件在自己的 transform 中写入，用户 transform 草稿里仍看不到 `settings`（beta 结论保持）；运行时读目录时 `projectModel` 把 provider.settings 合并进 model.settings，最终顶层展开进工厂 options，首次工厂调用经 `rebindModelsUrls` 接入的方式仍成立。注意第 10 条：该「首次调用」可能也是唯一一次。影响：**无需改**（措辞随第 10 条更新）。
14. **G · 安装面**：V2 稳定版安装走 `npm i -g @opencode/cli`（或 `bun`/`pnpm`/`yarn` 对应形式）或 `curl -fsSL https://opencode.ai/v2/install | bash`；官方仍提供 `opencode2`（npm bin 同时映射 `opencode`/`opencode2`，curl 安装脚本写 `opencode2` shim）；`plugin add` 只接受 npm/Git 规格并写全局配置 `plugins`，本地路径直接写 `plugins` 配置。影响：**需改**（安装文档）。
15. **H · 包名与定稿**：官方插件 SDK 包名已迁到 `@opencode/plugin@2.0.x`；`@opencode-ai/plugin` 定格为 V1 SDK（latest 1.18.30，其 `beta` tag 是旧 V2 beta 线）。正式文档已去掉 beta 警告、2.x 稳定包已发布，但未见「V2 插件 API 定稿/frozen」的显式声明；`ctx.aisdk` 仍未写进正式插件 API 文档（源码与 SDK 类型仍在）。影响：**需改**（devDependency/注释口径）+ **待实测/持续关注**（`aisdk` 是事实契约而非文档契约）。

## 1. 差异表

| # | beta 假设（出处） | 正式版实况（v2.0.1） | 证据 | 影响 |
|---|---|---|---|---|
| 1 | 入口可零依赖：不 import `@opencode-ai/plugin`，直接默认导出 `{id, setup}`，`define()` 是恒等函数（beta 文档 §5.4；`src/index.ts:14-16`） | 成立。V2 加载器只按 `{id, setup}` 或 `{id, effect}` 解码 default，多余键被剥离；`define()` 实现即恒等；文档回显「V2 reads the default export's `id` and `setup()`, ignoring `server()`」 | `packages/core/src/plugin/module.ts:60-73`；`packages/plugin/src/promise/plugin.ts:56-63`；V2 文档 build/plugins「Support V1」节 | 无需改 |
| 2 | 三键 `{id, setup, server}` 是 v1/v2 双宿主共用形状；v1 侧带 `id` 缺 `server` 会跳过整模块（beta `src/index.ts:5-7`） | V2 侧确认兼容；V1 1.18.30 侧确认：object 形态 default 在 server kind 下缺 `server()` 会抛错，`id` 只要求非空字符串 | `v1.18.30 → packages/opencode/src/plugin/shared.ts:270-303` | 无需改 |
| 3 | `provider.package` 必须带 `aisdk:` 前缀，漏写即 `UnsupportedPackageError`（beta 文档 §0.2） | 成立且仍是 `UnsupportedPackageError` 判点：`isAISDK` 前缀检查、无 mapping 且无 aisdk 加载器时抛错 | `packages/core/src/provider.ts:14-15`；`packages/core/src/model-resolver.ts:201-224,323` | 无需改 |
| 4 | `aisdk:file://` 本地包免 npm 安装直载（beta 文档 §0.1/§1） | 成立：`loadSDKFactory` 对 `file://` 直接用路径 `import()`，否则走 `npm.add` | `packages/core/src/plugin/provider/sdk-factory.ts:5-13` | 无需改 |
| 5 | 工厂判据 = 模块**第一个** `create*` 前缀导出（`src/host/v2.ts:10-12,116-118`；`src/provider/model.ts:9-10`） | 成立：`Object.keys(mod).find(name => name.startsWith("create"))`（对象键序） | `packages/core/src/plugin/provider/sdk-factory.ts:13-16` | 无需改 |
| 6 | 宿主再 import 同一入口 URL 时命中同一模块实例（伪装状态单例前提，`src/host/v2.ts:7-9`） | 成立：`importModule` 是原生动态 `import()`（URL 级缓存）；插件加载解析出的入口与 `ENTRY_URL` 为同一 file URL | `packages/util/src/runtime/import.bun.ts:1-5`；`packages/core/src/plugin/module.ts:94-105`；`packages/plugin/src/host.ts` resolve | 无需改 |
| 7 | 用户 config 只写空壳 `providers: {"commandcode-go": {}}`，其余自举（`src/host/v2.ts:4-6`；README「beta 限制」） | 源码不再有硬性必需：transform 即可 update-or-create provider 与 integration；`activation:"auto"` 的可见性 = integration 有连接（凭证或 env）。但写了空壳 → 内置 config 插件把 activation 覆写为 `"enabled"`（无条件可用） | `packages/core/src/catalog.ts:67-72,92-135`；`packages/core/src/config/plugin/provider.ts:41-65`；`packages/core/src/plugin/supervisor.ts:91-95` | 待实测 |
| 8 | `Model.Info` 必填字段可由目录默认基线兜底；只补缺位不覆盖（`src/host/v2.ts:49-61,140-145`；`src/models/mapping.ts:44-56`） | 必填集未变：`id/modelID/providerID/name/capabilities/variants/time/cost/status/enabled/limit`；`model.update` 先以 `Model.Info.default` 起手、回放回调后再回填 `id`/`providerID` | `openapi.json → Model.Info`；`packages/schema/src/model.ts:130-150`；`packages/core/src/catalog.ts:111-135` | 无需改 |
| 9 | `catalog.reload()` 触发本 transform 重放、register 幂等（`src/host/v2.ts:10-13`；`src/host/v2.ts:102-105`） | 语义未变：`reload()` 标记变更并通知；下一次读按注册顺序重放全部 active transform；不重跑插件 `setup` | V2 文档 build/plugins「Transforms」；`packages/core/src/state.ts:150,199-244`；`packages/core/src/catalog.ts:144-145` | 无需改 |
| 10 | 工厂入参 `{name, apiKey, headers, body, fetch}`，fetch 为宿主包装版（beta 文档 §1；`src/provider/model.ts:62-82`） | 形状未变：`options = {name: canonical ?? providerID, ...settings, headers, body}` + 包装 `fetch`；`chunkTimeout` 消费后删除，`timeout` 保留；`languageModel(model.modelID ?? model.id)` | `packages/core/src/aisdk.ts:119-161,289`；`packages/core/src/plugin/provider/dynamic.ts` | 无需改 |
| 11 | 「宿主每次模型请求都会重新调用工厂（v2 实测两遍/请求）」（`src/provider/model.ts:23-25`） | 与源码不符：sdk/language 实例按 key 缓存（sdk key：providerID/canonical/package/settings/headers/body；language key 另含 id/modelID/limit），同 key 直接返回缓存，不再调工厂 | `packages/core/src/aisdk.ts:194-206,249-294` | 需改 / 待实测 |
| 12 | LanguageModel = V3，`finishReason` 为 `{unified, raw}` 对象、`usage` 嵌套（beta 文档 §0.6/§2；`src/provider/model.ts:32-42`） | 未变：宿主按 `LanguageModelV3`/`LanguageModelV3StreamPart` 消费；`@ai-sdk/provider` 固定 3.0.8 | `packages/core/src/aisdk.ts:4-17,632-773`；`packages/core/package.json:111`；`packages/plugin/package.json` | 无需改 |
| 13 | `integration.transform` 为全新 provider upsert integration；key/env 方法形状（`src/host/v2.ts:14-16,76-86,150-165`） | 未变：`integration.update` update-or-create；`method.update` 按 type 去重（key/env 同 type 覆盖）；key/env 无 `id`，command/oauth 需要 `id` | `openapi.json → Integration.KeyMethod/EnvMethod/Method`；`packages/plugin/src/promise/integration.ts:24-56`；`packages/core/src/plugin/host.ts:593-634`；`packages/core/src/integration.ts:286-308` | 无需改 |
| 14 | 凭证优先级 credential > env；凭证经工厂 `apiKey` 注入（`src/host/v2.ts:16,150-153`；`src/provider/model.ts:62-69`） | 成立：`resolveConnections` 先 active 凭证、再其它凭证、最后 env；env 解析为 key 凭证；`nativeCredentialSettings` 给 aisdk 链路注入 `{apiKey}` | `packages/core/src/integration.ts:345-357,662-671`；`packages/core/src/credential.ts:80-93`；`packages/core/src/model-resolver.ts:199-224,310-321` | 无需改 |
| 15 | transform 草稿看不到 config settings；由宿主合并进工厂 options 顶层，首次工厂调用经 `rebindModelsUrls` 接入（`src/host/v2.ts:17-20,167-171`） | 成立：回放顺序 pre → 用户插件 → post；settings 由 post 插件在 transform 中写入；运行时 `projectModel` 合并 provider.settings，resolver 再并入凭证后由 `prepareOptions` 顶层展开 | `packages/core/src/plugin/supervisor.ts:91-95,143-152`；`packages/core/src/config/plugin/provider.ts:41-65`；`packages/core/src/catalog.ts:74-89`；`packages/core/src/aisdk.ts:119-126` | 无需改 |
| 16 | dev 分支漂移形态 `api: {type:"aisdk", package, url, settings}`（beta 文档 §6 提醒；§5.5） | 未落地到 2.0.1：`Provider.Info` 无 `api` 字段，仍是 `package` + `settings`；AI SDK 包按 `aisdk:` 前缀走 `aisdk-native` 映射或动态工厂 | `openapi.json → Provider.Info`；`packages/core/src/aisdk-native.ts:106-131` | 无需改 |
| 17 | 插件 SDK 包名 `@opencode-ai/plugin`（`package.json` devDependency `beta`；lock `0.0.0-beta-18866`） | 官方文档统一改用 `@opencode/plugin`（npm latest 2.0.2）；`@opencode-ai/plugin` 定格为 V1 SDK（latest 1.18.30），其 `beta` tag 是旧 V2 beta 线（0.0.0-beta-19271） | V2 文档 build/plugins；npm registry `@opencode/plugin`、`@opencode-ai/plugin` | 需改 |
| 18 | 双宿主命令：v2 = `opencode2`、v1 = `opencode`（`docs/guide/installation.md` Step 0；README） | V2 稳定版两个名字都指向同一二进制：`@opencode/cli@2.0.2` 的 bin 同时提供 `opencode` 与 `opencode2`；curl 安装脚本显式写 `opencode2` shim；`--version` 实测输出 `opencode v2.0.1` | npm registry `@opencode/cli@2.0.2` 清单；`https://opencode.ai/v2/install` 的 `install_legacy_shim`；本机 `opencode --version` | 需改（安装文档） |

## 2. 关键机制取证（差异表补充）

### 2.1 插件入口（A）

- 加载链：配置/发现 → `PluginModule.load` 解析入口（包按 subpath `server` / 主入口/ `tui` / `rpc` 探测，本地路径按文件/目录解析）→ `importModule` → **`Schema.decodeUnknownEffect(Module)` 只取 `default`**，形态为 `{id: string, effect: fn}` 或 `{id: string, setup: fn}`。Effect Schema 的 Struct 解码默认剥离多余属性，因此 `server` 键不会被解码、更不会被调用。出处：`packages/core/src/plugin/module.ts:60-73,107-115`；`packages/plugin/src/host.ts`。
- `Plugin.define` 的实现体是 `return plugin`，运行时不需要调用它；官方文档「Support V1 and V2」节也把 `{...Plugin.define({id, setup}), server}` 作为标准双形态，并明确 V2 忽略 `server()`。
- `id`：`Plugin.ID = Schema.String.pipe(Schema.brand("Plugin.ID"))`，无 pattern/长度/字符集校验；`plugin.ts` 对重复 id 直接 `Effect.die`，supervisor 侧把重复者标记为 failed（`Duplicate plugin ID: ...`）。插件存储命名空间对 id 做十六进制转义，任意字符串可容纳。出处：`packages/schema/src/plugin.ts:7`；`packages/core/src/plugin.ts:93-97`；`packages/core/src/plugin/supervisor.ts:96-111`；`packages/core/src/plugin/host.ts:564-568`。

### 2.2 自指 import 与 aisdk 工厂（B/D）

- 解析路径（正式版）：`resolveCatalogModel` 见 `Provider.isAISDK(package)` 为真 → `AISDKNative.map` 只识别一组已知 `@ai-sdk/*` 包名（列表见 `aisdk-native.ts` 的 `mapPackage`）→ `file://...` 不命中 → 走 `AISDK.language(model)`：取 `packageName`（剥 `aisdk:`）→ 建 options → 跑 `sdk` hooks（内置插件 `opencode.provider.dynamic`）→ `loadSDKFactory` → 工厂调用 → `sdk.languageModel(modelID)`（hook 可覆盖）。出处：`packages/core/src/model-resolver.ts:192-259`；`packages/core/src/aisdk.ts:249-294`；`packages/core/src/plugin/provider/dynamic.ts`。
- 工厂发现：`loadSDKFactory` 对 `file://` 直载；否则 `npm.add` + 解析入口；`Object.keys(mod).find(name => name.startsWith("create"))` 取**第一个** `create*` 导出（对象键序），因此入口模块新增更早的 `create*` 导出会改变工厂选择——`tests/package-shape.test.ts` 的防回归断言仍然必要。出处：`packages/core/src/plugin/provider/sdk-factory.ts:5-17`。
- 模块实例：`importModule` 在 Bun 运行时就是原生 `import(specifier)`；插件加载器解析出的入口（包主入口 `dist/index.js`）与模块内 `import.meta.url` 一致，宿主的第二次 `import()` 命中同一 URL 缓存。单实例前提成立。出处：`packages/util/src/runtime/import.bun.ts:1-5`；`packages/plugin/src/host.ts` 的 `resolve/load`。
- 实例缓存：`AISDK.locationLayer` 内维护 `languages` / `sdks` 两个 Map；key 是 JSON 序列化（函数按 identity 编号）。language key = `{providerID, canonical, id, modelID, package, settings, headers, body, limit}`；sdk key = 去掉 `id/modelID/limit`。命中即返回，不再执行 `runSDK`/工厂。凭证变化会改变 `settings.apiKey` → 换 key → 重新构造。出处：`packages/core/src/aisdk.ts:194-206,249-294`。
- `prepareOptions`：`name = canonical ?? providerID`；`...settings`（凭证已并入，含 `apiKey`）；`headers`；`body`（经 `mapBodyToProviderOptions` 处理 `reasoning` pro 模式）；`fetch` 换成宿主包装版（合并 `chunkTimeout` 的 SSE 看门、`timeout` 的 `AbortSignal.timeout`；`chunkTimeout` 从 options 删除，`timeout` 保留）。出处：`packages/core/src/aisdk.ts:119-161`。

### 2.3 空壳 config 与凭证可用性（B/E）

- 插件注册路径：`provider.update` 与 `integration.update` 都是 update-or-create（分别以 `Provider.Info.empty(id)`、`{ref:{id,name:id}, methods:[]}` 起手）；`provider.update` 回调后回填 `id`；`model.update` 回调后回填 `id`/`providerID`。出处：`packages/core/src/catalog.ts:92-135`；`packages/core/src/integration.ts:276-308`。
- 可见性判定（`Catalog.provider.available`）：`activation:"disabled"` → 不可用；`"enabled"` → 无条件可用；`"auto"` → 仅当对应 integration（`provider.integrationID ?? providerID`）存在且 `connections.length > 0`，或该 provider 无 integrationID 且查无 integration。integration 连接由「已存凭证 + env 方法命中的进程环境变量」实时计算。出处：`packages/core/src/catalog.ts:67-72`；`packages/core/src/integration.ts:345-357`。
- 空壳的副作用：`opencode.config.provider`（内置、**post** 阶段）对每个 config provider 执行 `provider.activation = "enabled"` 并合并 `settings`，同时为其注册 key 方法（仅当 integration 尚无该方法时）与 `env` 方法。因此：不写空壳 → activation 保持插件写的 `"auto"`（凭证/env 就绪后才可见）；写了空壳 → activation 被覆写为 `"enabled"`（无凭证也可见）。出处：`packages/core/src/config/plugin/provider.ts:20-65`；`packages/core/src/plugin/supervisor.ts:91-95,143-152`。
- 凭证：`connection.active(id)` 返回 `resolveConnections(...)[0]`，顺序 = 已存凭证（active 在前、新的在前）→ env；`connection.resolve` 对 env 返回 `Credential.Key {type:"key"}`；`nativeCredentialSettings` 对 key 凭证给 `{apiKey}`（个别原生包给 authToken/accessToken），并入 aisdk 工厂 options。`/connect` 对 key 方法显示 `method.label ?? "API key"`，并把 label 用作密钥输入提示；credential 未显式传 label 时按 integration ref name 生成（`Command Code (Go)` / `Command Code (Go) 2`…）。出处：`packages/core/src/integration.ts:332-357,662-685`；`packages/core/src/model-resolver.ts:199-224,310-321`；`packages/cli/src/commands/handlers/auth/login.ts:100-140`。

### 2.4 settings 通道（F）

- 回放顺序：supervisor 组装 `ordered = [...pre, ...packages(用户/配置/发现插件), ...post]`；transform 按注册顺序在同一份新状态上回放。`opencode.config.provider` 在 post，用户插件在其之前，因此用户 transform 的草稿里 `settings` 不含 config 值（beta-18684 结论在 2.0.1 依旧成立）。
- 运行时合并：`projectModel` 在每次读目录时把 `provider.settings/headers/body` 深合并进 model；`resolveCatalogModel` 再叠 `credential.metadata`/`configuration`；`prepareOptions` 把 settings 顶层铺进工厂 options——所以 `settings.modelsUrls` 以顶层键出现在工厂入参里，首次工厂调用 `rebindModelsUrls(options.modelsUrls)` 的接线方式仍成立。
- 注意与差异表 #11 联动：工厂调用被缓存，不再保证「逐次重绑」；同一 key 下 `modelsUrls` 只会在该实例构建时绑定一次。配置变更会改变 settings → 换 language key → 重新构造并重新绑定。出处：`packages/core/src/plugin/supervisor.ts:91-95,143-152`；`packages/core/src/config/plugin/provider.ts:41-65`；`packages/core/src/catalog.ts:74-89`；`packages/core/src/aisdk.ts:119-126,249-294`。

## 3. 安装文档事实输入（G）

> 供 `docs/guide/installation.md` 与 README 改写使用；事实均有上列出处，日期 2026-09-12。

### 3.1 宿主判别

- 官方口径：V1 与 V2 **都叫 `opencode`**，默认不再并存安装；V2 的 curl 安装器会替换 V1 二进制（V2 文档 migrate-v1「Install V2」；`https://opencode.ai/v2/docs/migrate-v1/`）。
- 本机实测：`opencode --version` → `opencode v2.0.1`；`opencode -v` 同。
- V1 的 `--version`：v1.18.30 源码用 yargs `.version("version", "show version number", InstallationVersion)`（纯版本字符串输出，形如 `1.18.30`）。**未在本机以 V1 二进制实测**，但判别规则可用「输出以 `opencode v` 开头 → V2」。
- `opencode2` 不是 V2 独有名：`@opencode/cli@2.0.2` 的 bin 同时映射 `opencode` 与 `opencode2` 到同一可执行文件；官方 curl 安装脚本的 `install_legacy_shim` 显式创建 `opencode2`（Linux/macOS 为 `exec "$(dirname "$0")/opencode" "$@"` 的 sh 脚本，Windows 为 .cmd）。本机 `/home/wall/.opencode/bin/opencode2` 与脚本生成内容逐字一致。
- 结论：安装文档不能再以「命令名」判别宿主（`opencode` 已同时属于两代），应改用 `opencode --version` 输出。

### 3.2 命令

- 安装 V2：`npm install -g @opencode/cli`；`bun install -g --trust @opencode/cli`；`pnpm add -g --allow-build=@opencode/cli @opencode/cli`；`yarn global add @opencode/cli`；或 `curl -fsSL https://opencode.ai/v2/install | bash`（postinstall 选择平台原生二进制；Homebrew/AUR/Windows 包管理器不在支持列表）。
- 插件管理：`opencode plugin add <pkg[@ver|tag|range|git-spec]>`；`opencode plugin list [--builtin]`；`opencode plugin check [pkg]`；`opencode plugin update [pkg]`；`opencode plugin remove <pkg>`。
  - `plugin add` 仅接受 npm registry 包或 npm 兼容 Git 规格（`github:...`、`git+ssh://...`、`#branch/tag/commit`、`::path:` 子目录）；本地路径、tarball、npm alias 会被拒；本地路径应直接写进配置。
  - `add/remove` 写**全局配置**的 `plugins` 数组（`resolveConfigPath` 顺序：`opencode.json` → `opencode.jsonc` → `.opencode/opencode.json(c)` → 新建 `opencode.json`）；`list` 需要连接服务端，输出 `ID / VERSION / SOURCE` 三列（ID = 插件 `default.id`，SOURCE = 包名或本地路径；`--builtin` 才显示内置插件）。
  - `check/update` 只针对包插件，跳过本地插件与固定精确版本。
- `opencode models` 的插件可见性在 beta 期实测为「不加载插件」；本次未复核稳定版（见 §4 第 9 条）。安装验证请用 `opencode plugin list` 判成败，不要用 `models`。

### 3.3 配置形状

- V2 原生键 `plugins`：字符串（包名/相对路径/绝对路径/`file://`）或 `{package, options}` 对象；`-` 前缀禁用、`*`/`.*` 通配；相对路径相对**包含该条目的配置文件**解析；自动发现 `.opencode/plugins/`（每 location）与 `<全局 config>/plugins/`；项目根 `plugins/` 目录不会被自动发现。
- `providers.<id>`：`name` / `env` / `package` / `canonical` / `settings` / `headers` / `body` / `models` / `websocket` / `compaction`；`models.<id>`：`modelID` / `name` / `family` / `package` / `settings` / `headers` / `body` / `capabilities` / `compatibility` / `variants` / `cost` / `limit` / `disabled` / `websocket` / `compaction`。
- `$schema` 注意：V2 文档所有示例写 `"$schema": "https://opencode.ai/config.json"`，但 2026-09-12 实测该 URL 返回的仍是 **V1 形状** schema（顶层 `provider`/`plugin`/`npm` 等字段，`additionalProperties: false`，不含 `providers`/`plugins`/`agents`/`permissions`）。编辑器会因此把 V2 原生键标为非法——这是文档与 schema 的现有落差，安装文档提到 `$schema` 时需说明或避免让用户困惑。
- `plugin add` 的包名写法：`@wallbreakerno4/opencode-commandcode`（不带版本即跟 latest）；`plugin remove` 支持带或不带版本/`@` 的同一 target 匹配。

### 3.4 npm 包状态（2026-09-12）

| 包 | latest | 其它 tag | 说明 |
|---|---|---|---|
| `@opencode/cli` | `2.0.2` | `beta` / `dev` / `reserved` | V2 稳定 CLI；bin 同时提供 `opencode` 与 `opencode2`；postinstall 选原生二进制 |
| `@opencode/plugin` | `2.0.2` | `beta 0.0.0-beta-19507`、`dev`、`reserved` | V2 插件 SDK（官方文档口径）；2.0.0 发布于 2026-09-12 |
| `@opencode/ai` / `@opencode/client` / `@opencode/sdk` | `2.0.2` | 同上 | V2 原生 provider 运行时 / 客户端 / SDK |
| `opencode-ai` | `1.18.30` | `beta 0.0.0-beta-202608110357` | V1 CLI（npm 安装线） |
| `@opencode-ai/cli` | `0.0.0-beta-17823` | `beta 0.0.0-beta-19271` | V2 beta 线旧 CLI 包，已被 `@opencode/cli` 取代 |
| `@opencode-ai/plugin` | `1.18.30` | `beta 0.0.0-beta-19271` | V1 插件 SDK；`beta` tag 是旧 V2 beta SDK，不再对应文档案 |

## 4. 待真机验证清单（留给 prototype / 人工验收）

以下问题文档与源码仍答不出，需在 v2.0.1 真机上验证；不做真实 API 调用也能做的项已标注。

1. **无空壳 config 的自举可用性（最高优先）**：配置只写 `plugins: ["@wallbreakerno4/opencode-commandcode"]`、不写 `providers.commandcode-go`，确认：`/connect` 能列出 Command Code (Go)、`/models` 在 env 或凭证就绪后列出模型、发消息端到端跑通。同时验证有空壳时「activation=enabled → 无凭证也可见」的副作用是否可接受。此为安装文档能否删掉空壳步骤的前提。
2. **工厂调用次数与 seam 生命周期**：同一模型的主回复与标题/小任务请求中，`createCommandCode` 实际被调用几次（源码推断为每 key 一次）；`src/provider/model.ts` 的「逐次工厂调用重指向 fetch/headers/logger」在缓存命中时是否仍需要。用插件侧日志即可，无需真实 key 的部分可 mock。
3. **`settings.modelsUrls` 真机行为**：在 transform 草稿打探针确认仍看不到 config settings；确认首次工厂 options 顶层出现 `modelsUrls`，且配置变更后触发重建与重绑。
4. **`/connect` 细节**：方法列表中显示 `Command Code API Key`；存储后的 credential label 实际显示（预期 = integration name）；credential 与 env 同时存在时的优先级（预期 credential 胜）。
5. **`plugin add/list/remove` 本包实测**：`opencode plugin add @wallbreakerno4/opencode-commandcode` → 全局 `plugins` 写入位置与 `plugin list` 三列值（预期 ID=`commandcode-go`、VERSION=包版本、SOURCE=包名）；`remove` 回滚干净。
6. **V1 版本输出**：拿到 1.18.30 二进制后跑 `opencode --version`，确认纯版本号输出（本机只有 V2，未实测）。
7. **官方 `ctx.aisdk` 的去留**：正式插件文档无 aisdk 章节，源码与 SDK 类型仍在。升级 v2.x 时持续监控其是否被文档化/改名/移除；这是本插件主路径的最大上游风险。
8. **双宿主同配置文件共存**：同一份 `~/.config/opencode/opencode.json` 同时含 `plugin`（V1）与 `plugins`（V2）时两宿主各自行为（V2 归一化是否静默、V1 是否报错），覆盖用户真实场景。
9. **`opencode models` 复核**：稳定版 `opencode models` 是否仍看不到插件注册的模型（beta 结论）；若行为已变，安装验证步骤需要相应更新。

## 5. 来源清单（访问日期均为 2026-09-12）

**官方文档与 schema**

- V2 插件指南：https://opencode.ai/v2/docs/build/plugins/（含 Context / Transforms / Integrations / Hooks / Publish / Support V1 节）
- V2 插件迁移：https://opencode.ai/v2/docs/build/plugins/migrate-v1/
- V2 插件配置与 CLI 管理：https://opencode.ai/v2/docs/plugins/、https://opencode.ai/v2/docs/cli/plugins/
- V2 Providers：https://opencode.ai/v2/docs/providers/ ｜ Models：https://opencode.ai/v2/docs/models/ ｜ Config：https://opencode.ai/v2/docs/config/
- V1→V2 迁移：https://opencode.ai/v2/docs/migrate-v1/ ｜ CLI 总览与安装：https://opencode.ai/v2/docs/、https://opencode.ai/v2/docs/cli/
- 文档索引：https://opencode.ai/v2/llms.txt
- OpenAPI：https://opencode.ai/v2/openapi.json（`Provider.Info`、`Model.Info`、`Model.Capabilities`、`Model.Variant`、`Model.Cost`、`Integration.Info/Method/KeyMethod/EnvMethod`、`Config.ProviderEncoded/ModelEncoded`、`Plugin.Info/Source/Features`）
- 配置 schema：https://opencode.ai/config.json（实测为 V1 形状；`https://opencode.ai/v2/config.json` 返回 404）
- 安装脚本：https://opencode.ai/v2/install（`install_legacy_shim` 生成 `opencode2`）

**官方源码（GitHub `anomalyco/opencode`，tag `v2.0.1`，commit `afc3359e`；另引用 V1 tag `v1.18.30`，commit `3104c142`）**

- `packages/core/src/plugin/module.ts:60-73,94-115`（插件模块 decode：`{id, setup|effect}`；入口解析）
- `packages/plugin/src/host.ts`（entrypoints：server/tui/rpc）
- `packages/plugin/src/promise/plugin.ts:56-63`（`Plugin` 接口与 `define` 恒等实现）
- `packages/core/src/plugin/host.ts:169-197,564-568,593-634`（aisdk hook 适配；存储命名空间；integration 方法适配）
- `packages/core/src/plugin/supervisor.ts:91-95,96-111,143-152`（pre → 用户插件 → post 顺序；重复 id）
- `packages/core/src/provider.ts:14-25,77-104,159-181`（`aisdk:` 前缀、旧 scope 迁移、原生包加载）
- `packages/core/src/model-resolver.ts:192-259,310-321`（aisdk 分支、凭证注入）
- `packages/core/src/plugin/provider/sdk-factory.ts:5-17`（`file://` 直载、`create*` 判据）
- `packages/core/src/plugin/provider/dynamic.ts`（内置 `opencode.provider.dynamic`）
- `packages/core/src/aisdk.ts:119-161,194-294,632-773`（工厂 options、sdk/language 缓存、V3 流消费）
- `packages/core/src/aisdk-native.ts:106-131`（已知 AI SDK 包 → 原生包映射表）
- `packages/core/src/catalog.ts:67-72,74-89,92-135,144-145`（可用性、投影合并、update-or-create、reload）
- `packages/core/src/state.ts:150,199-244`（transform/reload 语义）
- `packages/core/src/integration.ts:276-308,332-357,662-685`（integration/method upsert、连接解析、active/resolve）
- `packages/core/src/credential.ts:80-93`（凭证排序：active、创建时间）
- `packages/core/src/config/plugin/provider.ts:20-65,128-132`（config provider 注入：activation/settings/认证方法）
- `packages/core/src/plugin.ts:93-97`（重复插件 id 直接失败）
- `packages/schema/src/plugin.ts:7`、`packages/schema/src/provider.ts:14-69`、`packages/schema/src/model.ts:100-150`（Plugin.ID / Provider.Info / Model.Info 与默认基线）
- `packages/plugin/src/promise/integration.ts:24-56`（key/env/command/oauth 方法类型）
- `packages/util/src/runtime/import.bun.ts:1-5`（`importModule` = 原生动态 import）
- `packages/cli/src/commands/handlers/plugin/add.ts:17-77`、`list.ts:18-95`、`remove.ts`、`check.ts`、`update.ts`（插件管理行为与输出格式）
- `packages/cli/src/commands/handlers/auth/login.ts:100-140`（`/connect` key 方法 label 消费）
- `packages/cli/src/index.ts:95-100`、`packages/cli/src/version.ts`（`--version` 输出来源）
- `packages/core/package.json:111`、`packages/plugin/package.json`（`@ai-sdk/provider@3.0.8`、包名与版本）
- V1 1.18.30：`packages/opencode/src/plugin/shared.ts:270-303`（object 形态 default 的 id/server 校验）、`packages/opencode/src/index.ts`（yargs `.version()`）

**npm registry（只读查询）**

- `https://registry.npmjs.org/@opencode%2fcli`（latest 2.0.2；bin `opencode`,`opencode2`）
- `https://registry.npmjs.org/@opencode%2fplugin`（latest 2.0.2；beta/dev/reserved tag）
- `https://registry.npmjs.org/@opencode%2fai`、`@opencode%2fclient`、`@opencode%2fsdk`（latest 2.0.2）
- `https://registry.npmjs.org/opencode-ai`（latest 1.18.30）
- `https://registry.npmjs.org/@opencode-ai%2fcli`（latest 0.0.0-beta-17823；beta 0.0.0-beta-19271）
- `https://registry.npmjs.org/@opencode-ai%2fplugin`（latest 1.18.30；beta 0.0.0-beta-19271）

**本机只读检查**

- `opencode --version` → `opencode v2.0.1`；`opencode --help` / `opencode plugin --help` / `opencode plugin list --help`
- `/home/wall/.opencode/bin/opencode2`（shim 内容与 curl 安装脚本生成物一致）

**本仓库**

- `src/host/v2.ts`（beta 假设全文）
- `src/index.ts:30,47-51`（入口三键与 `ENTRY_URL`）
- `src/provider/model.ts:9-30,62-87,241-268`（工厂契约与调用节奏假设）
- `src/models/mapping.ts:44-56,78-87`（v2 模型字段映射）
- `tests/package-shape.test.ts`（入口形状防回归断言）
- `package.json`、`pnpm-lock.yaml:115,190`（`@opencode-ai/plugin@beta` / `0.0.0-beta-18866`）
- `docs/dev/research/v2-provider-contract.md`（beta-18414 基线，本文的对照物）
- `docs/dev/spec/model-pipeline.md` §1.3/§3（modelsUrls 通道与消费映射）
- `docs/guide/installation.md`、`README.md`（待改写的安装文档）

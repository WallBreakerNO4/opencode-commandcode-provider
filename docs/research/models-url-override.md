# 产物 URL 列表用户覆盖机制：v1/v2 配置通道查证与键形状建议

> 调研问题：`docs/spec/model-pipeline.md` §1.3 与 CONTEXT.md「默认 URL 列表」词条承诺构建产物拉取列表「用户配置可覆盖」，但覆盖机制未定案——写入位置、键形状、值如何到达插件进程均无规格。
> 对应工单：[#24 产物 URL 列表用户覆盖机制](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/24)（#17 复审轮判为实现路径未决项）。
> 调研日期：2026-09-02。方法：shallow clone 一手源码逐行核对（v1 tag `v1.18.25` commit `cb7d8b2f`；v2 beta 分支 HEAD `5894e466`，2026-08-31 23:35 +0800），本机安装的 opencode 即 1.18.25 可交叉验证。已核对 v1.18.21→v1.18.25 相关文件 diff（差异仅在 Azure/Cloudflare 加载器与 v2 兼容外壳，本主题机制不变）与 90fb6562（`session-visibility.md` 所引快照）→5894e466 的 5 个关键文件 diff（零变化，无 beta 漂移）。全文只读调查。

## 0. 裁决速览

| 问题 | 裁决 | 最强证据 |
|---|---|---|
| v1：用户 provider 块与插件 config hook 注入如何合并 | **宿主不做裁决**——hook 拿到唯一的活配置对象原地修改，Provider state 明确「先跑 hook、后读 `cfg.provider`」；用户块与注入块谁胜由插件自己的合并代码决定（应非破坏合并、用户键胜） | v1 `plugin/index.ts:245-253`、`provider.ts:1436-1440` |
| v1：用户自定义字段可达位置 | 经 `options` 通道：`provider.<id>.options.<自定义键>` 能穿过 schema 解码、进 provider state、并经 `{name, ...options}` 全量透传到工厂 | v1 `core/src/v1/config/provider.ts:90-124`、`parse.ts:40-44`、`provider.ts:1733,1852-1856` |
| v2：空壳 `{}` 内加字段可读吗 | 顶层自定义键**被剥离**（封闭 schema + `onExcessProperty: "ignore"`）；但 `settings` 是 `Record(String, Json)` 任意 JSON 保留，`settings.<自定义键>` 经内置 transform → catalog → 请求时 `prepareOptions` 展开进工厂 options | v2 `schema/src/config/provider.ts:8-14,59-65`、`core/src/config.ts:95-96`、`core/src/aisdk.ts:119-126` |
| v2：第二通道 | 有两处：`ctx.options`（`plugins` 数组对象形式 `{package, options}`，setup 时即可读）；catalog 读接口 `provider.get()`（读 transform 回放后的提交态）。integration 不承载配置 | v2 `plugin/src/promise/plugin.ts:28`、`config/plugin/source.ts:111`、`plugin/src/promise/catalog.ts:15` |
| 环境变量统一通道 | **可行**：v1/v2 插件与 provider 包都是宿主进程内动态 import，`process.env` 天然共享，两宿主零差异；与 testing.md §3 禁令不冲突（禁的是测试专用后门，这是用户配置面） | v1 `provider.ts:1850`；v2 `plugin/provider/sdk-factory.ts:12-14` |
| 键形状 | **整列表替换**：键名统一 `modelsUrls`，值 = http(s) URL 字符串数组（兼容逗号分隔字符串）；v1 写 `provider.commandcode-go.options.modelsUrls`，v2 写 `providers.commandcode-go.settings.modelsUrls`，环境变量 `COMMANDCODE_MODELS_URLS` 作统一兜底通道；优先级 config > env > 默认。非法值逐项丢弃 + warn，整体非法回退默认列表 + warn，**不阻断启动**；覆盖语义不做新鲜度仲裁，快照兜底不变 | 本报告 §4/§5 |

---

## 1. v1 事实（tag v1.18.25，commit `cb7d8b2f`）

### 1.1 config 文件层之间：remeda `mergeDeep` 深合并

多份 config 文件（全局 → `OPENCODE_CONFIG` → 项目级 → managed/MDM）逐层 `mergeConfig = mergeDeep(target, source)`：递归深合并、后加载者逐字段胜、**数组整体替换**（唯一例外 `instructions` 拼接去重，`mergeConfigConcatArrays`）。见 `packages/opencode/src/config/config.ts:42-52`、`272-288`、`365-367`。

### 1.2 用户 config 与插件 config hook 之间：没有宿主级合并，裁决权在插件

- config hook 的调用点在插件状态初始化时：`hook.config?.(cfg)`（`packages/opencode/src/plugin/index.ts:245-253`），`cfg` 是 `config.get()` 返回的缓存对象（`config.ts:600-603`，`get` 直接返回 `s.config`）。
- Provider state 构建**先触发插件加载**再读 provider 配置，宿主源码自带注释定案：

  ```ts
  // load plugins first so config() hook runs before reading cfg.provider
  const plugins = yield* plugin.list()
  // now read config providers - includes any modifications from plugin config() hook
  const configProviders = Object.entries(cfg.provider ?? {})
  ```

  （`packages/opencode/src/provider/provider.ts:1436-1440`；`cfg` 在 1399 行取自同一 `config.get()` 缓存——hook 的原地修改对 Provider state 可见，与 #11 实测一致。）

- 因此**不存在宿主级「对象级谁胜 / 字段级深合并」**：hook 看到的 `cfg.provider["commandcode-go"]` 已经是用户 config 全层合并后的结果，hook 自己决定怎么写这个键。若插件整块赋值就会踩掉用户字段——所以「用户块胜、插件只补缺」必须是插件 glue 的合并策略（Breskott 参考实现同口径，见 `docs/research/reference-projects.md` §三）。

### 1.3 schema 解码：哪些用户自定义字段能活下来

config 文件经 Effect Schema 解码，全局选项 `onExcessProperty: "ignore"`（`packages/opencode/src/config/parse.ts:40-44`）——**未知键静默剥离**（effect 官方 SCHEMA.md：`ignore` 丢弃、`preserve` 保留；storage.ts 对 session 数据用 `preserve`、config 刻意用 `ignore`，`storage.ts:101,146`）。

由此（`packages/core/src/v1/config/provider.ts`、`core/src/v1/config/config.ts`）：

| 写入位置 | 解码后命运 | 依据 |
|---|---|---|
| config 顶层自定义节点（如 `"commandcode": {...}`） | ❌ 剥离 | `ConfigV1.Info` 是裸 `Schema.Struct`，无 rest（config.ts:32） |
| `provider.<id>.<顶层自定义键>`（如 `modelsUrls` 直接写在 provider 块下） | ❌ 剥离 | `ConfigProviderV1.Info` 是裸 `Schema.Struct`：`api/name/env/id/npm/whitelist/blacklist/options/models` 之外全剥（provider.ts:82-126） |
| **`provider.<id>.options.<任意键>`** | ✅ 保留 | `options = Schema.StructWithRest(Struct({apiKey, baseURL, enterpriseUrl, setCacheKey, timeout, headerTimeout, chunkTimeout}), [Schema.Record(String, Any)])`——rest 捕获的键不是 excess（provider.ts:90-124；effect SCHEMA.md StructWithRest 语义） |
| `provider.<id>.models.<mid>.options` | ✅ 保留 | `Schema.Record(String, Any)`（provider.ts:67） |
| `provider.<id>.models.<mid>.variants.<名>.<任意键>` | ✅ 保留 | `StructWithRest` + rest（provider.ts:69-79） |
| **`plugin: [[pkg, {任意键}]]` 插件级 options** | ✅ 保留 | `Spec = Union([String, Tuple([String, Record(String, Unknown)])])`（`core/src/v1/config/plugin.ts`） |

注意：config hook 收到的是**解码后**的对象——被剥离的字段 hook 也读不到。v1 用户自定义数据的合法落点就是 `options`（以及模型级 `options`/`variants`、插件级 tuple options）。

### 1.4 自定义字段到达工厂：`{name, ...options}` 全量透传

`resolveSDK`（`packages/opencode/src/provider/provider.ts:1730-1858`）：

- 1733 行 `const options = { ...provider.options }`——provider state 的 options 全量拷贝。provider state 构建时 config 条目按 `options: mergeDeep(existing?.options ?? {}, provider.options ?? {})` 并入（1484 行；本 provider 不在 models.dev 目录，existing 为空）。
- 随后宿主叠加 `baseURL`/`apiKey`（`options.apiKey === undefined && provider.key` 时注入，1777 行——auth > env 的凭证流，#11 定案）、`headers`（1778-1782 行）、超时与 `fetch` 包装（1794-1825 行）——**只动已知键，不删自定义键**。
- npm 包加载后工厂调用（1850-1856 行）：

  ```ts
  const mod = await import(importSpec)
  const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
  const loaded = fn({ name: model.providerID, ...options })
  ```

  #11 实测的 `{name, apiKey, headers, fetch}` 是当时 options 只有那些键的形状；`...options` 展开意味着**用户写在 `options` 里的任意自定义键同样到达工厂**。

### 1.5 v1 通道小结

用户覆盖值到达插件的三条已验证通路：

1. **config hook 读取**：hook 在注入 provider 块前可读 `cfg.provider["commandcode-go"]?.options?.modelsUrls`（1.3 schema 保留 + 1.2 时序保证）；这是 v1 glue 已要实现的注入点，顺路读取零新增机制。
2. **工厂 options**：同一自定义键经 `{name, ...options}` 透传给 `create*` 工厂（1.4），v1/v2 工厂读法可统一（见 §2.3/§4）。
3. **插件级 options**：`plugin: [["@wallbreakerno4/opencode-commandcode", { modelsUrls: [...] }]]` → `server(input, load.options)`（`plugin/index.ts:118`、`config/plugin.ts:36-38`、`loader.ts:79`）。可用，但要求用户把 `plugin` 数组项从字符串改成二元组，可发现性差，只作备选记录。

另有全文级 `{env:VAR}` 替换先例：`{env:...}`/`{file:...}` 在 JSONC 文本上正则替换后才解析（`packages/opencode/src/config/variable.ts:27-29`），任何字符串值可引用环境变量。

---

## 2. v2 事实（beta HEAD `5894e466`，2026-08-31；90fb6562 → 5894e466 五个关键文件零 diff）

### 2.1 空壳 `{}` 内加字段：顶层键被剥离，`settings` 保留

- v2 config 解码同样是 Effect Schema + `onExcessProperty: "ignore"`（`packages/core/src/config.ts:95-96`）。
- `providers.<id>` 条目 schema 是封闭的 Effect Schema Class（`packages/schema/src/config/provider.ts:59-65`）：只有 `name / env / package / settings / headers / body / models`。空壳里写顶层自定义键（`{"providers": {"commandcode-go": {"modelsUrls": [...]}}}`）**被剥离**。
- `settings` 字段类型是 `JsonRecord = Schema.Record(Schema.String, Schema.Json)`（同文件 8、11 行）——**任意 JSON 值（含字符串数组）原样保留**。`{"providers": {"commandcode-go": {"settings": {"modelsUrls": [...]}}}}` 能穿过解码。

### 2.2 settings 的下落：内置 transform 合并进 catalog，请求时展开进工厂 options

完整链路（全部源码定位）：

1. **config → catalog**：内置插件 `opencode.config.provider` 的 transform 把每个 config provider 条目合并进目录——`provider.settings = Provider.mergeOverlay(provider.settings, item.settings)`（`packages/core/src/config/plugin/provider.ts:51`；同函数还设 `activation = "enabled"`、name/package/headers/body，并从 `env` 注册 integration env method——这正是 #12 空壳必填的机制根源：config 之外新建的 provider 拿不到 `activation = "enabled"`，`catalog.ts:67-72` 的 `available()` 判定不过）。
2. **catalog → Model.Info**：`projectModel` 把 `provider.settings` 与 `model.settings` overlay 合并进每个模型（`packages/core/src/catalog.ts:74-82`）。
3. **Model.Info → 工厂 options**：aisdk 加载时 `prepareOptions` 构造 `options = { name: model.providerID, ...(model.settings ?? {}), headers: model.headers, body: projected.body }` 并包上 fetch/超时（`packages/core/src/aisdk.ts:119-126`），经 `runSDK({model, package, options})` 交给 hooks（279 行）。
4. **默认 sdk hook → 工厂**：内置 `opencode.provider.dynamic` 插件注册 `aisdk.hook("sdk")`：无人接管时 `loadSDKFactory(npm, evt.package)` 动态 import 包模块、找第一个 `create*` 导出、以 **`evt.options`** 为唯一实参调用（`packages/core/src/plugin/provider/dynamic.ts:10-16`、`sdk-factory.ts:6-18`）。

结论：**用户写在 `providers.commandcode-go.settings` 里的自定义键，以顶层键身份出现在工厂 options 里**（`options.modelsUrls`），与 `apiKey`/`headers` 同层——#12 实测的 `{name, apiKey, headers, body, fetch}` 是无自定义 settings 时的形状，`...(model.settings ?? {})` 展开是自定义键的传输机制。`aisdk.hook("sdk")` 的插件侧读法等价（`evt.options` 即同一对象）。

### 2.3 时序：transform 回放顺序与读取时机

- 插件代际顺序 = 内部 pre → **外部插件（packages/本地/npm）** → 内部 post（`packages/core/src/plugin/supervisor.ts:76-81`、`107-119`；`opencode.config.provider` 在 post，`plugin/internal.ts:278`）。transform 按插件加载顺序回放（`docs/research/opencode-plugin-provider.md` §2.3）→ **外部插件（本插件）的 transform 回放时，config 的 settings 尚未合并**。
- 但这不构成障碍：工厂调用发生在模型请求时（全部 transform 已回放并提交），此刻 `prepareOptions` 里的 settings 已就位；插件侧如需在请求前读取，可用 catalog 读接口 `ctx.catalog.provider.get("commandcode-go")`（`packages/plugin/src/promise/catalog.ts:15`；实现在 `catalog.ts:146-148`，读 transform 回放后的提交态）或等 `Catalog.Event.Updated` 事件。v2 glue「快照先行 + 后台拉产物 + reload」的既定节奏不受影响。

### 2.4 第二通道与排除项

- **`ctx.options`**（promise 风格 ctx 必有字段，`packages/plugin/src/promise/plugin.ts:28`，类型 `Readonly<Record<string, any>>`）：来自 `opencode.json` 的 `plugins` 数组对象形式 `{ "package": "...", "options": {...} }`（`config/plugin/source.ts:111`；字符串形式条目 options 为 `{}`，113 行）。官方插件文档明载此形式（`docs/research/opencode-plugin-provider.md` §2.1 引）。setup 时即可读，早于一切 transform 回放。代价：`opencode2 plugin add` 写入的是字符串形式，用户需手工改成对象形式。
- **integration**：只承载认证方法与连接（key/env/oauth），无用户配置承载位（`config/plugin/provider.ts:20-38`、`docs/research/opencode-plugin-provider.md` §2.6）。
- **`ctx.storage`**：插件私有持久化 JSON，不是用户配置面，排除。
- catalog 草稿读接口 `provider.get/list` 在 transform 内可用（`catalog.ts:90-91`），但因 2.3 的回放顺序，transform 内读到的是 settings 合并前的状态——读取时机必须在工厂/请求/事件侧，不在自家 transform 内。

### 2.5 v2 通道小结

- 主通道：`providers.commandcode-go.settings.modelsUrls`（空壳加 settings，不破坏 #12 的空壳承诺，`{}` → `{ "settings": { ... } }`）→ 工厂 `options.modelsUrls`。
- 备选：`plugins` 对象形式 → `ctx.options.modelsUrls`（setup 时可读，但要求用户手改 plugins 数组形状）。
- 顶层空壳自定义键不可行（剥离），无须再测。

---

## 3. 环境变量统一通道（`COMMANDCODE_MODELS_URLS`）

### 3.1 可达性：v1/v2 插件均在宿主进程内，`process.env` 天然共享

- v1：外部插件经 `PluginLoader.loadExternal` 动态 import 进宿主进程（`plugin/index.ts:186-218`、`applyPlugin` 114-125 行）；provider npm 包同样 `await import(importSpec)` 进程内加载（`provider.ts:1850`）。
- v2：插件由 supervisor 在宿主 Effect 运行时内激活（`supervisor.ts:101-121`）；aisdk 包经 `importModule(...)` 进程内加载（`sdk-factory.ts:12-14`）。
- 宿主自身大量直读 `process.env`（如 `core/src/flag/flag.ts` 的 `OPENCODE_CONFIG` 等），并存在「Env.set 只更新浅拷贝、需直读 process.env」的源码注释（`provider.ts:319-322`）——进程内共享 env 是宿主自己依赖的行为。

⇒ 插件代码里 `process.env.COMMANDCODE_MODELS_URLS` 在 v1/v2 语义完全一致：读宿主进程继承的环境变量（用户 shell / 启动器注入）。无配置落点差异、无 host 形状差异，是**唯一零分支覆盖两宿主的通道**。已知边界：GUI 桌面应用启动的 opencode 可能不继承 shell env（macOS/Windows 图形启动惯例），此类用户应走 config 通道——报告中标注为文档注意项。

### 3.2 与 testing.md §3 禁令的边界

§3 禁止的是「生产代码自定义**测试专用**环境变量（base URL 覆盖、行为开关等）」；判定轴是「该变量为谁存在」。`COMMANDCODE_MODELS_URLS` 是面向用户的分发配置（README 公开记载），与 `COMMANDCODE_API_KEY`（#12 v2 integration env method 已定案使用）同性质同前缀，不在禁令内。配套纪律：**测试不使用该变量**——集成测试的 URL 指向继续走既有定案通道（工厂 `options.fetch` 接缝 + 本地 fixture server，testing.md §2），URL 列表解析函数以参数注入直测，保证「变量存在 ≠ 测试后门」。

### 3.3 机制先例一致性

| 先例 | 语义 | 出处 |
|---|---|---|
| v1 `provider.<id>.env: [...]` → 工厂 apiKey | 环境变量作凭证来源，优先级 auth/credential > env | #11 实测定案 |
| v2 integration env method `names: [...]` | 同上 | #12 实测定案 |
| v1 google-vertex `options.project ?? env["GOOGLE_VERTEX_PROJECT"] ?? ...` | **显式 config 优先、env 兜底**——与本项目推荐优先级一致 | `provider.ts:509-514` |
| v1/v2 config 全文 `{env:VAR}` 替换 | config 内可显式引用环境变量 | v1 `variable.ts:27-29`；v2 `config/variable.ts:26-33` |
| 宿主级 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` 等 | 宿主接受环境变量作配置输入的既有惯例 | v1 `flag.ts:21-22`；v2 `config.ts:252-263` |

---

## 4. 键形状建议

### 4.1 语义：整列表替换（推荐）vs 追加/插位（否决）

- **推荐：整列表替换**。用户提供的有序列表**完整取代**内置默认列表（Release → npmmirror → unpkg → raw），按序尝试、首个成功者胜的级联语义不变；包内快照不占 URL 位，仍是失败兜底层（与 §1.3/§5 现有承诺零冲突）。
- 追加/插位（用户列表插到默认列表前/后）否决理由：
  1. **表达力缺口**：插位永远无法表达「只用自建镜像、不许打 github.com/unpkg」——这是替换语义免费覆盖的真实场景（隐私/内网约束）；两种语义并存则一个键两种含义，文档与排错成本翻倍。
  2. **可审计性**：替换语义下「我实际会打哪些 URL」= 用户写的列表，一目了然；插位语义需要脑内拼接两份列表推演生效顺序。
  3. 冗长代价用文档配方消化：README 直接给「大陆重排版」四行现成列表（npmmirror 提前）供复制粘贴，真实主场景（大陆用户）的配置成本降为一次粘贴。
- 键形状：值 = http(s) 绝对 URL 字符串数组（`string[]`）；同时接受逗号分隔的单个字符串（与 env var 形状共用同一解析器，config 里手写 JSON 数组或引用 env 均可）。键名统一 `modelsUrls`。

### 4.2 写入位置与优先级

| 宿主 | config 写法 | 到达点 |
|---|---|---|
| v1 | `provider.commandcode-go.options.modelsUrls: [...]`（user opencode.json；v1 glue 的 config hook 注入 provider 块时必须非破坏合并，用户键胜——§1.2） | 工厂 `options.modelsUrls` + config hook 直读（§1.5） |
| v2 | `providers.commandcode-go.settings.modelsUrls: [...]`（空壳升级为 settings 壳，#12 空壳承诺不破坏） | 工厂 `options.modelsUrls` / 请求时 catalog 读（§2.2/2.5） |
| 两宿主统一 | 环境变量 `COMMANDCODE_MODELS_URLS=https://a.json,https://b.json`（逗号分隔） | 插件进程内直读（§3.1） |

优先级：**config > env > 默认列表**。理由：v1 宿主自带同构先例（`options.project ?? env[...]`，§3.3）；config 是逐项目可版本化的显式声明，env 是进程级兜底；两者都缺失时用内置默认列表。非法值按 4.3 逐级回退（config 非法 → 试 env → 仍非法 → 默认列表，每级 warn）。

### 4.3 非法值处理：回退默认列表 + warn，不阻断启动（评估结论：采纳）

- **评估**：采纳「回退 + warn、不阻断」。理由：① 覆盖是可选增强，配置笔误不应升级成「provider 整体不可用」——URL 列表解析处在模型注册的必经路径上，硬失败等于把最坏失败模式（无模型可用）交给一个逗号；② warn 而非静默回退，保证问题可发现；③ 与两宿主自身的容错惯例同构——v1 config hook 抛错被宿主 log 后吞掉（`plugin/index.ts:246-252` `Effect.tapError(logError) + Effect.ignore`），v2 config 文档解析失败是 logWarning + 跳过该文档（`config.ts:100-127`），两宿主都不因配置问题炸启动。
- 具体规则（建议条款）：逐项校验——每项必须是 `new URL()` 可解析且协议为 `http:`/`https:` 的绝对 URL；非法项丢弃并逐项 warn；值为非数组/非字符串/合法项为零时，整体回退默认列表并 warn 一次（注明原始值）；解析在插件侧进行，不依赖宿主校验。
- warn 通道：v1 用 `client.app.log`（PluginInput 必带 client，`plugin/index.ts:146-151`；Breskott 同款），取不到时 `console.warn` 兜底；v2 插件 ctx 无 log 域（`plugin/src/promise/plugin.ts:25-51` 全字段核对），用 `console.warn`（宿主进程 stderr）。解析成功时以 debug/info 打一行「生效的 URL 列表 + 来源（config/env/default）」，支撑排错。

### 4.4 与新鲜度 SLA 的交互

- SLA ≤30 分钟（#10 定案，`model-pipeline.md` §3 暴露规则使产物陈旧成为正确性问题）约束的是**我方发布管线与默认渠道**。用户覆盖渠道不在 SLA 内：存活但滞后的自建/第三方镜像会赢下级联（「首个成功者胜」不检查新鲜度），后果 = §3 暴露规则下新模型对用户静默隐藏（存量模型不受影响；快照只在**失败**时兜底，不对抗**滞后**）。
- **覆盖语义不做新鲜度仲裁**（否决跨渠道比新鲜度方案）：任何仲裁都要求每轮额外拉取至少第二个渠道做对比——流量翻倍、破坏「首个成功者胜」的可审计简单性，且仍无法得知「真 latest」（默认渠道自身也可能滞后，比出来的「更新」不可信）。曾考虑「与包内快照比 `generatedAt`，快照更新则 warn」：快照新鲜度锚定插件发版而非上游发版，误报/漏报都不收敛，放弃。
- 缓解改为文档与日志：README 覆盖章节明示「用户渠道无新鲜度保证，滞镜像 = 新模型延迟可见」；生效列表与每次产物拉取的 `generatedAt`/`sourceCliVersion` 落 debug/info 日志（§4.3），用户可自查镜像滞后。

---

## 5. 供 #17 复审拍板的建议规格草案

以下为候选文本，拍板后回填 `docs/spec/model-pipeline.md` §1.3 与 CONTEXT.md「默认 URL 列表」词条（本票不改任何规格文件）。

### 5.1 `model-pipeline.md` §1.3 增补条款（候选）

> - 客户端按**有序 URL 列表**拉取产物：代码内置默认列表（#10 定案），用户配置可覆盖；按序尝试，首个成功者胜。
> - **覆盖机制**（键名统一 `modelsUrls`，值 = http(s) URL 有序列表，接受字符串数组或逗号分隔字符串）：
>   - v1：用户 `opencode.json` 的 `provider.commandcode-go.options.modelsUrls`；v1 config hook 注入 provider 块时必须非破坏合并，用户已写键优先。
>   - v2：用户 `opencode.json` 的 `providers.commandcode-go.settings.modelsUrls`（空壳升级为 settings 壳）；值经宿主内置 transform 进入目录并在工厂 options 中以顶层键出现。
>   - 统一环境变量兜底：`COMMANDCODE_MODELS_URLS`（逗号分隔），v1/v2 插件进程内直读。优先级 config > env > 默认列表。该变量是用户配置面，非测试通道；测试仍经工厂 `options.fetch` 接缝注入（testing.md §2/§3）。
>   - **语义为整列表替换**：不与默认列表拼接、不提供插位；包内快照不占列表位，仍是失败兜底层。
>   - **非法值处理**：逐项校验（可解析且 http/https 的绝对 URL），非法项丢弃 + 逐项 warn；非数组或合法项为零时整体回退默认列表 + warn；任何情况下不阻断启动。解析结果与来源（config/env/default）打日志。
>   - **新鲜度边界**：≤30 分钟 SLA 只约束默认渠道的发布管线；用户覆盖渠道无新鲜度保证，存活但滞后的镜像会按首个成功者胜持续生效（新模型延迟可见，存量不受影响），客户端不做跨渠道新鲜度仲裁。

### 5.2 CONTEXT.md「默认 URL 列表」词条修订（候选）

> **默认 URL 列表**:
> 客户端内置的构建产物拉取地址序列，按序尝试、首个成功者胜；用户可经 v1 `provider…options.modelsUrls` / v2 `providers…settings.modelsUrls` / 环境变量 `COMMANDCODE_MODELS_URLS` 以**整列表替换**方式覆盖（config > env > 默认），非法值回退默认列表并告警、不阻断启动。包内快照独立于列表，始终是最后兜底层。
> _Avoid_: 源列表、fallback 链、URL 追加/插位

### 5.3 留给 #17 复审的拍板点

1. 键形状采纳「整列表替换」（4.1）还是仍要插位语义——本报告建议替换，配方进 README。
2. 环境变量是否纳入规格正文（4.2/5.1）——本报告建议纳入并写明「非测试通道」边界，防 #20 禁令误读。
3. 4.3 的非法值条款（逐项丢弃 vs 整体回退的取舍）是否照抄。

## 6. 不确定与未决点

- v1 `/connect`、`opencode auth login` 等交互路径下的 config hook 重跑行为未逐路径验证（config hook 至少在实例插件状态初始化时运行一次且先于 Provider state 构建，`provider.ts:1436-1440` 已源码定案；config invalidate 后的 hook 重跑时序未查，不影响本报告结论——覆盖值的读取点在工厂/请求侧，不依赖 hook 重跑）。
- v2 `plugin add` CLI 写入的 plugins 条目形状未实测（源码 `source.ts:113` 表明字符串形式 options 恒为 `{}`；对象形式需用户手改 config，官方文档已明载该形式）。
- GUI 桌面端启动时 shell 环境变量继承程度属操作系统惯例，未实测；env 通道在该场景可能不可用，config 通道不受影响（§3.1 已列为文档注意项）。
- 工厂 options 中 settings 自定义键与宿主保留键（`name/fetch/timeout/chunkTimeout` 等）理论可撞名——config 值均为 JSON 标量/数组，撞 `fetch`（需函数）不成立，撞 `name` 属用户误用，规格不设防。

## 7. 引用清单

**v1（tag v1.18.25 `cb7d8b2f`；v1.18.21 相关文件 diff 已核对，机制不变）**

- `packages/opencode/src/config/config.ts:42-52`（mergeDeep 层间合并、instructions 拼接例外）、`:272-288,365-367`（文件层加载序）、`:600-603`（get 返回缓存对象）
- `packages/opencode/src/config/parse.ts:35-44`（`onExcessProperty: "ignore"`）
- `packages/opencode/src/config/variable.ts:27-29`（`{env:}` 全文替换）
- `packages/opencode/src/config/plugin.ts:36-38`（插件 tuple options 提取）；`packages/core/src/v1/config/plugin.ts`（Spec = String | [String, Record]）
- `packages/core/src/v1/config/config.ts:32`（顶层 Info 裸 Struct）、`packages/core/src/v1/config/provider.ts:13-80,67,69-79,82-126`（provider/model schema：options 与 variants 的 StructWithRest rest 保留）
- `packages/opencode/src/plugin/index.ts:114-125`（server(input, options)）、`:146-151`（client 注入）、`:245-253`（config hook 调用）、`:284-297`（trigger 机制，config hook 不走 trigger）
- `packages/opencode/src/provider/provider.ts:1399,1436-1440`（先插件后读 cfg.provider 的宿主注释与实现）、`:1477-1484`（config provider options 深合并进 state）、`:1730-1733,1755-1777`（resolveSDK options 构造）、`:1850-1856`（`fn({name, ...options})`）、`:509-514`（google-vertex config ?? env 先例）、`:319-322`（process.env 直读注释）
- effect Schema 语义：effect 官方 SCHEMA.md（onExcessProperty ignore=丢弃 / preserve=保留；StructWithRest rest 键属 schema 本体）——经 Context7 `/effect-ts/effect` 核对

**v2（beta 分支 HEAD `5894e466`，2026-08-31 23:35 +0800；90fb6562 → HEAD 五文件零 diff）**

- `packages/core/src/config.ts:95-96`（解码选项）、`:129-136`（loadFile + `{env:}` 替换）、`:100-127`（解析失败 logWarning + 跳过）
- `packages/core/src/config/variable.ts:26-33`（`{env:}` 全文替换）
- `packages/schema/src/config/provider.ts:8-14,59-65`（ConfigProvider.Info 封闭 Class、settings = JsonRecord）
- `packages/core/src/config/plugin/provider.ts:20-38`（env → integration method）、`:41-54`（config providers 合并进 catalog，settings mergeOverlay）、`:108-112`（configuredProviders）
- `packages/core/src/catalog.ts:67-72`（available 判定）、`:74-82`（projectModel settings 叠加）、`:84-136`（Draft provider.get/list/update）、`:146-148`（提交态读接口）
- `packages/core/src/plugin/internal.ts:236-282`（pre/post 内部插件表，ConfigProviderPlugin 在 post）、`packages/core/src/plugin/supervisor.ts:76-81,101-121`（pre → 外部 → post 代际顺序）
- `packages/core/src/aisdk.ts:119-126`（prepareOptions：settings 展开）、`:249-292`（language/runSDK 传 options）
- `packages/core/src/plugin/provider/dynamic.ts:6-17`、`sdk-factory.ts:6-18`（默认 sdk hook：import 包、create 工厂、evt.options 实参）
- `packages/plugin/src/promise/plugin.ts:25-63`（ctx 全字段、无 log 域）、`packages/plugin/src/options.ts`（PluginOptions）、`packages/plugin/src/promise/catalog.ts:13-17`（catalog 读接口）、`packages/core/src/config/plugin/source.ts:111-113`（plugins 对象形式 options）、`packages/schema/src/provider.ts:32`（Provider.Info.settings）

**既有定案引用**：#10（默认列表与 SLA）、#11（v1 工厂/凭证实测）、#12（v2 空壳与 credential > env）、`docs/research/opencode-plugin-provider.md`（§2.1 plugins 对象形式、§2.3 transform 回放顺序、§2.6 integration）、`docs/research/reference-projects.md` §三（Breskott 非破坏合并先例）、`docs/spec/model-pipeline.md` §1.3/§3/§4、`docs/spec/testing.md` §2/§3、CONTEXT.md「默认 URL 列表」。

# 模型管线规格：发现来源、构建产物 schema 与运行时合并级联

> 状态：定稿（2026-10-21，发现机制迁移至 `view=client` catalog）。决策票：[#61](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/61)（规格，含 2026-10-20 勘误评论）、[#62](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/62)–[#64](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/64)（实现）、[#65](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/65)（文档收口）；取舍见 `docs/dev/adr/0005-model-discovery-client-catalog.md`。
> 事实输入：`docs/dev/research/model-metadata-sources.md`、`docs/dev/research/plan-model-mapping.md`、#61 正文与勘误评论（2026-10-20 实测）。
> 范围：模型管线模块的两侧契约——构建侧来源与 Go plan 过滤、构建产物 schema、客户端运行时合并级联与降级。分发渠道选型、GitHub Action 实现、伪装层由其他票承接，本文只约束与它们的接口。
> 历史说明：旧版规格（2026-08-29）把普通 `GET /provider/v1/models` 当作发现权威。官方 CLI 1.84.0 起运行时改用 `GET /provider/v1/models?view=client`，普通端点在官方源码中已零引用；本文描述迁移后的终态，普通 `/models` 端点不再出现在本管线的任何来源中。

## 0. 数据来源与角色

**发现权威分两层**：构建侧是 `view=client` catalog（辅以内嵌目录补集），运行时是构建产物全集。client catalog 在运行时只作 `context` / `name` 的字段级权威，不参与「暴露哪些 id」的判定。

| 来源 | 角色 | 参与时机 |
|---|---|---|
| `GET https://api.commandcode.ai/provider/v1/models?view=client`（client catalog） | 构建侧发现权威：id 集合、`name` / `display.label`、`context_length`、`minimumPlan`、`hidden`、`reasoningEfforts`、`inputModalities`、`maxOutputTokens`；运行时 `context` / `name` 的字段级权威 | 构建每次拉取；运行时匿名拉取，节奏跟随响应 `refreshAfterSeconds` |
| 官方 CLI 包内嵌目录（npm `command-code` tarball 的 `dist/cli.mjs`） | 构建侧补集来源：只补 client catalog 缺失、但官方内嵌目录中 Go 可见的条目（`stealth/cat-jam:free` 为首案） | 仅构建侧，软兜底；下载 / 解包 / 解析任一失败只告警，不阻塞发布 |
| models.dev（`api.json`） | limits 补全源：catalog 缺 `context_length` / `maxOutputTokens` 的模型用其 `limit.context` / `limit.output` 补齐 | 仅构建侧拉取与匹配，不进运行时级联 |
| 构建产物 | 运行时发现权威：注册哪些模型（Go 过滤已在构建侧完成） | 运行时按有序 URL 列表拉取，TTL 1h + 抖动 |
| 包内快照 | 与构建产物同 schema 的「最后已知良好产物」，随插件发版内置 | 运行时兜底，永远可用 |

补充约束：

- **构建输入链**：npm registry 版本检测（触发器，`sourceCliVersion` 由此而来）+ `view=client`（硬依赖）+ models.dev（limits 补全）+ tarball 内嵌目录（可选补集）。tarball 只做文本解析，绝不执行包内代码；解包动作绝不发生在用户机器上。
- **运行时只有两层来源**：client catalog × 产物角色（构建产物、内存中的上次成功产物或包内快照）。models.dev 只在构建侧参与；efforts 与 modalities 不采用 models.dev（档位只认官方目录；模态按「网关可投递」口径，见 §1.1）；价格已砍出 v1。
- **普通 `/models` 端点退役**：不再用于发现、对账或 `context` 取值。client catalog 无 `created` 字段，旧变更签名中的 `created` 剔除规则随之消亡。
- **当前实例（2026-10-20 实测）**：client catalog 102 条，`minimumPlan === "individual-go"` 且非 `hidden` 58 条；内嵌目录补入 `stealth/cat-jam:free` 后产物 59 条。计数随官方目录变化，不写进契约。

## 1. 构建产物 schema v1

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-20T00:00:00Z",
  "sourceCliVersion": "1.84.0",
  "catalogVersion": "2026-10-20T00:00:00Z",
  "models": [
    {
      "id": "deepseek/deepseek-v4-flash",
      "name": "DeepSeek V4 Flash (latest)",
      "reasoning": true,
      "inputModalities": ["text"],
      "efforts": ["high", "max"],
      "context": 1000000,
      "maxOutput": 32000
    }
  ]
}
```

### 1.1 字段表

顶层：

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | ✅ | 整数，当前 `1` |
| `generatedAt` | ✅ | ISO 8601 UTC，产物生成时刻 |
| `sourceCliVersion` | ✅ | 构建时 npm 上最新的 `command-code` 版本，仅作溯源；伪装层版本头兜底链第 ③ 层——npm/jsDelivr 均不可达且无落盘缓存时，读运行时已拉取产物的此字段（只读内存、不触发拉取；见 `docs/dev/spec/disguise.md` §6，#19 修订） |
| `catalogVersion` | 可选 | 构建时 `view=client` 响应顶层的 `catalogVersion`。供 build-meta 变更检测与人工溯源；运行时解析器按「未知字段忽略」处理，不消费 |
| `models` | ✅ | 模型数组，**仅含 Go plan 可用子集**（见 §2.3） |

per-model：

| 字段 | 必填 | 构建侧来源 | 说明 |
|---|---|---|---|
| `id` | ✅ | client catalog `data[].id`；补集条目取内嵌目录 `id` | 主键，与网关 wire id 同一写法 |
| `name` | ✅ | catalog `name`，缺失时取 `display.label`；补集条目同口径 | 展示名；入口缺 `name` / `label` 时构建硬失败，不猜值 |
| `reasoning` | ✅ | catalog `reasoning`；字段缺失时由 `reasoningEfforts` 非空推导 | 布尔；上游 CLI 从 1.82.2 起运行时一律以 `reasoningEfforts` 非空判定推理，目录里的 `reasoning` 字段只是冗余标注。构建侧与 CLI 同口径，缺省显式写出 `false` |
| `inputModalities` | ✅ | catalog `inputModalities`；补集条目同字段 | 词表按「网关可投递」口径：取值仅 `["text"]` / `["text","image"]`（即 OpenCode 判断图片可否粘贴的开关）。不采用 models.dev 的 audio/video/pdf——那是厂商原生 API 能力，`/alpha/generate` 投递通道未经验证，advertise 超出协议层转换能力会导致放行后静默丢弃。字段为开放数组，网关支持面扩大时直接扩数据，schema 不变。条目缺该字段时构建硬失败 |
| `efforts` | 可选 | catalog `reasoningEfforts`；补集条目同字段 | 严格透传官方词表（当前 `low/medium/high/xhigh/max`）；无档位的模型**不写该字段**，不造空数组、不造占位值 |
| `context` | ✅ | 补全链：catalog `context_length`（构建日志沿用历史标签 `bundle`）→ 同 family 官方目录值借用 → models.dev `limit.context` → 常量 200000 | 构建侧保证每个模型都有具体值；运行时可能被 client catalog 的 `context_length` 覆盖（那是网关实际执行值），产物值主要服务 catalog 失效的降级场景 |
| `maxOutput` | ✅ | 补全链：catalog `maxOutputTokens`（`null` / 缺失视为未披露）→ 同 family 借用 → models.dev `limit.output` → 常量 32000 | 官方仅少数条目录披露该字段（2026-10-20 实测 10/102），主要靠 models.dev 补齐。运行时角色为 `max_tokens` 裁剪参考与 `limit.output` 展示值，不再是缺省值本身（`docs/dev/spec/protocol.md` §1.2 / `docs/dev/adr/0002-gateway-max-tokens-cap.md`） |

**无价格字段**：v1 明确不做价格（理由见 §6），`cost` 留待将来以新增可选字段方式回归。

### 1.2 版本演进

- `schemaVersion` 为整数。**同版本内只允许新增可选字段**；客户端必须忽略未知字段（向前兼容）。
- 破坏性变更（删字段、改类型、改语义）必须递增 `schemaVersion`。
- 客户端遇到大于自身已知上限的版本号：**整体弃用该渠道的产物**，继续尝试 URL 列表中的后续渠道；全渠道都失败才按 §5 降级到内存中的上次成功产物（从未成功过则包内快照），并告警。不做多版本兼容解析。

### 1.3 渠道无关约束

- schema 与客户端代码不得包含渠道特有概念（如 gist revision、Release tag 语义）。
- 客户端按**有序 URL 列表**拉取产物：代码内置默认列表，用户配置可覆盖；按序尝试，首个成功者胜。
- **覆盖机制**（键名统一 `modelsUrls`，值 = http(s) URL 有序列表，接受字符串数组或逗号分隔字符串；#17 终审拍板，调研 `docs/dev/research/models-url-override.md`）：
  - v1：用户 `opencode.json` 的 `provider.commandcode-go.options.modelsUrls`；v1 config hook 注入 provider 块时必须非破坏合并，用户已写键优先。为覆盖 v1 插件与 provider 工厂可能分属两个动态模块实例的情况，hook 只额外写入包内保留的 logger 接线标记。
  - v2：用户 `opencode.json` 的 `providers.commandcode-go.settings.modelsUrls`（空壳升级为 settings 壳）；值经宿主内置 transform 进入目录并在工厂 options 中以顶层键出现。
  - 统一环境变量兜底：`COMMANDCODE_MODELS_URLS`（逗号分隔），v1/v2 插件进程内直读。优先级 config > env > 默认列表。该变量是用户配置面，非测试通道；测试仍经工厂 `options.fetch` 接缝注入（`docs/dev/spec/testing.md` §2/§3）。
  - **语义为整列表替换**：不与默认列表拼接、不提供插位；包内快照不占列表位，仍是失败兜底层。
  - **非法值处理**：逐项校验（可解析且 http/https 的绝对 URL），非法项丢弃 + 逐项 warn；非数组或合法项为零时整体回退默认列表 + warn；任何情况下不阻断启动。解析结果与来源（config/env/default）打日志。
  - **新鲜度边界**：≤30 分钟 SLA 只约束默认渠道的发布管线；用户覆盖渠道无新鲜度保证，存活但滞后的镜像会按首个成功者胜持续生效（新模型延迟可见，存量不受影响），客户端不做跨渠道新鲜度仲裁。

## 2. 构建侧契约

### 2.1 输入

| 输入 | 必需性 | 用途 |
|---|---|---|
| npm registry `command-code/latest` | 必需 | 版本检测与 `sourceCliVersion`；workflow 也用它判断是否需要构建 |
| `GET /provider/v1/models?view=client` | 必需 | 发现权威与条目元数据；失败即构建失败 |
| models.dev `api.json` | 必需 | limits 补全；内容 hash 也是构建触发器 |
| `command-code@<version>` tarball 的 `dist/cli.mjs` | 可选 | 解析内嵌目录，补 client catalog 缺失的 Go 可见条目；只做文本解析，绝不执行包内代码 |

### 2.2 流程

1. **取版本**：workflow 把检测步拿到的 CLI 版本经 `--cli-version` 传入，避免检测与构建之间的 TOCTOU 漂移；本地运行时缺失则实时查询 registry。
2. **拉 client catalog**：解析顶层 `catalogVersion` 与 `data`，条目按 `id` 去重（重复 id 即解析失败）。此步失败直接终止构建。
3. **解析内嵌目录补集（软兜底）**：下载 tarball、提取 `dist/cli.mjs`、逆向内嵌目录。下载、解包、锚点定位、字面量解析任一失败都只打 warn 并退回纯 `view=client` 集合，**不阻塞发布**。补集只用于补远程缺失条目，不覆盖已有条目。
4. **合并**：产物集合 = client catalog 条目 ∪ 内嵌目录中「Go 可见但 client catalog 缺失」的条目；同 id 时远程条目优先。
5. **Go plan 过滤**：`minimumPlan === "individual-go"` 且 `hidden !== true`。
6. **limits 补全**：按 §1.1 的补全链保证 `context` / `maxOutput` 每模型必有具体值；构建日志记录每个值的 provenance（`bundle` / `family` / `models-dev` / `constant`），编造值可审计。
7. **对账断言**：见 §2.5；任一失败则构建失败、开 issue，不静默出产物。
8. **写出**：断言全部通过后才写 `models.json` 与 `build-meta.json`；产物 schema 见 §1。

### 2.3 Go plan 判据

- 保留 `minimumPlan === "individual-go"` 且 `hidden !== true` 的条目。这是官方 1.84.0 起 client catalog 的原生判据。
- `minimumPlan` 是「能调用该模型的最便宜订阅档位」；高档包含低档全部模型。Go plan 只取 `individual-go` 档。
- 套餐档位词表（值域断言用）：`individual-go` / `individual-goat` / `individual-pro` / `individual-max` / `individual-provider`。`individual-provider` 是 BYOK 相关档位，对 Go 过滤无影响；出现词表外新值 = 官方调整档位体系 = 构建失败开 issue 人工确认。
- 客户端不做 Go 过滤、不做档位判断——产物里的就是 Go plan 子集。

### 2.4 limits 补全链

- `context`：catalog `context_length` → 同 family 官方目录值借用 → models.dev `limit.context` → 常量 200000。
- `maxOutput`：catalog `maxOutputTokens`（`null` / 缺失视为未披露）→ 同 family 借用 → models.dev `limit.output` → 常量 32000。
- family 借用只看同批 catalog 的原始值、不传递（防止编造值成链）；同键下多个供体取 id 排序最小者，保证确定性。
- 每个字段的 provenance 进构建日志，「编造值必须可审计」由日志满足。

### 2.5 对账与断言

现行对账断言（`runReconcile`，任一失败即构建失败、开 issue、不写产物）：

| 断言 | 判据 | 失败语义 |
|---|---|---|
| Min plan 值域 | 合并目录中出现的 `minimumPlan` ⊆ 五值词表 | 官方调整档位体系，需人工确认套餐序与过滤判据 |
| 产物非空 | Go 过滤后至少 1 条 | 解析或过滤链路损坏，拒绝发布空产物 |
| Go 模型计数监控 | 当前 `individual-go` 非隐藏计数相对上次成功构建漂移 ≤ ±5 | 批量套餐调整或坏数据可能静默通过，需人工复核 |
| inputModalities 词表 | 进产物的 Go 可见条目只含 `text` / `image` | 新模态 = 网关投递能力未经验证，需人工确认协议层支持后扩词表 |

另有产物组装 fail-fast（`emit.ts`，不属于 `runReconcile` 的聚合断言）：条目缺 `name` / `label` 或 `inputModalities` 时抛出错误，构建同样失败，不以猜值掩盖。

已删除的断言：

- **「产物 id ⊆ 普通 `/models` API id 集合」**：用「API 收录与否」当「官方是否隐藏」的代理指标。`cat-jam:free` 证明该指标失效——官方内嵌目录与 models.md 均标 Go 可用、无 hidden，官方 CLI 靠内嵌目录兜底放行，只是 API 清单尚未收录。删除，不做替代断言。
- **「Efforts 两源互证」**：models.md 退役后没有第二源；efforts 以 client catalog 的 `reasoningEfforts` 为唯一来源，严格透传。
- **models.md 的列头 / Min plan 分布断言**：models.md 不参与构建，不含 `hidden`，无法判定产物集合。

计数基线写在 `build-meta.json` 的 `goModelCount`；#62 之前的旧 data 分支基准只有 `planDistribution.Go`，迁移首轮沿用同一口径。

### 2.6 build-meta 与变更检测

`build-meta.json` 记录：`sourceCliVersion`、`catalogVersion`、`generatedAt`、`modelsDevSha256`、`modelsJsonSha256`、`goModelCount`、`modelsCount`。它随 data 分支发布，同时是下次构建的 `--prev-meta`。

workflow 每 15 分钟轮询三项，任一变化即构建：

1. npm 上 `command-code` 的最新版本；
2. models.dev `api.json` 的内容 sha256；
3. `view=client` 的 `catalogVersion`——用 build-meta 中的值补回双引号作 `If-None-Match` 条件请求；304 或同值视为未变。旧 build-meta 缺 `catalogVersion` 时构建一次建立基准。

第三项覆盖「官方不发 CLI 新版、只更新 catalog」的场景。检测日志注明三种触发原因；`drill-prev-distribution` 演练注入伪造的 `individual-go` 非隐藏计数（非负整数，非法输入在检测步直接失败），构建应失败并自动开 issue、不出产物。三渠道（Release asset / npm 数据包 / data 分支）发布机制不变（`docs/dev/adr/0001-artifact-distribution-channels.md`）。

## 3. 运行时合并级联

原则：**每字段单一天窗**，权威 = 离网关事实最近的来源；包内快照永远最后。

| 字段 | 权威 | 兜底链 |
|---|---|---|
| 发现（暴露哪些 id） | **产物全集**（产物角色由构建产物、内存中的上次成功产物或包内快照扮演） | 产物拉取失败 → 内存中的上次成功产物；从未成功 → 包内快照 |
| `context` | client catalog `context_length`（网关实际执行值） | 产物 `context` → 快照（构建侧已保证必有值） |
| `name` | client catalog `name` | 产物 → 快照 |
| `efforts` / variants | 产物 | 无 |
| `reasoning` / `inputModalities` / `maxOutput` | 产物 | 快照（构建侧已保证必有值） |
| `tool_call` | 常量 `true` | — |

暴露规则：

- **catalog 有而产物无 → 不注册**。发现权威是产物全集；catalog 独有条目不进入模型列表。
- **产物有而 catalog 无 → 照常注册**。上游已下架但产物尚未更新时条目仍在，选中后由网关报错——与官方 CLI 用户承担一致的风险面，不让模型从列表里凭空消失。
- **官方标记 `hidden` / 非 Go 档 → 构建侧已过滤**，不会进产物；运行时不再做第二道套餐判断。
- client catalog 失败不缩小模型列表：发现仍按产物全集，只有 `context` / `name` 回落产物值（§5）。

### 3.1 variants 构造（严格透传）

- 产物有 `efforts` → 按档位生成同名 variants（v1 为 map 形状、v2 为数组形状）；base 模型不发送 `reasoning_effort`，交网关/模型自决。
- 产物无 `efforts` → **不造任何变体**。官方没给的档位就是不存在的档位：不得手动补全、不得降级为「暴露全部档位」（jiesou 式降级弃用）。
- **不做任何档位词过滤**：上游给什么透传什么（含将来可能出现的 `none` / `minimal`），不发明白名单。

### 3.2 消费映射（v1 / v2）

- v1 模型 entry：`{id, name, tool_call: true, reasoning, attachment, modalities, limit: {context, output}, variants}`；不写 `cost`。
- v2 `Model.Info`：`capabilities: {tools: true, input: <inputModalities>, output: ["text"]}`、`limit`、`variants: [{id: <档位>, settings: {reasoningEffort: <档位>}}]`；`cost` 省略。
- 字段形状细节以 `docs/dev/research/opencode-plugin-provider.md` §3/§4 为准，由 v1/v2 glue 票承接。

## 4. 刷新与缓存

| 数据源 | 节奏 |
|---|---|
| `view=client` catalog | 匿名拉取；TTL 跟随响应 `refreshAfterSeconds`（当前 900s；缺失或非法回落 900s）；带 `If-None-Match` 条件请求（值为上次成功响应的 `catalogVersion`，请求头中补回双引号），304 复用上次成功清单并重排 TTL；变更签名 = 排序后 `(id, context_length)` 序列——`name` 变化只影响展示、`catalogVersion` / `refreshAfterSeconds` 只影响 ETag 与节奏，均不触发 reload |
| 构建产物 | 按 §1.3 的有序 URL 列表拉取；TTL 1h + 0～5min 随机抖动；对 `models` 数组做内容 hash，变化才触发下游动作（v2 `catalog.reload()`）；渠道支持时带 ETag/Last-Modified 条件请求 |
| v1 客户端 | 启动拉取一次（15s 总预算），失败用快照；**不做后台刷新**（v1 无 reload 机制） |
| v2 客户端 | 启动零阻塞：先用包内快照注册，后台拉 catalog + 产物，签名变化才 `catalog.reload()` |

- 刷新为惰性驱动：不挂 `setInterval`，读模型列表时或显式 `refreshIfDue` 时检查 TTL，到点转后台刷新；stale-while-revalidate——读永不等待在途拉取。
- 刷新失败按来源独立退避：30s × 2^失败次数，上限 30min；任一来源恢复即回到完整级联。

## 5. 降级行为

包内快照 = 与产物同 schema 的 JSON，随插件发版从最新产物复制进来。级联统一为「client catalog × 产物角色」，产物角色由构建产物、内存中的上次成功产物或包内快照扮演，全程只需一套解析代码。

| 场景 | 行为 |
|---|---|
| catalog + 产物正常 | 完整级联：产物全集发现，catalog 提供 `context` / `name` |
| catalog 失败 | 发现不退化为空、不缩小：产物全集照常注册，`context` / `name` 回落产物（或快照）值；warn 注明退到哪一层 |
| 产物失败 | 内存中的上次成功产物顶替产物角色；从未成功过则包内快照顶替；catalog 仍可为重叠 id 提供 `context` / `name`；warn |
| 全部失败（离线） | 快照全量注册，照常可用（数据可能过期）；指数退避重试，任一来源恢复即回到完整级联 |
| 产物 schemaVersion 高于已知上限 | 整体弃用该渠道的产物，继续尝试后续渠道；全渠道失败后按「产物失败」处理；单独 warn |
| 构建侧内嵌目录失败 | 产物退化为纯 `view=client` 集合（少补若干模型），构建照常发布；构建日志 warn |
| 上游下架但产物未更新 | 条目照常注册，选中后由网关报错（§3 暴露规则） |

- v2 不采用「失败保持空列表等待刷新」方案（Breskott 式）——有同构快照，没理由让用户面对空模型列表。
- 所有降级路径打 opencode log warn，注明退到了哪一层。
- 构建侧内嵌目录失败与运行时降级是两件事：前者影响产物集合的完整性，不改变运行时级联规则。

## 6. 备选与否决记录

| 备选 | 否决理由 |
|---|---|
| 普通 `GET /provider/v1/models` 继续作发现权威 | 官方 CLI 1.84.0 起改用 `view=client`，普通端点在官方源码中已零引用；其响应缺 `minimumPlan` / `hidden`，无法判定 Go 可见性与隐藏模型，且已造成 5 天数据落后与流水线连环失败（#55） |
| 仅 `view=client` 直出（方案 A，不补内嵌目录） | `stealth/cat-jam:free` 只存在于官方内嵌目录，远程 catalog 尚未收录；直出会漏掉官方 CLI 源码路径实际允许调用的模型 |
| 复刻官方线上现状（远程 catalog 正常时隐藏 cat-jam） | 维护者拍板复刻「官方源码可调用」语义而非线上现状：官方远程查不到时用内嵌目录兜底放行，我们采用同一语义；远程 catalog 的收录滞后不应当成为插件用户的可见性差异 |
| tarball 下载与解包整体退役 | 原决策前提「view=client 已含 cat-jam」经实测有误。tarball 保留但降级为软兜底：内嵌目录解析失败只告警，bundle 结构漂移从「流水线卡死」降为「少补若干模型 + 一条告警」 |
| 运行时发现 = catalog ∩ 产物（交集过滤） | catalog 滞后会隐藏官方已上线的新模型；官方 CLI 对未知模型默认放行、对远程查不到用内嵌目录兜底。改为产物全集注册，上游能否真正调通由网关调用时决定 |
| 「产物 id ⊆ 普通 `/models` API id 集合」断言 | 代理指标，`cat-jam:free` 案证明失效（API 未收录 ≠ 官方隐藏）；删除，不做替代断言 |
| 「Efforts 两源互证」断言 | models.md 退役后没有第二源；efforts 以 catalog `reasoningEfforts` 为唯一来源，严格透传 |
| 运行时保留普通 `/models` 端点作 `context` 回退 | client catalog 的 `context_length` 就是网关实际执行值；再保留旧端点等于维护两条会分叉的口径。API 失败时直接回落产物值 |
| catalog-only 变更不触发构建（只轮询 CLI 版本与 models.dev） | 官方可能不发 CLI 新版、只更新 catalog；`catalogVersion` 条件请求把这种情况纳入 ≤30min 刷新承诺 |
| models.dev 参与运行时级联（四层方案） | 4.4MB 拉取 + 脆弱的别名匹配链路进客户端；`context` 运行时已有 client catalog 权威，订阅制用户无新鲜度收益 |
| limits 缺失用常量兜底（初版草案） | `context` 是 OpenCode 压缩判断的依据、`maxOutput` 是 `max_tokens` 裁剪参考与展示值（`docs/dev/adr/0002-gateway-max-tokens-cap.md`），真实数据优于编造值；models.dev limits 覆盖绝大多数模型，构建侧补全后常量只剩极端兜底 |
| 模态词表扩到 audio/video/pdf | models.dev 口径是厂商原生 API 能力，网关投递通道未经验证；advertise 超出协议层转换能力 = 放行后静默丢弃。维持「网关可投递」口径 text/image，通道扩展后直接扩数据 |
| 价格字段（`cost.*`） | v1 明确砍掉：实现链路长（三来源对账 + 官方 promo 口径校正），订阅制下展示收益薄；schema 演进规则留门 |
| isGoModel 前缀启发式（jiesou） | 官方明文「套餐按计费类别门控，与开源/闭源无关」；实测已漏 3 个 Go 可用模型；仅可作为断言链末级应急且需打补丁，不作常规依据 |
| off 变体 | 实测 off ≡ 不发送 `reasoning_effort` ≡ base 模型，造了是冗余 |
| 官网文档 RSC payload 作套餐主源 | flight chunk 重组 + 页面间转义层级不一致 + 前端升级即碎；已被 client catalog 的机器可读 `minimumPlan` 取代 |

### 6.1 cat-jam 勘误与方案 B

#61 正文最初假设 `stealth/cat-jam:free` 已在 `view=client` 中，据此决定「tarball 整体退役」。2026-10-20 复核实测纠正：

- `view=client`（102 条）中 `individual-go` 且非 `hidden` 的条目为 58 条，**不含 cat-jam**；
- cat-jam 只存在于官方 CLI 包内嵌目录（Go 档、无隐藏标记、带 free 徽章与每日 100 次配额公告），远程 catalog 尚未收录；
- 官方 CLI 线上行为：远程 catalog 正常时选择器不显示 cat-jam，仅在远程不可用退回内嵌目录时显示。

维护者据此拍板**方案 B**：产物 = `view=client` 的 Go 可见条目 ∪ 内嵌目录中「Go 可见但 `view=client` 缺失」的条目；当前实例化为 58 + cat-jam = 59。随之修订原规格三处：tarball 解析保留并软兜底化；models.md 解析维持退役、Efforts 互证维持删除；cat-jam 回归 fixture 的语义改为「内嵌目录有（Go、非隐藏）而 `view=client` 无 → 必须进产物」。

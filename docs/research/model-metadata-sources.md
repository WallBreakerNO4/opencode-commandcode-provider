# 模型元数据来源矩阵调研

> 调研日期：2026-08-28。对应 GitHub issue #3。
> 全部数字来自当天实测：`/models` API 实时响应、models.dev `api.json` 全量快照、jsDelivr 上的 `models.md`（解析到 1.37.0）、npm `command-code@1.37.0` tarball（下载到 /tmp 下解压分析，未安装、未触碰本机任何 CLI/凭据文件）。
> 提取与匹配脚本思路见文末「附录：实测方法」。

## TL;DR

1. `/models` API 实测有 **62 个模型、6 个字段**：除已知情报的 `id/name/context_length` 外，还有 `object:"model"`、`created`、`owned_by:"command-code"` 三个 OpenAI 兼容字段（已知情报漏了，但仍无 capabilities/cost/max-output/reasoning）。
2. **models.dev 已提供 per-model 的 reasoning efforts 档位**（`reasoning_options[].{type:"effort",values:[...]}`），本批 62 个模型中 40 个（66%）可拿到档位——地图上「models.dev 不提供 efforts 档位列表」的既有判断**已过时**，予以纠正。
3. CLI 随包的 `reference/models.md`（jsDelivr，解析到 1.37.0）覆盖 61 个模型，Efforts 列与 npm bundle 里的 `reasoningEfforts` **30/30 逐值一致**（同源）；它还独有「最低套餐（Min plan）」和官方含 promo 价。缺 `tencent/hy4-preview`。
4. npm bundle 逆向在 1.37.0 上**锚点字符串全部仍在**，但解析脚本需要适配（bundle 从 `dist/index.mjs` 挪到 `dist/cli.mjs`；provider 从枚举对象变成独立常量；目录对象截取逻辑要改）。目录 65 条覆盖 API 全部 62 个 id，独有 `maxOutputTokens`（仅 4 个模型有值）与 `inputModalities`（vision 判定）。
5. 三个来源都给不出的硬缺口：**max output tokens（58/62 个模型）、4 个模型无任何 context 数字、价格表外 42 个模型的 cache_write**。兜底建议沿用 Breskott：`DEFAULT_OUTPUT_TOKENS = 32000`、context 兜底 200k。
6. **带认证对比（真实 Go key 实测）**：`/models` 带 `Authorization: Bearer` 与匿名访问除 `created` 外**逐字节一致**——该端点无套餐差异化行为，匿名拉取即可；且 `created` 是**响应生成时刻的 Unix 时间戳**（每请求都变，与模型无关），做模型列表变更检测时必须剔除，否则每次都会误判「列表变了」。

---

## 一、「字段 × 来源」矩阵

分母：`/models` API 的 62 个模型 id。括号内为实测覆盖数。

| 字段 | ① /models API | ② models.dev | ③ CLI models.md | ④ npm bundle 逆向 |
|---|---|---|---|---|
| id | ✅ 62/62（列表本体） | ✅ 61/62 匹配上（54 个官方组 + 7 个第三方组；`tencent/hy3-paid` 缺） | ✅ 61/62（缺 `tencent/hy4-preview`） | ✅ 65 条目录，62/62 全覆盖（另含 3 个隐藏 free 条目） |
| name（展示名） | ✅ 62/62 | ✅（匹配上的都有） | ✅ 61/61 | ✅ 65/65（`label` 与 `name` 双份） |
| context_length | ✅ 62/62（网关侧权威值） | ⚠️ 61/61 但与 API 有 **28 处不一致**（取整差异 + 真矛盾，见 §三） | ⚠️ 57/61（人类近似值 `1.05M/262K`；4 个为 `—`） | ⚠️ 61/65 精确值；GLM-5.1、MiniMax-M2.7、Qwen3.6-Max-Preview、Qwen3.6-Plus 缺失 |
| max output tokens | ❌ 无 | ✅ 61/61（`limit.output`；但部分为第三方视角值） | ❌ 无 | ⚠️ 仅 4/65 有 `maxOutputTokens`（GLM-5.3-flash 131072、Qwen3.8-27B 32768、laguna-s-2.1-free 32768、ling-3.0-flash-free 32768） |
| cost.input | ❌ 无 | ✅ 61/61（第三方兜底的 3 个 free 模型为 $0，属真实免费） | ✅ 61/61（`$/1M in` 列，官方价含 promo） | ⚠️ 仅 20/62 在价格表（`promptCost`）；其余需 FALLBACK |
| cost.output | ❌ 无 | ✅ 61/61 | ✅ 61/61 | ⚠️ 同上 20/62（`completionCost`） |
| cost.cache_read | ❌ 无 | ✅ 60/61（inkling 官方条目无价格） | ✅ 61/61（`cache $x` 列） | ⚠️ 20/62（`cacheHitCost`；>0 才有意义） |
| cost.cache_write | ❌ 无 | ⚠️ 24/61（39%，provider 计费才有） | ✅ 20/61（`cache $x (write $y)`，只有计费的才写） | ⚠️ 20/62（`cacheWrite5mCost`，且另有 `cacheWrite1hCost` 是独有维度） |
| modalities（input/output 列表） | ❌ 无 | ✅ 61/61（`modalities.input/output`，含 pdf/audio/video 细分） | ❌ 无（只能从描述文本猜） | ⚠️ 仅 `inputModalities`（44/65 含 image），无 output 维度 |
| vision/attachment | ❌ 无 | ✅ 61/61（`attachment` 布尔 + modalities 可交叉验证） | ❌ 无（`Best for` 文本提 vision 不可靠） | ⚠️ 44/65 可从 `inputModalities` 推导 |
| tool_call | ❌ 无 | ✅ 61/61（全 true） | ❌ 无 | ⚠️ 无此字段（brent 硬编码 true） |
| reasoning 布尔 | ❌ 无 | ✅ 61/61（全 true） | ❌ 无显式布尔（可用「Efforts 非空」近似，但会漏模型自决型） | ✅ 65/65（`reasoning` 字段；12 个无此字段=非推理；另有 `reasoningEfforts` 可兜底） |
| **reasoning efforts 档位** | ❌ 无 | ✅ **40/61**（`reasoning_options[].{type:"effort",values}`；全库 7439 模型中 2974 个有此结构） | ✅ 30/61（Efforts 列逗号列表；与 bundle 30/30 一致；`—`=模型自决） | ✅ 30/65（`reasoningEfforts` 数组，与 models.md 同源） |
| 最低套餐（Go/GOAT/Pro/Max） | ❌ 无 | ❌ 无 | ✅ 61/61 独有（Min plan 列） | ❌ 无 |
| 其他独有 | `object/created/owned_by`（OpenAI 兼容样板） | `structured_output`、`open_weights`、`knowledge` 截止日期、`release_date`、`interleaved` | `Best for` 描述、promo 价说明 | `description`、`vendorLabel`、`badge:"free"`、`hidden`、`notice`（上游故障公告）、`spec`（chatComplete/responses）、价格表 `category` |

> 纠错记录：已知情报「第 2 列是 id、第 5 列是 efforts」是按 `split('|')` 后的数组下标说的；按 markdown 表格列语义，id 在第 **1** 列、Efforts 在第 **4** 列、价格在第 5 列。语义结论（id 列、efforts 逗号列表、`—`=模型自决）实测全部成立。

---

## 二、来源 1：CommandCode 官方 `/models` API

`GET https://api.commandcode.ai/provider/v1/models`（实测无需认证，裸 curl 200）。

### 数据形态（实测样例，节选）

```json
{"object":"list","data":[
  {"id":"claude-sonnet-5","object":"model","created":1787931186,
   "owned_by":"command-code","name":"Claude Sonnet 5","context_length":1000000},
  {"id":"deepseek/deepseek-v4-flash","object":"model","created":1787931186,
   "owned_by":"command-code","name":"DeepSeek V4 Flash (latest)","context_length":1000000}
]}
```

### 实测结论

- **62 个模型**（完整 id 列表见 §八附表）。
- 全部条目的字段并集恰为 6 个：`id`、`object`（恒 `"model"`）、`created`（动态，见下）、`owned_by`（恒 `"command-code"`）、`name`、`context_length`。
- **与已知情报的差异**：已知情报说「只有 `{id,name,context_length}` 三个字段」，实测多出 `object/created/owned_by` 三个 OpenAI 兼容样板字段。除此之外确实**没有** capabilities/cost/max-output/reasoning，这点与已知情报一致。
- **带认证对比（2026-08-28，真实 Go key）**：`Authorization: Bearer <key>` 与匿名请求的响应除 `created` 外**逐字节一致**（62 个模型、6 字段全同）——无套餐过滤、无额外字段。匿名拉取即可，不需要把 key 发给该端点。
- **`created` 是动态值**：实测其值等于响应生成时刻的 Unix 秒（与 `date +%s` 同步，每次请求都变），并非模型创建时间。做模型列表变更检测（如 v2 的 `catalog.reload()` 触发判断）必须剔除该字段再算签名，否则每次都会误判「列表变了」。
- id 命名三种形态混用：无前缀（claude-\*、gpt-\*）、`vendor/model`、大小写不统一（`moonshotai/Kimi-K3` vs `minimax/minimax-m3-free`）。
- `context_length` 是**网关实际执行的上下文上限**，是所有来源里唯一代表 CommandCode 侧真实限制的值。

---

## 三、来源 2：models.dev

`https://models.dev/api.json`（实测 4.4 MB，204 个 provider 分组、7439 个模型）。

### 组织方式与匹配规则（实测确定）

- 按 provider 分组：`api.json[provider].models[modelId]`。模型 id 多数小写（`kimi-k3`），但 minimax 组保留大小写（`MiniMax-M2.5`），部分组（nvidia、thinkingmachines）的 key 自带 `provider/` 前缀（`nvidia/nemotron-3-ultra-550b-a55b`）。
- 本次匹配规则：
  1. CommandCode id 按 `/` 拆成「前缀 + 模型 id」；无前缀的按品牌映射（`claude*→anthropic`、`gpt*→openai`）。
  2. 前缀别名表：`z-ai`/`zai-org→zai`、`MiniMaxAI`/`minimax→minimax`、`Qwen→alibaba`、`tencent→tencent-tokenhub|tencent-coding-plan|tencent-token-plan`、`moonshotai→moonshotai`、`stepfun→stepfun` 等。
  3. 依次尝试：精确 id → 大小写/`_`/`-` 归一 → models.dev key 以「`前缀/模型id`」整串结尾匹配。
  4. 仍未命中则全库扫描（结果标记为第三方，质量打折）。

### 匹配结果

- **61/62 匹配（98%）**：54 个落在官方/规范组，7 个只落在第三方聚合组（neuralwatt、opencode、vercel、iteracompute、orcarouter、nano-gpt），价格/limit 是第三方视角。
- **匹配不上（1 个）**：`tencent/hy3-paid`——models.dev 的 tencent-tokenhub 只有 `hy3` 与 `hy3-preview`，无 `-paid` 计费变体。
- 字段覆盖（分母 61）：`cost.input/output` 100%、`cost.cache_read` 98%、`cost.cache_write` 39%、`limit.context/output` 100%、`modalities` 100%（vision 72%）、`tool_call`/`reasoning`/`attachment` 100%、**effort 档位 66%（40 个）**。

### 重点验证：「models.dev 是否只有 reasoning 布尔」

**已推翻**。models.dev 现有 `reasoning_options` 数组，典型形态：

```json
"reasoning_options": [ { "type": "toggle" }, { "type": "effort", "values": ["low","high","max"] } ]
```

本批 40/61 个模型可解析出 effort values，全库 7439 个模型中 2974 个有此结构——是普遍字段而非孤例。档位词表含 CommandCode 未用的 `none/minimal`，合并时需过滤到自家支持的子集。

### 与来源 1 的 context 矛盾（28 处）

分两类：

- **取整口径差**（Kimi 系 256000 vs 262144、google 系 1000000 vs 1048576 等）：无实质冲突。
- **真矛盾**（需注意）：`gpt-5.5`/`gpt-5.4`（API 400k vs models.dev 1050k）、`Qwen3.6-Plus`（API 200k vs 1000k）、`Step-3.5-Flash`（API 1M vs 256k）、`z-ai/glm-5.3-flash`（API 1048576 vs 1000000，方向相反）。

结论：**context 以 `/models` API 为权威**——它反映网关实际执行的限制；models.dev 是厂商官方口径，可能宽于/窄于网关。

---

## 四、来源 3a：官方 CLI 的 `reference/models.md`（jsDelivr）

URL：`https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md`
（该文件由 CLI 构建时从 commandcode.ai/docs 生成，`<!-- Generated from the Command Code docs -->` 头注明。实测内容解析到 **1.37.0**。）

### 表格结构（8 个 provider 分节，列语义实测）

| 列 | 含义 | 实测样例 |
|---|---|---|
| 1. Id | 精确 wire id（反引号包裹） | `` `deepseek/deepseek-v4-pro` `` |
| 2. Name | 展示名 | `DeepSeek V4 Pro (latest)` |
| 3. Context | 上下文（人类近似值；`—`=未公布） | `1M` / `262K` / `—` |
| 4. Efforts | reasoning 档位逗号列表；`—`=模型自决 | `high, max` / `low, medium, high, xhigh, max` / `—` |
| 5. $/1M in/out · cache read | 官方价（**promo 已 baked in**）；`(write $y)`=cache write | `$0.66/$1.98 · cache $0.022 (write $2.5)` |
| 6. Min plan | 最低可用套餐（Go 39 / Pro 13 / Max 5 / GOAT 4） | `Go and above` |
| 7. Best for | 一句话定位 | `hybrid-attention long-context reasoning` |

### 覆盖度

- **61 个模型行**：与 API 62 个 id 相比，唯一缺失 **`tencent/hy4-preview`**；无 API 之外的 id。
- Efforts 非空 30 个 / `—` 31 个；档位词表 `{low, medium, high, xhigh, max}`。
- Context 为 `—` 的 4 个：GLM-5.1、MiniMax-M2.7、Qwen3.6-Max-Preview、Qwen3.6-Plus（与 bundle 缺 contextWindow 的 4 个完全一致）。
- 价格列 20 个带 cache write。
- **逐值校验**：Efforts 列与 bundle 的 `reasoningEfforts` 在 61 个可比模型上 **30/30 完全一致**——两处同源（CLI 同一构建产物）。

### `@latest` 解析行为与生产建议

- jsDelivr 对 `@latest` **不做 302 重定向**，由边缘直接按解析版本服务，并在响应头暴露实际版本：`x-jsd-version: 1.37.0`（可日志记录用于排查）。
- 缓存：`cache-control: public, max-age=604800, s-maxage=43200`——浏览器 7 天、CDN 12 小时。即新版本发布后，`@latest` 最长 **12 小时** 内仍可能拿到旧版（实测时拿到过 age≈11.9h 的缓存响应）。
- npm `latest` tag 当前即 1.37.0（2026-08-28 当天发布，398 个版本，另有 alpha/beta/rc tag）。
- **建议**：解析成本低的 models.md 可以用 `@latest`（容忍 12h 滞后 + 解析失败兜底），但**依赖锚点的 bundle 逆向必须 pin 版本**（如 `command-code@1` 大版本 pin 或精确版本），因为 0.x→1.x 已发生结构断裂（见下节）。版本号可从 `x-jsd-version` 响应头或 `registry.npmjs.org/command-code/latest` 获取并写入快照元数据。

---

## 五、来源 3b：npm bundle 逆向（`command-code@1.37.0` 实测）

### brent sync-models.ts 的锚点与字段（读源码确认）

- 锚点 1 `ANTHROPIC:"anthropic"` → provider 枚举；锚点 2 `SONNET_4_6:{id:"claude-sonnet-4-6"` → 模型目录；锚点 3 `{id:"anthropic:claude-sonnet-4-` → 价格表。
- `normalizeForEval`（`!0→true`、`!1→false`、科学计数法还原）后 `Function` eval 还原。
- 模型目录条目（脚本内 `SnEntry` 接口）：`id/provider/spec/label/name/description/reasoning?/reasoningEfforts?/contextWindow?`。
- 价格表条目（`CostEntry`）：`id/provider/category/promptCost/completionCost/cacheWrite5mCost/cacheWrite1hCost/cacheHitCost`。
- 合并策略：缺价格 → `FALLBACK_COSTS`（10 个模型）否则跳过；缺 context → `FALLBACK_LIMITS`（22 个）否则 `{context:200000, output:65536}`；output 缺省 65536；`tool_call` 硬编码 true。

### 1.37.0 实测：锚点仍在，但结构有四处变化

1. **bundle 位置**：真实代码在 `dist/cli.mjs`（2.5 MB，单行）；`dist/index.mjs` 只剩 1.8 KB 的 Node 版本检查 loader。brent 脚本读 `dist/index.mjs` 会直接失败。
2. **provider 常量化**：`ANTHROPIC:"anthropic"` 出现 3 次（UI 过滤枚举 `ro`、auth 枚举 `$o`、路由枚举 `ov`），但模型目录引用的是**独立常量** `TR="anthropic",PR="openai",MR="baseten",xR="vercel-ai-gateway",IR="cloudflare-ai-gateway",AR="cmd-ai",RR="openrouter",OR="alibaba",LR="alibaba-intl",DR="novita",NR="morph"`（还有别名 `$R=xR`）。按旧脚本注入枚举对象会 `TR is not defined`。
3. **目录对象截取**：目录是 `BR={SONNET_5:{...},SONNET_4_6:{...},...}`，「锚点向前找最近 `(`」会截出单个模型对象；应改为「向前找最近的 `={`」再做平衡括号扫描。
4. **getter 与别名**：目录含 `get hidden(){return isMiniMaxFreeEnded()}`，eval 展开时需注入 stub 函数；`id:jR` 这类变量引用（`jR="MiniMaxAI/MiniMax-M3-Free"`）也要解析注入。

（本次实测脚本对这些做了通用适配：从目录文本提取引用的标识符 → 在 bundle 里找字面量/别名定义 → 注入 eval 上下文，即可复现提取。）

### 1.37.0 提取结果

**模型目录：65 条**，字段实测全集：

| 字段 | 覆盖 | 说明 |
|---|---|---|
| `id` | 65/65 | wire id，62 个 API id 全覆盖 |
| `inputModalities` | 65/65 | `["text"]`/`["text","image"]`；44 个含 image（vision 判定依据） |
| `provider` | 65/65 | anthropic 7 / vercel-ai-gateway 50 / openrouter 4 / openai 4 |
| `spec` | 65/65 | `chatComplete` 58 / `responses` 7（gpt-5.6 系） |
| `label`/`name`/`description` | 65/65 | 展示与描述 |
| `reasoning` | 53 条显式 `true`，12 条缺省 | 缺省者=非推理模型（haiku、Kimi-K2.5/K2.6、GLM-5/5.1/5.2-Fast、MiniMax-M2.5/M2.7 等） |
| `reasoningEfforts` | 30/65 | 与 models.md Efforts 列 30/30 一致 |
| `contextWindow` | 61/65 | 缺失 4 个同 models.md 的 `—` |
| `maxOutputTokens` | **4/65** | GLM-5.3-flash 131072、Qwen3.8-27B 32768、laguna/ling free 32768 |
| `vendorLabel` | 14/65 | OpenAI/Google/Sakana/Meta/xAI |
| `badge`/`hidden`/`notice` | 6/2/2 | free 标记、隐藏条目（M3-Free、Hy3）、上游故障公告 |

API 之外多出的 3 条全是隐藏 free 条目：`MiniMaxAI/MiniMax-M3-Free`、`tencent/Hy3`、`inclusionai/ling-3.0-flash-free`。

**价格表：6 组 24 条**，字段实测全集：`id`（`anthropic:claude-sonnet-5` 式或 `zai-org/GLM-5` 式）、`provider`（人类可读名 "Anthropic"）、`category`（"premium"）、`promptCost`、`completionCost`、`cacheWrite5mCost`、`cacheWrite1hCost`、`cacheHitCost`。

- 去前缀后 24 个裸 id 与 API 62 个的交集 **20 个**（另 4 个是 API 已下架的旧快照：claude-sonnet-4-20250514、claude-sonnet-4-5-20250929、claude-opus-4-5-20251101、claude-opus-4-6）。
- **42/62 的模型在 bundle 里无价格**——bundle 价格表不是全量定价来源。
- **bundle 价 ≠ models.md 价的例子**（models.md 自述「promo 已 baked in」，以它为准）：MiniMax-M2.5（bundle $0.5/$2 vs md $0.3/$1.2）、GLM-5（$0.95/$3.15 vs $1/$3.2）、Kimi-K2.5（cache 0 vs $0.1）。bundle 价格表是上游价目，models.md 是面向用户计费的口径。

---

## 六、缺口清单（三个来源都给不出的字段）

| 缺口字段 | 受影响模型 | 处置建议 |
|---|---|---|
| **max output tokens** | 除 GLM-5.3-flash、Qwen3.8-27B 外的 **60/62**（bundle 仅 4 个有值，其中 2 个是 free 隐藏条目；models.dev 的 `limit.output` 是厂商官方口径，非网关执行值，可参考但不是事实） | 硬编码这 2-4 个 + `DEFAULT_OUTPUT_TOKENS = 32000`（Breskott 同款）；`/alpha/generate` 侧 `max_tokens` 上限仍需自裁（MAXeaglet 裁 200k） |
| **context 缺失的 4 个模型** | `zai-org/GLM-5.1`、`MiniMaxAI/MiniMax-M2.7`、`Qwen/Qwen3.6-Max-Preview`、`Qwen/Qwen3.6-Plus`（API 有值时以 API 为准；仅当 API 不给时才暴露此缺口） | 兜底 200_000（Breskott 同款）；同一 family 有值的可借用（M2.7→200k 与 M2.5 相同） |
| **42/62 的 cost** | 全部开源 provider 模型（deepseek/Qwen/GLM/MiniMax/stepfun/tencent/google/meta/xai… 在 bundle 价格表无条目） | 以 **models.dev 为主要价格源**（cost.input/output/cache_read 覆盖 100%），models.md 为官方 promo 价校正源，bundle 价格表只用于 premium 系（anthropic/openai）与 cache_write 补充 |
| **cache_write（39-41% 覆盖）** | deepseek、kimi、stepfun、google 等多数开源系 | 缺省不写该字段（OpenCode 对缺省的 cache_write 不展示），不要猜 0 |
| **`tencent/hy3-paid` 的 models.dev 元数据** | 仅此 1 个 | 用 bundle 目录条目（有 contextWindow=262144、reasoning、inputModalities）+ models.md 价格行拼装 |
| **reasoning efforts 的 20-22 个「模型自决」模型** | Efforts=`—` 且 bundle 无 `reasoningEfforts` 的 31/61 个（Kimi 系、Step、Tencent、Meta muse、Nemotron、inkling 等） | 不造 variants，交网关自决；或暴露全部档位由用户选（jiesou 的降级行为） |
| **tool_call** | 无缺口（models.dev 61/61 全 true；bundle 无此字段） | 硬编码 true 即可 |

## 七、「哪个来源负责哪个字段」建议（供 gist schema 设计）

按「权威性 = 离网关事实最近」排序，每个字段单一天窗（single source of truth），其余来源只做兜底：

| 字段 | 第一来源（权威） | 兜底链 |
|---|---|---|
| id 列表（发现） | ① `/models` API（动态，唯一实时源） | 包内快照 id 列表 |
| name | ① API | ④ bundle `label` → 快照 |
| context_length | ① API | ④ bundle `contextWindow` → ③ models.md（近似值换算）→ 200k |
| max output tokens | ④ bundle `maxOutputTokens`（仅 2 个有效） | 快照硬编码 → 32000 常量 |
| cost.input / cost.output | ② models.dev（全量覆盖） | ③ models.md 官方价（promo 口径，优先级可讨论：对用户计费而言 ③ 更准，建议 ③ 覆盖 ②）→ ④ bundle（仅 premium 20 个）→ 快照 |
| cost.cache_read | ② models.dev | ③ models.md → ④ bundle |
| cost.cache_write | ③ models.md（`(write $x)`）| ④ bundle `cacheWrite5mCost` → ② models.dev → 缺省不写 |
| reasoning 布尔 | ④ bundle `reasoning`（语义最准：非推理模型显式缺省） | ② models.dev → efforts 非空推断 → false |
| reasoning efforts 档位 | ③ models.md Efforts 列 与 ④ bundle `reasoningEfforts`（同源，30 个一致；任一即可，④ 更结构化） | ② models.dev `reasoning_options`（档位词表不同，需过滤 none/minimal）→ 不造 variants |
| vision / modalities | ④ bundle `inputModalities`（网关自家口径） | ② models.dev `modalities`（信息更全）→ id 前缀启发式（最后手段） |
| tool_call | 常量 true | —（三个来源都无反例） |
| 最低套餐 plan | ③ models.md Min plan 列（独有） | 无 |
| 定价外的补充展示（描述、厂商名、free 标记、故障公告） | ④ bundle `description/vendorLabel/badge/notice` | 无 |

一句话版：**发现与 context 听 API 的，价格与 vision 听 bundle+models.dev（价格再让 models.md 校正），efforts 听 bundle/models.md（同源），max output 与一切缺失听快照+保守常量。**

schema 设计推论：gist 快照至少需要 `id / name / context? / maxOutput? / cost{input,output,cacheRead?,cacheWrite?} / reasoning / efforts? / inputModalities` 十个键；其中 `context/maxOutput/cost` 允许缺省并由默认值兜底，`id` 必填。

---

## 八、附表

### /models API 全量 62 个 id（2026-08-28 实测）

```
claude-sonnet-5, claude-sonnet-4-6, claude-fable-5, claude-opus-5, claude-opus-4-8,
claude-opus-4-7, claude-haiku-4-5-20251001,
gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.3-codex, gpt-5.4-mini,
deepseek/deepseek-v4-pro, deepseek/deepseek-v4-flash, deepseek/deepseek-v4-flash-vision-exp,
moonshotai/Kimi-K3, moonshotai/Kimi-K2.7-Code, moonshotai/Kimi-K2.7-Code-Highspeed,
moonshotai/Kimi-K2.6, moonshotai/Kimi-K2.5,
z-ai/glm-5.3-flash, zai-org/GLM-5.3, zai-org/GLM-5.2, zai-org/GLM-5.2-Fast,
zai-org/GLM-5.1, zai-org/GLM-5,
MiniMaxAI/MiniMax-M3, MiniMaxAI/MiniMax-M2.7, minimax/minimax-m3-free,
minimax/minimax-m2.7-free, MiniMaxAI/MiniMax-M2.5,
xiaomi/mimo-v2.5-pro, xiaomi/mimo-v2.5,
Qwen/Qwen3.8-Max, Qwen/Qwen3.8-27B, Qwen/Qwen3.8-Flash, Qwen/Qwen3.7-Max,
Qwen/Qwen3.7-Plus, Qwen/Qwen3.7-Flash, Qwen/Qwen3.6-Max-Preview, Qwen/Qwen3.6-Plus,
stepfun/Step-3.7-Flash, stepfun/Step-3.5-Flash,
tencent/hy3-paid, tencent/hy4-preview,
google/gemini-3.7-flash, google/gemini-3.6-flash, google/gemini-3.5-flash,
google/gemini-3.5-flash-lite, google/gemini-3.1-flash-lite,
sakana/fugu-ultra, nvidia/nemotron-3-ultra-550b-a55b,
thinkingmachines/inkling, thinkingmachines/inkling-small,
poolside/laguna-s-2.1-free,
meta/muse-spark-1.1, meta/muse-spark-1.2, meta/muse-spark-1.2-contributor,
xai/grok-4.5, xai/grok-4.6
```

### 各来源覆盖差异速查

| 对比 | 结果 |
|---|---|
| models.md vs API | 61/62，缺 `tencent/hy4-preview`；context 为近似值（1.05M/262K）；无 API 外 id |
| bundle 目录 vs API | 65 条 ⊇ 62 个 API id，多 3 个隐藏 free 条目 |
| bundle 价格表 vs API | 20/62 有价格（另 4 条为已下架旧快照） |
| models.dev vs API | 61/62 匹配（54 规范 + 7 第三方），缺 `tencent/hy3-paid` |
| bundle `reasoningEfforts` vs models.md Efforts | 30/30 逐值一致 |
| models.md / bundle 的 context `—` 清单 | 同为 GLM-5.1、MiniMax-M2.7、Qwen3.6-Max-Preview、Qwen3.6-Plus |

### 附录：实测方法

- `/models`：`curl` 裸请求，响应存 /tmp 后 `jq` 统计字段并集与 id 清单；另用真实 Go key（经 shell 加载环境变量注入，未读取 .env 文件内容）带 `Authorization: Bearer` 复测并 diff，确认除 `created` 外逐字节一致。
- models.dev：`api.json` 全量下载后用 node 脚本匹配（别名表 + 三级归一 + 全库兜底），字段覆盖逐一断言。
- models.md：jsDelivr 拉取后按 `| \`...` 行解析 7 列，与 API/bundle 交叉比对。
- npm bundle：`registry.npmjs.org/command-code/latest` 取 1.37.0 tarball → /tmp 解压 → node 脚本按「锚点 + `={` 平衡括号 + 标识符注入 eval」提取目录与价格表（未安装、未执行包内任何代码，仅文本解析与受限 eval 对象字面量）。
- 全程未触碰 `~/.commandcode/`、`~/.pi/` 等任何本机凭据路径。

### 参考链接

- CommandCode Provider API：`https://api.commandcode.ai/provider/v1/models`
- models.dev 聚合 API：`https://models.dev/api.json`
- 官方 CLI 模型目录（jsDelivr）：`https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md`
- npm registry：`https://registry.npmjs.org/command-code/latest`（tarball `https://registry.npmjs.org/command-code/-/command-code-1.37.0.tgz`）
- jsDelivr 版本解析 API：`https://data.jsdelivr.com/v1/packages/npm/command-code/resolved?specifier=latest`
- 锚点逆向脚本（参考实现）：`https://raw.githubusercontent.com/brent-weatherall/opencode-commandcode-provider/main/scripts/sync-models.ts`
- 本仓库背景调研：`docs/research/reference-projects.md`（§二 jiesou 的 models.md 解析、§三 Breskott 的兜底常量、§四 brent 的 sync 脚本）

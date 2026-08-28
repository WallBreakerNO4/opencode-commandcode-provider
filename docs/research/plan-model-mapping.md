# Go plan 过滤数据源调研（套餐→可用模型映射）

> 调研日期：2026-08-29。对应构建侧决策：Go plan 模型过滤（从 `/provider/v1/models` 的 62 个模型中筛出 Go plan 可用子集）的数据源选型，即 GitHub Action 自动提取 per-model 最低套餐该抓哪里。
> 全部结论来自当天实测：`/provider/v1/models` 实时响应、commandcode.ai 官方文档页原始 HTML（7 个 URL）、npm `command-code@1.37.0` tarball（下载到 /tmp 解包，仅文本解析，未安装、未执行包内任何代码、未触碰本机任何凭据路径）、jsDelivr `models.md`（`x-jsd-version: 1.37.0`，与 tarball 内文件逐字节一致）。
> 上游背景见 `docs/research/model-metadata-sources.md`（下称「元数据调研」）——该文记录的「models.md 只有 61 行、缺 `tencent/hy4-preview`、Min plan 分布 Go 39」已过时，本文予以纠正。

## TL;DR

1. **老板的情报属实且比预想更好**：官方文档确实明确写了「哪个套餐能调用哪些模型」，而且不止是给人看的表格——`/docs/plans/go` 与 `/docs/resources/pricing-limits` 两个页面的 Next.js RSC payload 里**内嵌了全量 65 行结构化 JSON**，每模型带 9 个订阅 SKU 的布尔可用性表 `availability`（含 `individual-go`）。是嵌入 JSON，不是 HTML 表格也不是 prose；但提取需要重组 flight chunk + 多层转义还原，页面间转义层级还不一致。
2. **更推荐的来源是 CLI 包内 `reference/models.md`**（jsDelivr）：1.37.0 实测 **62 行 = API 62 个 id 全覆盖**（hy4-preview 已在），Min plan 列分布 **Go 40 / GOAT 4 / Pro 13 / Max 5**；官方 `plans.md` 明文钦定「回答 which models can I use 就读 models.md 的 Min plan 列」——它就是官网数据的官方投影。
3. **交叉验证零分歧**：从官网 `availability` 按 Go < GOAT < Pro < Max 推导出的 Min plan 与 models.md 手写值 **62/62 逐模型一致**（见 §四）。两源同源可信。
4. **`tencent/hy4-preview` 三源全在**（官网 payload / models.md / sitemap 专页），套餐为 **Go and above**（availability 九档全 true）。元数据调研记录的「CLI 缺 hy4」已过时（疑为当时 jsDelivr 12h CDN 缓存旧版所致）。
5. **jiesou 的 `isGoModel` 启发式已漂移，不建议采用**：官方明文「plan tiers gate by billing category, not open- vs closed-source」；实测当前 62 id 下它漏掉 3 个 Go 可用模型（`thinkingmachines/inkling`、`thinkingmachines/inkling-small`、`poolside/laguna-s-2.1-free`，前缀不在其白名单），0 个误保。
6. **推荐组合**：主源 models.md（markdown 表格解析，带 `x-jsd-version` 审计头）→ 兜底官网 `/docs/resources/pricing-limits` 的 RSC payload（结构化 availability，但解析链路脆弱、需 slug→wire id 映射）→ 再兜底上次成功解析的仓库内快照 → 最后才是（打过补丁的）前缀启发式。详见 §六。

---

## 一、官方文档「套餐→可用模型」页面实测

### 1.1 页面在哪（不在 sitemap）

`https://commandcode.ai/sitemap.xml`（响应头 `x-sitemap-generated: 2026-08-28`，内容很新）里**没有任何 `/docs` 路径**——文档站整体不进 sitemap。真实 URL 由 CLI 包内 `reference/plans.md` 官方给出（见 §二），实测全部 HTTP 200：

| URL | 状态 | 大小 | payload 内模型行数 |
|---|---|---|---|
| `https://commandcode.ai/docs` | 200 | 295 KB | 0 |
| `https://commandcode.ai/docs/plans/go` | 200 | 357 KB | **65（全量）** |
| `https://commandcode.ai/docs/plans/goat` | 200 | 589 KB | 62（转义层级不同，见 1.4） |
| `https://commandcode.ai/docs/plans/pro` | 200 | 643 KB | 62（同上） |
| `https://commandcode.ai/docs/plans/max` | 200 | 281 KB | 0 |
| `https://commandcode.ai/docs/resources/pricing-limits` | 200 | 637 KB | **65（全量）** |
| `https://commandcode.ai/docs/resources/usage-limits` | 200 | 220 KB | 0 |

候选路径 `/docs/models`、`/docs/plans`、`/docs/pricing` 未在 plans.md 的链接清单中出现（sitemap 与 plans.md 均未提及，未单独深挖）。

### 1.2 渲染方式：Next.js App Router SSR + RSC flight payload

原始 HTML 里无 `__NEXT_DATA__`（Pages Router 标志），而是 20~44 块 `self.__next_f.push([1,"<字符串字面量>"])`——App Router 的流式 RSC payload。数据**在首屏 HTML 里**（无需执行 JS），对爬取友好；但对解析者藏在「JS 字符串字面量 → 转义的字符串化 JSON」两层嵌套里。

页面可见形态是 HTML `<table>`（go 页 1 个 `<table>`、13 处「Available on GOAT and above.」式文案）——给人看的是套餐页表格，给机器的数据全在 payload。

### 1.3 payload 里的数据结构（核心发现）

从 `/docs/plans/go` 与 `/docs/resources/pricing-limits` 的 payload 各提取出**同一个 65 行数据集**，结构：

```json
{
  "rows": [{
    "id": "laguna-s-2.1-free",
    "name": "Laguna S 2.1",
    "category": "opensource",
    "availability": {
      "individual-go": true, "individual-goat": true, "individual-pro": true,
      "individual-pro-v1": true, "individual-provider": true, "individual-max": true,
      "individual-ultra": true, "teams-pro": true, "all": true
    },
    "contextWindow": 256000,
    "caps": {"text": true, "vision": false, "reasoning": true},
    "tip": "Free while capacity lasts.",
    "deal": {"id": "...", "discountPercent": 100, "free": true},
    "tiers": [{"rates": {"input": 0, "output": 0, "cacheRead": 0}}]
  }, ...]
}
```

- `availability` 的 9 个 key 即官方订阅 SKU：`individual-go` / `individual-goat` / `individual-pro` / `individual-pro-v1` / `individual-provider` / `individual-max` / `individual-ultra` / `teams-pro` / `all`。**这就是「哪个套餐能调用哪些模型」的机器可读原文**，比 models.md 的 4 档 Min plan 更细（多了 provider / ultra / teams / v1 遗留档）。
- `category` 只有 `opensource` / `premium` 两个值（计费类别）。
- 额外白送：`caps`（vision/reasoning）、`contextWindow`、`deal`（promo）、`tiers`（分段费率）。
- 65 行 = API 62 id + 3 个 API 之外条目（见 §4.2）；「套餐页只发本套餐可用行」的猜想不成立——go 页也是全量 65 行下发（前端按 `availability` 过滤展示），抓一页即可拿全量。

### 1.4 解析风险：页面间形态不一致

- **转义层级不一致**：go / pricing-limits 页的 payload 是「字面量 → `\"` → `\"`」两层转义；goat 页只有一层（实测其 `contextWindow` 以 `\"` 单层形式出现）。同一个提取器不能无脑复用到所有 docs 页。
- flight chunk 数量随页面波动（go 24 块 84 KB；goat 页仅 2 块可被标准 push 正则捕获，其余走未知通道）。
- rows 的 `id` 是**官网 slug 而非 wire id**（`deepseek-v4-pro`、`kimi-k2.7-code`、`glm-5.3`、`qwen-3.8-max`），与 API id 之间没有一一对应的机械规则，特例见 §4.2。Breskott 从 `/models` 聚合页抓快照时面对的就是这套 slug。
- Next.js 版本升级、页面改版都可能改变 payload 形态，无任何稳定性承诺（这是营销/文档页，不是 API）。

### 1.5 排除的其他站点页面

- `https://commandcode.ai/models`（聚合页）：**不是 Next.js**（无 `self.__next_f`），标题「All coding models supported by Command Code」，数据走 `application/ld+json` ×5 + `window.__` ×8，**无任何套餐字段**（grep `min plan / go plan / availability` 均为 0）。Breskott 的 58 模型快照来自此页，只适合抓元数据，不适合套餐。
- `https://commandcode.ai/pricing`：营销页，无 `individual-*` SKU、无模型表，仅 1 处「Go plan」字样。

## 二、CLI 包内 bundled 知识目录（1.37.0）

tarball `https://registry.npmjs.org/command-code/-/command-code-1.37.0.tgz`（约 1.0 MB）解包后，`dist/bundled/command-code-knowledge/` 下共 **17 个 markdown 文件**（`SKILL.md` + `reference/` 16 个）：`byok / custom-agents / custom-slash-commands / headless / hooks / mcp / memory / models / permissions / plan-mode / plans / product-help / sessions / skills / tools`。同目录树其余是 agent-browser、config、design、mod-builder、skill-builder 等无关技能包。

- **整个包没有任何 JSON/结构化数据文件**（全包仅 `package.json` 一个 JSON）；没有 models.json。plan/goat/套餐相关内容散落在 7 个 md（models、plans、SKILL、product-help、tools、hooks、custom-slash-commands），但 **per-model 套餐数据只有 models.md 一处**。
- `plan-mode.md` 是「计划模式」（plan mode）功能文档，与订阅套餐无关，别被文件名骗了。
- `reference/plans.md` 全文只有 16 行，是**指针文件**，信息密度极高：
  - 套餐序官方定义：「Individual plans, cheapest first: **Go, GOAT, Pro, Max**」；
  - 官方文档 URL 清单（即 §1.1 表格的出处）；
  - 官方回答「which models can I use」的方式：「once the plan is known, read the **Min plan column in models.md** — the cheapest public plan that serves each model; every higher plan includes it」；
  - 关键定性：「the plan tiers **gate by billing category, not open- vs closed-source**: some closed models are served on Go/GOAT」——从原理上否定了「开源前缀白名单」式启发式；
  - 同样带 `<!-- Generated from the Command Code docs: https://commandcode.ai/docs -->` 头。
- `SKILL.md` 索引对 plans.md 的描述：「Plans, credits, and **per-plan model access**」；并强调模型问题读 models.md、账号/套餐问题读 plans.md + models.md Min plan 列。

**结论**：包内不存在比 models.md 更结构化的套餐数据；models.md 的 Min plan 列是官方钦定（self-describing）的「套餐→模型」数据源。

## 三、models.md 的 Min plan 列（1.37.0 实测）

### 3.1 版本与可达性

- npm tarball 内文件与 jsDelivr `@latest` 响应**逐字节一致**（diff 为空），响应头 `x-jsd-version: 1.37.0`、`x-jsd-version-type: version`、`etag: W/"2ca6-..."`、`cache-control: public, max-age=604800, s-maxage=43200`（CDN 12 小时可能滞后）。
- 元数据调研当天记的「61 行、缺 hy4-preview、Go 39」与今天同一 `x-jsd-version: 1.37.0` 的内容矛盾——当时拿到的应是 CDN 缓存旧版。教训：**以 tarball 或强制 revalidate 的 jsDelivr 为准，且解析时校验行数**。

### 3.2 取值词表与分布（62 行）

去重取值共 4 个：`Go and above` / `GOAT and above` / `Pro and above` / `Max`（注意 Max 是裸词，不带「and above」）。分布：

| Min plan | 模型数 | 模型 |
|---|---|---|
| **Go and above** | **40** | deepseek/deepseek-v4-pro, deepseek/deepseek-v4-flash, deepseek/deepseek-v4-flash-vision-exp, moonshotai/Kimi-K3, moonshotai/Kimi-K2.7-Code, moonshotai/Kimi-K2.7-Code-Highspeed, moonshotai/Kimi-K2.6, moonshotai/Kimi-K2.5, z-ai/glm-5.3-flash, zai-org/GLM-5.3, zai-org/GLM-5.2, zai-org/GLM-5.2-Fast, zai-org/GLM-5.1, zai-org/GLM-5, MiniMaxAI/MiniMax-M3, MiniMaxAI/MiniMax-M2.7, minimax/minimax-m3-free, minimax/minimax-m2.7-free, MiniMaxAI/MiniMax-M2.5, xiaomi/mimo-v2.5-pro, xiaomi/mimo-v2.5, Qwen/Qwen3.8-Max, Qwen/Qwen3.8-27B, Qwen/Qwen3.8-Flash, Qwen/Qwen3.7-Max, Qwen/Qwen3.7-Plus, Qwen/Qwen3.7-Flash, Qwen/Qwen3.6-Max-Preview, Qwen/Qwen3.6-Plus, stepfun/Step-3.7-Flash, stepfun/Step-3.5-Flash, tencent/hy3-paid, **tencent/hy4-preview**, nvidia/nemotron-3-ultra-550b-a55b, thinkingmachines/inkling, thinkingmachines/inkling-small, poolside/laguna-s-2.1-free, gpt-5.6-luna, meta/muse-spark-1.2-contributor, xai/grok-4.5 |
| GOAT and above | 4 | gpt-5.6-sol, google/gemini-3.7-flash, meta/muse-spark-1.2, xai/grok-4.6 |
| Pro and above | 13 | claude-sonnet-5, claude-sonnet-4-6, claude-haiku-4-5-20251001, gpt-5.6-terra, gpt-5.5, gpt-5.4, gpt-5.3-codex, gpt-5.4-mini, google/gemini-3.6-flash, google/gemini-3.5-flash, google/gemini-3.5-flash-lite, google/gemini-3.1-flash-lite, meta/muse-spark-1.1 |
| Max | 5 | claude-fable-5, claude-opus-5, claude-opus-4-8, claude-opus-4-7, sakana/fugu-ultra |

- 62 行 id 与 API 62 id **集合完全一致**（无缺失、无 API 之外的 id）——元数据调研的「61/62」已过时。
- 覆盖品类观察：`category=opensource` 的模型全部 Go 档起步；premium 27 个中 Go 3 + GOAT 4 + Pro 13 + Max 6（第 6 个 Max 是 API 之外的官网旧条目 claude-opus-4-6，见 §4.2）+ all 1。「开源 = Go 可用」当前碰巧成立，但官方口径是按计费类别门控（plans.md 原文），两者只是今天恰好重合。

### 3.3 「Min plan 取值 → Go plan 可用」映射规则

models.md 尾注自述语义：「Min plan is the cheapest public plan that serves the model, ordered **Go < GOAT < Pro < Max** (see plans.md)」。规则因此是：

```text
normalize(v) = v 去掉后缀 " and above"   # "Max" 无后缀，自然归一
值域断言: normalize(v) ∈ {"Go","GOAT","Pro","Max"}
go_plan_available(model) ⇔ normalize(min_plan(model)) == "Go"
# 等价的通用形式（新套餐出现时自动正确）：tier(normalize(v)) <= tier("Go")，
# 其中 tier 序取自 plans.md 的 cheapest-first 列表。
```

解析层面：markdown 7 列表格（`Id | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for`），8 个 provider 分节（Open Source / Anthropic / OpenAI / Google / Sakana / Meta / xAI 等），行首模式 `` ^| `wire-id` | ``，按 `|` split 后 **Min plan 在第 6 列（index 6）**。无跨行单元格、无内嵌 `|`（价格列用 `·` 分隔），解析为朴素文本处理即可。

## 四、`tencent/hy4-preview` 下落（任务 4）

**三源全在，且口径一致为 Go 档：**

| 来源 | 是否出现 | 套餐信息 |
|---|---|---|
| models.md 1.37.0（tarball 与 jsDelivr 一致） | ✅ 62 行之一 | `Go and above`；Context 1.05M；$0.834/$2.501 · cache $0.042 |
| 官网 payload（go 页与 pricing-limits 页） | ✅ 且 id 恰好是完整 wire id `tencent/hy4-preview`（官网 rows 唯二带 `tencent/` 前缀的条目之一） | `availability` 九档全 `true`（含 `individual-go`）→ 推导 Min plan = Go |
| sitemap（`https://commandcode.ai/models/hy4-preview`，lastmod 2026-04-30） | ✅ 有独立专页 | — |

元数据调研记录的「models.md 缺 hy4-preview」判定作废：今天 tarball 与 jsDelivr 均为 62 行全量。差异最可能是当天 jsDelivr 返回了 CDN 缓存旧版（该 CDN 对 `@latest` 有 s-maxage=43200 的缓存窗口）。

### 4.2 附带发现：官网 rows 比 API 多 3 个条目

65 行中有 4 个不与 API 62 id 精确对应：

| rows id | category | 推导 Min plan | 说明 |
|---|---|---|---|
| `nemotron-3-ultra` | opensource | Go | 即 API 的 `nvidia/nemotron-3-ultra-550b-a55b`（slug 去掉了参数后缀），不是额外模型 |
| `ling-3.0-flash-free` | opensource | all（仅 `all:true`） | 免费模型，不在 API 62 内 |
| `claude-opus-4-6` | premium | Max | API 已下架的旧模型，官网残留 |
| `claude-sonnet-4-5` | premium | all（仅 `all:true`，9 SKU 中仅 all 为 true） | API 已下架；「all-only」语义存疑，疑为官网数据残留 |

构建侧若用官网 payload 兜底，需容忍这 3 个 API 外条目（按「API id 集合为主、payload 为映射表」的方向使用即可规避）。

### 4.3 slug → wire id 映射规则（仅兜底解析需要）

官网 rows id 与 API wire id 的换算无统一函数，实测特例全集：

- `tencent/hy4-preview`、`tencent/hy3-paid`：**保留 `tencent/` 前缀**（唯二带前缀的 rows）；
- 其余：小写、去 vendor 前缀、`_`→`-`、**点号保留**（`kimi-k2.7-code`、`glm-5.3`、`gpt-5.6-sol`、`muse-spark-1.2`）；
- Qwen 系点号另有形态：`Qwen/Qwen3.8-Max` → `qwen-3.8-max`（`qwen` 后插 `-`，版本点号保留）；
- 去日期后缀：`claude-haiku-4-5-20251001` → `claude-haiku-4-5`；
- 去 `-preview`：`Qwen/Qwen3.6-Max-Preview` → `qwen-3.6-max`；
- 去参数后缀：`nemotron-3-ultra-550b-a55b` → `nemotron-3-ultra`。

这些特例随时可能新增（每上一个新模型就可能多一个形态），是官网 payload 路线的最大解析负担——models.md 路线完全绕开它（Min plan 列直接就是 wire id）。

## 五、jiesou `isGoModel` 启发式实测偏差

按 `docs/research/reference-projects.md` §二记录的规则（开源前缀白名单全保留 + 3 个 premium 例外 `gpt-5.6-luna`、`xai/grok-4.5`、`meta/muse-spark-1.2-contributor`；google/sakana/claude/gpt/gemini/grok/fugu/muse-spark 排除）在今日 API 62 id 上模拟：

- **误保（保留但官方非 Go）：0 个**；
- **漏保（官方 Go 但被排除）：3 个**——`thinkingmachines/inkling`、`thinkingmachines/inkling-small`、`poolside/laguna-s-2.1-free`（`thinkingmachines/`、`poolside/` 不在白名单，也不是任何例外）；
- 即当前 jiesou 规则会少暴露 3 个 Go 可用模型（占 Go 档 40 个的 7.5%），且每新增一个非白名单前缀的开源模型就会继续漏。

「3 个 premium 例外」的官方真相（premium category 但 Go/GOAT 档的完整清单，来自 availability）：Go 档 3 个（`gpt-5.6-luna`、`meta/muse-spark-1.2-contributor`、`xai/grok-4.5`——恰为 jiesou 的例外表）+ GOAT 档 4 个（`gpt-5.6-sol`、`google/gemini-3.7-flash`、`meta/muse-spark-1.2`、`xai/grok-4.6`）。jiesou 对 Go 过滤的结果碰巧只差那 3 个开源系新前缀，属「例外表过时 + 白名单过时」双重漂移，不可作为构建侧依据。

## 六、结论：数据源推荐与降级链（任务 5）

### 6.1 推荐：models.md 为主源

| 候选 | 解析稳定性 | 格式漂移风险 | 覆盖 | 判定 |
|---|---|---|---|---|
| **models.md（jsDelivr）** | 高：纯 markdown 表格、朴素行解析、无 JS/转义 | 中：列序/措辞可能变（缓解：列头断言「Min plan」+ 值域断言 + 行数对账）；CDN 12h 滞后 | 62/62（今日实测），官方钦定语义 | ✅ **主源** |
| 官网 RSC payload（pricing-limits / go 页） | 低：flight chunk 重组 + 多层转义 + 页面间层级不一致 + slug 映射特例 | 高：前端框架升级即可破坏，且是文档页非 API | 65 行全量，9 SKU 布尔（比 4 档更细） | ⚠️ 兜底 |
| 包内其他文件 | — | — | plans.md 无 per-model 数据，全包无 JSON | ❌ 无增量价值 |
| `/models` 聚合页、`/pricing` 页 | 中 | 中 | 无套餐字段 | ❌ 排除 |
| isGoModel 启发式 | 高（纯函数） | 已漂移：漏 3 个、官方明确否定其原理 | — | ❌ 仅末级应急 |

推荐理由：models.md 是**官方对「哪个套餐能用哪些模型」这一问题的钦定答案载体**（plans.md 明文），id 直接是 wire id（零映射），与官网 availability 数据今日实测 62/62 零分歧（同源投影），且解析面（markdown 表格）远小于官网 payload（RSC flight）。元数据调研 §七已将「最低套餐 plan」字段的第一来源定为 models.md——本次调研用官网数据交叉验证后维持该结论，并把兜底链补全。

### 6.2 GitHub Action 提取流程建议

```text
主路径：
  GET jsDelivr @latest models.md（记录 x-jsd-version + etag 入快照元数据）
  → 按行 ^\| `id` | 解析 7 列，取 col[6]
  → 断言：列头含 "Min plan"；normalize 后值域 ⊆ {Go,GOAT,Pro,Max}；id 集合与 /models API 对账
  → 产出 plan-map.json {wire_id: "Go"|"GOAT"|"Pro"|"Max"}，Go plan 过滤 = 值为 "Go" 的子集

降级 1（主路径断言失败/网络失败）：
  GET commandcode.ai/docs/resources/pricing-limits（次选 /docs/plans/go）
  → 正则抽 self.__next_f.push([1,"..."]) 全部字面量，逐块 JSON.parse 拼接为 flight 文本
  → 先按双层转义还原（\\ 与 \" 用占位符法），找 {"rows":[{"id" 起始做平衡括号截取 + JSON.parse；
     失败再试单层转义（goat/pro 页形态）
  → availability 按 individual-go → individual-goat → individual-pro → individual-max 推导 Min plan
  → slug→wire id 映射回 API id 集合（§4.3 规则 + 特例表，映射不上的行丢弃并告警）

降级 2（官网也不可达/解析失败）：
  使用仓库内上次成功解析的 plan-map.json 快照（GH Action 每次成功后 commit 回仓库）

末级应急（无任何快照）：
  前缀启发式（jiesou 规则 + 打补丁：白名单补 thinkingmachines/、poolside/），
  并在 provider 初始化日志中显式标注「套餐过滤为启发式降级」
```

配套监控建议：每次解析记录 `x-jsd-version`、行数、值域分布（当前基线 Go 40 / GOAT 4 / Pro 13 / Max 5）；分布突变（如 Go 从 40 跳变）或 id 对账失败时开 issue 而非静默采用。CI 内可加一条静态校验：`models.md` 若出现新 Min plan 取值（新套餐上线），构建应失败提醒人工确认套餐序。

### 6.3 残留不确定性

- 两源更新时序未知（新模型上线时官网 payload 与 npm 包谁先更新无数据）；主路径每日 cron + 对账 API id 已能把窗口压到一天内。
- `individual-provider`、`individual-ultra`、`teams-pro`、`individual-pro-v1` 四个 SKU 与公开四档的从属关系未逐一验证（公开计划文档只列 Go/GOAT/Pro/Max）；本决策只用 `individual-go` 判 Go 档，不受影响。
- 「all-only」条目（ling-3.0-flash-free、claude-sonnet-4-5）的语义未证实；均不在 API 62 id 内，不影响构建。

---

## 附录：实测方法

- **官网文档页**：`curl -D <headers> -o page.html` 逐页抓取 7 个 `/docs` URL 与 `/models`、`/pricing`、`sitemap.xml`（输出均在 /tmp/opencode/cc-plan-research/）。渲染判定：grep `__NEXT_DATA__` / `self.__next_f` / `application/ld+json`；数据形态判定：对 go 页写了两段一次性 node 脚本（`extract_rsc.mjs`：正则捕获 `self.__next_f.push([1,"…"])` 字面量 → `JSON.parse` 拼接 flight → 占位符法双层 unescape → `{"rows":[{"id"` 定位 + 平衡括号截取 → `JSON.parse`），对 goat 页做了转义层级对照。全程仅解析文本，未执行任何页面/包代码。
- **npm tarball**：`curl` 下载 `command-code-1.37.0.tgz` → `tar -xzf` 解到 /tmp → `find` 列目录 → 仅 `Read`/`grep` 文本分析；对照 `diff` 校验 tarball 与 jsDelivr 内容一致性；`x-jsd-version` 从响应头记录。
- **Min plan 统计与三源对账**：node 脚本按 `` ^\| `id` \| `` 行解析 models.md 第 6 列；`availability` 按 Go<GOAT<Pro<Max 推导 Min plan；以 `/provider/v1/models` 实时 62 id 为主表做三源交叉（匹配脚本 `compare2.mjs`）；jiesou 启发式按其源码规则在 62 id 上复算。
- 红线遵守：未读取 `~/.commandcode/`、`~/.pi/` 等任何本机凭据路径；未安装/执行 CLI；临时文件全部位于 /tmp/opencode。

## 参考链接

- 官方文档套餐页：`https://commandcode.ai/docs/plans/go`（及 `/goat`、`/pro`、`/max`）、`https://commandcode.ai/docs/resources/pricing-limits`、`https://commandcode.ai/docs/resources/usage-limits`
- 站点地图（不含 /docs）：`https://commandcode.ai/sitemap.xml`
- 官网模型聚合页（无套餐数据，排除记录）：`https://commandcode.ai/models`
- 模型目录（本决策推荐主源）：`https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md`
- 套餐指针文件（官方套餐序与 URL 清单）：`https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/plans.md`
- npm registry：`https://registry.npmjs.org/command-code/-/command-code-1.37.0.tgz`
- 模型发现 API：`https://api.commandcode.ai/provider/v1/models`
- hy4-preview 官网专页：`https://commandcode.ai/models/hy4-preview`
- 本仓库背景调研：`docs/research/model-metadata-sources.md`、`docs/research/reference-projects.md`

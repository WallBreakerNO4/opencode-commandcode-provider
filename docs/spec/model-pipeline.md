# 模型管线规格：构建产物 schema 与运行时合并级联

> 状态：定稿（2026-08-29）。决策票：[WallBreakerNO4/opencode-commandcode-provider#4](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/4)。
> 事实输入：`docs/research/model-metadata-sources.md`（来源矩阵）、`docs/research/plan-model-mapping.md`（官方套餐→模型映射）。
> 范围：模型管线模块的两侧契约——构建侧产物 schema 与 Go plan 过滤规则、客户端运行时合并级联与降级。分发渠道选型、GitHub Action 流水线实现、伪装层由其他票承接，本文只约束与它们的接口。

## 0. 三来源架构

| 来源 | 角色 | 参与时机 |
|---|---|---|
| `GET /provider/v1/models` | 发现（id 清单）与 `context_length` 的权威 | 运行时拉取，匿名即可（带 key 实测无差异） |
| 官方 CLI 包（npm `command-code`） | 模型元数据的唯一权威：efforts、reasoning、contextWindow、maxOutputTokens、inputModalities、name、Min plan（Go 过滤依据） | 仅构建侧解析（GitHub Action 随官方发版触发）；解包动作绝不发生在用户机器上 |
| 包内快照 | 与构建产物同 schema 的「最后已知良好产物」，随插件发版内置 | 运行时兜底，永远可用 |

**models.dev 不参与本项目**（构建侧与客户端均不拉取）：价格砍出 v1 后它没有独有字段；efforts 只认官方 CLI；其 limit/cost 是第三方视角值。将来若需引入，按 §1.2 的演进规则以新增可选字段方式回归，不改现有字段语义。

## 1. 构建产物 schema v1

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-29T00:00:00Z",
  "sourceCliVersion": "1.37.0",
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
| `sourceCliVersion` | ✅ | 解析所用的 `command-code` 版本，仅作溯源；伪装层的 `x-command-code-version` 头不从它取（伪装层独立从 npm registry 拉 latest，此字段只作离线兜底） |
| `models` | ✅ | 模型数组，**仅含 Go plan 可用子集**（见 §2） |

per-model：

| 字段 | 必填 | 构建侧来源 | 说明 |
|---|---|---|---|
| `id` | ✅ | models.md Id 列（与 API id 同一 wire id） | 主键 |
| `name` | ✅ | bundle `label`/`name` | 展示名 |
| `reasoning` | ✅ | bundle `reasoning` | 布尔；bundle 缺省该字段的模型即非推理模型，构建侧显式写出 `false` |
| `inputModalities` | ✅ | bundle `inputModalities` | 取值仅 `["text"]` / `["text","image"]`；不引入 models.dev 的 pdf/audio 细分（协议层只转发图片） |
| `efforts` | 可选 | bundle `reasoningEfforts`（与 models.md Efforts 列同源，逐值一致） | 严格透传官方词表（当前 `low/medium/high/xhigh/max`）；无档位的模型**不写该字段**，不造空数组、不造占位值 |
| `context` | 可选 | bundle `contextWindow` | 运行时通常被 API 覆盖；缺失时兜底常量 200000 |
| `maxOutput` | 可选 | bundle `maxOutputTokens` | 仅极少数模型有值；缺失时兜底常量 32000 |

**无价格字段**：v1 明确不做价格（理由见 §6），`cost` 留待将来以新增可选字段方式回归。

### 1.2 版本演进

- `schemaVersion` 为整数。**同版本内只允许新增可选字段**；客户端必须忽略未知字段（向前兼容）。
- 破坏性变更（删字段、改类型、改语义）必须递增 `schemaVersion`。
- 客户端遇到大于自身已知上限的版本号：**整体弃用该产物**，按 §5 降级到包内快照，并告警。不做多版本兼容解析。

### 1.3 渠道无关约束

- schema 与客户端代码不得包含渠道特有概念（如 gist revision、Release tag 语义）。
- 客户端按**有序 URL 列表**拉取产物：代码内置默认列表（由「分发渠道选型」票确定），用户配置可覆盖；按序尝试，首个成功者胜。

## 2. 构建侧契约

输入：`command-code@<version>` tarball（解包仅做文本解析，绝不执行包内代码）+ `/provider/v1/models` 实时清单（对账用）。

1. **bundle 逆向**（`dist/cli.mjs`）：提取模型目录字段（`id/label/name/reasoning/reasoningEfforts/contextWindow/maxOutputTokens/inputModalities`）。注意 1.37.0 结构：provider 为独立常量、目录对象按「`={` + 平衡括号」截取、getter 与标识符引用需注入求值（方法详见 `docs/research/model-metadata-sources.md` §五）。
2. **models.md 解析**（`dist/bundled/command-code-knowledge/reference/models.md`，与 tarball 内文件同源）：Min plan 在第 6 列（index 6），按行首 `` | `wire-id` | `` 模式解析；normalize = 去掉后缀 `" and above"`（`Max` 为裸词，自然归一）。
3. **Go plan 过滤**：保留 normalize 后 `== "Go"` 的模型。官方语义：Min plan 是能调用该模型的最便宜档位，高档包含低档全部模型，套餐序 `Go < GOAT < Pro < Max`。当前基线 40 个模型。
4. **对账与断言**（任一失败则构建失败、开 issue，不静默出产物）：
   - models.md 列头含 `Min plan`；normalize 值域 ⊆ `{Go, GOAT, Pro, Max}`（新取值出现 = 新套餐上线，需人工确认套餐序）。
   - 产物 id 集合 ⊆ `/models` API id 集合；bundle 目录中 API 之外的条目（隐藏 free 等）不进产物。
   - 监控基线：Min plan 分布 Go 40 / GOAT 4 / Pro 13 / Max 5；分布突变即人工复核。

## 3. 运行时合并级联

原则：**每字段单一天窗**，权威 = 离网关事实最近的来源；包内快照永远最后。

| 字段 | 权威 | 兜底链 |
|---|---|---|
| 发现（暴露哪些 id） | API ∩ 产物（Go 过滤已在构建侧完成） | API 失败 → 产物 id 清单；再失败 → 快照 id 清单 |
| `context` | API `context_length`（网关实际执行值） | 产物 `context` → 快照 → 常量 200000 |
| `name` | API | 产物 → 快照 |
| `efforts` / variants | 产物 | 无 |
| `reasoning` / `inputModalities` / `maxOutput` | 产物 | 快照 → 常量（32000 / 200000） |
| `tool_call` | 常量 `true` | — |

暴露规则（保守）：

- API 有而产物无 → **隐藏**（可能是非 Go 档的新模型，防止 403 漏到用户面前）。
- 产物有而 API 无 → **隐藏**（已下架；发现的权威是 API）。
- 快照兜发现时规则同上，只是「产物」换成「快照」。

### 3.1 variants 构造（严格透传）

- 产物有 `efforts` → 按档位生成同名 variants（v1 为 map 形状、v2 为数组形状）；base 模型不发送 `reasoning_effort`，交网关/模型自决。
- 产物无 `efforts` → **不造任何变体**。官方没给的档位就是不存在的档位：不得手动补全、不得降级为「暴露全部档位」（jiesou 式降级弃用）。
- **不做任何档位词过滤**：上游给什么透传什么（含将来可能出现的 `none`/`minimal`），不发明白名单。

### 3.2 消费映射（v1 / v2）

- v1 模型 entry：`{id, name, tool_call: true, reasoning, attachment, modalities, limit: {context, output}, variants}`；不写 `cost`。
- v2 `Model.Info`：`capabilities: {tools: true, input: <inputModalities>, output: ["text"]}`、`limit`、`variants: [{id: <档位>, settings: {reasoningEffort: <档位>}}]`；`cost` 省略。
- 字段形状细节以 `docs/research/opencode-plugin-provider.md` §3/§4 为准，由 v1/v2 glue 票承接。

## 4. 刷新与缓存

| 数据源 | 节奏 |
|---|---|
| `/models` API | 匿名拉取；TTL 5min；变更签名 = 排序后 `(id, context_length)` 序列，**必须剔除 `created`**（它是响应生成时刻的动态时间戳，不剔必误判「列表变了」） |
| 构建产物 | 按 §1.3 的有序 URL 列表拉取；TTL 1h + 随机抖动；对 `models` 数组做内容 hash，变化才触发下游动作（v2 `catalog.reload()`）；渠道支持时带 ETag/Last-Modified |
| v1 客户端 | 启动拉取一次（15s 超时），失败用快照；**不做后台刷新**（v1 无 reload 机制） |
| v2 客户端 | 启动零阻塞：`catalog.transform` 先用快照注册，后台拉 API + 产物，签名变化才 `catalog.reload()` |

## 5. 降级行为

包内快照 = 与产物同 schema 的 JSON，随插件发版从最新产物复制进来。级联统一为三层，快照即「最后已知良好产物」，全程只需一套解析代码。

| 场景 | 行为 |
|---|---|
| API + 产物正常 | 完整级联 |
| API 失败 | 发现退化为产物 id 清单；告警 |
| 产物失败 | 快照顶替产物角色；告警 |
| 全部失败（离线） | 快照全量注册，照常可用（数据可能过期）；指数退避重试（30s 起、上限 30min），任一来源恢复即回到完整级联 |

- v2 不采用「失败保持空列表等待刷新」方案（Breskott 式）——有同构快照，没理由让用户面对空模型列表。
- 所有降级路径打 opencode log warn，注明退到了哪一层。

## 6. 备选与否决记录

| 备选 | 否决理由 |
|---|---|
| models.dev 参与运行时级联（四层方案） | 4.4MB 拉取 + 脆弱的别名匹配链路进客户端；对订阅制用户，「价格/档位更新快几小时」没有实际收益 |
| models.dev 参与构建侧合并 | 价格砍出 v1 后无独有字段；efforts 只认官方 CLI（其档位与 limit 同为第三方视角） |
| 价格字段（`cost.*`） | v1 明确砍掉：实现链路长（三来源对账 + 官方 promo 口径校正），订阅制下展示收益薄；schema 演进规则留门 |
| isGoModel 前缀启发式（jiesou） | 官方明文「套餐按计费类别门控，与开源/闭源无关」；实测已漏 3 个 Go 可用模型；仅可作为 §2 断言链末级应急且需打补丁，不作常规依据 |
| off 变体 | 实测 off ≡ 不发送 `reasoning_effort` ≡ base 模型，造了是冗余 |
| 官网文档 RSC payload 作套餐主源 | flight chunk 重组 + 页面间转义层级不一致 + 前端升级即碎；降级为 §2 断言链的兜底数据源 |

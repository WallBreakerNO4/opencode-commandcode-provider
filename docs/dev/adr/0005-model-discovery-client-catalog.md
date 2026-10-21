# 模型发现迁移至 view=client catalog：构建侧并集补集，运行时产物全集

> 状态：accepted（2026-10-21）。规格与决策票：[#61](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/61)（含 2026-10-20 勘误评论）；实现：[#62](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/62)（构建侧）、[#63](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/63)（变更检测）、[#64](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/64)（运行时）、[#65](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/65)（文档收口）。

## 背景与问题

官方 CLI 1.84.0 起，运行时模型发现改为 `GET https://api.commandcode.ai/provider/v1/models?view=client`：响应顶层为 `{schemaVersion, catalogVersion, refreshAfterSeconds, roles, data}`，条目带 `minimumPlan`、`hidden`、`context_length` 等字段。普通 `/provider/v1/models` 在官方 CLI 源码中已零引用，响应也没有 `minimumPlan` / `hidden`——而插件此前的整个模型管线（构建侧 Go 过滤、运行时发现、`context` 权威）都建立在这个端点之上。

故障因此不是单点的：Go plan 用户看不到 1.84.0 已开放的 `stealth/cat-jam:free` 与另外 3 个新模型；构建流水线自 1.84.0 起持续失败（#55），先是 bundle 锚点解析失败，后是对账断言「产物 id ⊆ 普通 `/models` API id 集合」因 cat-jam 不在 API 清单而失败；产物停留在 1.82.2 时代。需要重新回答三个问题：

1. **发现权威**：官方已换代后，构建侧与运行时各以什么为「有哪些模型」的权威？
2. **tarball 的角色**：bundle 逆向与 models.md 解析是否还需要？结构漂移应不应该继续阻塞发布？
3. **代理指标**：「API 是否收录」能否继续当作「官方是否隐藏」的判据？

## 决策

### 构建侧

- **发现权威 = `view=client` catalog**。每次构建硬依赖该端点；失败即构建失败。
- **Go plan 判据 = `minimumPlan === "individual-go"` 且 `hidden !== true`**。套餐档位词表为 `individual-go` / `individual-goat` / `individual-pro` / `individual-max` / `individual-provider`；出现词表外新值即构建失败、自动开 issue 人工确认。
- **产物集合 = `view=client` 的 Go 可见条目 ∪ 内嵌目录中「Go 可见但 `view=client` 缺失」的条目**。同 id 时远程条目优先。当前实例（2026-10-20）：58 + `stealth/cat-jam:free` = 59。
- **tarball 解析保留但降级为软兜底**。下载、解包、bundle 锚点或字面量解析任一失败只打 warn，产物退化为纯 `view=client` 集合，不阻塞发布。tarball 只做文本解析，绝不执行包内代码。
- **models.md 解析完全退役**。它不含 `hidden`，无法判定产物集合；Go 过滤与 efforts 都不再需要它。
- **产物 schema 保持 v1**，新增可选字段 `catalogVersion`（构建时 `view=client` 的版本号，供 build-meta 与溯源）；`sourceCliVersion` 保留。运行时解析器忽略未知字段，旧插件可照常消费新产物。
- **对账断言重写**：保留并改写 Min plan 值域（五值）、产物非空、Go 计数 ±5 漂移监控、模态词表；产物组装另有必填字段 fail-fast（缺 `name` / `label` 或 `inputModalities` 即失败）。删除「产物 id ⊆ API id 集合」与「Efforts 两源互证」。
- **变更检测加入 `catalogVersion`**：workflow 用 build-meta 中的值作 `If-None-Match` 条件请求；304 或同值不重复构建。官方只更新 catalog、不发 CLI 新版时也能在轮询周期内触发构建。

### 运行时

- **发现权威 = 产物全集**（产物角色由构建产物、内存中的上次成功产物或包内快照扮演）。client catalog 不再做交集过滤，catalog 独有条目不注册。
- **`context` / `name` 的字段级权威 = client catalog**：`context_length` 是网关实际执行值，`name` 是展示名；catalog 失败时回落产物 / 快照值，模型列表不缩小。
- **刷新跟随官方声明**：TTL 取响应 `refreshAfterSeconds`（当前 900s），`If-None-Match` 用 `catalogVersion`，变更签名 = 排序后 `(id, context_length)` 序列。
- **上游下架但产物未更新时条目照常注册**：用户选中后收到网关错误，与官方 CLI 用户承担一致的风险面；不让模型从列表里凭空消失。
- 产物拉取层、包内快照、指数退避与三渠道分发机制不变；v1 冻结面不动，全部改动落在共享模块。

## 为什么这样取舍

### 为什么复刻源码语义，而不是官方线上现状

远程 catalog 正常时，官方 CLI 的选择器不显示 cat-jam（远程未收录）；只有远程不可用、退回内嵌目录时才显示。但官方源码的判定语义是「远程查不到 → 内嵌目录兜底放行」，且对未知模型默认放行。维护者选择复刻**源码可调用语义**：cat-jam 在官方内嵌目录中是 Go 档、无隐藏标记、带 free 徽章与配额公告，远程收录滞后不应成为插件用户的可见性差异。

代价是接受「产物有而 catalog 无」的条目继续暴露；上游若已真正下架，用户会在调用时收到网关错误。这与官方 CLI 用户的风险面一致，且比「列表静默缩水」更可解释。

### 为什么 tarball 保留但软兜底

#61 正文最初假设 cat-jam 已在 `view=client` 中，据此计划让 tarball 整体退役。2026-10-20 复核实测证明该前提有误：cat-jam 只在官方 CLI 包内嵌目录，远程 catalog 尚未收录。没有 tarball 就没有补集，方案 A 会漏掉这个官方源码路径实际允许调用的模型。

因此 tarball 保留，但只承担「补集」这一件事，且失败不阻塞发布。bundle 结构漂移（#55 第一层故障）从「流水线卡死」降级为「少补若干模型 + 一条告警」——这是可接受的降级，因为主集合仍由 `view=client` 保证。

### 为什么删除代理指标断言

旧断言用「API 收录与否」当作「官方是否隐藏该模型」的代理指标。cat-jam 是它失效的首案：官方内嵌目录与 models.md 均标注 Go 档可用、无隐藏标记，官方 CLI 靠内嵌目录兜底照常放行，只是普通 API 清单尚未收录。该断言的失败不是数据异常，而是指标本身错了。删除后不做替代断言——官方是否隐藏直接读 `hidden` 字段，官方是否 Go 可见直接读 `minimumPlan`，两者都在新数据源里是原生字段。

## Considered Options

- **继续使用普通 `/provider/v1/models`**：端点在官方源码中已零引用，缺 `minimumPlan` / `hidden`，无法判定 Go 可见性；已造成 5 天数据落后与流水线连环失败。否决。
- **仅 `view=client` 直出（方案 A）**：会漏掉只存在于内嵌目录的 cat-jam；与官方源码的兜底语义不一致。否决（勘误后改方案 B）。
- **复刻官方线上现状（远程 catalog 正常时隐藏 cat-jam）**：把官方远程收录滞后固化成插件行为，用户的可用模型取决于官方数据同步进度而非源码能力。否决。
- **tarball 下载与解包整体退役**：前提「view=client 已含 cat-jam」经实测有误；退役后无法补集。否决。
- **运行时发现 = catalog ∩ 产物**：catalog 滞后会隐藏官方已上线的新模型；旧实现正是因此让新模型不可见。否决。
- **运行时保留普通 `/models` 作降级源**：维护两条会分叉的 `context` 口径，且官方已淘汰该端点。否决。
- **catalog-only 变更不触发构建**：违反「新模型 30 分钟内可见」对官方只更新 catalog、不发 CLI 新版的场景。否决。

## Consequences

- **新鲜度**：官方发版或 catalog-only 变更后，下一轮 15 分钟轮询触发构建；三条发布渠道照旧，≤30 分钟 SLA 恢复。
- **过时风险接受**：产物全集注册意味着已下架模型可能短暂残留，调用时由网关报错；不做运行时二次过滤。
- **bundle 漂移的故障面缩小**：不再阻塞发布，但补集可能缺失；构建日志必须保留明确 warn，维护者看到 warn 仍应人工适配锚点。
- **兼容性承诺**：schema v1 + 可选 `catalogVersion`，旧插件按未知字段忽略规则消费新产物；旧插件自身拉普通 `/models` 的行为不受影响（端点是否下线由官方控制，下线时走其既有降级路径）。
- **cat-jam 真实调用尚未实测**：迁移前只用 mock 验证。合入后需维护者用真实 key 人工发一条消息；若网关拒绝，按「复刻官方源码、上游问题记 known-issues」处理，不因此回退发现机制。
- **#55 的关闭时机**：流水线实际恢复绿色后由维护者关闭，评论注明 cat-jam 为代理指标失效首案、根因是官方端点换代；迁移期间保持开放，避免失败自动开 issue 逻辑刷屏。
- 术语「模型清单」「Go plan 过滤」「Min plan」「合并级联」「构建产物」按新数据链更新 `CONTEXT.md`；完整契约见 `docs/dev/spec/model-pipeline.md`。

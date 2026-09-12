# 端到端验收清单：真宿主人工验收（V2 主 + V1 条件复验）

> 状态：换轴修订（2026-09-12）：主路径改为 OpenCode 2 正式版；V1 按 ADR-0004 只在 v1 专属面改动时复验。原版（2026-09-01，决策票 [#21](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/21)）为 v1/v2 双轮。
> 事实输入：`docs/dev/spec/testing.md` §4（真宿主边界与本票分工）、`docs/dev/spec/protocol.md` §3（错误映射文案）、`docs/dev/spec/disguise.md` §3（会话绑定与两套 session id）、`docs/dev/spec/model-pipeline.md`（级联与降级）、`docs/dev/research/v2-stable-contract.md`（V2 正式版契约）、`docs/dev/research/v2-stable-probe.md`（无空壳自举、本地路径写法、冷启动竞态真机事实）、`docs/dev/adr/0004-v1-freeze-and-retention.md`（V1 冻结）、#9（抓包口径）、#22（安装承诺面基准）。
> 范围：实现完成后、发布前后的真宿主人工验收。V2 主路径每轮执行——发布前用本地 dist 预验收、发布后按真 README 走查（两阶段见 `docs/dev/release/release-process.md`）；V1 条件复验见 §2。自动化覆盖面见 `docs/dev/spec/testing.md`，两文互不重复；看门狗与预请求时序**不入**本清单（#20 §4 定案）。

## 0. 前置条件与验收约定

| 项 | 要求 |
|---|---|
| 执行时机 | V2 主路径：每轮发布（发布前本地 dist 预验收 + 发布后真 README 走查）；V1 条件复验：仅当 v1 专属面（`src/host/v1.ts`、v1 专属测试与文档）被改动 |
| 凭据 | 真实 Command Code Go plan API key |
| 宿主版本 | v2 = 最新 stable（本清单按 v2.0.1 契约调研与探针定稿）；v1 = 最新 stable（仅条件复验） |
| 验收机 | 日常使用机即可——伪装人格 = 如实上报真机（#9 定案），无人格需核对 |
| 抓包环境 | HTTPS MITM 代理（mitmproxy 等）接管宿主进程出网；wire 级断言项必需，降级项的断路复用同一环境（按域名/路径断流） |
| 隔离 | 全程 `XDG_*` 重定向至临时目录（方法见 `docs/dev/research/v2-stable-probe.md` §1），不污染日常配置 |
| 缺陷回路 | 验收失败 → 开 issue → 修复 → 仅复验失败项 |

**V2 主路径验收约定（不遵守会误判）：**

- **凭证前置**：未配置凭证（`/connect` 或 `COMMANDCODE_API_KEY`）前，provider 不可见、模型列表为空是预期（探针 A3）；模型与消息类判据一律在凭证就绪后执行。
- **冷启动重试**：服务冷启动后第一次 `plugin list` / `models` 可能为空，**重试一次**再判失败（探针 §5 竞态）。
- **无空壳语义**：验收环境**不写** `providers.commandcode-go` 空壳；provider 应为 `activation:"auto"`——无凭证不可见、有凭证可见（探针 A/B 对照）。写了空壳会把 activation 覆写为 `enabled`（无凭证也虚可见），不作为安装路径。

观察手段图例：**TUI** = 界面直接可见；**日志** = 插件日志（脱敏：伪标识符仅 12 位截断）；**抓包** = MITM 看 wire 级信封。wire 级断言默认抓包，日志只作会话绑定的辅助判据。

注：v2 宿主不调 doGenerate（折叠进 doStream，#5 定案），清单所有项均为 doStream 场景，无单独 doGenerate 项。

## 1. 清单（V2 主路径）

### 1. 全新环境安装走查（含 /connect 登录）

- **步骤**：干净（隔离）环境按当轮路径逐步执行：
  - 发布前（本地 dist）：`opencode --version` 确认 `opencode v2.x` → 全局配置 `plugins` 指向本地 `dist/` 目录（写法规格见 `docs/dev/release/release-process.md` §1）→ 重启 → `/connect` → 发首条消息。
  - 发布后（真 README）：原样执行 README 手动安装节——`opencode plugin add @wallbreakerno4/opencode-commandcode` → 重启 → `/connect`（或 env）→ 发首条消息。**不写任何 provider 空壳键**。
- **观察**：TUI + 配置文件。
- **通过判据**：每步与当轮承诺一致，无承诺之外的手工步骤；未配置凭证时模型列表为空、provider 不可见（预期，不判失败），配置凭证后 `commandcode-go/` 模型出现；`/connect` 出现「Command Code API Key」登录项；key 写入宿主凭证存储；全局配置无 `providers.commandcode-go` 空壳、provider `activation` 为 `auto`；首条消息成功（凭证直达工厂 apiKey 的端到端证明）。
- **勿误判**：冷启动后第一次 `plugin list` / `models` 可能为空，重试一次再判（§0 约定）。
- **基准**：#22 终稿。

### 2. 模型列表核对

- **步骤**：打开 TUI 模型选择器，记录 `commandcode-go/<wire>` 全部模型与各模型 variants 档位（截图即可）；对照官方 models.md 的 Go plan（Min plan ≤ Go）模型集；终端用 `opencode models` 复核（凭证就绪后）。
- **观察**：TUI + 终端 + models.md。
- **通过判据**：模型集合与档位集合与 models.md **全量一致**；context / maxOutput 抽查 3–5 个熟知模型，数值与公开口径同量级；无「TUI 有而 models.md 无」的漏网模型。

### 3. 普通对话

- **步骤**：常规多轮对话，含一段长回复与一次追问。
- **观察**：TUI；抓包可选。
- **通过判据**：流式回复完整、无截断、无错误横幅；（可选）抓包响应流含 finish / usage 事件，形状符合 `docs/dev/spec/protocol.md` 词表。

### 4. 推理档位

- **步骤**：选带 variants 的模型切 max 档，提问触发推理；再切回 base 模型发一条。
- **观察**：TUI + 抓包。
- **通过判据**：max 档 reasoning delta 可见（折叠或直显）；抓包信封 `params.reasoning_effort` 等于所选档位值；base 请求**不含**该字段（严格透传，缺档位不造变体）。

### 5. 工具调用

- **步骤**：让模型执行一次产生长参数写入的任务（如写长文件、多处编辑）。
- **观察**：TUI；抓包可选。
- **通过判据**：工具完整执行、结果回传后模型继续合理回复；长参数无截断错乱；（可选）抓包可见 `tool-input-delta` 增量。

### 6. 图片输入

- **步骤**：从模型选择器选一个声明 image 模态的模型（判据：产物 `inputModalities` 含 image），贴图提问。
- **观察**：TUI + 抓包。
- **通过判据**：模型正确描述图片内容；抓包信封消息内为 `data:image/<fmt>;base64,…`。

### 7. 错误面

- **步骤**：a) `/connect` 填入错误 key 后发消息；b) 套餐文案路径：若存在 TUI 可见但网关拒绝的模型（如 models.md 标 Go 但网关未放行的新模型）则选用之。
- **观察**：TUI。
- **通过判据**：a) 报认证错误并指向 `/connect` 重新登录；b) 报「模型 X 不在当前套餐内」，**不**误导重新登录。
- **条件项说明**：b 无确定触发路径时不阻塞验收——记录「mock 覆盖、未真机触发」即可（映射逻辑已有 `docs/dev/spec/protocol.md` §3 全表单测覆盖）。

### 8. 降级

三场景各验一次，全部以「模型列表仍可用 + 消息可发」为目标：

| 场景 | 断路方式 | 预期 |
|---|---|---|
| a. 断产物渠道 | MITM（或 hosts）屏蔽默认 URL 列表四渠道域名，API 与 generate 通 | 包内快照顶替 + warn 日志 |
| b. 断 /models API | MITM 按路径断 `/provider/v1/models`，产物渠道通 | 产物清单顶替 |
| c. 整机离线 | 断网（或 MITM 全断） | 快照全量注册 |

- **观察**：TUI + 日志。
- **通过判据**：三场景模型列表均出现且符合预期来源；每场景首条消息均成功（generate 不依赖被断渠道）；a 场景 warn 日志可见（脱敏后）。

### 9. 会话绑定

- **步骤**：会话 A 连发两条消息 → 新会话 B 发一条 → 重启宿主、恢复会话 A 再发一条。
- **观察**：日志（主，12 位截断足以判异同）；抓包可选核全值。
- **通过判据**：A 内两条 `x-session-id` 相同；A ≠ B；重启后恢复的 A 与重启前相同（确定性派生，跨重启同 id）。
- **勿误判**：lifecycle 的 `sess_<16hex>` 与 `x-session-id` 是两套互不引用的 ID（#9 定案），各自稳定、各自轮换均属预期。

### 10. /connect 文案与 README 承诺一致性复核

- **步骤**：逐条复核：provider id `commandcode-go`（integrationID / 模型 id 前缀全处同名）、登录项 label「Command Code API Key」、README 手动安装节与「全新环境安装走查」的实际行为。
- **观察**：TUI + README。
- **通过判据**：三处与 README 承诺零偏差；README 不出现已废弃的 `opencode2`、beta 措辞或 provider 空壳键。
- **基准**：#22 终稿（provider 承诺面）+ #49（文档换轴）。

## 2. V1 条件复验（非每轮）

触发条件（`docs/dev/adr/0004-v1-freeze-and-retention.md`）：本次发布改动了 v1 专属面——`src/host/v1.ts`、v1 专属测试或 v1 专属文档。共享核心改动不触发 v1 轮。

触发时执行：

1. **安装**：按[冻结版安装指南](https://github.com/WallBreakerNO4/opencode-commandcode-provider/blob/v0.1.2/docs/guide/installation.md)的 v1 步骤（全局配置 `plugin` 数组一行），在隔离环境完成安装与 `/connect`（或 env）登录。
2. **范围**：§1 中受本次 v1 改动影响的项 +「全新环境安装走查」「普通对话」两项；其余项可引用最近一次 v1 轮记录。
3. **记录**：注明触发的 v1 专属改动（issue / commit）。

## 3. 记录形式

每轮验收留一份记录（issue 评论或文档）：逐项 pass / fail / 未触发 + 证据（截图、日志摘录、抓包摘录）+ 宿主版本号 + 当轮安装路径（本地 dist / 真 README）。条件项（如 7b）如实标注「未触发」，不冒充通过。

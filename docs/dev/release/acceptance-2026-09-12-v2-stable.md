# V2 正式版人工验收记录（第一阶段：本地 dist 预验收，2026-09-12）

> 关联：[#51](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/51)；清单：`docs/dev/spec/acceptance.md` §1；流程：`docs/dev/release/release-process.md` §1。
> 宿主版本：`opencode v2.0.1`（`/home/wall/.opencode/bin/opencode`，官方 curl 安装线）。
> 当轮安装路径：**本地 dist**（全局配置 `plugins: ["<仓库>/dist"]`；**未写** provider 空壳，provider `activation:"auto"`）。
> 隔离：`XDG_{CONFIG,DATA,CACHE,STATE}_HOME` 全部重定向到 `/tmp/opencode/accept-20260912-175105/{A,B,C}`；后台服务端口 48931/48932；HTTPS MITM（mitmdump 8080 → Clash 7890）接管宿主出网，全量 wire JSONL 留在隔离目录（含凭据，永不入库）。
> 凭据：真实 Command Code Go plan key（订阅 `individual-go`、active）。
> 执行方式：**agent 代跑 + 维护者复核**。TUI 交互经 tmux 驱动并逐屏留图；发布与最终签收仍归维护者（职责归属见 `docs/dev/release/release-process.md`）。
> 性质：本文件是 **agent 代跑稿**——本轮由 agent 按维护者指示执行并留证，供维护者复核签收；不替代 `docs/dev/spec/acceptance.md` 语义下的人工签收。
> dist 溯源：构建自 commit `58d1a0f`（工作树干净），包版本 0.1.3；工厂计数所用临时插桩构建已还原并重建（见 §2）。
> 范围：第一阶段（发布前门槛）。第二阶段（发布后按真 README 走查）待新版本发布后执行，见 §5。

## 0. 结论速览

| # | 清单项 | 结论 | 一句话 |
|---|---|---|---|
| 1 | 全新环境安装走查（含 `/connect`） | **pass** | 无 provider 空壳自举；凭证前 provider 不可见；`/connect` 出现「Command Code API Key」并入库；首条消息成功 |
| 2 | 模型列表核对 | **pass** | 运行时 44 = 当前官方 CLI 1.53.1 Go 档 44；variants 与 `efforts` 全等；抽查 limit 全等 |
| 3 | 普通对话 | **pass** | TUI 多轮：约 300 字长回复完整 + 追问正常 |
| 4 | 推理档位 | **pass** | max 档 TUI 可见 Thought；wire `params.reasoning_effort="max"`；base 请求不含该字段 |
| 5 | 工具调用 | **pass** | shell 与 write 两类工具均完整执行并续答；write 长参数 2088B 经 `tool-input-delta` 流式无损，落盘文件与源逐字节一致 |
| 6 | 图片输入 | **pass（TUI 贴图受限）** | 视觉模型描述正确；wire `data:image/png;base64` 可解码回原 PNG。TUI 贴图受无头剪贴板限制，改用宿主 `run --file` 公开通道 |
| 7 | 错误面 | a **pass** / b **未触发** | a：错误 key 经 `/connect` 入库后消息报认证失败并指向 `/connect`；b：无真机触发路径，映射已有单测覆盖 |
| 8 | 降级 | **pass（c 按变体解读）** | a：断四渠道→快照顶替 42 条 + warn；b：断 `/models`→产物清单 44 条 + 退化 warn；c：全断→快照全量 42 条；另证「管线全断、网关通」消息成功 |
| 9 | 会话绑定 | **pass** | A 两条消息同 id、A ≠ B、跨服务重启恢复 A 后 id 不变 |
| 10 | `/connect` 文案与 README 一致性 | **pass** | provider id / 显示名 / 认证 label 三处一致；README 与指南无 `opencode2` / beta / 空壳残留 |

十项全部有结论；7b 为条件项如实标注「未触发」。

## 1. 逐项记录

### 1. 全新环境安装走查（含 `/connect` 登录）——pass

**步骤与观察**：

1. 隔离区只写 `{"update":"disable","plugins":["/…/opencode-commandcode-provider/dist"]}`，不写任何 provider 键；重启宿主服务后：
   - `plugin list`：**冷启动竞态实测**——服务起后 +308ms、+620ms 两次均 `No plugins found`，+1068ms 第三次列出 `commandcode-go  local  /…/dist/index.js`。激活窗口约 1s：间隔 ≥1s 的手动「重试一次」足够；同秒内连点两次可能都落在窗口内。
   - 无凭证时 `opencode models` 只有 7 条内置 `opencode/*` 免费模型，**无** `commandcode-go/*`；`/api/provider` 不含 `commandcode-go`；`/api/integration` 已注册 `commandcode-go`（key 方法 label「Command Code API Key」+ env 方法 `COMMANDCODE_API_KEY`）。「未配置凭证前不可见」为预期，不判失败。
2. TUI 输入 `/connect` → 搜索「command code」→ 列表出现 **Command Code (Go)** → 输入框标题 **Command Code API Key**（占位符 `API key`）→ 粘贴真实 key 回车 → 提示 Connected。
3. 凭证落库：`opencode auth list` → `Command Code (Go)  Command Code (Go)  stored`（凭据存于隔离区 `data/opencode/opencode.db`；label 取 integration 名，符合 `docs/dev/research/v2-stable-contract.md` §2.3）。
4. 凭证就绪后：`opencode models` 列出 44 条 `commandcode-go/*`（+ 7 条内置）；`/api/provider`：

   ```json
   {"id":"commandcode-go","integrationID":"commandcode-go","name":"Command Code (Go)",
    "activation":"auto","package":"aisdk:file:///…/opencode-commandcode-provider/dist/index.js"}
   ```

   `/api/integration` 的 `connections` 为 1（type `credential`）。
5. 首条消息（TUI 新会话，模型 DeepSeek V4 Pro）：成功回包（约 300 字短文，`10.2s · 28.7 tok/s`），流式完整无截断。

**判据核对**：无空壳、`activation:"auto"`、无承诺外手工步骤 ✅；凭证前不可见 ✅；`/connect` 登录项与 label ✅；key 入库 ✅；首条消息成功 ✅。

### 2. 模型列表核对 —— pass

- 运行时（`opencode models`，凭证就绪）：`commandcode-go/*` **44** 条。
- 基线：按 `scripts/build-models` 流水线对**当前官方 CLI `command-code@1.53.1`** 的 `models.md` 重新解析（Go 档 = 44），产物 `models.json` 写出到隔离目录；**44 = 44，双向零差集**。
- variants：运行时目录 44 个模型的 variants 与官方 `efforts` **全等**（0 处不一致）；TUI 变体弹窗实测 V4 Pro 为 `Default / high / max`。
- limit 抽查（运行时 vs 官方产物）：`deepseek-v4-pro` 1000000/384000 = 1000000/384000；`deepseek-v4-flash` 同；`zai-org/GLM-5.3` 1000000/131072 同；`gpt-5.6-luna` 1050000/128000 同。
- TUI 模型选择器逐屏留图（含 Command Code (Go) 分组、当前选中项）。

补充事实：包内快照（CLI 1.49.1）为 42 条，比当前产物少 `deepseek-v4.1-flash`、`inclusionai/ling-3.0-flash-sante:free` 两条；这是快照的时间差，正常路径无线影响（§8a/c 的降级清单因此为 42）。

### 3. 普通对话 —— pass

TUI 会话内：长回复（约 300 字）完整流式；追问「再压缩成一句话」得到正确收敛回答。全程无错误横幅、无截断。wire 响应含 `start / reasoning-* / text-* / finish-step / finish / provider-metadata` 事件，形状符合 `docs/dev/spec/protocol.md` 词表。

### 4. 推理档位 —— pass

- TUI：`ctrl+t` 切 V4 Pro 变体到 `max`（页脚显示 `… Command Code (Go) · max`），发推理题，「Thought」可见。
- wire（同会话请求）：`params.reasoning_effort = "max"`；base 会话请求**不含** `reasoning_effort` 字段（严格透传，缺档位不造变体）。

### 5. 工具调用 —— pass

TUI 内两轮实测：

1. 「写 200 行文件」→ 模型走 shell 工具（`for i in {1..200}`），执行、结果回传、续答正常。
2. 「改用 write 工具写 200 行」→ `write` 工具调用参数 **2088 字节**，由 `tool-input-delta` 增量完整流式（逐 token delta 到 `}`，`tool-input-end` 后 `tool-call` 收拢），无 `error` 事件；落盘文件 200 行内容与源文件一致（仅末行无换行符，`wc -l` 差 1，非截断）。

### 6. 图片输入 —— pass（TUI 贴图受限）

- 选声明 image 模态的模型 `deepseek/deepseek-v4-flash-vision-exp`（产物 `inputModalities` 含 image；同类候选另 23 个）。
- **偏差说明**：无头环境无剪贴板通道，TUI 贴图不可执行；改用宿主公开的 `opencode run --file` 通道完成同一链路的投放与判读。
- 自造图（红圆 + 倒蓝三角 + 绿长方形）→ 模型描述：「红色圆形（左上偏中）、蓝色三角形（右上角，尖角朝下）、绿色长方形（下方）」，与实际一致。
- wire：消息内出现 `data:image/png;base64,`，总长 2090，解码 1550 字节、PNG magic `89504e470d0a1a0a` 正确。

### 7. 错误面 —— a pass / b 未触发

- **a**：隔离 B 区经 `/connect` 存入错误 key（`user_acceptance_invalid_key_0000`），`auth list` 显示 stored；发消息得：
  `[deepseek/deepseek-v4-pro] 认证失败（401）：key 无效或已过期，请重新运行 /connect 登录。上游：Invalid 'Authorization' header or token.`——错误指向 `/connect`，wire 401，符合错误映射。
- **b**：无「TUI 可见但网关拒绝」的确定触发路径（当前 API 返回的模型均可用），如实记「未触发」；`MODEL_NOT_IN_PLAN` 文案映射有 `docs/dev/spec/protocol.md` §3 全表单测覆盖。

### 8. 降级 —— pass（c 按变体解读）

控制面：MITM addon 按 `block_domains` / `block_paths` / `block_all` 实时断流；每场景冷启动服务后取模型清单。

| 场景 | 断路 | 结果 |
|---|---|---|
| a. 断产物渠道 | 4 个默认 URL 渠道域名 → 503 | 模型清单 42 条（= 包内快照 ∩ API，符合「快照顶替产物」）；warn 可见：`构建产物拉取失败（4 条 URL → HTTP 503），包内快照顶替产物角色`；首条消息成功 |
| b. 断 `/models` API | 仅路径 `/provider/v1/models` → 503 | 模型清单 **44** 条，与最新官方产物全等；warn：`/provider/v1/models 拉取失败（HTTP 503），发现退化为产物 id 清单`；首条消息成功 |
| c. 整机离线（字面） | `block_all`（`*.commandcode.ai` + 全部渠道 → 503） | 模型清单 42 条 = 包内快照**全量注册**；消息发送按预期因断网失败（`上游 503`），与清单「每场景首条消息均成功」的字面表述冲突，见 §3 观察 4 |
| c′.（管线全断、网关通） | 4 渠道域名 + `/models` 路径同时断 | 模型清单 42 条（快照）；**首条消息成功**——证明 generate 不依赖被断的管线渠道 |

注：warn 日志在 `opencode run --standalone --print-logs` 下可见；后台服务模式的插件 console 输出不落日志文件（见 §3 观察 3）。

### 9. 会话绑定 —— pass

| 会话 | 请求 | `x-session-id`（12 位截断） |
|---|---|---|
| A 消息 1 | 主回复 18:16:09 | `41c100da-90d…` |
| A 消息 2 | 追问 18:17:49 | `41c100da-90d…` |
| B 单条 | 18:18:15/16 | `ce66c2f0-1f1…` |
| A 重启恢复后 | 18:19:22（服务进程已重启） | `41c100da-90d…` |

A 内相同、A ≠ B、跨重启同 id ✅；`threadId == x-session-id` 逐请求成立；`traceparent` 逐请求新造（tracestate 形状 `00-…-01`）。重启方式：结束 TUI → 杀掉隔离后台服务 → 重新拉起（新 pid），再经会话列表恢复 A。

### 10. `/connect` 文案与 README 承诺一致性 —— pass

- provider id `commandcode-go`：integration、模型前缀、配置/文档全处同名；显示名 `Command Code (Go)`：TUI 列表、`/api/integration`、provider 列表一致；key 方法 label「Command Code API Key」与 v1 常量同文案。
- `README.md` 与 `docs/guide/installation.md`、`docs/guide/known-issues.md` 全文无 `opencode2`、beta 措辞、`providers.commandcode-go` 空壳键（grep 零命中）。
- 与实测行为偏差提示：docs 称「未配置凭证前模型列表为空」，实测内置 `opencode/*` 免费模型仍会列出，`commandcode-go/*` 为空——承诺面指插件模型，语义不冲突，供维护者留意。

## 2. #51 专项项记录

- **真 key 端到端成功回包**：pass。首条消息、多轮对话、工具调用、图片输入均成功；wire 上请求真实到达网关，响应 NDJSON 完整。
- **`/connect` 交互**：pass。A 区（正确 key，含二次更换新 key）、B 区（错误 key）各走一遍；列表项、输入 label、入库、错误回显均符合。
- **credential > env 优先级**：pass。A 区已存真实凭证时注入假 env（`user_acceptance_env_decoy_9999`），消息成功且 wire `Authorization` 哈希与凭证一致（≠ 假 env 哈希，见 `evidence/16-cred-over-env-wire.txt`）。另在 C 区（无凭证）验证 env 单通道成功，wire 哈希与 env key 一致（`evidence/17-env-only-wire.txt`）。
- **工厂调用次数**：临时插桩实测（测毕还原、工作树已干净）：
  - 同一后台服务进程首条消息：`createCommandCode` 被调用 **2 次**（间隔 5ms，宿主 options 完全一致，调用栈同点）——首轮并发解析的缓存竞态；
  - 同进程第二条消息：**0 次新调用**（缓存命中）。
  - 结论：宿主缓存生效，但「同 key 只构造一次」在**首轮并发时并不成立**；`src/provider/model.ts` 头注的绝对表述（#50 更新）建议后续小幅修正或开 issue 修订（不影响运行行为与本次验收）。
- **冷启动重试行为**：见 1/§1 的秒级实测；文档「重试一次」对人工操作成立。

## 3. 观察与待办

1. **npm 页面 README 仍是旧文案**：0.1.3 发布于 #49 之前，npm 只在发版时封存 README。要让 npm 页面兑现新 README，需发布 0.1.4（版本号、快照刷新、`pnpm pack` 抽查按 `docs/dev/release/release-process.md` §2 由维护者执行）；随后执行第二阶段走查（§5）。
2. **工厂调用次数**：首轮 2 次并发构造 + 后续 0 次缓存命中；建议把 `src/provider/model.ts` 的调用节奏注释从「只构造一次」修正为「按 key 缓存；首轮并发解析可能构造两次，之后命中复用」。
3. **warn 日志可见性**：后台服务 stdout → `/dev/null`，插件 console warn 不落宿主日志文件；`--print-logs`（standalone）可见。清单 8a 的 warn 判据在该模式下满足；是否在文档中补充「排障需 `--print-logs`」交维护者定。
4. **8c 字面离线与判据冲突**：清单同时要求「断网（或 MITM 全断）」与「每场景首条消息均成功」；字面离线不可能满足后者。本记录按字面 + 「管线全断、网关通」两种解读都测了，建议下一轮修订清单措辞。
5. **首个 key 周额度耗尽**：首轮真 key 在第一条消息即 429（周窗口 6.1/6，`individual-go` active）；此为账号配额事实，非插件缺陷。更换 key 后全程正常。验收过程共消耗新 key 少量额度（约 8 次短消息）。
6. **图片 TUI 贴图**：无头环境无剪贴板，改用 `run --file`；若维护者要补 TUI 目视，需在有图形会话的机器上重做该半项。

## 4. 证据索引

原始证据（TUI 截图文本、日志、wire JSONL、官方产物）保留在 `/tmp/opencode/accept-20260912-175105/`，不随仓库提交。关键文件：

```
evidence/01-plugin-list-1/2.txt          冷启动 plugin list
evidence/02-connect-key-prompt.txt       /connect 的 Command Code API Key 输入框
evidence/02-auth-list.txt                凭证 stored
evidence/04-models-with-cred.txt         44 条 commandcode-go（+7 builtin）
evidence/07-first-msg-done.txt           首条消息完整回包
evidence/08-followup.txt                 追问
evidence/11-api-model.json               运行时目录（limit/variants 核对源）
evidence/12-reasoning-max.txt            max 档 TUI
evidence/13c-toolcall-write-done.txt     write 工具 200 行
evidence/14-image-run.txt / 14-image-wire.txt   图片描述 + data:image 核验
evidence/15-wrong-key-run.txt            7a 认证错误
evidence/16-cred-over-env.txt            优先级（凭证胜出，含 wire 哈希核验 16-cred-over-env-wire.txt）
evidence/17-env-only.txt                  env 单通道（17-env-only-wire.txt）
evidence/18-coldstart.txt                冷启动秒级窗口
evidence/19a*/20b*/21c*/22c2*            降级 a/b/c/c′
evidence/23-factory-*.log                工厂调用计数（插桩）
official/models.json + build-meta.json   当前官方 CLI 1.53.1 Go 档 44（核对基准）
```

## 5. 第二阶段计划（发布后）

1. 维护者发布含新 README 的版本（建议 0.1.4），打 tag、Release notes 注明包内快照 sha256（`docs/dev/release/release-process.md` §2）。
2. 在全新隔离区**原样执行 README 手动安装节**：`opencode plugin add @wallbreakerno4/opencode-commandcode` → 重启 → `/connect`（或 env）→ 发消息；核对 npm 页面 README 与仓库一致。
3. 跑 `docs/dev/spec/acceptance.md` §1 十项：TUI 目视与 wire 级项重做，纯插件逻辑项引用本记录；记录追加于本文件或 #51 评论，再关闭 #51。

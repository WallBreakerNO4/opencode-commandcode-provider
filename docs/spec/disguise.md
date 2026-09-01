# 伪装模块规格：状态、时机、降级

> 状态：定稿（2026-08-30）。决策票：[WallBreakerNO4/opencode-commandcode-provider#7](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/7)。
> 事实输入：`docs/research/disguise-spec.md`（MAXeaglet/commandcode-proxy 逆向提炼，下称「调研」）。
> 范围：伪装模块的运行时行为契约——状态管理、预请求时机、会话与 lifecycle 语义、失败降级、版本头策略、日志脱敏、伪装人格、generate 信封 `config` 块取值（§9，#19）。指纹 / slug / traceparent 的**算法本身**以调研 §1–§7 为准，本文只约束「怎么跑」，不重复「怎么算」。
> 校准状态：抓包校准已完成（2026-08-30，工单 #9）。事实输入升级为「逆向提炼 + 抓包 ground truth」双层，凡两者冲突处以调研文档 **§11 抓包校准** 为准；本文受影响条款已就地修订，修订点标注「（#9 校准）」。

## 0. 决策总览

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 状态存储 | 内存态为主；唯一落盘物 = CC 版本缓存；指纹进程内稳定（重启才换） |
| D2 | 预请求时机 | 插件进程启动时发一次（对齐真实 CLI 语义，#9 校准）；每个预请求独立 3s 超时；超时/失败照常放行主请求 |
| D3 | 会话身份 | 绑定 OpenCode 会话（1 会话 = 1 sessionId）；不可见时回退 per-key uuid 12–13h 轮换 |
| D4 | lifecycle | 每进程启动发一次（真实语义，#9 校准）；metadata.sessionId 为与 x-session-id 无关的随机 `sess_<16hex>`（#9 校准：真实 CLI 就是两套 ID） |
| D5 | 失败降级 | 主请求永不因预请求受阻；网络错误/5xx 短退避重试，4xx 长冷却 |
| D6 | 版本头 | 全局单值；首请求前 1.5s 竞速；24h 惰性刷新；兜底链 = 落盘值 → 构建产物 `sourceCliVersion` → 包内快照（#19 修订） |
| D7 | 日志脱敏 | key 只以短哈希出现；伪标识符截断；Authorization 永不整串输出 |
| D8 | 伪装人格 | **如实上报真实机器**：指纹各字段取真机真值，`config.environment` 报真实 platform（#9 校准：真实 CLI 不伪装 Windows，MAXeaglet 的 win32 假人格纯属它的发明） |
| D9 | config 块取值 | 逐字段照抄官方 CLI 实现（源码调研 #23 定案）：非 git 显式空值九字段齐全、date=UTC、mainBranch=远程 HEAD 推断、structure 单层+黑名单、gitStatus 空/失败→"Working tree clean"；仅两处防御偏离（git 查询 2s 超时、进程级冻结 + 24h 过期重采），均不改线上形状（§9，#19） |

## 1. 状态模型（D1）

- **per-key 内存态**（`Map<apiKey, KeyState>`，key 为原文、绝不落盘、绝不进日志）：
  - `fingerprint`：指纹对象，进程启动时采集一次（#9 校准：内容为真机真值）；
  - `session`：`sessionId` + 过期时刻（仅回退路径需要过期语义，见 §3）；
  - 预请求调度：`nextInitAt`、`failCount`（见 §5）。
- **全局内存态**：`ccVersion` 当前值（见 §6）。
- **指纹进程内稳定**：会话过期轮换只换 session，**不删指纹**——修掉 MAXeaglet「每小时清理定时器把过期会话连同指纹一起删 → 每 12–13h 换一台机器」的无意副作用（调研 §1.5 指认，连作者自己的注释/README 都不是这个本意）。进程重启 = 状态全空，首见 key 重新生成指纹并立即重报（MAXeaglet 同款重启语义）。
- **唯一落盘物 = 版本缓存**（§6），其余伪装状态一律不落盘。
- 后续增强（非本期，留门不实现）：指纹落盘跨重启稳定。触发条件：真实环境出现与「设备频繁更换」相关的风控证据再立项。

## 2. 预请求时机（D2）

- 结构照抄 MAXeaglet：指纹记录与 lifecycle 两个预请求**并行**发出（同一 `Promise.all`）。**触发时机（#9 校准）**：真实 CLI 是**每进程启动发一次**（3 次进程启动 = 3 组预请求，均在首个 generate 前 0.3–2.5s 完成），并非 per-key 8–10h 节奏——插件对齐为**插件进程启动时发一次**；长驻进程的 8–10h 惰性补发保留为保守策略（观察窗口无法证伪，见调研 §11.4）。
- **修一处真 bug**：每个预请求挂**独立 3s 超时**（`AbortSignal.timeout(3000)`）。MAXeaglet 预请求无独立超时，网关挂起时主请求被拖着白等 5 分钟（调研 §8.2）。
- 超时/失败的主请求**照常放行**（降级语义见 §5）；预请求在后台继续跑完，仅更新状态与日志，不影响本次响应。
- 预请求头（#9 校准后照抄真实 CLI）：`content-type: application/json`、`User-Agent: cli`、`x-cli-environment: production`、`Authorization: Bearer <key>`、`x-command-code-version`、`accept: */*`、`accept-language: *`、`sec-fetch-mode: cors`、`accept-encoding: br, gzip, deflate`；不带 `x-session-id` / `x-project-slug` / `traceparent` / `x-taste-learning`。

## 3. 会话身份与 project-slug（D3）

- **身份规则（老板拍板）**：一段 OpenCode 会话 = 一个 `x-session-id`；不同会话不共享。动机：会话标识稳定利于服务端会话关联（老板提出亦有利于缓存命中、减少开销），且贴合真实 CLI「一个会话一个 session」的语义。
- **主路径（绑定）**：调用参数中可见 OpenCode 会话标识时，`x-session-id` 由其**确定性派生**（sha256 → 32 hex → 修补 uuid v4 的版本/变体位），无需任何存储即保证「同会话同 id、跨重启同 id」。
- **slug（#9 校准后改写）**：真实 CLI 的 `x-project-slug` 由真实 workingDir 派生、跨会话恒定（实测 20 次 generate 跨 4 个 session id 而 slug 不变），形状为「小写字母数字短横分组 ×8 组、组长 4–11」（样本见 `capture/samples/generate.json`），与 MAXeaglet 的 `users-dev-projects-*` 算法毫无相似。确切算法未知（逐段哈希链为最像假说，调研 §11.4），插件实现取**形状一致的 workingDir 哈希近似**，不再从 sessionId 派生。
- **回退路径**：看不到会话标识时，照抄 MAXeaglet——per-key 随机 uuid v4，12h + 0~1h 抖动惰性轮换（此路径无法区分会话边界，属尽力而为）。
- **可见性验证（已定案，源码级）**：#11/#12 未回答此项，2026-08-31 经源码定案补课（`docs/research/session-visibility.md`）——v1/v2 宿主均**无条件**把 OpenCode 会话 id 注入 `doStream(options).headers`：`X-Session-Id` 与 `x-session-affinity`（= sessionID，每会话稳定；v2 另有 `x-opencode-session` 同值）。**主路径取值位置**：doStream 时读上述头，任一存在即以其为种子派生；全部缺失才落回退路径（容忍宿主改头名，命中后值漂移打日志）。干扰项勿用：v1 `x-opencode-request`（消息 id，每请求唯一）、telemetry（不进调用参数）。v2 宿主不调 `doGenerate`（折叠进 doStream），主路径只需在 doStream 实现。
- slug 旧算法（MAXeaglet `users-dev-projects-*`）整体弃用（#9 校准），其 NaN 边界问题随之消失。
- MAXeaglet 的入站头透传（`x-session-id` / `x-claude-code-session-id`）**不适用**：插件形态没有入站 HTTP 头，其位置由上述绑定主路径取代。

## 4. lifecycle 事件（D4）

- **节奏（#9 校准）**：真实 CLI 每进程启动发一次（先 whoami/billing，lifecycle 先于指纹 ≤0.8s，均早于首个 generate）——插件对齐为插件进程启动时发一次；不再绑定会话铸造（原设计弃用）。长驻进程的 8–10h 补发保留为保守策略（§5）。
- **身份（#9 校准，推翻原同源派生）**：`metadata.sessionId` 为**与 x-session-id 无关的随机 `sess_<16hex>`**——抓包证实真实 CLI 就是两套互不引用的 ID（`x-session-id` uuid v4 随会话轮换，lifecycle sess id 每进程现造）。「嘴上说会话 A、手上签会话 B」的原判断错误，如实照抄。
- 其余照抄：`eventType: "cli_session_exists"`（实测唯一事件类型）；`cliVersion` = 当前 ccVersion；`mode: "interactive"` 恒定（连 `-p` 一次性调用也报 interactive）；`os` = 真实 `platform-arch`（#9 校准：报真值，不再取伪装人格）；请求头同预请求（§2）；响应为 `{"tracked": true}`。

## 5. 失败降级（D5）

**总则：预请求的任何结局都不影响主请求的发出与响应**——jiesou/brent 从不发预请求也能长期使用，裸奔不致命；因遥测失败扣押用户请求是用用户体验给伪装失败陪葬，否决熔断。

预请求单元（两个请求合记，照抄 MAXeaglet 的耦合结构）结局分类：

| 结局 | 判定 | 动作 |
|---|---|---|
| 成功 | 两个都 2xx | `nextInitAt = now + 8h + rand*2h`（长驻补发节奏；真实 CLI 的重发间隔未获 ground truth，保守保留），`failCount = 0` |
| 瞬时失败 | 网络错误 / 超时 / 5xx（任一） | 不推进 8–10h；`nextAttemptAt = now + min(60s × 2^failCount, 15min)`，`failCount++`；下次主请求前到点即重试 |
| 拒绝 | 4xx（含 401/403，任一） | `nextAttemptAt = now + 8h + rand*2h` 长冷却；服务器明确说「不」之后继续敲门更像机器人，且 403 可能意味着 key 已被盯上，安静是上策 |

- MAXeaglet「发过就无条件进 8–10h 冷却」的语义**弃用**（调研 §8.2 证明是其死代码注释掩盖的实际行为）：一次开局网络抖动不该让 key 裸奔一整天。
- 失败只记日志（脱敏见 §7），不重试队列、不落盘、不跨进程记忆——重启归零是可接受的。

## 6. 版本头 `x-command-code-version`（D6）

- **全局单值**（D6a）：一台真机只装一个 CLI，版本与 key 数量无关；全部 key、全部请求（主请求 + 预请求 + models）共享同一值。
- **首请求前 1.5s 竞速**（D6b）：进程内首次需要该值时，给 npm 查询 1.5s 上限——抢到用新值，抢不到先用兜底值放行、查询转后台继续。修 MAXeaglet fire-and-forget 的「初期请求带陈旧兜底值」瑕疵，同时不让被墙的 npm 拖住首请求。
- **24h 惰性刷新**（D6c）：每次主请求前比对「距上次成功拉取是否超 24h」，超时后台触发拉取。不挂 `setInterval`（插件生命周期负担），**不加抖动**（各进程启动时间天然分散，无收益）。
- **数据源顺序**：npm registry 直连（1.5s 上限）→ jsDelivr 镜像 `cdn.jsdelivr.net/npm/command-code/package.json`（1.5s 上限，国内可达性好）。
- **取值兜底链**（#19 修订，全链序）：① npm/jsDelivr 竞速成功值（内存）→ ② 落盘的「上次成功拉取值」→ ③ 运行时已拉取构建产物的 `sourceCliVersion` → ④ 包内快照的 `sourceCliVersion`（`docs/spec/model-pipeline.md` §1.1，随插件发版更新，不会烂在代码里）。③ 只读模型管线**内存中已有**的产物——不触发额外拉取、不等待；③ 的值**不回写**落盘缓存（② 的语义 = npm/jsDelivr 一手拉取值）。
- **重估时机（#19）**：版本值只在两个时刻重估——初解析（首请求 1.5s 竞速 + 后台查询落地更新）与 24h 惰性刷新；期间模型管线的产物刷新**不**引起版本头翻转（防抖动）。
- 落盘物：`<缓存目录>/opencode-commandcode/version-cache.json`（`XDG_CACHE_HOME` 优先，默认 `~/.cache`），内容 `{version, fetchedAt}`，原子写（临时文件 + rename）。这是伪装模块**唯一**的磁盘 IO（D1）。

## 7. 日志脱敏（D7）

总则（老板拍板）：不泄露敏感信息。

| 对象 | 日志形态 |
|---|---|
| apiKey | `cc-key#` + sha256(apiKey) 前 8 位 hex——日志中零原文 |
| thumbmark / sessionId / trace-id | 本身即伪标识符，截断为前 12 位 hex + `…` |
| Authorization 头 / 完整 key | 永不输出；错误日志只记 HTTP status 与错误类别，不序列化请求头 |

级别：预请求成功、版本刷新成功 = `debug`（默认安静）；预请求失败、降级路径、落盘异常 = `warn`。

通道：**注入式 logger**——伪装模块不直接依赖 opencode 客户端；v2 glue 注入 `client.app.log`，v1 与独立调用退化 console，测试注 no-op。

## 8. 伪装人格（D8，#9 校准后整体改写）

- **如实上报真实机器**：抓包证实真实 CLI 的指纹就是真机真值——`platform`/`arch` 取真实平台、`osRelease` 报内核版本（如 `6.8.0-138-generic`）、`cpuModel`/`cpuCount`/`memGiB` 报真实硬件（cpuCount 为逻辑核数，实测 8 核 16 线程报 16）、`timezone` 报真实 IANA 时区、`macHashes` 按真实网卡数量生成（实测多网卡主机 29 个）。MAXeaglet 的 win32 随机池假人格纯属其发明，**弃用**。
- **指纹生成 = 采集**：进程启动时读真实平台/硬件/时区/网卡，按调研 §1.2 的哈希算法计算各字段哈希与 thumbmark（拼接序与「五字段不入哈希」结构保留——服务端无从校验原像，结构同构无成本）。真机真值天然确定，指纹跨进程稳定随之免费获得。
- **`config.environment`**：报真实 `platform` 单词（实测恒 `"linux"`），无 arch、无 Node 版本——MAXeaglet 的 `${platform}-${arch}, Node.js ${version}` 拼接格式弃用。原「报人格值修自相矛盾」条款随之作废：如实上报天然自洽。
- 时区读真实时区，不做随机池。

## 9. generate 信封 `config` 块取值（D9，#19 定稿）

> 事实输入：官方 CLI 源码调研 `docs/research/cli-config-collection.md`（`command-code` 1.38.2 `dist/cli.mjs` 字节偏移级还原，下称「源码调研」，工单 #23）；抓包样本 `capture/samples/generate.json`。
> 总则：**逐字段照抄官方实现**（老板拍板「人家代码怎么办，我们怎么办」）；仅两处纯客户端防御性偏离（§9.3），均不改变请求线上形状。

### 9.1 逐字段取值（官方实现照抄）

| 字段 | 取值 |
|---|---|
| `workingDir` | `process.cwd()` 原样（官方 `createNodeRuntime().cwd()` 即此）；与 §3 的 slug 派生共用同一来源 |
| `date` | **UTC** 日期：`(new Date).toISOString().split("T")[0] ?? ""` → `YYYY-MM-DD`（官方即 UTC，非本地时区） |
| `environment` | `process.platform` 单词（实测恒 `"linux"`，与 §8 同源） |
| `structure` | 见 §9.2 |
| `isGitRepo` | `git rev-parse --git-dir` 有输出 → `true`；空输出/失败（非 git 目录、git 未装同形）→ `false` |
| `currentBranch` | `git branch --show-current`；失败 → `""` |
| `mainBranch` | 三级推断（从不直接取当前分支）：`git symbolic-ref --short refs/remotes/origin/HEAD` 成功 → 去 `origin/` 前缀；失败 → `git branch -r` 输出含 `origin/main` → `"main"`、含 `origin/master` → `"master"`；兜底 `"main"` |
| `gitStatus` | `git status --porcelain` stdout 仅 trim 首尾、行间原样；**空输出或失败** → `"Working tree clean"`（官方语义：失败与干净工作区在 wire 上不可区分，照抄接受） |
| `recentCommits` | `git log --oneline -3` stdout 按行 split；空/失败 → `[]`（勿与官方 system prompt 侧另一条 `-5` 路径混淆，那不进 config） |
| 顶层 `permissionMode` | 恒 `"standard"`（抓包 ground truth；与 OpenCode 自身权限模式无关，照抄） |

**非 git 仓库 / git 未装**：`rev-parse --git-dir` 为空即提前返回——九字段**齐全**的显式空值形状（`isGitRepo: false`、`currentBranch`/`mainBranch`/`gitStatus` 空串、`recentCommits: []`），`workingDir/date/environment/structure` 照常采集（structure 先于 git 判定，非 git 目录也有内容）。**不省略字段**（源码调研推翻 #19 访谈的「省略」拍板）。

### 9.2 `structure` 采集

- `readdir(workingDir)` **仅单层**，无递归，文件与目录混排。
- 过滤：名字 `.` 开头的条目 + 14 项黑名单 `["node_modules","dist","build",".git",".svn",".hg","coverage",".nyc_output",".cache","tmp","temp",".next",".nuxt","out"]`（黑名单内点开头项与第一条规则重叠，属官方冗余保险，照抄）。**不读 .gitignore**，不区分文件/目录。
- 排序：默认字典序（`.sort()`，UTF-16 码元序，大写在小写前——抓包样本 `AGENTS.md, CONTEXT.md, capture, …` 正是此特征）。
- 无数量上限。
- **尾部 scope 标签**：额外工作区目录（`workspaceRoots()` 中非 cwd 者）逐个格式化为 `scope:<路径>` 追加在数组**末尾**、不参与排序；格式化语义：目录即 cwd → `"."`；在 cwd 下 → `"./xxx"`；即 home → `"~"`；在 home 下 → `"~/xxx"`；否则原样绝对路径。OpenCode 单工作区场景通常无 scope 标签。readdir 抛异常 → 返回仅含 scope 标签的数组。

### 9.3 采集节奏与两处防御性偏离

- **官方语义（照抄）**：config **进程级只构建一次**（首次需要时构建并冻结复用），git/status/log/structure 各跑一次；git 查询**顺序 await、无并发**；`shellOutput` try/catch 全包——非零退出码/异常 → `""`，逐字段独立降级、绝不抛错；失败结果同样冻结复用。
- **偏离 a（防御超时）**：官方 git 查询无超时（官方进程短命无碍）；插件为长驻进程，每条 git 查询加 **2s** 上限，到点按失败处理（`""`）——纯客户端防御，不改请求形状。
- **偏离 b（过期重采）**：官方进程每任务重启，冻结无感；插件会话可长跑数日，冻结过久的 config 在真实用户群体中罕见。在冻结语义上加 **24h 过期重采**（与 §6 版本头惰性刷新同节奏）：距上次构建超 24h 的首次 generate 触发后台重采，期间沿用旧值、主请求不等待。cache 仍为纯内存态，不落盘（D1 不变）。

### 9.4 与协议核心的边界

`config` 块与顶层 `permissionMode` 的取值由伪装模块提供，协议核心（`docs/spec/protocol.md` §1）构造信封时填充；`threadId` 来自 §3 会话身份。协议核心对 `config` 内容零知识、只留填充点。

## 10. 照抄 / 修写 / 不适用 对照表

**照抄（逐字，#9 校准后以调研 §11 为准）**：thumbmark/components 的 15 字段结构与哈希算法（输入换真机真值）；traceparent 生成（`00-<32hex>-<16hex>-01` 逐请求新造，实测吻合）；请求头集合与取值（`x-cli-environment: production`、`x-taste-learning: true`、`User-Agent: cli`、accept 家族，全集见调研 §11.3）；两套 session id 并存（`x-session-id` uuid v4 + lifecycle `sess_<16hex>` 无关随机）；lifecycle 事件类型与 metadata 形状；回退路径会话寿命 12–13h；per-key KeyState 结构。

**修写（相对 MAXeaglet）**：

| 项 | 改法 | 理由 |
|---|---|---|
| 预请求无超时 | 独立 3s | 网关挂起拖死主请求 5 分钟（调研 §8.2） |
| 失败无条件 8–10h 冷却 | 差异化退避/冷却 | 死代码注释掩盖的实际行为；一次抖动 = 裸奔一天 |
| 清理连带删指纹 | 指纹进程内稳定 | 每 12–13h 换机是作者本意外的副作用 |
| win32 随机池假人格 | 如实上报真机真值 | #9 证实真实指纹是真机数据（linux/真内核/真 CPU/29 个 macHashes），假人格纯属 MAXeaglet 发明 |
| environment 拼接 platform-arch + Node 版本 | 报真实 platform 单词 | #9 实测恒 `"linux"` |
| slug 由 sessionId 派生（`users-dev-projects-*`） | 由 workingDir 派生（形状一致近似） | #9 证实真实 slug 跨会话恒定、随 workingDir 变，旧算法形状完全不符 |
| lifecycle sess id 与 x-session-id 同源派生 | 无关随机 `sess_<16hex>` | #9 证实真实 CLI 就是两套互不引用的 ID，原「破绽」判断错误 |
| `x-co-flag` 头 | 删除 | #9 证实真实 CLI 不发送此头 |
| `x-taste-learning: false` | 改 `true` | #9 实测取值 `true` |
| 预请求仅 4 头 | 补 `User-Agent: cli` + accept 家族 | #9 实测头全集（调研 §11.3） |
| slug NaN 边界 | 随旧算法一并弃用 | 旧算法不复存在 |
| 版本头 fire-and-forget + 硬编码兜底 | 1.5s 竞速 + 落盘/快照链 | 初期请求带陈旧值；被墙用户集体陈旧成异常簇 |
| 模块级散装全局变量 + appendFileSync | 单一模块 state + 注入 logger | 插件形态无文件日志；两版 glue 共用同一实现 |

**不适用 / 丢弃**：本地反代服务器形态（架构主判例是进程内转换，不起本地服务）；入站 session 头透传（插件无入站 HTTP 头，由会话绑定主路径取代，见 §3）；指纹随机池（假人格弃用，见 §8）；`x-co-flag` 头（真实 CLI 不发送）。另注：MAXeaglet 的「死代码 threadId」其实是真协议字段——generate body 顶层的 `threadId` 等于 `x-session-id`（#9 证实），协议模块（#8）实现 generate 信封时需带上。

## 11. 参数速查

| 参数 | 值 |
|---|---|
| 预请求独立超时 | 3s |
| 版本竞速上限 / jsDelivr 尝试上限 | 1.5s / 1.5s |
| 版本惰性刷新间隔 | 24h |
| config 重采间隔（偏离官方冻结语义，#19）| 24h |
| git 查询防御超时（偏离官方无超时，#19）| 2s/条 |
| 指纹重报节奏（成功后）/ 4xx 长冷却 | 8h + rand×2h（未获 ground truth 证实，保守保留，#9） |
| 回退路径会话寿命 | 12h + rand×1h |
| 瞬时失败退避 | 60s × 2^n，上限 15min |

## 12. 备选与否决记录

| 备选 | 否决 / 推迟理由 |
|---|---|
| MAXeaglet 内存版逐字照抄（含指纹 12–13h 换机） | 副作用连作者本意都不是；修复仅 ~3 行，无理由保留已知破绽 |
| 指纹落盘跨重启 | 推迟留门：收益无实证，先不加磁盘 IO 路径；有风控证据再立项 |
| 预请求失败熔断主请求 | 裸奔被 jiesou/brent 长期实证可用；拿用户请求给伪装失败陪葬 |
| 失败不分类、统一 8–10h 冷却 | 瞬时抖动应尽快补上报；4xx 后频繁重试反而更像机器人 |
| 版本刷新固定 `setInterval` | 插件需管生命周期；惰性检查零负担 |
| 版本刷新加抖动 | 各进程启动时间天然分散，无收益，纯增复杂度 |
| 版本兜底仅硬编码常量 | 被墙用户集体报同一陈旧版本，自身成为异常版本簇 |
| lifecycle 照抄现造 sess id | 明知两套 ID 互不引用是破绽还自己造一个 |
| 多平台人格池 | 无 ground truth 的纯发明；单一 win32 与被逆向对象同构 |
| 日志输出 raw key / 完整伪标识符 | 老板红线：不泄露敏感信息 |
| config 块逐请求现采 / 5min 缓存（#19 访谈提案） | 官方为进程级构建一次冻结复用；照抄 + 24h 过期重采即可，中间态发明无证据支撑 |
| 非 git 目录省略 git 字段（#19 访谈拍板） | 官方九字段齐全显式空值；省略是形状偏离（源码调研 #23 推翻） |
| date 报本地时区（#19 访谈拍板） | 官方 `toISOString()` 恒 UTC；照抄 |
| mainBranch 报当前分支（#19 访谈拍板） | 官方为远程 HEAD 推断（symbolic-ref → branch -r → 兜底 main），与当前分支语义不同 |
| gitStatus 行数/字节上限 | 官方无上限；加限是发明 |

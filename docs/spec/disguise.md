# 伪装模块规格：状态、时机、降级

> 状态：定稿（2026-08-30）。决策票：[WallBreakerNO4/opencode-commandcode-provider#7](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/7)。
> 事实输入：`docs/research/disguise-spec.md`（MAXeaglet/commandcode-proxy 逆向提炼，下称「调研」）。
> 范围：伪装模块的运行时行为契约——状态管理、预请求时机、会话与 lifecycle 语义、失败降级、版本头策略、日志脱敏、伪装人格。指纹 / slug / traceparent 的**算法本身**以调研 §1–§7 为准，本文只约束「怎么跑」，不重复「怎么算」。
> 校准预留：抓包校准票（#9）产出 ground truth 后，凡与本文冲突的**事实条款**（body 形状、slug 前缀、ID 真实关系等）以抓包为准并修订本文；本文标注「照抄」的条目均为对 MAXeaglet 行为的同构复刻。

## 0. 决策总览

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 状态存储 | 内存态为主；唯一落盘物 = CC 版本缓存；指纹进程内稳定（重启才换） |
| D2 | 预请求时机 | 首请求前阻塞等待，每个预请求独立 3s 超时；超时/失败照常放行主请求 |
| D3 | 会话身份 | 绑定 OpenCode 会话（1 会话 = 1 sessionId）；不可见时回退 per-key uuid 12–13h 轮换 |
| D4 | lifecycle | 铸造新会话时发一次；metadata.sessionId 与 x-session-id 同源派生 |
| D5 | 失败降级 | 主请求永不因预请求受阻；网络错误/5xx 短退避重试，4xx 长冷却 |
| D6 | 版本头 | 全局单值；首请求前 1.5s 竞速；24h 惰性刷新；落盘值 → 包内快照双兜底 |
| D7 | 日志脱敏 | key 只以短哈希出现；伪标识符截断；Authorization 永不整串输出 |
| D8 | 伪装人格 | 单一 win32-x64 人格逐字照抄；environment 字段修为与人格一致 |

## 1. 状态模型（D1）

- **per-key 内存态**（`Map<apiKey, KeyState>`，key 为原文、绝不落盘、绝不进日志）：
  - `fingerprint`：指纹对象，首见该 key 时生成一次；
  - `session`：`sessionId` + 过期时刻（仅回退路径需要过期语义，见 §3）；
  - 预请求调度：`nextInitAt`、`failCount`（见 §5）。
- **全局内存态**：`ccVersion` 当前值（见 §6）。
- **指纹进程内稳定**：会话过期轮换只换 session，**不删指纹**——修掉 MAXeaglet「每小时清理定时器把过期会话连同指纹一起删 → 每 12–13h 换一台机器」的无意副作用（调研 §1.5 指认，连作者自己的注释/README 都不是这个本意）。进程重启 = 状态全空，首见 key 重新生成指纹并立即重报（MAXeaglet 同款重启语义）。
- **唯一落盘物 = 版本缓存**（§6），其余伪装状态一律不落盘。
- 后续增强（非本期，留门不实现）：指纹落盘跨重启稳定。触发条件：真实环境出现与「设备频繁更换」相关的风控证据再立项。

## 2. 预请求时机（D2）

- 结构照抄 MAXeaglet：per-key 首次主请求前，指纹记录与 lifecycle 两个预请求**并行**发出（同一 `Promise.all`）；此后按重报节奏惰性补发（每次主请求前比对 `nextInitAt`，不挂定时器）。
- **修一处真 bug**：每个预请求挂**独立 3s 超时**（`AbortSignal.timeout(3000)`）。MAXeaglet 预请求无独立超时，网关挂起时主请求被拖着白等 5 分钟（调研 §8.2）。
- 超时/失败的主请求**照常放行**（降级语义见 §5）；预请求在后台继续跑完，仅更新状态与日志，不影响本次响应。
- 预请求头照抄：`Content-Type`、`x-cli-environment: production`、`Authorization: Bearer <key>`、`x-command-code-version`；不带 `x-session-id` / `x-project-slug` / `traceparent`（调研 §1.4/§2）。

## 3. 会话身份与 project-slug（D3）

- **身份规则（老板拍板）**：一段 OpenCode 会话 = 一个 `x-session-id`；不同会话不共享。动机：会话标识稳定利于服务端会话关联（老板提出亦有利于缓存命中、减少开销），且贴合真实 CLI「一个会话一个 session」的语义。
- **主路径（绑定）**：调用参数中可见 OpenCode 会话标识时，`x-session-id` 由其**确定性派生**（sha256 → 32 hex → 修补 uuid v4 的版本/变体位），无需任何存储即保证「同会话同 id、跨重启同 id」；`x-project-slug` 照抄调研 §4 算法从该 id 派生，同会话 slug 随之稳定。
- **回退路径**：看不到会话标识时，照抄 MAXeaglet——per-key 随机 uuid v4，12h + 0~1h 抖动惰性轮换（此路径无法区分会话边界，属尽力而为）。
- **可见性验证**：v1/v2 调用参数里到底能不能拿到 OpenCode 会话 id，由实测票 #11/#12 验证并回填本文主路径的取值位置。
- slug 派生修 NaN 边界（调研 §9.2）：id 前 4 字符非 hex 时回退哈希派生，绝不产出含 `undefined` 的 slug。
- MAXeaglet 的入站头透传（`x-session-id` / `x-claude-code-session-id`）**不适用**：插件形态没有入站 HTTP 头，其位置由上述绑定主路径取代。

## 4. lifecycle 事件（D4）

- **节奏**：铸造新会话时发一次——绑定路径 = 每个会话在本进程内首次请求前；回退路径 = 首次用前 + 每次 12–13h 轮换时。与指纹的 8–10h 重发**解绑**（MAXeaglet 把两者捆在一拍，而本事件字面语义是「这个会话存在」，理应跟着会话走）。
- **身份同源**：`metadata.sessionId` = `"sess_" + x-session-id 去连字符后前 16 位 hex`——保持 MAXeaglet 的 wire 格式，但与主请求头讲同一个故事，消灭「嘴上说会话 A 存在、手上签会话 B」的两套 ID 破绽（调研 §2 疑点）。#9 若抓到两套 ID 的真实关系与本派生不符，以抓包为准。
- 其余照抄：`eventType: "cli_session_exists"`；`cliVersion` = 当前 ccVersion；`mode: "interactive"`；`os: "win32-x64"`（取自伪装人格，MAXeaglet 从指纹 platform-arch 拼接，同值）；请求头同预请求（§2）。

## 5. 失败降级（D5）

**总则：预请求的任何结局都不影响主请求的发出与响应**——jiesou/brent 从不发预请求也能长期使用，裸奔不致命；因遥测失败扣押用户请求是用用户体验给伪装失败陪葬，否决熔断。

预请求单元（两个请求合记，照抄 MAXeaglet 的耦合结构）结局分类：

| 结局 | 判定 | 动作 |
|---|---|---|
| 成功 | 两个都 2xx | `nextInitAt = now + 8h + rand*2h`（照抄节奏），`failCount = 0` |
| 瞬时失败 | 网络错误 / 超时 / 5xx（任一） | 不推进 8–10h；`nextAttemptAt = now + min(60s × 2^failCount, 15min)`，`failCount++`；下次主请求前到点即重试 |
| 拒绝 | 4xx（含 401/403，任一） | `nextAttemptAt = now + 8h + rand*2h` 长冷却；服务器明确说「不」之后继续敲门更像机器人，且 403 可能意味着 key 已被盯上，安静是上策 |

- MAXeaglet「发过就无条件进 8–10h 冷却」的语义**弃用**（调研 §8.2 证明是其死代码注释掩盖的实际行为）：一次开局网络抖动不该让 key 裸奔一整天。
- 失败只记日志（脱敏见 §7），不重试队列、不落盘、不跨进程记忆——重启归零是可接受的。

## 6. 版本头 `x-command-code-version`（D6）

- **全局单值**（D6a）：一台真机只装一个 CLI，版本与 key 数量无关；全部 key、全部请求（主请求 + 预请求 + models）共享同一值。
- **首请求前 1.5s 竞速**（D6b）：进程内首次需要该值时，给 npm 查询 1.5s 上限——抢到用新值，抢不到先用兜底值放行、查询转后台继续。修 MAXeaglet fire-and-forget 的「初期请求带陈旧兜底值」瑕疵，同时不让被墙的 npm 拖住首请求。
- **24h 惰性刷新**（D6c）：每次主请求前比对「距上次成功拉取是否超 24h」，超时后台触发拉取。不挂 `setInterval`（插件生命周期负担），**不加抖动**（各进程启动时间天然分散，无收益）。
- **数据源顺序**：npm registry 直连（1.5s 上限）→ jsDelivr 镜像 `cdn.jsdelivr.net/npm/command-code/package.json`（1.5s 上限，国内可达性好）。
- **取值兜底链**（都拉不到时）：① 落盘的「上次成功拉取值」→ ② 包内快照的 `sourceCliVersion` 字段（`docs/spec/model-pipeline.md` §1.1 预留的离线兜底接口，随插件发版更新，不会烂在代码里）。
- 落盘物：`<缓存目录>/opencode-commandcode/version-cache.json`（`XDG_CACHE_HOME` 优先，默认 `~/.cache`），内容 `{version, fetchedAt}`，原子写（临时文件 + rename）。这是伪装模块**唯一**的磁盘 IO（D1）。
- 预留：#10 分发渠道拍板后，构建产物可直接携带 cliVersion 成为兜底链新层级，届时修订本节。

## 7. 日志脱敏（D7）

总则（老板拍板）：不泄露敏感信息。

| 对象 | 日志形态 |
|---|---|
| apiKey | `cc-key#` + sha256(apiKey) 前 8 位 hex——日志中零原文 |
| thumbmark / sessionId / trace-id | 本身即伪标识符，截断为前 12 位 hex + `…` |
| Authorization 头 / 完整 key | 永不输出；错误日志只记 HTTP status 与错误类别，不序列化请求头 |

级别：预请求成功、版本刷新成功 = `debug`（默认安静）；预请求失败、降级路径、落盘异常 = `warn`。

通道：**注入式 logger**——伪装模块不直接依赖 opencode 客户端；v2 glue 注入 `client.app.log`，v1 与独立调用退化 console，测试注 no-op。

## 8. 伪装人格（D8）

- **单一 win32-x64 人格逐字照抄**：CPU/内存/时区随机池、`platform: "win32"`、`arch: "x64"`、`osRelease: "10.0.22631"` 硬编码、thumbmark 拼接序与「五字段不入哈希」结构、`isContainer/runtime/collectorVersion` 常量——与被逆向对象字节级同构是当下唯一有依据的安全姿态；多平台池属无 ground truth 的纯发明，不做。
- **修一处自相矛盾**（照抄反而是把破绽抄进来）：请求体 `config.environment` 的 platform-arch 部分报人格值 `win32-x64`（MAXeaglet 报进程真实平台，Linux 部署即自曝，调研 §7）；Node 版本部分报真实运行时版本——真实 CLI 的版本分布未知，不发明。
- 时区照抄池随机，不读用户真实时区。

## 9. 照抄 / 修写 / 不适用 对照表

**照抄（逐字）**：指纹随机池与生成算法；thumbmark 联合哈希；slug 派生算法（NaN 修补除外）；traceparent 生成；请求头集合与取值（`x-cli-environment` / `x-co-flag` / `x-taste-learning`）；指纹重报节奏 8–10h；回退路径会话寿命 12–13h；lifecycle 事件类型与 metadata 形状；per-key KeyState 结构；重启即重造重报。

**修写（相对 MAXeaglet）**：

| 项 | 改法 | 理由 |
|---|---|---|
| 预请求无超时 | 独立 3s | 网关挂起拖死主请求 5 分钟（调研 §8.2） |
| 失败无条件 8–10h 冷却 | 差异化退避/冷却 | 死代码注释掩盖的实际行为；一次抖动 = 裸奔一天 |
| 清理连带删指纹 | 指纹进程内稳定 | 每 12–13h 换机是作者本意外的副作用 |
| lifecycle 捆绑 8–10h 节奏 + 现造 sess id | 绑会话 + 同源派生 | 两套互不引用的 ID 是画像破绽 |
| environment 报真实平台 | 报人格值 | Linux 部署自曝 win32 谎言 |
| slug NaN 边界 | hex 校验回退 | 透传 id 可产出 `undefined` slug |
| 版本头 fire-and-forget + 硬编码兜底 | 1.5s 竞速 + 落盘/快照链 | 初期请求带陈旧值；被墙用户集体陈旧成异常簇 |
| 模块级散装全局变量 + appendFileSync | 单一模块 state + 注入 logger | 插件形态无文件日志；两版 glue 共用同一实现 |

**不适用 / 丢弃**：本地反代服务器形态（架构主判例是进程内转换，不起本地服务）；入站 session 头透传（插件无入站 HTTP 头，由会话绑定主路径取代，见 §3）；两套 session id 并存（同源化，见 §4）；死代码 `threadId`。

## 10. 参数速查

| 参数 | 值 |
|---|---|
| 预请求独立超时 | 3s |
| 版本竞速上限 / jsDelivr 尝试上限 | 1.5s / 1.5s |
| 版本惰性刷新间隔 | 24h |
| 指纹重报节奏（成功后）/ 4xx 长冷却 | 8h + rand×2h |
| 回退路径会话寿命 | 12h + rand×1h |
| 瞬时失败退避 | 60s × 2^n，上限 15min |

## 11. 备选与否决记录

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

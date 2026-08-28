# 伪装层全量规格调研（MAXeaglet/commandcode-proxy 逆向提炼）

> 调研日期：2026-08-28。对应工单：#2「伪装层全量规格调研（MAXeaglet 逆向提炼）」。
> 目的：把 MAXeaglet/commandcode-proxy 的伪装机制提炼成算法级规格，作为本插件伪装模块的设计输入。
>
> **引用约定**：本文所有行号均指 `proxy.mjs`（1940 行）在 commit **`bb5120e343f289b0db86a03f029e91ac556b1d28`**（2026-08-13，master HEAD）下的行号，下文简记为 `bb5120e`。README_zh.md 引用同样基于该 commit。

## 0. 素材可得性声明（重要）

工单要求以 `proxy.mjs` + `captured-requests/` 抓包数据为一手素材。实测结论：

- **`captured-requests/` 在公开渠道不存在**。它被写入 `.gitignore`（`bb5120e` 的 `.gitignore` 第 9 行），从未进入任何 commit——已遍历该仓库全部 git 历史（`git rev-list --all` 逐 commit `git ls-tree` 检索）、`test` 分支（`117a5b6`）与 GitHub Releases，均无此目录。README.md / README_zh.md 第 43 行仍声称仓库含此目录，**与实际不符**（作者本地目录，`0ff7efe` "gitignore captured-requests" 起不再随仓库分发）。Dockerfile 只 `COPY package.json proxy.mjs`，GHCR 镜像里同样没有。
- 因此本文**全部结论来自 `proxy.mjs` 源码**（`bb5120e`），README_zh.md 的「反检测」表（L341-361）仅作同作者旁证；**没有任何一条结论有独立抓包数据印证**。凡代码与注释/README 不一致处，已在正文标出。这一缺口影响见「§9 开放问题」Q1。

---

## 1. `POST /alpha/fingerprint/record` —— 设备指纹

源码位置：`generateFingerprint()` L78-119，随机池常量 L52-76；发送逻辑在 `ensureInitialized()` L235-287（见 §8）。

### 1.1 随机池全集（bb5120e 逐项抄录）

- **CPU 型号池 `FINGERPRINT_CPUS`（L52-68，恰好 15 个，型号↔核心数绑定）**：

| # | 型号 | cores |
|---|---|---|
| 1 | 12th Gen Intel(R) Core(TM) i7-12650H | 10 |
| 2 | 12th Gen Intel(R) Core(TM) i5-12400F | 6 |
| 3 | 12th Gen Intel(R) Core(TM) i9-12900K | 16 |
| 4 | 13th Gen Intel(R) Core(TM) i7-13700K | 16 |
| 5 | 13th Gen Intel(R) Core(TM) i5-13600K | 14 |
| 6 | 13th Gen Intel(R) Core(TM) i9-13900K | 24 |
| 7 | Intel(R) Core(TM) Ultra 7 155H | 16 |
| 8 | Intel(R) Core(TM) Ultra 9 285H | 16 |
| 9 | Intel(R) Core(TM) i9-14900K | 24 |
| 10 | Intel(R) Core(TM) i7-14700K | 20 |
| 11 | AMD Ryzen 7 7800X3D | 8 |
| 12 | AMD Ryzen 9 7950X | 16 |
| 13 | AMD Ryzen 5 7600 | 6 |
| 14 | AMD Ryzen 9 7900X | 12 |
| 15 | AMD Ryzen 7 5800X3D | 8 |

  （全部为 Windows x64 桌面/移动端型号；`platform:'win32'`、`arch:'x64'`、`osRelease:'10.0.22631'`（Win11 22H2 内部版本号）为**硬编码**，不参与随机，L107-109。）

- **内存池 `FINGERPRINT_MEMS`（L69）**：`[8, 16, 24, 32, 48, 64]`——**6 个离散值等概率抽取**，不是"8-64G 内均匀分布"（README 说的"内存 8-64G"即指此池）。
- **时区池 `FINGERPRINT_TZS`（L70-75，恰好 15 个）**：`America/New_York`、`America/Chicago`、`America/Los_Angeles`、`America/Toronto`、`Europe/London`、`Europe/Berlin`、`Europe/Paris`、`Europe/Moscow`、`Asia/Shanghai`、`Asia/Tokyo`、`Asia/Singapore`、`Asia/Seoul`、`Asia/Hong_Kong`、`Australia/Sydney`、`Pacific/Auckland`。
- **MAC 数量 `FINGERPRINT_MAC_COUNT_RANGE`（L76）**：`[2, 3, 4, 5]` 等概率抽一个，生成对应个数的 MAC 哈希。

### 1.2 各组件哈希的生成算法（L84-93）

辅助函数：`sha256(s) = hex(sha256(utf8(s)))`（L84，输出 64 位小写 hex）；`randHex(n) = hex(randomBytes(n))`（L85，输出 2n 位 hex 字符串）。

```
macCount      ← random_pick([2,3,4,5])                  // L82
macHashes[i]  ← sha256(randHex(32))   i = 0..macCount-1  // L87-88，输入为 64 字符随机 hex 串
machineIdHash ← sha256(randHex(32))                     // L90，同上
osUserHash    ← sha256(randHex(16))                     // L91，输入为 32 字符随机 hex 串
hostnameHash  ← sha256(randHex(16))                     // L92
gitEmailHash  ← sha256(randHex(16))                     // L93
```

注意：输入**不是**模拟的"MAC 地址/主机名"等真实形态值，而是纯随机 hex 串直接过哈希——即这五个哈希字段除长度分布（machineId/MAC 输入 64 字符，其余 32 字符）外无任何内部结构，服务端无法（也不需要）校验原像格式。

### 1.3 thumbmark 联合哈希的确切算法（L95-97）

```js
thumbData = [machineIdHash, ...macHashes, osUserHash, hostnameHash, gitEmailHash,
             'win32', '10.0.22631', cpuModel, String(cpuCount), String(memGiB)]
             .join('|');
thumbmark = sha256(thumbData);   // 64 位小写 hex
```

- 拼接顺序精确为：machineIdHash → 按 macHashes 数组顺序 → osUserHash → hostnameHash → gitEmailHash → 平台字面量 `'win32'` → osRelease 字面量 `'10.0.22631'` → cpuModel → cpuCount（十进制字符串）→ memGiB（十进制字符串），分隔符 `|`，编码 UTF-8，输出小写 hex。
- **参与联合哈希的字段**：machineIdHash、macHashes（全部）、osUserHash、hostnameHash、gitEmailHash、platform、osRelease、cpuModel、cpuCount、memGiB。
- **不参与联合哈希的 components 字段**：`arch`、`timezone`、`isContainer`、`runtime`、`collectorVersion`（L96 的数组里没有它们）——即服务端若重算 thumbmark，这五个字段改了也算不出来；这是实现者的取舍（或疏漏），复刻时建议原样保留以保持与"被逆向对象"字节级同构。
- 已用独立 Node 脚本复算验证该算法可确定性重现（相同输入 → 相同 thumbmark）。

### 1.4 POST body 形状（L99-118 + L253）

`body = JSON.stringify({ thumbmark, components })`，其中：

```json
{
  "thumbmark": "<64hex>",
  "components": {
    "machineIdHash": "<64hex>",
    "macHashes": ["<64hex>", "…2~5 个"],
    "osUserHash": "<64hex>",
    "hostnameHash": "<64hex>",
    "gitEmailHash": "<64hex>",
    "platform": "win32",
    "arch": "x64",
    "osRelease": "10.0.22631",
    "cpuModel": "<池中型号原文>",
    "cpuCount": 10,
    "memGiB": 32,
    "isContainer": false,
    "timezone": "<池中 IANA 时区名>",
    "runtime": "cli",
    "collectorVersion": 1
  }
}
```

共 15 个 components 字段。`collectorVersion` 是数字 `1` 而非字符串；`macHashes` 为数组。

### 1.5 per-key 绑定方式（L214-229）

- `keyStateStore: Map<apiKey, { fingerprint, nextInitAt }>`（L216）；`getOrCreateKeyState()`（L218-229）在**首次见到某 apiKey** 时生成一次指纹并常驻内存，之后该 key 的所有 record 请求复用同一指纹对象。
- 指纹的**再生成**不发生在 8h 刷新时（刷新只是重发同一对象），而是发生在**会话清理**时：每小时的清理定时器（L185-196）把过期 session 连同其 keyState 一并删除（L191），该 key 下次请求到来时重新生成全新指纹、`nextInitAt=0` 立即重报。即：**指纹身份的实际寿命 ≈ session 寿命（12h + 0~1h 抖动）**，与"每 8h 刷新"是两件事（README L347 的"每 8h+2h 抖动刷新"指的是重发节奏，不是换指纹）。
- 进程重启 = 全部指纹重造（无持久化）。

### 1.6 刷新节奏（8h + 2h 抖动）的实现（L232-233, L281-283）

```
INIT_REFRESH_MS = 8h;  INIT_JITTER_MS = 2h            // L232-233
成功走完 Promise.all 后：                              // L281-282
  nextInitAt = Date.now() + 8h + floor(random() * 2h)  // 均匀分布 8~10h
```

无持久化、无进程级定时器——是"惰性检查"：每次主请求前比对 `now < nextInitAt`（L238）决定是否补发。失败时该值如何变化见 §8。

---

## 2. `POST /alpha/lifecycle-events` —— 生命周期声明

源码位置：`ensureInitialized()` L261-277（与指纹请求经 `Promise.all` 并行发出，L250-278）。

- **请求头**：与指纹请求完全相同（L242-247）：`Content-Type: application/json`、`x-cli-environment: production`、`Authorization: Bearer <key>`、`x-command-code-version: <CC_VERSION>`。**不携带** `x-session-id`/`x-project-slug`/`traceparent`/`x-co-flag`/`x-taste-learning`。
- **事件类型全集（bb5120e 实现中）**：仅 1 种 —— `eventType: "cli_session_exists"`（L264）。没有其他事件类型被发送。
- **metadata 字段（L265-270）**：

| 字段 | 取值 | 备注 |
|---|---|---|
| `sessionId` | `` `sess_${crypto.randomBytes(8).toString('hex')}` `` | 即 `sess_` + 16 位小写 hex（L266）。**每次发 lifecycle 事件都现场随机造一个，与 §3 会话存储里的 uuid `x-session-id` 无任何关联**——两套 ID 格式（`sess_<16hex>` vs uuid v4）并存且互不引用，这是实现层面的显著疑点（真实 CLI 是否如此无从验证，见 §9 Q3） |
| `cliVersion` | `CC_VERSION`（动态 npm 版本，见 §6） | L267 |
| `mode` | `"interactive"` | L268，硬编码 |
| `os` | `` `${fingerprint.components.platform}-${fingerprint.components.arch}` `` | L269，因指纹硬编码而恒为 `"win32-x64"` |

- **发送时机**：每个 key 首次请求前必发；此后随指纹一起按 8h+2h 抖动节奏重发（同一 `Promise.all`，见 §8）。

---

## 3. `x-session-id` —— 会话伪装

源码位置：`ensureSession()` L168-182、`getSessionId()` L198-209、常量 L163-166、清理定时器 L185-196；消费点在 `forwardToCC()` L758/L767。

- **生成规则**：`crypto.randomUUID()`（L178）→ **RFC 4122 version 4**（随机 UUID，带连字符标准格式）。
- **per-key 独立**：`sessionStore: Map<apiKey, { sessionId, expiresAt }>`（L166），每 key 一条。
- **12h 过期 + 1h 抖动**（L163-164, L177-179）：
  ```
  jitter    = floor(random() * 1h)          // 0 ~ 1h 均匀分布
  expiresAt = now + 12h + jitter            // 实际寿命 12~13h
  ```
  过期后（或首次）下次请求换新 UUID（L172-179）。**惰性过期**：读取时检查，另有每小时清理定时器删除过期条目及其 keyState（L185-196）。
- **对客户端传入头的透传优先级**（L198-209）：
  1. `x-session-id`（入站请求头）
  2. `x-claude-code-session-id`（入站请求头）
  3. ——按顺序取第一个"非空字符串且 `length >= 8`"的值（L204-205），**直接透传**，不校验格式、不写回 sessionStore；
  4. 都没有 → `ensureSession(apiKey)` 走 per-key 存储。
  注意：透传的客户端 ID 也被用于派生 `x-project-slug`（L770），见 §4 的 NaN 边界问题。

---

## 4. `x-project-slug` —— 假工作目录派生

源码位置：`fakeProjectSlug(sessionId)` L331-345；消费点 `forwardToCC()` L770。输入是**实际发送的 sessionId**（§3 的产物），因此同 key 在同一会话周期内 slug 稳定，会话轮换时 slug 跟着变。

### 算法（伪代码）

```
names = [app, api, backend, bot, cli, core, data, frontend,
         lib, plugin, proxy, server, service, tool, web, worker]   // 16 个，L334-335
name   = names[ parseInt(sessionId[0:4], 16) % 16 ]                // L336
suffix = sessionId[0:4]                                            // L337
path   = `C:\Users\dev\projects\${name}-${suffix}`                 // L339，模拟 Windows 路径
slug   = path.toLowerCase()                                        // L341
         .replace(/^[a-z]:/i, '')        // 删盘符 "c:"             // L342
         .replace(/[^a-z0-9]+/g, '-')    // 非 [a-z0-9] 连续段 → '-' // L343
         .replace(/^-+|-+$/g, '')        // 掐头去尾 '-'            // L344
```

### 实测输出（用 bb5120e 的函数体原样执行验证）

- sessionId `a3f2…` → `0xa3f2 % 16 = 2` → `backend` → **`users-dev-projects-backend-a3f2`**
- `0000…` → `users-dev-projects-app-0000`；`ffff…` → `users-dev-projects-worker-ffff`

**两处与文档不一致 / 缺陷，实测确证**：

1. **盘符前缀并未保留**。源码注释（L332「结果形如 "d-users-dev-projects-web-app-a3f2"」）和本仓库 `reference-projects.md` 里的示例（`c-users-dev-projects-web-app-a3f2`）都**错了**：`/^[a-z]:/` 连字母带冒号一起删掉，首个 `\` 又被转成 `-` 再被掐头，产物**没有** `c-`/`d-` 前缀。真实 CLI 的 slug 是否带盘符前缀，没有抓包可证（见 §9 Q1）。
2. **NaN 边界**：客户端透传的 session id 只要求 `length >= 8`（L205）；若前 4 字符非 hex（如 `zzzz1234…`），`parseInt(...,16)` 返回 NaN → `names[NaN]` 为 `undefined` → 产出含 `undefined` 字样的坏 slug：`users-dev-projects-undefined-zzzz`（实测）。复刻时应加 hex 校验兜底。

---

## 5. `traceparent` —— W3C Trace Context

源码位置：`generateTraceparent()` L347-351；消费点 `forwardToCC()` L757/L771。

```js
traceparent = `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`
//             版本  trace-id（32 位小写 hex）          parent-span-id（16 位小写 hex）      flag
```

- **版本**恒为 `00`（W3C 当前版本）；**trace-id** 32 位 hex（16 随机字节）；**span-id** 16 位 hex（8 随机字节）；**flag** 恒为 `01`（recorded + sampled 位）。满足 W3C 对 trace-id「非全零、32 hex」的格式要求（随机字节实际不可能全零）。
- **每个请求新造**：`forwardToCC()` 每次调用都执行 `generateTraceparent()`（L757），trace-id/span-id 全新随机、跨请求零复用。注：严格按 W3C 语义，同一 trace 应共享 trace-id、每跳换 span-id；MAXeaglet 的"全随机"做法放弃了 trace 关联性，换来的是最简实现。真实 CLI 是否复用 trace-id 无抓包可证（§9 Q6）。
- 只出现在 `/alpha/generate` 主请求；指纹/lifecycle 预请求（L242-247）与 `/provider/v1/models`（L1836-1843）都不带。

---

## 6. `x-command-code-version` —— 动态版本号

源码位置：常量 L121-123，`refreshCCVersion()` L126-139，启动调用 L140，定时器 L141；消费点：`forwardToCC` L766、预请求 L246、`fetchModels` L1840、lifecycle metadata L267。

### 实现（bb5120e 精确描述）

- 初始值与兜底值均为硬编码 `'0.32.3'`（L121-122）。
- `refreshCCVersion()`：`fetch('https://registry.npmjs.org/command-code/latest', { signal: AbortSignal.timeout(10000) })`（L128-129，10 秒超时）→ 取 `pkg.version`（要求非空字符串）→ 覆写内存变量 `CC_VERSION`（L132-133）。
- **失败处理**：HTTP 非 2xx / JSON 异常 / 网络错误 / 超时 → 仅 `log('warn')`，保持当前 `CC_VERSION` 不变（L136-138）。
- **节奏**：进程启动时立即调用一次（L140，**不 await**——fire-and-forget，启动初期的请求会带着兜底值 0.32.3 出门）；此后 `setInterval` 每 24h 固定触发（L123/L141），**无抖动、无持久化缓存文件**，纯内存。
- 读的是 npm dist-tag `latest` 文档的 `version` 字段，等于"官方 CLI 最新发版号"。

### 与 pin 死版本的对比（结合本仓库 `reference-projects.md` 的旁证）

jiesou 与 brent-weatherall 两个项目均 pin `0.26.20` 也能长期工作（jiesou `src/protocol.ts` 注释原话："Gateway compatibility rides on the `x-command-code-version` header"——网关兼容性主要由这个头担保）。

| 维度 | 动态 npm latest（MAXeaglet） | pin 死版本（jiesou / brent） |
|---|---|---|
| 群体一致性 | 与真实 CLI 用户主流版本同步，不随时间漂移成"孤版本" | 时间越久越像离群值（全网都升级后仍报旧版） |
| 可用性依赖 | 启动时需能访问 registry.npmjs.org；被墙/断网时退化到硬编码兜底值（且兜底值会随代码陈旧） | 零外部依赖，完全确定 |
| 协议匹配风险 | **反向风险**：npm 出新版的瞬间，proxy 会自称新版本但仍在讲旧协议；若新版改了信封字段，伪装头反而先行背叛了 body | 版本与 body 永远自洽（body 按 pin 的版本行为实现） |
| 被风控画像 | 版本分布贴近真实群体 | 长期单一旧版本可能进入风控统计的长尾 |
| 实现复杂度 | +30 行（fetch/超时/定时/兜底） | 一行常量 |

**对插件的建议（设计输入）**：动态 + 兜底的混合式——启动时 await 拉一次（MAXeaglet 的 fire-and-forget 是个可修的瑕疵）、24h+抖动刷新、失败无限期沿用上次成功值（而非固定字符串）、启动时读一次本地缓存则更稳；同时 pin 的兜底值应随版本发布更新。

---

## 7. 其余伪装头

消费点集中在 `forwardToCC()` L762-772（除注明外）：

| 头 | 取值 | 位置 | 作用/备注 |
|---|---|---|---|
| `x-cli-environment` | `"production"` | L244（预请求）、L765（generate）、L1839（models） | 声明 CLI 构建渠道；三处端点都带，值恒定 |
| `x-co-flag` | `"false"`（字符串） | L768 | 仅 generate 携带。语义无任何注释/文档说明（README_zh L353 仅列名）；从命名与 `"false"` 取值推测是某功能开关的上报位。**纯策略性取值，无法从代码确证服务端语义**（§9 Q2） |
| `x-taste-learning` | `"false"`（字符串） | L769 | 同上；推测是"是否允许用会话数据改进 taste（品味/风格记忆）"的退出开关。请求体里同时有 `taste: null`（L457），两处互证"不参与 taste 功能"的姿态 |
| `Authorization` | `Bearer user_…` | L764 | key 经 `getApiKey()`（L737-751）从入站 `Authorization: Bearer` 或 `x-api-key` 中以正则 `user_[a-zA-Z0-9_-]+` 提取——同时起到"清洗前缀/拒绝非 user_ 格式 key"的作用 |
| `Content-Type` | `application/json` | L763 | — |

另注（非头、相关）：`buildCcRequest()` 里 `config.environment = \`${process.platform}-${process.arch}, Node.js ${process.version.slice(1)}\``（`getEnvironment()` L361-363）——上报的是 **proxy 进程自己**的平台与 Node 版本，与指纹声称的 `win32-x64` 在 Linux 部署时**自相矛盾**（README 示例 `win32-x64, Node.js v24.16.0` 是作者在 Windows 跑的产物）。插件移植时应统一人格（见 §8 移植清单第 5 条）。还有一处死代码：L442 `const threadId = newThreadId()` 计算后从未进入请求体（全文件唯一出现），复刻时丢弃。

---

## 8. 伪装请求失败时的行为 & `ensureInitialized` 完整控制流

源码位置：`ensureInitialized()` L235-287；调用点 `handleChatCompletions()` L816、`handleMessages()` L1567（均在构建完请求体之后、`forwardToCC()` 之前 `await`）。

### 8.1 控制流（逐步）

```
主请求进入
 └─ await ensureInitialized(apiKey, abortSignal)          // L816 / L1567 —— 阻塞点
     ├─ state = getOrCreateKeyState(apiKey)                // 首见 key → 现场生成指纹（L218-229）
     ├─ now < state.nextInitAt ? return : continue         // L238 惰性节流
     ├─ headers = {Content-Type, x-cli-environment, Authorization, x-command-code-version}  // L242-247
     ├─ await Promise.all([                                 // L250-278，两个预请求并行
     │    ① POST /alpha/fingerprint/record  body=JSON(fingerprint)
     │       .then(r => r.ok ? log info : log warn status)  // L254-256：HTTP 失败只记日志
     │       .catch(e => e.name!=='AbortError' && log warn) // L257-259：网络异常只记日志
     │    ② POST /alpha/lifecycle-events   body=JSON({eventType, metadata})
     │       .then/.catch 同构                              // L272-277
     │  ])
     ├─ nextInitAt = now + 8h + floor(rand*2h)              // L281-282，无条件执行（见 8.2）
     └─ outer catch: 非 AbortError → log "will retry next request"  // L284-286
 └─ await forwardToCC(...)                                   // 主请求这才出发
```

### 8.2 精确失败语义（含与注释矛盾处的指认）

1. **单个预请求失败（HTTP 4xx/5xx 或网络错误/超时）不抛出、不重试**：每个 fetch 都自挂 `.then/.catch`，失败被吞成日志（L254-259, L272-277）。
2. **`nextInitAt` 照样推进——失败也进入 8~10h 冷却**。这是 bb5120e 的**实际行为**：因为 ①② 永不 reject，`Promise.all` 必然 resolve，L281-282 无条件执行。L285 外层 catch 的日志文案"will retry next request"（下次请求重试）**是事实上的死代码**——外层 catch 只有在 `.then/.catch` 处理器自身抛异常时才可达。**代码行为与 L280 注释「成功：8h + 2h 随机抖动」及 README「每 8h+2h 抖动刷新」的语义都有出入：不是"成功后才排期"，而是"发起过就排期"。** 两预请求全挂的 key 会被冷却 8~10 小时不重报指纹。
3. **是否阻塞主请求：阻塞，但只到预请求 settle 为止**。`await ensureInitialized` 串行在 `forwardToCC` 之前；且这两个 fetch **没有独立超时**——传入的 `signal` 只在客户端断连时触发（L806/L818）。网关若挂起不响应，主请求会被无限期拖住（实际由 undici 默认 headers/body 300s 超时兜底，最终以网络错误被吞掉，但那时主请求已白等了 5 分钟）。**客户端断连（AbortError）发生在预请求阶段时同样被吞**（L258/L276 显式排除 AbortError 不记日志），随后继续尝试发主请求（fetch 会立刻因 aborted signal 失败，进入断连处理路径）。
4. **静默降级总结**：任何伪装预请求失败都不影响主请求的发出与响应内容——只有日志差异。风险全部后置到风控侧（服务端看到的是一个"从不报指纹"的客户端）。
5. **无重试队列 / 无退避 / 无持久化**：失败痕迹只存在于日志；进程重启后一切归零重造。

### 8.3 对插件实现的直接启示（设计输入，非 MAXeaglet 原行为）

按 §8.2 的三个瑕疵反向设计：① 预请求应带独立短超时（如 `AbortSignal.timeout(5~10s)`），绝不阻塞主请求——建议 fire-and-forget 或与主请求并行；② 失败时**不推进** `nextInitAt`（或设一个分钟级短冷却），让下次请求尽快重试；③ 修复外层死代码语义，把"失败重试"写进状态机而不是日志文案。

---

## 9. 可直接移植 / 需改写清单

许可前提：仓库 LICENSE 为 **MIT**（Copyright (c) 2026 MAXeaglet），直接移植+改造无法律障碍，仅需保留许可声明。运行目标为 OpenCode 插件进程（Bun 运行时，兼容 `node:crypto` / 全局 `fetch` / `AbortSignal.timeout`，均 ≥ Node 18 语义）。

### 9.1 可直接移植（逐函数）

| 函数/常量 | 行号（bb5120e） | 说明 |
|---|---|---|
| `FINGERPRINT_CPUS` 等 4 个池 | L52-76 | 纯常量，原样照抄 |
| `generateFingerprint()` | L78-119 | 只依赖 `node:crypto`（createHash/randomBytes）+ `Math.random`，Bun 全兼容；建议保留 thumbmark 拼接序与"五字段不入哈希"的原样结构 |
| `SESSION_DURATION_MS/JITTER_MS`、`ensureSession()`、`sessionStore` | L163-182 | `randomUUID` Bun 支持；Map 内存态原样可用 |
| `getSessionId()` | L198-209 | 纯逻辑（NaN 修补除外，见 9.2） |
| `fakeProjectSlug()` | L331-345 | 纯字符串函数；修 NaN 边界后照抄 |
| `generateTraceparent()` | L347-351 | 一行模板串 |
| `refreshCCVersion()` | L126-139 | 全局 `fetch` + `AbortSignal.timeout`，Bun 可用；改 await + 本地缓存后移植 |
| `forwardToCC()` 的头装配块 | L762-772 | 头集合与顺序（HTTP 头实际无序，值照抄） |

### 9.2 需改写 / 需适配

| 项 | 行号 | 问题与改法 |
|---|---|---|
| `ensureInitialized()` 整体 | L235-287 | 见 §8.3：加独立超时、失败不推进 `nextInitAt`、避免阻塞主请求。结构可保留，语义必须改 |
| 会话/指纹的每小时清理定时器 | L185-196 | `setInterval` 在插件里需挂到插件生命周期（dispose 时清除）；且"清理连带删指纹"导致指纹每 12~13h 换新——真实设备指纹应长期稳定，建议改为持久化 per-key 指纹（OpenCode `ctx.storage`），只保留重报节奏 |
| 指纹身份的 Windows 人格 | L107-109 | `win32/x64/10.0.22631` 硬编码。可原样沿用（单一人格最简、可复算），也可扩展多平台池——属设计决策，无 ground truth 支持哪种更安全 |
| `getEnvironment()` 与 `config.workingDir` | L361-363, L446 | MAXeaglet 上报 proxy 自身的真实 cwd/平台，与指纹人格可能矛盾（Linux 上跑就是 `linux-x64`）。插件内应改为与 sessionId 派生的假路径、指纹人格三方自洽 |
| `fakeProjectSlug` 的 NaN 边界 | L336 | 客户端透传非 hex session id 时产出 `undefined` slug（实测）；加 `^[0-9a-f]{4}` 校验，不匹配则回退哈希派生 |
| lifecycle `sessionId` 与 `x-session-id` 两套 ID 并存 | L266 vs L178 | MAXeaglet 让两者互不相关（格式还不同：`sess_<16hex>` vs uuid v4）。无抓包能裁决哪个像真的；建议作为独立决策点（见 §10 Q3），而不是无脑照抄 |
| 模块级全局状态 + fire-and-forget 启动 | L140, L166, L216 | 插件进程内应收敛到单一 state 对象；版本刷新改 await（或竞速限时）后再放行首个请求 |
| `appendFileSync` 日志 | L156 | 换 OpenCode `client.app.log` |
| 死代码 `threadId` | L212, L442 | 丢弃 |

---

## 10. 开放问题（建议追加工单）

- **Q1 抓包 ground truth 缺失（高优先）**：本规格全部算法来自对 MAXeaglet 实现的阅读，无一条有独立抓包印证；且已发现其注释/README 与行为存在至少 3 处出入（§4 前缀、§8.2 冷却语义、§7 环境矛盾）。建议追加工单：用 mitmproxy 抓一次真实官方 CLI 的 `/alpha/fingerprint/record`、`/alpha/lifecycle-events`、`/alpha/generate` 流量，校准指纹 body 形状、slug 是否带盘符前缀、两套 session id 的真实关系。
- **Q2 `x-co-flag` / `x-taste-learning` 服务端语义不明**：可设计对照实验（去掉/改值发请求）验证是否影响响应或风控。
- **Q3 会话 ID 人格决策**：`x-session-id`（uuid v4）与 lifecycle `sess_<16hex>` 两套格式的取舍，取决于真实 CLI 行为（依赖 Q1）。
- **Q4 指纹持久化策略**：真实 CLI 的 machineId 应跨会话稳定；MAXeaglet 每 12~13h 换全指纹。插件若走 `ctx.storage` 持久化 per-key 指纹，长期一致性更好——但"哪个更不像机器人"无实证。
- **Q5 版本头的 npm 出网依赖**：OpenCode 插件运行在用户机器上，直连 `registry.npmjs.org` 可能被墙；需决定兜底版本号的更新渠道（随插件发版 vs jsDelivr 镜像）。

---

## 附：本调研取证路径备忘

- 克隆：`git clone --depth 1 https://github.com/MAXeaglet/commandcode-proxy /tmp/opencode/commandcode-proxy`，后 `git fetch --unshallow` 展开全史取证。
- `captured-requests/` 缺失的验证：`git log --all -- captured-requests/` 为空；全历史 `git ls-tree -r | grep -i captur` 为空；`test` 分支（`117a5b6`）与 GitHub Releases 无；`.gitignore` L9、README L43 为孤证。
- slug/NaN 边界与 thumbmark 可复算性：以 bb5120e 函数体原样抽出，Node 22 下独立执行验证（输出见正文 §4）。

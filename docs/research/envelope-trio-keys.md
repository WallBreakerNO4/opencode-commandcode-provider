# CLI 信封 memory / taste / skills 三键取证调研（逐键 ground truth + opencode 侧数据可读性）

> 调研日期：2026-09-02。对应工单：**#25**（wayfinder 地图 #1 的 research 票），结论供 `disguise.md` §9.1 逐字段表与 `protocol.md` §1 的回填拍板（回填本身不在本调研范围）。
> 调研对象：官方 npm 包 **`command-code` 1.38.2**（与抓包版本一致），主文件 **`dist/cli.mjs`**（2.4MB、15 行的 tsup+terser 产物，`__name()` 调试标注保留原始函数名）。
> 交叉验证素材：`capture/samples/generate.json`（2026-08-30 真实流量抓包，3 条 generate 记录，`cli_version: 1.38.2`）。
>
> **引用约定**：与 `cli-config-collection.md`（#23 报告）一致——下文偏移均为 `dist/cli.mjs` 内的**字节偏移**（`grep -bo` 可复现）。⚠️ 复现时注意：文件含多字节字符（如系统提示词常量里的 em-dash，UTF-8 占 3 字节），用 node 读取后以 JS 字符串 `indexOf` 定位得到的是 UTF-16 码元偏移，会与字节偏移漂移（本调研实测同一处代码两套偏移相差约 800）；须按 `Buffer` 语义（如 `toString("latin1")`）取偏移，或直接用 `grep -bo`。
>
> **素材位置**：解包在 `/tmp/opencode/cc-cli/package`（重取：`https://registry.npmmirror.com/command-code/-/command-code-1.38.2.tgz`）。仅维护者环境静态分析（grep / Buffer 切片），与 #23 边界一致：绝无要求用户安装 CLI，全程未执行包内任何代码。

---

## 0. 主链路全貌：三键在哪、怎么填

generate 请求体由 `createModelClient`（偏移 **772224**）构造，`/alpha/generate` 路由常量 `Sv="/alpha/generate"`（偏移 **1690341**）。**全 bundle 中 `route:Sv` 仅出现 1 次**（偏移 773003 附近的 postStream 调用）——即 generate 信封只有这一个构造点，无第二条路径。还原代码（偏移 772150–772360，语义逐字对应）：

```js
for (let n = 0; n <= Jg; n++) {                       // Jg=5（偏移 1566210 常量区），上限 6 次尝试
  const r = await e.transport.postStream({
    route: Sv,
    body: {
      config: d,                                      // 进程级缓存的 buildServerConfig 结果（#23 已定案）
      memory: null,                                   // ← 字面量，偏移 773039
      taste: null,                                    // ← 字面量
      skills: null,                                   // ← 字面量
      permissionMode: u,                              // toWirePermissionMode(t.permissionMode)，偏移 767946
      threadId: toWireThreadId(t.threadId),           // 偏移 768055
      mode: t.mode,                                   // 偏移 772319
      params: { model: t.model, messages: l, tools: c, system: t.system,
                max_tokens: t.maxOutputTokens ?? 64e3, stream: !0,
                ...(void 0 !== t.temperature ? { temperature: t.temperature } : {}),
                ...(i ? { reasoning_effort: i } : {}) }   // i = registry.supportsThinking 时才取 effort
    },
    headers: w, signal: t.signal
  }), ...
}
```

**三键是硬编码的 `null` 字面量**——不是变量、不是条件表达式。全文穷举复核（证明没有第二处赋值路径）：

- `memory:` 作为对象键全文仅 **3** 处：773039（本信封）、1054205（`analyzeContext` 上下文分析里 `k = s ? s.memory : w` 一行，`s` 为响应侧 breakdown 数据，客户端实际不传——见 §4）、1725006（`/import` 命令的分类标签 `"memory":"Memory"`）——后两处与请求体无关。
- `taste:` 作为对象键全文 11 处，逐一核对均为其他语境（通知文案、system prompt 拼装、`/context`、状态视图、学习管线、taste push UI 等），无一在请求体里。
- `skills:` 键 30+ 处全部在技能发现/目录渲染/工具定义语境。
- JSON 序列化在 `createNodeTransport`（偏移 **585079**）的 send 函数里：`body: ... JSON.stringify(r.body)`（偏移 **585436**）——值为 `undefined` 的键会被 `JSON.stringify` 丢弃。这解释了抓包里 `mode` 键的有无（见 §4）。

**两个相邻键的取值逻辑（顺带定案，供 §9.1 参考）**：

- `permissionMode`（`toWirePermissionMode`，偏移 767946）：`bypass→"auto-accept"`、`"auto-accept"`/`"plan"` 原样透传、其余 → `"standard"`。抓包恒 `"standard"` ✓。
- `threadId`（`toWireThreadId`，偏移 768055）：uuid v4 校验通过才原样携带，**校验失败返回 `undefined` → 键被 JSON.stringify 丢弃**（信封七键会变六键；抓包三条记录 threadId 均为合法 uuid，七键齐全）。
- `mode`：主会话 chat 的 callParams 不含 `mode`（agent 上下文无此字段，偏移 863322 起的 `bt` 对象可证）→ `t.mode` 为 `undefined` → 线上**省略该键**；plan 模式只改 `permissionMode`（`setPermissionMode`），不影响 `mode` 键。内部功能调用经 `withUsageContext`（偏移 **700401**：`complete(t) => base.complete({...t, threadId: t.threadId ?? e.threadId?.(), mode: t.mode ?? e.mode})`）注入 purpose 值，代码中观测到的 wire 值有 `"learning"`（taste 学习器，偏移 861223 附近 `O("learning")`）、`"vision"`（图片视觉辅助调用，偏移 419570）、`"custom-agent"`（子代理，偏移 657441 的子代理 config `d={...,mode:"custom-agent",...}`——**子代理的 system prompt 是 agent 定义的静态 `systemPrompt`，不含 memory/taste/skills 三个拼装段**）。抓包记录 3 实测 `"learning"`。

**响应侧旁证**：`createNodeTransport.postStream` 只返回 `i.body`（响应体流，偏移 586082 起的函数体），**响应头全部被丢弃**——包括 `x-system-prompt-breakdown` 在内的所有响应头，CLI 客户端从不读取。该头是纯服务端观测面（见 §4）。

---

## Q1 `memory` 键

**结论**：**恒 `null`（字面量死键），与项目里有没有 AGENTS.md 无关**。memory 数据根本不走信封——AGENTS.md 的内容由**客户端拼进 `params.system`**（system prompt 字符串）的 `<instructions>` 块发送。

**三键的真实去向（system prompt 拼装链）**：`createSystemPromptBuilder`（偏移 **738699**，经 `Ie=createSystemPromptBuilder({...})` 偏移 855431 装配，agent 上下文以 `systemPrompt: Ie` 注入，偏移 **864419**，**每轮请求都重新调用**——与 `config` 的进程级缓存不同）：

```js
function createSystemPromptBuilder(e) {
  return async t => {
    const n = [base /* basePrompt(permissionMode) */];
    const r = await getMemoryContent({ runtime: e.runtime, cwd: e.runtime.cwd(),
      contextPaths: t.contextPaths ?? await stateContextPaths({ runtime: e.runtime, state: t.state }) });
    r && n.push(`<instructions>\n${r.trim()}\n</instructions>`);       // ← memory 进 system prompt
    ...
    const i = await (e.taste?.()) ?? null;
    n.push(renderTasteSection2({ taste: i }));                         // ← taste 进 system prompt（Q2）
    const a = renderSkillsSection({ skills: e.skillCatalog?.() ?? null });
    a && n.push(a);                                                    // ← skills 进 system prompt（Q3）
    n.push(Dw);                                                        // <explore_agent> 子代理指引块
    ... scratchpad → envContext（进程级缓存，#23 已定案）→ ideContext
    return n.join("\n\n")
  }
}
```

**memory 内容来源（`getMemoryContent`，偏移 **735621**；`loadAllMemories`，偏移 **734695**）**——四层文件，全部读取并拼接：

| 层 | 路径（`getEnterpriseMemoryPath` 731959 / `getUserMemoryPath` 732161 / `getProjectMemoryPaths` 732245） |
|---|---|
| Enterprise | linux：`/etc/.commandcode/AGENTS.md`；darwin：`/Library/Application Support/CommandCode/AGENTS.md`；win32：`C:\ProgramData\CommandCode\AGENTS.md` |
| User | `~/.commandcode/AGENTS.md`（`HOME ?? USERPROFILE`） |
| Project | `<projectRoot>/AGENTS.md` **或** `<projectRoot>/.commandcode/AGENTS.md`（首个存在者优先，只取一个） |
| Subdirectory | 从本轮 `contextPaths`（用户 `@` 提及/代理读过的文件）逐级向上走到项目根，沿途 `<dir>/AGENTS.md` 或 `<dir>/.commandcode/AGENTS.md`，**最外层先入**，每层取先存在的一个 |

**非空时的数据形状**（还原自 `getMemoryContent` 735621 + 拼装点 739013）：

```text
<instructions>
# Memory from: /etc/.commandcode/AGENTS.md      ← 企业层（若存在）
<内容>

---

# Memory from: ~/.commandcode/AGENTS.md         ← 用户层（若存在）
<内容>

---

# Memory from: <项目>/AGENTS.md                 ← 项目层（若存在）
<内容>

---

# Memory from: <子目录>/AGENTS.md               ← 子目录层（按发现顺序）
<内容>
</instructions>
```

- 块间分隔符 `\n\n---\n\n`；每个文件自带 `# Memory from: <绝对路径>` 头。
- `@path` 引用会被递归展开（`expandMemoryImports`，偏移 **733922**，≤5 层，展开块加 `# Imported from <path>` 头，代码围栏内不展开，解析失败保持原文本）。
- 全部层都不存在 → `getMemoryContent` 返回 `null` → `<instructions>` 块整个不进 system prompt（信封 `memory` 键**依然**是 null——两者无关联）。
- 空项目/非 git 目录照常读（memory 读取先于 git 判定，与 config 的 structure 同理）。

**抓包对照**：抓包仓库根**有** `AGENTS.md`（`config.structure` 第一项即它），system prompt 43689 字符（`params.system`，被脱敏为 `<redacted-text len=43689>`）——内容大概率已包含 `<instructions>` 的 AGENTS.md 拼接块；而信封 `memory` 仍为 `null`。这直接证伪「空环境导致 null」假说：**环境有数据，键照样 null，因为键是死键**。

---

## Q2 `taste` 键

**结论**：**恒 `null`（字面量死键）**。taste（学到的偏好画像）同样**客户端拼进 `params.system` 的 `<taste>` 块**，且**无条件渲染**——没有数据时也渲染一段空态文案。

**内容来源（`getTasteContent`，偏移 **828118**）**：两个文件，按序读取：

1. `~/.commandcode/taste/taste.md`（用户级）
2. `<cwd>/.commandcode/taste/taste.md`（项目级）

```js
async function getTasteContent(e) {
  const t = homeDir(e.runtime),     // HOME ?? USERPROFILE
    n = [t ? `${t}/.commandcode/taste/taste.md` : "",
         `${e.runtime.cwd()}/.commandcode/taste/taste.md`].filter(x => x.length > 0),
    r = [];
  for (const p of n) {
    const c = (await readIfExists({ runtime: e.runtime, path: p }))?.trim() ?? "";
    isHeaderOnly(c) || r.push(c)    // 仅剩自动生成头部的文件跳过
  }
  return r.length > 0 ? r.join("\n\n") : null
}
```

（`readIfExists` 827143；`isHeaderOnly` 826983——识别仅含 `# Taste (Continuously Learned by …)` 之类自动头部的空文件；`homeDir18` 827060。）

**渲染形状（`renderTasteSection2`，偏移 **728070**，`<taste>` 标签起点 728140）**：

- **有内容**：

  ```text
  <taste>
  Below is the complete content of the .commandcode/taste/taste.md file.
  This shows you what preferences are available and which categories might have additional details in separate files.
  If you see references like "See [category/taste.md]", you MUST read that file using read_file to get the full preferences.

  --- Content of .commandcode/taste/taste.md ---

  <taste.md 原文>

  --- End of .commandcode/taste/taste.md ---
  </taste>
  ```

- **无内容**（taste.md 缺失或仅头部）：渲染固定空态段 `No preferences learned yet for this project. …`——**该块恒出现**。

**taste.md 数据形状**（学习管线视角，`getTasteStructure` 602833 / `parseCategories` 603066 / `runTasteTool` 604703）：markdown，`# <分类名>` 分节，学习条目为 `- …` 列表项且内含 `Confidence:` 标注；更细的分类拆到 `<分类>/taste.md` 子文件，正文以 `See [category/taste.md]` 引用（渲染文案据此指示模型用 read_file 追读）。

**学习管线（taste 数据怎么长出来）**：`createLearner`（偏移 **605707**）——一轮会话结束后（learning mod 的 `onRunEnd`，且 `isTasteLearningLiveOn()` 为真——该谓词 = **非 BYOK 且设置开启**，偏移 ~842288 处 `x = async () => !isByok(model) && isTasteLearningEnabled({runtime, userConfigPath, projectPath})`）**发起独立的内部模型调用**：

- `modelClient = O("learning")`（`withUsageContext` 注入 `mode:"learning"`）；
- 系统提示词为常量 `ly`（偏移 1603177 起，"You are the taste-learning agent…"）：源码字面量 1415 字节，还原成运行时 UTF-16 字符串恰为 **1394 字符**（13 处 `\'`/`\n` 转义各省 1 字符、4 个 em-dash 的 UTF-8 三字节序列各省 2 字节）——**与抓包记录 3 的 `params.system` 脱敏长度 1394 精确吻合**，即抓包记录 3 就是这次学习调用；
- 工具集 `cy` 恰为 **`read_taste_file` / `write_taste_file` / `edit_taste_file`** 三个（偏移 1604581 起；抓包记录 3 的 `params.tools` 实测正是这三个）；
- 学习产物通过这三个工具**写在本地** `.commandcode/taste/` 下；`emitLearningSignals`（偏移 603400）对比前后结构发 `taste learned/upgraded/downgraded/moved` 通知；`reorganizeIfNeeded`（603404）按需把主文件分类挪进子文件。
- 开关落点：用户配置 `tasteLearning`（`isTasteLearningEnabled` 偏移 386295；`/taste` 命令、`npx taste` CLI、BYOK 抑制）。

**请求头联动**：`x-taste-learning` 头 = `tasteLearningEnabled.toString()`（`buildCommandAuthHeaders`，常量表偏移 1598217）——**动态值**，非恒真：BYOK 模型或用户关掉 learning 时变 `"false"`（状态视图文案 "Learning off (byok)" 偏移 ~1124098 可证）。抓包三条记录均 `"true"`。

**抓包对照（决定性）**：抓包记录 3（15:25:58）**就是一次 taste 学习调用**：`mode:"learning"`、`params.tools` 恰为三个 taste 工具、system 1394 字符——而它的信封 `memory/taste/skills` **仍然是三个 `null`**。即：**即便在 taste 学习实际发生的场景里，三键也不填**。「learning 模式会填键」的假说被直接证伪。

---

## Q3 `skills` 键

**结论**：**恒 `null`（字面量死键）**。skills 由**客户端**以两种载体进请求：① `params.system` 里的 `<skills>` + `<available_skills>` XML 目录块；② `activate_skill` 工具的 `name` 枚举（`params.tools`）。技能全文**不进**任何请求字段——激活时（`activate_skill` 被调用）才由 `wrapSkillContent`（偏移 **135057**）把全文注入当轮消息。

**发现位置（`createSkillRegistry`，偏移 **131969**）**——按优先级扫描，同名先到先得（`project:0 < user:1 < extra:2 < bundled:3` 排序后去重，被遮蔽者记 warning 不静默丢弃）：

| 序 | 来源 | 路径 |
|---|---|---|
| 1 | project | `<cwd>/.commandcode/skills`、`<cwd>/.agents/skills`；有 git root 且 ≠ cwd 时再加 `<gitRoot>/` 下同名两处；无 git root 时向上找 `.commandcode`/`.agents` 目录 |
| 2 | user | `~/.commandcode/skills`、`~/.agents/skills` |
| 3 | extra | `--skill` 启动参数与 settings `skills` 数组指定的额外目录 |
| 4 | bundled | 包内 `dist/bundled/`（`bundledSkillsDir()` 偏移 122638 = `dirname(import.meta.url)/bundled`，即 package 自带的 `agent-browser` / `command-code-knowledge` / `config` / `design` / `mod-builder` / `skill-builder` 六个） |

每个技能 = 含 `SKILL.md`（或 `skill.md`，`resolveSkillMdPath` 535616）的目录，frontmatter 经 `parseFrontmatter`（122948）解析；嵌套目录递归扫描（深度上限 5，`Ih=5`）。

**目录渲染形状（catalog 工厂，偏移 ~133800–134700；`<available_skills>` 起点 134715）**：

```xml
<available_skills>
  <skill>
    <name>code-review</name>
    <description>Perform thorough code reviews…</description>
    <argument-hint>[branch]</argument-hint>      ← 可选
    <location>/abs/path/to/SKILL.md</location>
  </skill>
  …
</available_skills>
```

- 总字符预算 **8000**（`Ss=8e3`；可用环境变量 `COMMANDCODE_SKILL_CATALOG_CHAR_BUDGET` 覆盖，偏移 134230），超出时描述逐条截断（上限 250 字符，`ws=250`），再超则降级为仅 `<name>` 列表（namesOnly）。
- `disable-model-invocation: true` 的技能不进目录（catalog 与枚举都排除）。

**activate_skill 工具（偏移 **136128** 起）**：`name` 枚举 = 注册表中未被禁用、未设 `disable-model-invocation` 的技能名集合——这正是抓包里 `activate_skill.input_schema.properties.name.enum` 的来源（23 项：17 个抓包仓库项目技能 `gh`/`code-review`/… + 6 个 bundled 技能）。

**`skills-lock.json` 与 CLI 无关（修正既有前提）**：#23 报告与 #25 工单提到「包内含 skills-lock.json 痕迹」——本次全量核查**不成立**：`skills-lock`/`skillsLock` 在 `cli.mjs` **零命中**，包内全部 md/CHANGELOG/README 零命中，vsix 解包 strings 亦零命中。`skills-lock.json` 是 **`npx skills` 安装器生态的产物**（本仓库根现有一份：`{"version":1,"skills":{"gh":{"source":"cli/cli","sourceType":"github",…}}}`；抓包仓库的 `config.structure` 里也因装过技能而出现它）。它只作为「项目根的一个普通文件」被 `config.structure` 顺带列出，CLI 对其内容零感知。

**抓包对照**：抓包环境装有 17 个项目技能 + 6 个 bundled 技能（enum 23 项实证），`<skills>` 块必然在 43689/54072 字符的 system prompt 里——**有技能数据的环境，键照样 null**。

---

## 4. 与抓包对照：三键恒 null 的成因复核

三条 generate 记录（`capture/samples/generate.json`）逐项核对：

| 记录 | 时间 | 键集 | mode | params.system | params.tools | breakdown 头 |
|---|---|---|---|---|---|---|
| 0 | 15:23:03 | 七键（无 mode） | —— | 43689 字符 | 11 个（含 activate_skill，enum 23 项） | `{"systemPrompt":11903,"memory":0,"taste":0}` |
| 2 | 15:24:26 | 七键（无 mode） | —— | 54072 字符 | 12 个 | `{"systemPrompt":14705,"memory":0,"taste":0}` |
| 19 | 15:25:58 | **八键（含 mode）** | `"learning"` | 1394 字符 | **3 个 taste 工具** | `{"systemPrompt":377,"memory":0,"taste":0}` |

- **三键成因定案**：`memory/taste/skills` 在源码中是唯一构造点上的字面量 `null`（§0），三条记录无一例外 → **「CLI 从不填」，不是「该环境没有数据」**。抓包环境其实有 AGENTS.md、23 个技能与 54072 字符的大 system prompt——数据俱全，键仍 null。
- **breakdown 头语义（服务端面，客户端不可见）**：`systemPrompt` 与 `params.system` 的字符/token 比高度一致（43689/11903≈3.67、54072/14705≈3.68、1394/377≈3.70）→ 服务端把客户端发来的 `params.system` 计为 systemPrompt 段；`memory`/`taste` 两个计数器对应**信封键派生的服务端拼装段**，键恒 null → 计数恒 0。即该头是服务端为「信封三键通道」预留的观测面，当前 CLI 版本下恒走零值。CLI 客户端不读响应头（§0），此头对伪装无约束力。
- **源码无法覆盖的动态面**：仅剩「服务端收到非 null 三键时如何处置」（是否注入 system prompt、是否影响 breakdown 计数/风控）。这是纯服务端行为，**不影响伪装规格**（伪装的目标是复刻真实 CLI 的线上形状，而真实 CLI 恒发 null）。见 §6 可选复验。

---

## 5. opencode 侧数据可读性矩阵（「从 opencode 读数据来填」路线评估）

**结论先行**：该路线**不成立，且属方向性误设**——不是「能不能读到」的问题，而是**根本不该填**：伪装规格的总则是逐字段照抄官方实现（`disguise.md` §9 总则），官方 1.38.2 的三键恒为 `null` 字面量；把 opencode 侧数据填进三键反而会**偏离 ground truth**（线上形状从 `null` 变为非 null，且服务端 breakdown 通道被意外激活的风险不可控）。以下矩阵仅作事实存档，供理解两侧数据面。

| 数据类 | opencode 侧有什么 | v1（`provider.<id>.npm` 插件）读法 | v2（beta，`aisdk:`/integration hook 插件）读法 |
|---|---|---|---|
| **AGENTS.md / 规则类 memory** | 项目级 `AGENTS.md`（v1 自 cwd 向上找首个；v2 聚合全局 `~/.config/opencode/AGENTS.md` + Location 上行至 home/项目根的**全部** `AGENTS.md`，v2 **无 CLAUDE.md 回退**）；`instructions` 配置数组（v2 暂不加载）；内容均进 system prompt | ① 直接读文件（插件模块跑在 opencode 的 bun 进程内，可 `import node:fs`，`PluginInput` 给 `directory`/`worktree`，`$` 为 BunShell）；② **`experimental.chat.system.transform` hook**（`input {sessionID?, model}` → `output {system: string[]}`，可读写每次请求的成品 system prompt，含规则渲染结果） | ① 同样直接读文件（`ctx.location` 给 `directory`/`project.canonical`）；② **`session.hook("context")`**（`SessionContext`：`system: SystemPart[]`——`{type:"text", text, cache?, metadata?}` 数组，即 opencode 拼好的各 system 段，含 AGENTS.md 聚合与 skills 广告；另有 `messages`/`tools`/`generation`/`providerOptions`，可读写） |
| **skills（SKILL.md 面）** | v1：`.opencode/skills/<name>/SKILL.md`、`~/.config/opencode/skills/`、`.claude/skills`/`.agents/skills` 兼容位；`<available_skills>` 出现在 **skill 工具的描述文本**里 | 直接读文件（无 skills 插件 API）；工具描述无法从插件 hook 直读 | **`ctx.skill.list()`**（`SkillDomain extends SkillApi`）→ `Skill.Info[]`：`{id, name, description?, slash?, autoinvoke?, location(绝对路径), content(全文)}`——**结构化、含全文**；另有 `ctx.skill.transform/reload`；`/api/skill` 服务端 API 同形 |
| **skills-lock.json** | 非 opencode 数据——`npx skills` 安装器产物，落在项目根 | 直接读文件（无任何 API 面） | 同左 |
| **taste / 学习类数据** | opencode **无对应子系统**（无学习画像存储） | 无 | 无现成面；插件可用 **`ctx.storage`**（get/set/remove/scan，插件私有 JSON 持久化）自建，或读 `skill.updated` 等事件 |

**文件系统可读性总判**：v1/v2 插件都是**进程内代码模块**（bun 运行时），`node:fs` 导入无阻；v1 另有 `$/BunShell` 与 SDK `client`（可调服务端 API），v2 有 `ctx.shell` 与更全的能力域。**「读得到」在两侧都成立；但读来的数据没有可填的去处（三键必须 null）**。

---

## 6. 最小复验场景（源码无法覆盖的动态面）

**定案不需要复验**：客户端侧证据已闭环——唯一构造点 + 字面量 + `JSON.stringify` 丢 `undefined` 键语义 + 三条抓包记录（含 learning 调用）全部吻合。三键取值无任何条件分支可走。

以下场景**与伪装规格无关**，仅当老板想探「服务端对非 null 三键的行为」时才值得考虑（需真实 key、真实计费流量，HITL 决定执行与否；本调研不建议为伪装目的执行）：

1. **服务端三键通道探测**：手工构造一次 generate 请求（形状照抄真实 CLI），把 `memory` 置为一个小的 AGENTS.md 拼接块（或 `taste` 置 taste.md 文本），观察响应头 `x-system-prompt-breakdown` 的 `memory`/`taste` 计数是否从 0 变为非零、上游实际收到的 system 是否被服务端追加了段落。观察点：breakdown 头数值、`finish` 事件的 `systemPromptTokens`、上游 token 用量变化。
2. **学习模式下的信封稳定性**：真实登录态下关闭/开启 taste learning（`/taste`），跑一轮会话触发学习调用，核对学习调用的信封三键仍为 null（源码已证，此项仅为行为级双保险）。

---

## 7. 结论（供主会话拍板与回填）

1. **三键事实定案**：`memory` / `taste` / `skills` 在 `command-code` 1.38.2 中是 **generate 信封的三个硬编码 `null` 死键**——无赋值路径、无条件分支、与运行环境数据量无关（有 AGENTS.md / 23 技能 / taste 学习进行中的抓包记录同样全 null）。三键的真实数据通道是客户端 `params.system`（`<instructions>` / `<taste>` / `<skills>` 块）与 `params.tools`（activate_skill 枚举、学习调用的 taste 工具集），服务端 `x-system-prompt-breakdown` 的 memory/taste 计数器对应信封键通道，当前版本恒 0。
2. **「是否存在真实非空场景」的事实判断：不存在**（就 1.38.2 客户端侧而言，任何模式/环境/数据量下都恒 null；唯一无法从源码覆盖的是服务端对非 null 值的处置，但那不属于「CLI 会不会填」的范畴）。
3. **opencode 数据填充路线：否决**——可读性不是瓶颈（矩阵见 §5），方向本身不成立：照抄 ground truth 就必须发 `null`。
4. **回填建议**（回填动作不在本调研范围，待 grilling 拍板）：`disguise.md` §9.1 逐字段表补三行——`memory`/`taste`/`skills` 恒 `null`（字面量照抄，勿读任何数据源填充），并注明三键的真实数据通道在 `params.system`/`params.tools`；`protocol.md` §1 的「逐字段规格见 `docs/spec/disguise.md` §9」自引断裂随之消除。`x-taste-learning` 头的动态语义（learning 开关 + BYOK 抑制）可顺带在伪装规格中复核（当前 spec 拍板值 `"true"` 与抓包一致，但源码显示其非恒真——BYOK/关学习时为 `"false"`，属新信息）。
5. **HITL 复验需求：定案不需要**。§6 两个场景为可选的服务端行为探测，与伪装规格无涉，执行与否由老板决定。

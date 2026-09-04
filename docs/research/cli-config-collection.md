# 官方 CLI config 块采集逻辑调研（generate 信封 · 逐字段 ground truth）

> 调研日期：2026-09-01。对应工单：**#23**（wayfinder 地图 #1 的 research 票），结论供 **#19** 伪装规格补完拍板收口。
> 调研对象：官方 npm 包 **`command-code` 1.38.2**（与抓包版本一致），主文件 **`dist/cli.mjs`**（2.5MB，15 行的 tsup+terser 打包产物，`__name()` 调试标注保留了原始函数名，可还原度高）。
> 交叉验证素材：`capture/samples/generate.json`（2026-08-30 真实流量抓包，`cli_version: 1.38.2`）。
>
> **引用约定**：`dist/cli.mjs` 是 minified 产物，**字节偏移比行号可靠**（绝大多数代码挤在第 2 行）。下文偏移均为该文件内的字节偏移（`grep -bo` / node `buf.slice(a,b)` 可复现）。文中代码为还原排版（补空格/换行、恢复形参名），语义与原文件逐字对应。
>
> **素材位置**：解包在 `/tmp/opencode/cc-cli/package`（如需重取：`https://registry.npmmirror.com/command-code/-/command-code-1.38.2.tgz`）。仅维护者环境静态分析，与 #23 边界一致：绝无要求用户安装 CLI 或在用户机器上解析。

---

## 0. 主链路全貌：`buildServerConfig`

config 块由 `buildServerConfig({runtime})` 构建（偏移 **699652**，函数名 `__name` 标注原名）。还原代码：

```js
async function buildServerConfig(e) {
  const { runtime: t } = e,
    n = await readStructure({ runtime: t }),                       // structure（先采，含非 git 分支）
    r = (new Date).toISOString().split("T")[0] ?? "",              // date
    o = t.platform(),                                              // environment
    s = t.cwd();                                                   // workingDir
  if (!await shellOutput({ runtime: t, command: "git rev-parse --git-dir" }))
    return {                                                       // 非 git 仓库：九字段齐全的空值形状
      workingDir: s, date: r, environment: o, structure: n,
      isGitRepo: !1, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: []
    };
  const i = await shellOutput({ runtime: t, command: "git branch --show-current" }),
    a = await resolveMainBranch({ runtime: t }),
    l = await shellOutput({ runtime: t, command: "git status --porcelain" }),
    c = await shellOutput({ runtime: t, command: "git log --oneline -3" });
  return {
    workingDir: s, date: r, environment: o, structure: n,
    isGitRepo: !0, currentBranch: i, mainBranch: a,
    gitStatus: l || "Working tree clean",
    recentCommits: c ? c.split("\n") : []
  };
}
```

git 查询全部经 `shellOutput`（偏移 **698947**）：

```js
async function shellOutput(e) {
  try {
    const t = await e.runtime.shell.run({ command: e.command });
    return 0 !== t.code ? "" : t.stdout.trim();
  } catch { return "" }
}
```

`runtime` 真实实现是 `createNodeRuntime()`（偏移 **40355**）：`cwd()` = `process.cwd()`，`platform()` = `process.platform`，`workspaceRoots()` = `[process.cwd(), ...additionalDirs]`。

**缓存（重要）**：config 在进程级只构建一次，两条消费路径各自缓存——

- model client（偏移 **772233** `createModelClient`）：

  ```js
  const n = async () => e.config ? (t || (t = await e.config()), t) : {};   // resolveConfig，t 为闭包缓存
  // 请求体：body: { config: d, memory: null, taste: null, skills: null, permissionMode: u, ... }
  ```

  `config` 回调即 `() => buildServerConfig({runtime})`（偏移 **788018**），首次 generate 请求时构建，之后复用同一对象。
- system prompt 的 envContext（偏移 **855344**）：`Me ??= buildServerConfig({runtime}).then(e => renderEnvContext({config: e}))`，同样只构建一次。

即：**每个 CLI 进程生命周期内，git/status/log/structure 各跑一次，结果冻结复用**；会话中途的分支切换、新提交不会反映到后续请求。

---

## Q1 `mainBranch` 如何判定？

**结论**：三级 fallback，全部围绕远程分支推断，从不直接采当前分支：

1. `git symbolic-ref --short refs/remotes/origin/HEAD` 成功 → 取输出并 `replace(/^origin\//, "")`（`origin/main` → `main`）；
2. 失败 → `git branch -r`：输出**包含** `"origin/main"` → `"main"`；否则包含 `"origin/master"` → `"master"`；
3. 兜底 `"main"`。

**代码证据**（`resolveMainBranch`，偏移 **~699450**，函数名 `__name` 标注）：

```js
async function resolveMainBranch(e) {
  const t = await shellOutput({ runtime: e.runtime, command: "git symbolic-ref --short refs/remotes/origin/HEAD" });
  if (t) return t.replace(/^origin\//, "");
  const n = await shellOutput({ runtime: e.runtime, command: "git branch -r" });
  return n.includes("origin/main") ? "main" : n.includes("origin/master") ? "master" : "main";
}
```

**与抓包一致性**：样本仓库 `git symbolic-ref --short refs/remotes/origin/HEAD` 可解析（main 分支仓库），config 里 `"mainBranch": "main"` ✓。
**置信度**：高（代码直证 + 抓包吻合）。#19 访谈临时拍板的「报当前分支」**被纠偏**：这是独立的远程 HEAD 推断，与本地产出无关。

## Q2 非 git 仓库下 config 块的形状？

**结论**：**九字段齐全、显式空值，绝不省略字段**。`git rev-parse --git-dir` 拿不到输出（非仓库/未装 git 时 `shellOutput` 返回 `""`，falsy）→ 提前 return：`isGitRepo: false`、`currentBranch: ""`、`mainBranch: ""`、`gitStatus: ""`、`recentCommits: []`；`workingDir/date/environment/structure` 照常采集（structure 在 rev-parse **之前**采，非 git 目录也有内容）。

**代码证据**：见 §0 主链路 `if (!await shellOutput(...)) return {...}` 分支（偏移 699652 起的函数体）。
**与抓包一致性**：抓包仅含 `isGitRepo: true` 样本，无直接对照；但消费侧旁证一致——`renderEnvContext`（偏移 **~730890**）里 `t.isGitRepo ? \`...branch/status/commits...\` : ""`，即非 git 时 prompt 整段置空而 config 对象本身字段不变。
**置信度**：高（代码直证；#19 访谈拍板的「省略」**被纠偏**为「显式空值」）。

## Q3 git 查询失败的处理？有无 try/catch、超时、并发？

**结论**：

- **逐字段独立降级，绝不抛出**：`shellOutput` 用 try/catch 包住整个调用；非零退出码 → `""`，异常（git 未装、进程起不来）→ `""`，成功 → `stdout.trim()`。因此：无提交 → `git log` 空输出 → `recentCommits: []`；`branch --show-current` 失败 → `currentBranch: ""`；`git status --porcelain` 失败 → `gitStatus` 落到 `"Working tree clean"`（注意：**失败与干净工作区在输出上不可区分**，官方接受了这一歧义）。
- **无超时**：`runtime.shell.run`（`createNodeShell`，偏移 **~37768**）底层 `spawn(command, [], {shell: true, detached: process.platform !== "win32", windowsHide: true})`，**没有任何 timeout 逻辑**；中断只在外部传入 AbortSignal 时发生（`onAbort` 分支），而 `shellOutput` 不传 signal → git 命令挂起则 config 构建挂起（且因进程级缓存，只在首请求发生一次）。
- **无并发**：`buildServerConfig` 内 4 步 git 查询（`--show-current` → `resolveMainBranch` 内 1~2 步 → `status --porcelain` → `log --oneline -3`）全部顺序 `await`；`resolveMainBranch` 内部也是先 `symbolic-ref` 后（可能）`branch -r`。
- **失败路径的字段值汇总**：非仓库 → 见 Q2；git 未装 → 同 Q2 形状（`rev-parse` 返回 `""`）；单条命令失败（如在 git 仓库里 `log` 因空仓库失败）→ 对应字段 `""`/`[]`，`isGitRepo` 仍为 `true`。
- **缓存**：见 §0——config 进程级只建一次（`t || (t = await e.config())`），失败结果（如空串）同样会被缓存复用。

**代码证据**：`shellOutput`（698947）、`createNodeShell().run`（~37768，无 timeout 参数；AbortSignal 仅显式传入才生效）、§0 调用序列。
**与抓包一致性**：抓包为成功路径，无失败样本；形状旁证（`c.split("\n")`、`l || "Working tree clean"` 的类型）与样本字段类型吻合。
**置信度**：高（代码直证）。「无超时」是对照 `createNodeShell` 全文与调用参数的否定性结论，已穷尽该链路。

## Q4 `structure` 的采集：深度、过滤、上限、排序

**结论**：

- **深度**：`fs.readdir(process.cwd())` **仅当前目录单层**，无递归、无 glob、无深度参数。文件与目录混排（不区分类型，`readdir` 返回纯文件名数组）。
- **过滤**：`!name.startsWith(".")`（全部点开头条目）+ `!tw.has(name)`；`tw` 黑名单（偏移 **1629355**）：`node_modules, dist, build, .git, .svn, .hg, coverage, .nyc_output, .cache, tmp, temp, .next, .nuxt, out`（14 项；其中点开头的被第一条规则覆盖，属冗余保险）。**不读 .gitignore**（`ignore` 包在依赖里但此链路不用），也**不区分文件/目录**。
- **数量上限**：**无**。
- **排序**：`.sort()` 默认字典序（UTF-16 码元序，大写字母在小写前）。
- **尾部追加 scope 标签**：`scopeDirLabels`（偏移 **698768**）把 `workspaceRoots()` 里非 cwd 的额外工作区目录格式化为 `"scope:" + formatScopeDir(...)` 追加在数组**末尾**（不参与 sort）。`formatScopeDir`（偏移 **698460**）：目录即 cwd → `"."`；在 cwd 下 → `"./xxx"`；即 home → `"~"`；在 home 下 → `"~/xxx"`；否则原样绝对路径。readdir 抛异常 → 返回仅含 scope 标签的数组。

**代码证据**（`readStructure`，偏移 **699083**）：

```js
async function readStructure(e) {
  const t = scopeDirLabels({ runtime: e.runtime });
  try {
    return [
      ...(await e.runtime.fs.readdir({ path: e.runtime.cwd() }))
        .filter(e => !e.startsWith(".") && !tw.has(e))
        .sort(),
      ...t
    ];
  } catch { return [...t] }
}
// tw = new Set(["node_modules","dist","build",".git",".svn",".hg","coverage",".nyc_output",".cache","tmp","temp",".next",".nuxt","out"])  // 偏移 1629355
// createNodeFileSystem().readdir = fs.promises.readdir(path)  → string[]  // 偏移 ~36531
```

**与抓包一致性**：样本 `"structure": ["AGENTS.md","CONTEXT.md","capture","docs","prototype","skills-lock.json"]`——6 条按码元序（`AGENTS.md`/`CONTEXT.md` 大写 C=67 排在小写 c=99 之前，正是默认 `sort()` 的特征）；抓包仓库根无 node_modules 等黑名单目录，无点开头文件，与过滤规则不冲突 ✓；无 scope 标签（单工作区，`workspaceRoots()` 仅 cwd 一项被 filter 掉）✓。
**置信度**：高（代码直证 + 排序特征吻合）。

## Q5 `date`：时区与格式

**结论**：**UTC**，ISO 日期部分 `YYYY-MM-DD`。代码 `(new Date).toISOString().split("T")[0] ?? ""`——`toISOString()` 恒为 UTC 零时区，无任何本地化/时区换算；异常分支理论上给 `""`（`??` 兜底）。

**代码证据**：§0 主链路 `r = (new Date).toISOString().split("T")[0] ?? ""`（偏移 699652 函数体内）。
**与抓包一致性**：`"date": "2026-08-30"`，与抓包 `captured_at`（2026-08-30T15:23 UTC）同日 ✓（本地时区亦同日，但代码语义明确是 UTC）。
**置信度**：高（代码直证）。

## Q6 `gitStatus`：命令、参数、截断

**结论**：命令就一条：`git status --porcelain`（无额外参数，porcelain v1 默认格式）。stdout `.trim()`（仅去首尾空白，行间格式原样保留）。**无截断、无行数/字节上限、无 `-uno` 之类的参数**。空输出（干净工作区）→ 字符串 `"Working tree clean"`；命令失败 → 同样 `""` → 也落 `"Working tree clean"`（歧义见 Q3）。

**代码证据**：§0 主链路 `l = await shellOutput({..., command: "git status --porcelain"})`，返回 `gitStatus: l || "Working tree clean"`。
**与抓包一致性**：样本 `"gitStatus": "M .env.example\n M .gitignore\n?? capture/"`——3 行 porcelain 风格（`??` 未跟踪、` M` 未暂存），无任何截断迹象 ✓。
**置信度**：高（代码直证 + 格式吻合）。

## Q7 `recentCommits`：条数与格式

**结论**：`git log --oneline -3`（**3 条**），stdout `.trim()` 后 `split("\n")` → 字符串数组，每条即 `--oneline` 原生格式 `<短哈希> <主题>`（7 位短哈希，无额外加工）。失败或空 → `[]`。

**代码证据**：§0 主链路 `c = await shellOutput({..., command: "git log --oneline -3"})`，返回 `recentCommits: c ? c.split("\n") : []`。
**与抓包一致性**：样本恰 3 条 `"10546e0 词汇表与文档更新：…"` 格式（短哈希 + 空格 + 主题）✓。
**置信度**：高（代码直证 + 条数/格式吻合）。

**⚠️ 易混淆旁支**：CLI 内部还有**另一条 git 采集路径** `readWorkspace`（偏移 **~737790**，经 `gitLine` 偏移 **737565**，空输出返回 `null` 而非 `""`），用于渲染 system prompt 的 `<workspace>` 块，用的是 `git rev-parse --abbrev-ref HEAD` / `git status --porcelain` / **`git log -5 --oneline`（5 条）**。它只影响 prompt 文案，**不影响**发给服务器的 config 块（config 固定 `-3`）。实现伪装规格时不要混用。

---

## 附：`x-command-code-version` 头来源（顺带确认）

`getCliVersion()`（偏移 **~49150**）：`getPackageJson(import.meta.url)` 读**自身 package.json 的 `version` 字段**，失败返回 `"unknown"`；`buildCommandAuthHeaders`（偏移 **583511**）把它填进 `CLI_VERSION: "x-command-code-version"`（头名常量表偏移 **1598284**）。即预期行为：**恒等于 CLI 自身包版本**，抓包 `"1.38.2"` ✓。

---

## 对 #19 的拍板影响速览

| 字段 | 官方行为（本调研结论） | #19 访谈临时拍板 | 是否纠偏 |
|---|---|---|---|
| `mainBranch` | symbolic-ref origin/HEAD → 去 `origin/`；fallback `branch -r` 找 main/master；兜底 `main` | 报当前分支 | ✅ 纠偏 |
| 非 git 形状 | 九字段齐全，空串/空数组/`false`，不省略 | 省略 | ✅ 纠偏 |
| 失败处理 | 逐字段 `""`/`[]` 降级；无 try/catch 传播、无超时、无并发；进程级缓存 | — | 新信息 |
| `structure` | cwd 单层；滤点开头 + 14 项黑名单；不读 .gitignore；无上限；默认 `sort()`；尾部 scope 标签 | — | 新信息 |
| `date` | UTC `YYYY-MM-DD`（`toISOString`） | — | 确认 |
| `gitStatus` | `git status --porcelain` trim；空/失败 → `"Working tree clean"`；无截断 | — | 确认 |
| `recentCommits` | `git log --oneline -3` split 行；`<短哈希> <主题>` | — | 确认（勿与 prompt 侧 `-5` 混淆） |

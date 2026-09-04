/**
 * generate 信封 `config` 块九字段采集（disguise.md §9，#19 定稿）：逐字段照抄官方
 * CLI 实现（`command-code` 1.38.2 `buildServerConfig`，调研 `docs/research/cli-config-collection.md`
 * 字节偏移级还原）。
 *
 * 官方语义照抄：structure 先于 git 判定（非 git 目录也有内容）；git 查询顺序 await、
 * 无并发；shell 输出 try/catch 全包，非零退出码 / 异常 → `""`，逐字段独立降级、
 * 绝不抛错；非 git 仓库九字段**齐全**显式空值、不省略字段；`date` 恒 UTC；
 * `mainBranch` 三级远程 HEAD 推断（从不直接取当前分支）；`gitStatus` 空 / 失败 →
 * `"Working tree clean"`（失败与干净工作区在 wire 上不可区分，照抄接受）。
 *
 * 两处防御偏离（§9.3，均不改请求线上形状）：每条 git 查询加 2s 超时（官方无超时，
 * 插件长驻进程）；进程级冻结 + 24h 过期重采归状态层（#33），本模块只提供单次采集。
 *
 * runtime 接缝对应官方 `createNodeRuntime()` 的形状（cwd / platform / workspaceRoots /
 * fs.readdir / shell.run），`homeDir()` 为本接口补充——官方 formatScopeDir 的 home 来源
 * 在其 runtime 内部，此处显式化以便 scope 标签可测；测试注入 fake（testing.md §3 允许
 * 的既有接缝注入）。
 */

import { exec } from "node:child_process"
import { readdir as fsReaddir } from "node:fs/promises"
import { homedir } from "node:os"
import { promisify } from "node:util"

const execAsync = promisify(exec)

/** 每条 git 查询的防御超时（§11 参数速查：2s/条，到点按失败处理） */
export const GIT_QUERY_TIMEOUT_MS = 2000

/** 信封 `date` 字段取值（§9.1）：恒 UTC 的 `YYYY-MM-DD`（官方 `toISOString()` 即 UTC，非本地时区） */
export function currentUtcDate(): string {
  return new Date().toISOString().split("T")[0] ?? ""
}

/** 信封顶层 `permissionMode`：恒 `"standard"`（#9 抓包 ground truth，与 OpenCode 自身权限模式无关） */
export const PERMISSION_MODE = "standard"

/** 官方 structure 黑名单（调研偏移 1629355）；点开头项与「滤点开头」规则重叠属官方冗余保险，照抄 */
export const STRUCTURE_BLACKLIST: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".svn",
  ".hg",
  "coverage",
  ".nyc_output",
  ".cache",
  "tmp",
  "temp",
  ".next",
  ".nuxt",
  "out",
])

/** 官方 runtime 抽象（buildServerConfig 的注入面）；生产实现见 createNodeConfigRuntime */
export interface ConfigRuntime {
  cwd(): string
  platform(): string
  /** scope 标签的 home 相对化需要；对应官方 formatScopeDir 的 homeDir 来源 */
  homeDir(): string
  workspaceRoots(): string[]
  readdir(path: string): Promise<string[]>
  shell: {
    /** 执行命令 resolve stdout；非零退出码 / 进程起不来 / signal abort 一律 reject */
    run(command: string, signal: AbortSignal): Promise<string>
  }
}

/** config 块九字段；键序即官方 buildServerConfig 的 return 序（wire 形状） */
export interface ConfigBlock {
  workingDir: string
  date: string
  environment: string
  structure: string[]
  isGitRepo: boolean
  currentBranch: string
  mainBranch: string
  gitStatus: string
  recentCommits: string[]
}

/** 官方 shellOutput 等价物：成功 → stdout.trim()；失败（reject）→ ""。超时经 signal 到点 reject，
 * 与其他失败同形落入 ""。 */
async function shellOutput(runtime: ConfigRuntime, command: string): Promise<string> {
  try {
    const stdout = await runtime.shell.run(command, AbortSignal.timeout(GIT_QUERY_TIMEOUT_MS))
    return stdout.trim()
  } catch {
    return ""
  }
}

/** mainBranch 三级推断（调研 resolveMainBranch 逐字）：symbolic-ref → branch -r → 兜底 main */
async function resolveMainBranch(runtime: ConfigRuntime): Promise<string> {
  const symbolicRef = await shellOutput(runtime, "git symbolic-ref --short refs/remotes/origin/HEAD")
  if (symbolicRef) return symbolicRef.replace(/^origin\//, "")
  const remoteBranches = await shellOutput(runtime, "git branch -r")
  return remoteBranches.includes("origin/main") ? "main" : remoteBranches.includes("origin/master") ? "master" : "main"
}

/**
 * scope 标签的目录格式化（官方 formatScopeDir 语义）：目录即 cwd → `"."`；在 cwd 下 →
 * `"./xxx"`；即 home → `"~"`；在 home 下 → `"~/xxx"`；否则原样绝对路径。
 */
export function formatScopeDir(dir: string, cwd: string, homeDir: string): string {
  const prefixOf = (base: string): string => (base.endsWith("/") ? base : `${base}/`)
  if (dir === cwd) return "."
  if (dir.startsWith(prefixOf(cwd))) return `./${dir.slice(prefixOf(cwd).length)}`
  if (dir === homeDir) return "~"
  if (dir.startsWith(prefixOf(homeDir))) return `~/${dir.slice(prefixOf(homeDir).length)}`
  return dir
}

/**
 * structure 采集（官方 readStructure 逐字）：cwd 单层 readdir、无递归，滤点开头条目 +
 * 黑名单，默认字典序（`.sort()`，大写在小写前），无数量上限；额外工作区目录（非 cwd）
 * 格式化为 `scope:<路径>` 追加在数组末尾、不参与排序；readdir 抛异常 → 仅含 scope 标签。
 */
export async function collectStructure(runtime: ConfigRuntime): Promise<string[]> {
  const cwd = runtime.cwd()
  const homeDir = runtime.homeDir()
  const scopeLabels = runtime
    .workspaceRoots()
    .filter((root) => root !== cwd)
    .map((root) => `scope:${formatScopeDir(root, cwd, homeDir)}`)
  try {
    const entries = await runtime.readdir(cwd)
    return [
      ...entries.filter((name) => !name.startsWith(".") && !STRUCTURE_BLACKLIST.has(name)).sort(),
      ...scopeLabels,
    ]
  } catch {
    return scopeLabels
  }
}

/** 单次采集 config 块九字段；任何子查询失败独立降级、整体绝不抛错（官方语义） */
export async function collectConfigBlock(runtime: ConfigRuntime): Promise<ConfigBlock> {
  // 官方顺序：structure 最先（先于 git 判定），date/environment/workingDir 同步取
  const structure = await collectStructure(runtime)
  const date = currentUtcDate()
  const environment = runtime.platform()
  const workingDir = runtime.cwd()

  const gitDir = await shellOutput(runtime, "git rev-parse --git-dir")
  if (!gitDir) {
    // 非 git 仓库 / git 未装同形：九字段齐全的显式空值，不省略字段（源码调研纠偏 #19）
    return {
      workingDir,
      date,
      environment,
      structure,
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    }
  }

  const currentBranch = await shellOutput(runtime, "git branch --show-current")
  const mainBranch = await resolveMainBranch(runtime)
  const gitStatus = (await shellOutput(runtime, "git status --porcelain")) || "Working tree clean"
  const logOutput = await shellOutput(runtime, "git log --oneline -3")

  return {
    workingDir,
    date,
    environment,
    structure,
    isGitRepo: true,
    currentBranch,
    mainBranch,
    gitStatus,
    recentCommits: logOutput ? logOutput.split("\n") : [],
  }
}

/** 生产 runtime：官方 createNodeRuntime 同源取值（cwd = process.cwd() 等）。
 * shell 用 exec 走 shell 解释（对齐官方 spawn {shell: true, windowsHide}；exec 无
 * detached 选项，该参数对一次性短命令无观察差异）；stdout 无上限收集（官方无截断）。
 * OpenCode 单工作区场景 workspaceRoots 仅 cwd（scope 标签自然为空）；宿主侧若暴露
 * 多根工作区由 glue 层追加。 */
export function createNodeConfigRuntime(): ConfigRuntime {
  return {
    cwd: () => process.cwd(),
    platform: () => process.platform,
    homeDir: () => homedir(),
    workspaceRoots: () => [process.cwd()],
    readdir: (path) => fsReaddir(path),
    shell: {
      run: (command, signal) =>
        execAsync(command, {
          signal,
          windowsHide: true,
          maxBuffer: Infinity,
        }).then(({ stdout }) => stdout),
    },
  }
}

import { afterEach, describe, expect, jest, test } from "bun:test"
import {
  collectConfigBlock,
  collectStructure,
  formatScopeDir,
  GIT_QUERY_TIMEOUT_MS,
  PERMISSION_MODE,
  STRUCTURE_BLACKLIST,
  type ConfigRuntime,
} from "../../src/disguise/config-block.ts"

// config 块九字段采集（disguise.md §9，官方 buildServerConfig 逐字段照抄）：
// git 仓库与非 git 仓库两组 fixture 全九字段断言、失败逐字段独立降级、
// git 查询 2s 超时按失败处理（fake timers）、structure 过滤排序与 scope 标签。

afterEach(() => {
  jest.useRealTimers()
})

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

interface FakeRuntimeOptions {
  cwd?: string
  platform?: string
  homeDir?: string
  workspaceRoots?: string[]
  entries?: string[]
  readdirThrows?: boolean
  /** command → stdout；未登记的命令按执行失败（reject）处理 */
  git?: Record<string, string>
  /** 挂起不返回的命令清单——模拟网关/磁盘级挂起，仅 abort（超时到点）能解除 */
  hanging?: string[]
}

function fakeRuntime(options: FakeRuntimeOptions = {}) {
  const commands: string[] = []
  const readPaths: string[] = []
  const cwd = options.cwd ?? "/repo"
  const runtime: ConfigRuntime & { commands: string[]; readPaths: string[] } = {
    commands,
    readPaths,
    cwd: () => cwd,
    platform: () => options.platform ?? "linux",
    homeDir: () => options.homeDir ?? "/home/tester",
    workspaceRoots: () => options.workspaceRoots ?? [cwd],
    readdir: (path) => {
      readPaths.push(path)
      if (options.readdirThrows) return Promise.reject(new Error("EACCES: permission denied"))
      return Promise.resolve(options.entries ?? [])
    },
    shell: {
      run: (command, signal) => {
        commands.push(command)
        if (options.hanging?.includes(command)) {
          return new Promise((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason)
              return
            }
            signal.addEventListener("abort", () => reject(signal.reason))
          })
        }
        const stdout = options.git?.[command]
        if (stdout === undefined) return Promise.reject(new Error(`unexpected command: ${command}`))
        return Promise.resolve(stdout)
      },
    },
  }
  return runtime
}

const GIT_SUCCESS: Record<string, string> = {
  "git rev-parse --git-dir": ".git",
  "git branch --show-current": "feature-branch",
  "git symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
  "git status --porcelain": "M .env.example\n M .gitignore\n?? capture/",
  "git log --oneline -3": "10546e0 词汇表与文档更新\n2f3c9a1 协议核心 I\n7ad589f 演练输入",
}

describe("git 仓库 fixture（§9.1 全九字段）", () => {
  test("全字段断言；mainBranch 为远程 HEAD 推断、从不直接取当前分支", async () => {
    const runtime = fakeRuntime({
      git: GIT_SUCCESS,
      entries: ["capture", "CONTEXT.md", "AGENTS.md", "docs", "node_modules", ".env", "dist", "tmp", "prototype", "skills-lock.json"],
    })
    const config = await collectConfigBlock(runtime)
    expect(config).toEqual({
      workingDir: "/repo",
      date: config.date,
      environment: "linux",
      structure: ["AGENTS.md", "CONTEXT.md", "capture", "docs", "prototype", "skills-lock.json"],
      isGitRepo: true,
      currentBranch: "feature-branch",
      mainBranch: "main",
      gitStatus: "M .env.example\n M .gitignore\n?? capture/",
      recentCommits: ["10546e0 词汇表与文档更新", "2f3c9a1 协议核心 I", "7ad589f 演练输入"],
    })
  })

  test("键序即官方 buildServerConfig 的 return 序（wire 形状）", async () => {
    const config = await collectConfigBlock(fakeRuntime({ git: GIT_SUCCESS }))
    expect(Object.keys(config)).toEqual([
      "workingDir",
      "date",
      "environment",
      "structure",
      "isGitRepo",
      "currentBranch",
      "mainBranch",
      "gitStatus",
      "recentCommits",
    ])
  })

  test("git 查询顺序 await、无并发；structure 只读 cwd 单层", async () => {
    const runtime = fakeRuntime({ git: GIT_SUCCESS })
    await collectConfigBlock(runtime)
    expect(runtime.commands).toEqual([
      "git rev-parse --git-dir",
      "git branch --show-current",
      "git symbolic-ref --short refs/remotes/origin/HEAD",
      "git status --porcelain",
      "git log --oneline -3",
    ])
    expect(runtime.readPaths).toEqual(["/repo"])
  })
})

describe("非 git 仓库 fixture（§9.1：九字段齐全显式空值，不省略）", () => {
  test("rev-parse 无输出 → 提前返回空值形状，structure/date 照常采集", async () => {
    const runtime = fakeRuntime({ git: {}, entries: ["docs", "README.md"] })
    const config = await collectConfigBlock(runtime)
    expect(config).toEqual({
      workingDir: "/repo",
      date: config.date,
      environment: "linux",
      structure: ["README.md", "docs"],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    })
    expect(Object.keys(config)).toHaveLength(9)
    // 非 git 分支只跑 rev-parse 一条 git 查询
    expect(runtime.commands).toEqual(["git rev-parse --git-dir"])
  })

  test("git 未装（命令执行失败）与非 git 目录同形", async () => {
    const config = await collectConfigBlock(fakeRuntime({}))
    expect(config.isGitRepo).toBe(false)
    expect(config.currentBranch).toBe("")
    expect(config.mainBranch).toBe("")
    expect(config.gitStatus).toBe("")
    expect(config.recentCommits).toEqual([])
  })
})

describe("mainBranch 三级推断（§9.1）", () => {
  test("symbolic-ref 成功 → 去 origin/ 前缀", async () => {
    const config = await collectConfigBlock(fakeRuntime({
      git: { ...GIT_SUCCESS, "git symbolic-ref --short refs/remotes/origin/HEAD": "origin/develop" },
    }))
    expect(config.mainBranch).toBe("develop")
  })

  test("symbolic-ref 失败 → branch -r 含 origin/master → master", async () => {
    const config = await collectConfigBlock(fakeRuntime({
      git: {
        "git rev-parse --git-dir": ".git",
        "git branch --show-current": "feature-branch",
        "git branch -r": "  origin/HEAD -> origin/master\n  origin/master\n  origin/develop",
      },
    }))
    expect(config.mainBranch).toBe("master")
  })

  test("symbolic-ref 与 branch -r 双失败 → 兜底 main", async () => {
    const config = await collectConfigBlock(fakeRuntime({
      git: { "git rev-parse --git-dir": ".git", "git branch --show-current": "feature-branch" },
    }))
    expect(config.mainBranch).toBe("main")
  })
})

describe("失败逐字段独立降级（官方 shellOutput 语义）", () => {
  test("gitStatus 空输出（干净工作区）→ Working tree clean", async () => {
    const config = await collectConfigBlock(fakeRuntime({ git: { ...GIT_SUCCESS, "git status --porcelain": "   " } }))
    expect(config.gitStatus).toBe("Working tree clean")
  })

  test("gitStatus 失败 → 同 Working tree clean（失败与干净工作区 wire 上不可区分，照抄接受）", async () => {
    const config = await collectConfigBlock(fakeRuntime({ git: { "git rev-parse --git-dir": ".git" } }))
    expect(config.isGitRepo).toBe(true)
    expect(config.gitStatus).toBe("Working tree clean")
  })

  test("show-current 失败 → 空串，isGitRepo 仍 true；log 失败 → []", async () => {
    const config = await collectConfigBlock(fakeRuntime({
      git: { "git rev-parse --git-dir": ".git", "git symbolic-ref --short refs/remotes/origin/HEAD": "origin/main" },
    }))
    expect(config.isGitRepo).toBe(true)
    expect(config.currentBranch).toBe("")
    expect(config.recentCommits).toEqual([])
  })

  test("recentCommits 按行 split、行间原样", async () => {
    const config = await collectConfigBlock(fakeRuntime({
      git: {
        ...GIT_SUCCESS,
        "git log --oneline -3": "10546e0 feat: 中文主题行\n2f3c9a1 fix: another\n7ad589f chore: tidy",
      },
    }))
    expect(config.recentCommits).toEqual(["10546e0 feat: 中文主题行", "2f3c9a1 fix: another", "7ad589f chore: tidy"])
  })
})

describe("git 查询 2s 超时按失败处理（偏离 a，fake timers）", () => {
  test("rev-parse 挂起 → 到点按失败落非 git 形状，整体不抛错", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-08-30T15:23:00.000Z"))
    const runtime = fakeRuntime({ hanging: ["git rev-parse --git-dir"], entries: ["AGENTS.md"] })
    const pending = collectConfigBlock(runtime)
    await flushMicrotasks()
    jest.advanceTimersByTime(GIT_QUERY_TIMEOUT_MS)
    const config = await pending
    expect(config.isGitRepo).toBe(false)
    expect(config.currentBranch).toBe("")
    expect(config.gitStatus).toBe("")
    expect(config.recentCommits).toEqual([])
    expect(config.date).toBe("2026-08-30")
    expect(config.structure).toEqual(["AGENTS.md"])
  })

  test("git 仓库内单条查询挂起：该字段按失败、后续查询照常执行", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-08-30T15:23:00.000Z"))
    const runtime = fakeRuntime({
      git: {
        "git rev-parse --git-dir": ".git",
        "git branch --show-current": "main",
        "git symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
        "git log --oneline -3": "abc123 fix",
      },
      hanging: ["git status --porcelain"],
    })
    const pending = collectConfigBlock(runtime)
    await flushMicrotasks()
    jest.advanceTimersByTime(GIT_QUERY_TIMEOUT_MS)
    const config = await pending
    expect(config.isGitRepo).toBe(true)
    expect(config.gitStatus).toBe("Working tree clean")
    expect(config.currentBranch).toBe("main")
    expect(config.recentCommits).toEqual(["abc123 fix"])
    expect(runtime.commands).toHaveLength(5)
  })
})

describe("date 恒 UTC（§9.1）", () => {
  test("toISOString 的日期部分；UTC 20:00 在东八区已是次日，报的仍是 UTC 当日", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-08-30T20:00:00.000Z"))
    const config = await collectConfigBlock(fakeRuntime({}))
    expect(config.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(config.date).toBe("2026-08-30")
  })
})

describe("structure 采集（§9.2）", () => {
  test("滤点开头 + 黑名单 + 默认字典序（大写在小写前）+ 无数量上限", async () => {
    const entries = [
      "capture", ".gitignore", ".env", "CONTEXT.md", "AGENTS.md", "node_modules", "dist",
      "build", ".git", ".svn", ".hg", "coverage", ".nyc_output", ".cache", "tmp", "temp",
      ".next", ".nuxt", "out", "docs", "z-final", "a-first",
      ...Array.from({ length: 500 }, (_, i) => `file-${String(i).padStart(4, "0")}`),
    ]
    const structure = await collectStructure(fakeRuntime({ entries }))
    expect(structure[0]).toBe("AGENTS.md")
    expect(structure[1]).toBe("CONTEXT.md")
    expect(structure.indexOf("a-first")).toBeLessThan(structure.indexOf("capture"))
    expect(structure.indexOf("capture")).toBeLessThan(structure.indexOf("docs"))
    expect(structure).not.toContain(".gitignore")
    expect(structure).not.toContain("node_modules")
    expect(structure).not.toContain(".git")
    expect(structure).not.toContain("out")
    expect(structure).toHaveLength(506)
  })

  test("额外工作区目录 → scope: 标签追加在末尾、不参与排序", async () => {
    const structure = await collectStructure(fakeRuntime({
      cwd: "/repo",
      homeDir: "/home/tester",
      workspaceRoots: ["/repo", "/repo/packages/app", "/home/tester", "/home/tester/docs", "/mnt/other"],
      entries: ["b", "a"],
    }))
    expect(structure).toEqual(["a", "b", "scope:./packages/app", "scope:~", "scope:~/docs", "scope:/mnt/other"])
  })

  test("readdir 抛异常 → 仅含 scope 标签", async () => {
    const structure = await collectStructure(fakeRuntime({
      readdirThrows: true,
      workspaceRoots: ["/repo", "/mnt/other"],
    }))
    expect(structure).toEqual(["scope:/mnt/other"])
  })

  test("黑名单 14 项与官方常量一致（偏移 1629355）", () => {
    expect([...STRUCTURE_BLACKLIST].sort()).toEqual(
      [
        "node_modules", "dist", "build", ".git", ".svn", ".hg", "coverage",
        ".nyc_output", ".cache", "tmp", "temp", ".next", ".nuxt", "out",
      ].sort(),
    )
  })
})

describe("formatScopeDir（官方 formatScopeDir 语义）", () => {
  test("五分支：即 cwd → .；cwd 下 → ./xxx；即 home → ~；home 下 → ~/xxx；否则原样", () => {
    expect(formatScopeDir("/repo", "/repo", "/home/tester")).toBe(".")
    expect(formatScopeDir("/repo/packages/app", "/repo", "/home/tester")).toBe("./packages/app")
    expect(formatScopeDir("/home/tester", "/repo", "/home/tester")).toBe("~")
    expect(formatScopeDir("/home/tester/docs", "/repo", "/home/tester")).toBe("~/docs")
    expect(formatScopeDir("/mnt/other", "/repo", "/home/tester")).toBe("/mnt/other")
  })
})

describe("常量（§9.1 / §11）", () => {
  test("顶层 permissionMode 恒 standard；git 查询防御超时 2s", () => {
    expect(PERMISSION_MODE).toBe("standard")
    expect(GIT_QUERY_TIMEOUT_MS).toBe(2000)
  })

  test("environment 为 platform 单词（无 arch、无 Node 版本）", async () => {
    const config = await collectConfigBlock(fakeRuntime({ platform: "darwin" }))
    expect(config.environment).toBe("darwin")
  })
})

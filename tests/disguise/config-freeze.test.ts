import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConfigRuntime } from "../../src/disguise/config-block.ts"
import { collectingLogger } from "./helpers.ts"
import { createFrozenConfigProvider, CONFIG_REBUILD_INTERVAL_MS } from "../../src/disguise/config-freeze.ts"

// config 块进程级冻结 + 24h 过期后台重采（disguise.md §9.3 偏离 b，#33 验收标准）：
// 同进程两次取值返回同一冻结值；24h 后返回旧值并后台重采（主请求零等待）；重采
// 失败沿用旧值；采集意外失败兜九字段齐全的空值形状。时间走 setSystemTime（见
// version-runtime.test.ts 头注的 fake timers 实测约束）；runtime 经既有接缝注 fake。

/** 最小 fake runtime：非 git 仓库形状（rev-parse 空 → 九字段显式空值，采集单条 shell 快速完成） */
function fakeRuntime(overrides: {
  shellRun?: (command: string) => Promise<string>
  cwd?: () => string
} = {}): ConfigRuntime & { shellCommands: string[] } {
  const shellCommands: string[] = []
  const runtime = {
    shellCommands,
    cwd: () => overrides.cwd?.() ?? "/work/project",
    platform: () => "linux",
    homeDir: () => "/home/user",
    workspaceRoots: () => ["/work/project"],
    readdir: async () => ["AGENTS.md", "src"],
    shell: {
      run: (command: string) => {
        shellCommands.push(command)
        return overrides.shellRun?.(command) ?? Promise.resolve("")
      },
    },
  }
  return runtime as ConfigRuntime & { shellCommands: string[] }
}

/** 真实 IO await 让出宏任务：给后台重采的 promise 链落定机会 */
async function settle(marker: string, rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await fs.readFile(marker)
}

let cacheRoot = ""
let marker = ""

beforeEach(async () => {
  cacheRoot = await fs.mkdtemp(join(tmpdir(), "cc-config-freeze-"))
  marker = join(cacheRoot, "marker.txt")
  await fs.writeFile(marker, "ok")
})

afterEach(async () => {
  jest.useRealTimers()
  await fs.rm(cacheRoot, { recursive: true, force: true })
})

describe("冻结语义（官方进程级只构建一次）", () => {
  test("首次构建：主请求等待，结果冻结（块与数组双层）", async () => {
    const runtime = fakeRuntime()
    const provider = createFrozenConfigProvider({ runtime, logger: collectingLogger() })
    const block = await provider.get()
    expect(Object.isFrozen(block)).toBe(true)
    expect(Object.isFrozen(block.structure)).toBe(true)
    expect(Object.isFrozen(block.recentCommits)).toBe(true)
    expect(block.workingDir).toBe("/work/project")
    expect(block.isGitRepo).toBe(false)
  })

  test("同进程两次取值返回同一冻结值，不重新采集", async () => {
    const runtime = fakeRuntime()
    const provider = createFrozenConfigProvider({ runtime, logger: collectingLogger() })
    const first = await provider.get()
    const second = await provider.get()
    expect(second).toBe(first)
    expect(runtime.shellCommands.length).toBe(1) // 仅 rev-parse 一条，无重采
  })
})

describe("24h 过期后台重采（偏离 b）", () => {
  test("过期后取值立即返回旧值（同一冻结引用），重采后台进行，完成后换新值", async () => {
    jest.useFakeTimers()
    let revParseResult = "/work/project/.git"
    let branch = "feature-a"
    const runtime = fakeRuntime({
      shellRun: (command) => {
        if (command.includes("rev-parse")) return Promise.resolve(revParseResult)
        if (command.includes("--show-current")) return Promise.resolve(branch)
        return Promise.resolve("")
      },
    })
    const logger = collectingLogger()
    const provider = createFrozenConfigProvider({ runtime, logger })

    const first = await provider.get()
    expect(first.currentBranch).toBe("feature-a")

    jest.setSystemTime(new Date(Date.now() + CONFIG_REBUILD_INTERVAL_MS + 1))

    // 重采期间取值：立即拿到旧值（同一冻结引用），重采已后台启动
    const during = await provider.get()
    expect(during).toBe(first)
    expect(runtime.shellCommands.length).toBeGreaterThan(1)

    // 重采落定后：新冻结值生效
    branch = "feature-b"
    revParseResult = "/work/project/.git"
    await settle(marker)
    const next = await provider.get()
    expect(next).not.toBe(first)
    expect(next.currentBranch).toBe("feature-b")
    expect(logger.messages.some((message) => message.startsWith("warn:"))).toBe(false)
  })

  test("重采永挂：主请求零等待，旧值照常返回（不阻塞时序断言）", async () => {
    jest.useFakeTimers()
    let hang = false
    const runtime = fakeRuntime({
      shellRun: (command) => (hang ? new Promise<string>(() => {}) : Promise.resolve(command.includes("rev-parse") ? "/work/project/.git" : "")),
    })
    const provider = createFrozenConfigProvider({ runtime, logger: collectingLogger() })
    const first = await provider.get()

    jest.setSystemTime(new Date(Date.now() + CONFIG_REBUILD_INTERVAL_MS + 1))
    hang = true
    // 重采挂死，get 仍立即返回旧值（若阻塞，此 await 挂死至测试超时）
    const during = await provider.get()
    expect(during).toBe(first)
    expect(runtime.shellCommands.length).toBeGreaterThan(1) // 重采已启动
  })

  test("重采失败：沿用旧值 + warn（collectConfigBlock 意外抛错视为本轮失败）", async () => {
    jest.useFakeTimers()
    let cwdExploded = false
    const runtime = fakeRuntime({
      cwd: () => {
        if (cwdExploded) throw new Error("ENOENT: working directory removed")
        return "/work/project"
      },
    })
    const logger = collectingLogger()
    const provider = createFrozenConfigProvider({ runtime, logger })
    const first = await provider.get()

    jest.setSystemTime(new Date(Date.now() + CONFIG_REBUILD_INTERVAL_MS + 1))
    cwdExploded = true
    expect(await provider.get()).toBe(first) // 旧值
    await settle(marker)
    expect(logger.messages.some((message) => message.startsWith("warn:") && message.includes("重采失败"))).toBe(true)
    expect(await provider.get()).toBe(first) // 仍沿用旧值
  })

  test("重采窗口内不重复触发（in-flight 去重）", async () => {
    jest.useFakeTimers()
    let hang = false
    const runtime = fakeRuntime({
      shellRun: (command) => (hang ? new Promise<string>(() => {}) : Promise.resolve(command.includes("rev-parse") ? "" : "")),
    })
    const provider = createFrozenConfigProvider({ runtime, logger: collectingLogger() })
    await provider.get()

    jest.setSystemTime(new Date(Date.now() + CONFIG_REBUILD_INTERVAL_MS + 1))
    hang = true
    await provider.get() // 触发后台重采
    await settle(marker) // 让重采链推进到挂起的 shell（确定性 in-flight 状态）
    const commandsDuring = runtime.shellCommands.length
    expect(commandsDuring).toBe(2) // 首次构建 1 条 + 重采挂起的 1 条
    await provider.get() // 重采进行中的再次取值：不重复触发
    expect(runtime.shellCommands.length).toBe(commandsDuring)
  })
})

describe("采集意外失败兜底", () => {
  test("runtime 全面异常：兜九字段齐全的空值形状 + warn，get 绝不抛", async () => {
    const runtime = fakeRuntime({
      cwd: () => {
        throw new Error("ENOENT: working directory removed")
      },
      shellRun: () => Promise.reject(new Error("shell dead")),
    })
    const logger = collectingLogger()
    const provider = createFrozenConfigProvider({ runtime, logger })
    const block = await provider.get()
    expect(Object.isFrozen(block)).toBe(true)
    expect(block.workingDir).toBe("")
    expect(block.isGitRepo).toBe(false)
    expect(block.currentBranch).toBe("")
    expect(block.mainBranch).toBe("")
    expect(block.gitStatus).toBe("")
    expect(block.recentCommits).toEqual([])
    expect(block.structure).toEqual([])
    expect(logger.messages.some((message) => message.startsWith("warn:"))).toBe(true)
  })
})

describe("常量对齐 §11 参数速查", () => {
  test("config 重采间隔 24h", () => {
    expect(CONFIG_REBUILD_INTERVAL_MS).toBe(24 * 3_600_000)
  })
})

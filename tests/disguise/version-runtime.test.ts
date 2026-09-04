import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FetchLike } from "../../src/protocol/json.ts"
import { collectingLogger, deferred, flush, hangingResponse } from "./helpers.ts"
import {
  createVersionResolver,
  VERSION_RACE_MS,
  VERSION_REFRESH_INTERVAL_MS,
  VERSION_SOURCE_TIMEOUT_MS,
} from "../../src/disguise/version-runtime.ts"
import { resolveVersionCachePath } from "../../src/disguise/version-cache.ts"

// 版本头状态机（disguise.md §6，#33 验收标准）：1.5s 竞速先到先用、双超时兜底值
// 放行 + 后台完成内存更新、24h 惰性刷新无 setInterval（纯时间推进零动作的行为
// 断言）、兜底链四层序、写失败降兜底 + warn。出网经 fetch 接缝注 mock；落盘经
// XDG 重定向；时间走 fake timers。
//
// bun fake timers 实测约束（testing.md §2 的运行注记）：微任务冲刷不等于宏任务
// 让出——fs promise 完成回调是宏任务，断言落盘前须以真实 IO await（settleIO）
// 让出事件循环；时间跳跃一律 setSystemTime（advance 大步长在本环境有副作用），
// advance 仅用于小步长触发 AbortSignal/delay 到点。

const HOUR = 3_600_000

let cacheRoot = ""
let marker = ""

beforeEach(async () => {
  cacheRoot = await fs.mkdtemp(join(tmpdir(), "cc-version-runtime-"))
  marker = join(cacheRoot, "marker.txt")
  await fs.writeFile(marker, "ok")
  process.env["XDG_CACHE_HOME"] = cacheRoot
})

afterEach(async () => {
  delete process.env["XDG_CACHE_HOME"]
  jest.useRealTimers()
  await fs.rm(cacheRoot, { recursive: true, force: true })
})

/** 真实 IO await 让出宏任务：给 pending 的 fs 链（缓存写等）落定的机会 */
async function settleIO(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await fs.readFile(marker)
}

function jsonResponse(version: string): Response {
  return Response.json({ name: "command-code", version })
}

describe("常量对齐 §11 参数速查", () => {
  test("竞速/单源超时 1.5s、惰性刷新 24h", () => {
    expect(VERSION_RACE_MS).toBe(1500)
    expect(VERSION_SOURCE_TIMEOUT_MS).toBe(1500)
    expect(VERSION_REFRESH_INTERVAL_MS).toBe(24 * HOUR)
  })
})

describe("初解析竞速（D6b）", () => {
  test("npm 直连成功即用，无需等满 1.5s", async () => {
    const fetchImpl: FetchLike = (url) => {
      expect(String(url)).toBe("https://registry.npmjs.org/command-code/latest")
      return Promise.resolve(jsonResponse("1.38.2"))
    }
    const resolver = createVersionResolver({ fetch: fetchImpl, logger: collectingLogger() })
    expect(await resolver.getVersion()).toBe("1.38.2")
  })

  test("npm 失败 → jsDelivr 镜像顶上", async () => {
    const fetchImpl: FetchLike = (url) => {
      if (String(url).includes("registry.npmjs.org")) return Promise.reject(new Error("blocked"))
      expect(String(url)).toBe("https://cdn.jsdelivr.net/npm/command-code/package.json")
      return Promise.resolve(jsonResponse("1.38.2"))
    }
    const resolver = createVersionResolver({ fetch: fetchImpl, logger: collectingLogger() })
    expect(await resolver.getVersion()).toBe("1.38.2")
  })

  test("npm 非 2xx / 响应缺 version 字段都算该源失败", async () => {
    let call = 0
    const fetchImpl: FetchLike = (url) => {
      call += 1
      if (String(url).includes("registry.npmjs.org")) {
        return call === 1 ? Promise.resolve(new Response("nope", { status: 502 })) : Promise.resolve(Response.json({}))
      }
      return Promise.resolve(jsonResponse("1.38.2"))
    }
    const resolver = createVersionResolver({ fetch: fetchImpl, logger: collectingLogger() })
    expect(await resolver.getVersion()).toBe("1.38.2")
  })

  test("单源超时 = AbortSignal.timeout(1.5s)，jsDelivr 限时内补上", async () => {
    jest.useFakeTimers()
    const seenSignals: Array<AbortSignal | undefined> = []
    const fetchImpl: FetchLike = (url, init) => {
      seenSignals.push(init?.signal ?? undefined)
      if (String(url).includes("registry.npmjs.org")) return hangingResponse(init)
      return Promise.resolve(jsonResponse("1.38.2"))
    }
    const resolver = createVersionResolver({ fetch: fetchImpl, logger: collectingLogger() })
    const pending = resolver.getVersion()
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal)
    jest.advanceTimersByTime(VERSION_SOURCE_TIMEOUT_MS)
    expect(await pending).toBe("1.38.2")
  })
})

describe("双超时：兜底值放行、后台完成内存更新", () => {
  test("npm 挂起 1.5s → 兜底 snapshot 放行；jsDelivr 后台成功 → 内存更新并落盘", async () => {
    jest.useFakeTimers()
    const logger = collectingLogger()
    let jsDelivr = deferred()
    const fetchImpl: FetchLike = (url, init) => {
      if (String(url).includes("registry.npmjs.org")) return hangingResponse(init)
      const source = deferred()
      jsDelivr = source
      return source.promise
    }
    const resolver = createVersionResolver({
      fetch: fetchImpl,
      logger,
      snapshotSourceCliVersion: () => "1.35.0",
    })

    const first = resolver.getVersion()
    jest.advanceTimersByTime(VERSION_RACE_MS)
    await flush()
    // 竞速到点：兜底链放行（双源都还没回来）
    expect(await first).toBe("1.35.0")

    // jsDelivr 后台成功 → 内存与落盘更新（写盘经 settleIO 落定）
    jsDelivr.resolve(jsonResponse("1.38.2"))
    await flush()
    await settleIO()
    expect(await resolver.getVersion()).toBe("1.38.2")
    const entry = JSON.parse(await fs.readFile(resolveVersionCachePath(), "utf8")) as {
      version: string
      fetchedAt: string
    }
    expect(entry.version).toBe("1.38.2")
    expect(Number.isNaN(Date.parse(entry.fetchedAt))).toBe(false)
  })

  test("双源都超时：兜底链放行，链后台落定后仍无值则维持兜底", async () => {
    jest.useFakeTimers()
    const logger = collectingLogger()
    const fetchImpl: FetchLike = (_url, init) => hangingResponse(init)
    const resolver = createVersionResolver({ fetch: fetchImpl, logger, snapshotSourceCliVersion: () => "1.35.0" })

    const first = resolver.getVersion()
    jest.advanceTimersByTime(VERSION_RACE_MS)
    await flush()
    expect(await first).toBe("1.35.0")
    // jsDelivr 的 1.5s 也到点（链总长 3s），依旧无值
    jest.advanceTimersByTime(VERSION_SOURCE_TIMEOUT_MS)
    await flush()
    await settleIO()
    expect(await resolver.getVersion()).toBe("1.35.0")
    expect(logger.messages.some((message) => message.startsWith("warn:"))).toBe(false)
  })
})

describe("兜底链四层序（§6）", () => {
  test("cached 优先于 artifact 与 snapshot", async () => {
    const dir = join(cacheRoot, "opencode-commandcode")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(resolveVersionCachePath(), JSON.stringify({ version: "1.37.0", fetchedAt: "2026-09-01T00:00:00.000Z" }))
    const resolver = createVersionResolver({
      fetch: () => Promise.reject(new Error("offline")),
      logger: collectingLogger(),
      artifactSourceCliVersion: () => "1.36.0",
      snapshotSourceCliVersion: () => "1.35.0",
    })
    expect(await resolver.getVersion()).toBe("1.37.0")
  })

  test("无缓存时 artifact 优先于 snapshot；③ 不回写落盘缓存", async () => {
    const resolver = createVersionResolver({
      fetch: () => Promise.reject(new Error("offline")),
      logger: collectingLogger(),
      artifactSourceCliVersion: () => "1.36.0",
      snapshotSourceCliVersion: () => "1.35.0",
    })
    expect(await resolver.getVersion()).toBe("1.36.0")
    await expect(fs.readFile(resolveVersionCachePath(), "utf8")).rejects.toThrow()
  })

  test("四层皆空 → undefined（调用方决定放行形态）", async () => {
    const resolver = createVersionResolver({ fetch: () => Promise.reject(new Error("offline")), logger: collectingLogger() })
    expect(await resolver.getVersion()).toBeUndefined()
  })

  test("竞速值优先于落盘缓存", async () => {
    const dir = join(cacheRoot, "opencode-commandcode")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(resolveVersionCachePath(), JSON.stringify({ version: "1.37.0", fetchedAt: "2026-09-01T00:00:00.000Z" }))
    const resolver = createVersionResolver({
      fetch: () => Promise.resolve(jsonResponse("1.38.2")),
      logger: collectingLogger(),
    })
    expect(await resolver.getVersion()).toBe("1.38.2")
  })
})

describe("24h 惰性刷新（D6c）", () => {
  test("纯时间推进零动作（无 setInterval 的行为断言），取值时刻才触发", async () => {
    jest.useFakeTimers()
    let npmCalls = 0
    const logger = collectingLogger()
    const resolver = createVersionResolver({
      fetch: (url) => {
        if (String(url).includes("registry.npmjs.org")) {
          npmCalls += 1
          return Promise.resolve(jsonResponse("1.0.0"))
        }
        return Promise.resolve(jsonResponse("1.0.0"))
      },
      logger,
    })

    expect(await resolver.getVersion()).toBe("1.0.0")
    expect(npmCalls).toBe(1)

    // 24h 内推进：零 fetch、值不变
    jest.setSystemTime(new Date(Date.now() + VERSION_REFRESH_INTERVAL_MS - 1000))
    expect(await resolver.getVersion()).toBe("1.0.0")
    expect(npmCalls).toBe(1)

    // 满 24h：取值触发后台刷新（本次仍带旧值——主请求不等待），完成后仍取同值
    jest.setSystemTime(new Date(Date.now() + 1000))
    expect(await resolver.getVersion()).toBe("1.0.0")
    expect(npmCalls).toBe(2)
    await flush()
    await settleIO()
    expect(await resolver.getVersion()).toBe("1.0.0")
    expect(npmCalls).toBe(2)
  })

  test("刷新成功 → 版本头翻转 + 落盘缓存更新", async () => {
    jest.useFakeTimers()
    let calls = 0
    const logger = collectingLogger()
    const resolver = createVersionResolver({
      fetch: () => {
        calls += 1
        return Promise.resolve(jsonResponse(calls === 1 ? "1.0.0" : "2.0.0"))
      },
      logger,
    })
    expect(await resolver.getVersion()).toBe("1.0.0")

    jest.setSystemTime(new Date(Date.now() + VERSION_REFRESH_INTERVAL_MS + 1))
    // 刷新后台触发：本次请求不等待，仍带旧值
    expect(await resolver.getVersion()).toBe("1.0.0")
    expect(calls).toBe(2)
    await flush()
    await settleIO()
    expect(await resolver.getVersion()).toBe("2.0.0")
    const entry = JSON.parse(await fs.readFile(resolveVersionCachePath(), "utf8")) as { version: string }
    expect(entry.version).toBe("2.0.0")
  })

  test("刷新时刻才重估：产物刷新不引起版本头翻转", async () => {
    jest.useFakeTimers()
    let artifactVersion: string | undefined = "1.36.0"
    const logger = collectingLogger()
    const resolver = createVersionResolver({
      fetch: () => Promise.resolve(jsonResponse("1.0.0")),
      logger,
      artifactSourceCliVersion: () => artifactVersion,
      snapshotSourceCliVersion: () => "1.35.0",
    })
    expect(await resolver.getVersion()).toBe("1.0.0")

    // 期间模型管线产物刷新（③ 层值变化）不重估——版本头不翻转
    artifactVersion = "9.9.9"
    expect(await resolver.getVersion()).toBe("1.0.0")
  })

  test("刷新失败：值保持旧竞速值；按 D6c 字面语义，失败后每次取值照常重试", async () => {
    jest.useFakeTimers()
    let fail = false
    let calls = 0
    const logger = collectingLogger()
    const resolver = createVersionResolver({
      fetch: () => {
        calls += 1
        return fail ? Promise.reject(new Error("down")) : Promise.resolve(jsonResponse("1.0.0"))
      },
      logger,
    })
    expect(await resolver.getVersion()).toBe("1.0.0")

    fail = true
    jest.setSystemTime(new Date(Date.now() + VERSION_REFRESH_INTERVAL_MS + 1))
    expect(await resolver.getVersion()).toBe("1.0.0")
    await flush()
    await settleIO()
    // npm + jsDelivr 双失败，旧竞速值保持
    const attemptsAfterFailure = calls
    expect(attemptsAfterFailure).toBe(3)

    // 距上次「成功」拉取已超 24h（成功记账未发生）：下次取值照常后台重试
    jest.setSystemTime(new Date(Date.now() + HOUR))
    expect(await resolver.getVersion()).toBe("1.0.0")
    await flush()
    await settleIO()
    expect(calls).toBeGreaterThan(attemptsAfterFailure)
  })
})

describe("缓存写失败降兜底 + warn", () => {
  test("XDG 指向普通文件：内存值照常更新，仅 warn", async () => {
    const notADir = join(cacheRoot, "occupied")
    await fs.writeFile(notADir, "not a directory")
    process.env["XDG_CACHE_HOME"] = notADir
    const logger = collectingLogger()
    const resolver = createVersionResolver({ fetch: () => Promise.resolve(jsonResponse("1.38.2")), logger })
    expect(await resolver.getVersion()).toBe("1.38.2")
    // 读缓存的 ENOTDIR 与写缓存的失败各 warn 一条；「降兜底」由内存值照常可得体现
    expect(logger.messages.some((message) => message.startsWith("warn:") && message.includes("写入失败"))).toBe(true)
  })
})

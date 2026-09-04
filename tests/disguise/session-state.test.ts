import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FetchLike } from "../../src/protocol/json.ts"
import type { ConfigRuntime } from "../../src/disguise/config-block.ts"
import { collectingLogger, flush } from "./helpers.ts"
import { FINGERPRINT_ENDPOINT, LIFECYCLE_ENDPOINT } from "../../src/disguise/preflight.ts"
import { createDisguiseState, SESSION_TTL_BASE_MS, SESSION_TTL_JITTER_MS } from "../../src/disguise/state.ts"

// 会话身份主路径与回退轮换（disguise.md §3/§1 + #33 验收标准）：
// 主路径从 doStream headers 确定性派生（同 headers 恒同 id、跨 state 实例=跨重启
// 仍同 id、无存储）；全部缺失才落 per-key 随机 uuid 12h + 0~1h 抖动惰性轮换；
// 多头值不一致 warn（脱敏）。另覆盖门面的预请求调度幂等与「预请求不影响主请求时序」。

const KEY_A = "user_key_a_not_real"
const KEY_B = "user_key_b_not_real"
const SESSION_SEED = "ses_2f8a9c1e77b4d305"
const HOUR = 3_600_000

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** 最简非 git config runtime（冻结语义归 config-freeze.test.ts，这里只求可用） */
function minimalRuntime(): ConfigRuntime {
  return {
    cwd: () => "/work",
    platform: () => "linux",
    homeDir: () => "/home/u",
    workspaceRoots: () => ["/work"],
    readdir: async () => [],
    shell: {
      run: () => Promise.resolve(""),
    },
  }
}

/** 永挂 fetch（abort 到点 reject）：预请求挂起场景 */
function hangingFetch(): FetchLike & { calls: string[] } {
  const calls: string[] = []
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url))
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal ?? undefined
      if (signal === undefined) return
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  }) as FetchLike & { calls: string[] }
  impl.calls = calls
  return impl
}

/** 全请求即时成功的 fetch（预请求成功路径） */
function okFetch(): FetchLike & { calls: string[] } {
  const calls: string[] = []
  const impl = ((url: string | URL | Request) => {
    calls.push(String(url))
    return Promise.resolve(new Response("{}", { status: 200 }))
  }) as FetchLike & { calls: string[] }
  impl.calls = calls
  return impl
}

let cacheRoot = ""

/** 真实 IO await 让出宏任务：给版本链（缓存读）与预请求发射的 promise 落定机会 */
async function settle(rounds = 8): Promise<void> {
  const marker = join(cacheRoot, "marker.txt")
  await fs.writeFile(marker, "ok")
  for (let i = 0; i < rounds; i++) await fs.readFile(marker)
}

/** 轮询等待条件成立：门面链路含真实指纹采集（git 子进程，毫秒级不保证完成），
 * 固定轮数的 settle 不可靠；轮询以真实时间上限兜底。 */
async function waitFor(condition: () => boolean, rounds = 2000): Promise<void> {
  for (let i = 0; i < rounds && !condition(); i++) await settle(1)
  expect(condition()).toBe(true)
}

beforeEach(async () => {
  cacheRoot = await fs.mkdtemp(join(tmpdir(), "cc-session-state-"))
  await fs.writeFile(join(cacheRoot, "marker.txt"), "ok")
  process.env["XDG_CACHE_HOME"] = cacheRoot
})

afterEach(() => {
  delete process.env["XDG_CACHE_HOME"]
  jest.useRealTimers()
})

describe("会话身份主路径（D3 确定性派生）", () => {
  test("同 headers 恒同 id：同一实例多次调用", () => {
    const state = createDisguiseState({ logger: collectingLogger() })
    const headers = { "X-Session-Id": SESSION_SEED }
    const first = state.resolveSessionId(KEY_A, headers)
    expect(first).toMatch(UUID_V4)
    for (let i = 0; i < 5; i++) expect(state.resolveSessionId(KEY_A, headers)).toBe(first)
  })

  test("跨 state 实例（=跨重启）同 headers 仍同 id：无需任何存储", () => {
    const headers = { "X-Session-Id": SESSION_SEED }
    const first = createDisguiseState({ logger: collectingLogger() }).resolveSessionId(KEY_A, headers)
    const second = createDisguiseState({ logger: collectingLogger() }).resolveSessionId(KEY_A, headers)
    expect(second).toBe(first)
  })

  test("v1 两键与 v2 同值第三键派生同一 id；头名大小写变体命中", () => {
    const state = createDisguiseState({ logger: collectingLogger() })
    const viaXSessionId = state.resolveSessionId(KEY_A, { "X-Session-Id": SESSION_SEED })
    const viaAffinity = state.resolveSessionId(KEY_A, { "x-session-affinity": SESSION_SEED })
    const viaOpencodeSession = state.resolveSessionId(KEY_A, { "x-opencode-session": SESSION_SEED })
    const viaLowercase = state.resolveSessionId(KEY_A, { "x-session-id": SESSION_SEED })
    expect(viaAffinity).toBe(viaXSessionId)
    expect(viaOpencodeSession).toBe(viaXSessionId)
    expect(viaLowercase).toBe(viaXSessionId)
  })

  test("不同会话种子派生不同 id", () => {
    const state = createDisguiseState({ logger: collectingLogger() })
    const a = state.resolveSessionId(KEY_A, { "X-Session-Id": "ses_aaaa" })
    const b = state.resolveSessionId(KEY_A, { "X-Session-Id": "ses_bbbb" })
    expect(a).not.toBe(b)
  })

  test("多头同场值不一致：warn（脱敏）并按优先头取值", () => {
    const logger = collectingLogger()
    const state = createDisguiseState({ logger })
    const primary = state.resolveSessionId(KEY_A, {
      "X-Session-Id": SESSION_SEED,
      "x-opencode-session": "ses_totally_different_value",
    })
    expect(primary).toBe(createDisguiseState({ logger: collectingLogger() }).resolveSessionId(KEY_A, { "X-Session-Id": SESSION_SEED }))
    expect(logger.messages.length).toBe(1)
    expect(logger.messages[0]!.startsWith("warn:")).toBe(true)
    // 脱敏：完整种子不出现在日志
    expect(logger.messages[0]).not.toContain(SESSION_SEED)
    expect(logger.messages[0]).not.toContain("ses_totally_different_value")
  })

  test("多头同场同值：无告警", () => {
    const logger = collectingLogger()
    const state = createDisguiseState({ logger })
    state.resolveSessionId(KEY_A, { "X-Session-Id": SESSION_SEED, "x-opencode-session": SESSION_SEED })
    expect(logger.messages).toEqual([])
  })

  test("headers 值为 undefined/空串的键不算命中", () => {
    const state = createDisguiseState({ logger: collectingLogger() })
    const id = state.resolveSessionId(KEY_A, { "X-Session-Id": undefined, "x-session-affinity": "" })
    expect(id).toMatch(UUID_V4)
  })
})

describe("回退路径（per-key 随机 uuid 12h + 0~1h 惰性轮换）", () => {
  test("头缺失（undefined/空对象）落回退路径：uuid v4 形状", () => {
    const state = createDisguiseState({ logger: collectingLogger() })
    expect(state.resolveSessionId(KEY_A, undefined)).toMatch(UUID_V4)
    expect(state.resolveSessionId(KEY_B, {})).toMatch(UUID_V4)
  })

  test("同 key 未过期复用同 id；per-key 相互独立", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const state = createDisguiseState({ logger: collectingLogger() })
    const a1 = state.resolveSessionId(KEY_A, undefined)
    const a2 = state.resolveSessionId(KEY_A, undefined)
    const b1 = state.resolveSessionId(KEY_B, undefined)
    expect(a2).toBe(a1)
    expect(b1).not.toBe(a1)
    // 回退轮换窗口内推进仍复用
    jest.setSystemTime(new Date(Date.now() + 11 * HOUR))
    expect(state.resolveSessionId(KEY_A, undefined)).toBe(a1)
  })

  test("过 12h+1h 抖动上限必换新 id（轮换窗口上界确定性）", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const state = createDisguiseState({ logger: collectingLogger() })
    const first = state.resolveSessionId(KEY_A, undefined)
    // 抖动 ∈ [0, 1h)：寿命 < 13h；推 13h 必过期
    jest.setSystemTime(new Date(Date.now() + SESSION_TTL_BASE_MS + SESSION_TTL_JITTER_MS))
    const second = state.resolveSessionId(KEY_A, undefined)
    expect(second).not.toBe(first)
    // 新会话再次进入 12h 复用窗口
    jest.setSystemTime(new Date(Date.now() + 11 * HOUR))
    expect(state.resolveSessionId(KEY_A, undefined)).toBe(second)
  })

  test("主路径命中时不读写回退会话（回退值已过期也照常派生）", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const state = createDisguiseState({ logger: collectingLogger() })
    const fallback = state.resolveSessionId(KEY_A, undefined)
    jest.setSystemTime(new Date(Date.now() + 20 * HOUR)) // 回退早已过期
    const derived = state.resolveSessionId(KEY_A, { "X-Session-Id": SESSION_SEED })
    expect(derived).toMatch(UUID_V4)
    expect(derived).not.toBe(fallback)
  })
})

describe("门面调度：预请求幂等与主请求时序（D2/D5）", () => {
  test("startPreflight 幂等：每进程每 key 至多一轮（指纹+lifecycle 各一）", async () => {
    const fetchImpl = okFetch()
    const state = createDisguiseState({ fetch: fetchImpl, logger: collectingLogger(), configRuntime: minimalRuntime() })
    state.startPreflight(KEY_A)
    state.startPreflight(KEY_A)
    await waitFor(() => fetchImpl.calls.length >= 4)
    // 版本链的 npm/jsDelivr 查询也走同一 fetch 接缝，预请求按端点 URL 单独计数
    const preflightCalls = fetchImpl.calls.filter((url) => url === FINGERPRINT_ENDPOINT || url === LIFECYCLE_ENDPOINT)
    expect(preflightCalls.length).toBe(2)
    expect(preflightCalls.filter((url) => url === FINGERPRINT_ENDPOINT).length).toBe(1)
    expect(preflightCalls.filter((url) => url === LIFECYCLE_ENDPOINT).length).toBe(1)
  })

  test("maybeRunPreflight 未到点零发射；成功补发窗口（8–10h）过后到点即发", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const fetchImpl = okFetch()
    const state = createDisguiseState({ fetch: fetchImpl, logger: collectingLogger(), configRuntime: minimalRuntime() })
    const preflightCalls = () => fetchImpl.calls.filter((url) => url === FINGERPRINT_ENDPOINT || url === LIFECYCLE_ENDPOINT).length

    state.startPreflight(KEY_A)
    await waitFor(() => preflightCalls() >= 2)

    state.maybeRunPreflight(KEY_A) // 8–10h 冷却内：零发射
    await settle()
    expect(preflightCalls()).toBe(2)

    jest.setSystemTime(new Date(Date.now() + 10 * HOUR))
    state.maybeRunPreflight(KEY_A) // 到点：后台补发
    await waitFor(() => preflightCalls() >= 4)
  })

  test("预请求挂起（网关失联）：主请求方法零阻塞完成，时序不受影响", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const fetchImpl = hangingFetch()
    const state = createDisguiseState({
      fetch: fetchImpl,
      logger: collectingLogger(),
      configRuntime: minimalRuntime(),
      snapshotSourceCliVersion: () => "1.35.0",
    })
    state.startPreflight(KEY_A)
    await waitFor(() => fetchImpl.calls.length >= 1) // npm 版本查询上线（挂起）
    // 版本竞速 1.5s 到点（兜底放行）后预请求才上线并挂起
    jest.advanceTimersByTime(1500)
    await flush()
    await waitFor(() => fetchImpl.calls.length >= 3) // 指纹+lifecycle 上线（均挂起）
    const preflightCalls = fetchImpl.calls.filter((url) => url === FINGERPRINT_ENDPOINT || url === LIFECYCLE_ENDPOINT)
    expect(preflightCalls.length).toBe(2) // 预请求在途（永挂）

    // 主请求路径与预请求零共享等待：会话身份同步可得、config 立即可取
    const sessionId = state.resolveSessionId(KEY_A, { "X-Session-Id": SESSION_SEED })
    expect(sessionId).toMatch(UUID_V4)
    const configBlock = await state.getConfigBlock()
    expect(configBlock.workingDir).toBe("/work")

    // 版本头走自身的 1.5s 竞速兜底（预请求挂起不延长它）
    const versionPromise = state.getCommandCodeVersion()
    await flush()
    expect(await versionPromise).toBe("1.35.0")
  })
})

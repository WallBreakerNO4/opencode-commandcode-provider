import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FetchLike } from "../../src/protocol/json.ts"
import { initialPreflightState, TRANSIENT_BASE_MS, type PreflightState } from "../../src/disguise/backoff.ts"
import type { FingerprintBody } from "../../src/disguise/fingerprint.ts"
import { collectingLogger, deferred, flush, hangingResponse } from "./helpers.ts"
import {
  buildLifecycleEvent,
  buildPreflightHeaders,
  FINGERPRINT_ENDPOINT,
  LIFECYCLE_ENDPOINT,
  PREFLIGHT_TIMEOUT_MS,
  runPreflight,
  summarizePreflightResults,
  type PreflightDeps,
} from "../../src/disguise/preflight.ts"

// 预请求（disguise.md §2/§4/§5 + testing.md §1.2 预请求清单，#33 验收标准）：
// 指纹 + lifecycle 并行（同一 Promise.allSettled）、各自独立 3s 超时、超时/失败
// 照常放行主请求、头集合（#9 校准全集）、lifecycle 事件形状、退避状态机推进、
// 日志脱敏。fetch 与指纹 body 经依赖注入；时间走 fake timers。

const API_KEY = "user_test_key_not_a_real_one"
const CC_VERSION = "1.38.2"
const HOUR = 3_600_000

const FAKE_FINGERPRINT: FingerprintBody = {
  thumbmark: "a".repeat(64),
  components: {
    machineIdHash: "b".repeat(64),
    macHashes: ["c".repeat(64)],
    osUserHash: "d".repeat(64),
    hostnameHash: "e".repeat(64),
    gitEmailHash: "f".repeat(64),
    platform: "linux",
    arch: "x64",
    osRelease: "6.8.0-138-generic",
    cpuModel: "test cpu",
    cpuCount: 8,
    memGiB: 32,
    isContainer: false,
    timezone: "Asia/Shanghai",
    runtime: "cli",
    collectorVersion: 1,
  },
}

interface RecordedCall {
  url: string
  init: RequestInit
}

function recordingFetch(
  handler: (call: RecordedCall, index: number) => Promise<Response>,
): FetchLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = { url: String(url), init: init ?? {} }
    calls.push(call)
    return handler(call, calls.length - 1)
  }) as FetchLike & { calls: RecordedCall[] }
  impl.calls = calls
  return impl
}

function okResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function statusResponse(status: number): Response {
  return new Response("{}", { status })
}

function makeDeps(overrides: Partial<PreflightDeps> = {}): { deps: PreflightDeps; state: PreflightState } {
  const preflight = initialPreflightState()
  const deps: PreflightDeps = {
    apiKey: API_KEY,
    preflight,
    fetchImpl: recordingFetch(() => Promise.resolve(okResponse({ success: true }))),
    logger: collectingLogger(),
    getVersion: () => Promise.resolve(CC_VERSION),
    ensureFingerprintBody: () => Promise.resolve(FAKE_FINGERPRINT),
    ...overrides,
  }
  return { deps, state: deps.preflight }
}

let cacheRoot = ""

beforeEach(async () => {
  // 预请求路径自身不落盘（唯一落盘物是版本缓存，归版本层）；XDG 重定向后断言
  // 预请求失败不产生任何文件（testing.md §2）
  cacheRoot = await fs.mkdtemp(join(tmpdir(), "cc-preflight-"))
  process.env["XDG_CACHE_HOME"] = cacheRoot
})

afterEach(() => {
  delete process.env["XDG_CACHE_HOME"]
  jest.useRealTimers()
})

describe("请求形状（#9 校准全集）", () => {
  test("头集合：content-type/UA/x-cli-environment/Authorization/版本头/accept 家族", async () => {
    const { deps } = makeDeps()
    await runPreflight(deps)
    const fetchImpl = deps.fetchImpl as FetchLike & { calls: RecordedCall[] }
    expect(fetchImpl.calls.length).toBe(2)
    for (const call of fetchImpl.calls) {
      const headers = call.init.headers as Record<string, string>
      expect(headers["content-type"]).toBe("application/json")
      expect(headers["User-Agent"]).toBe("cli")
      expect(headers["x-cli-environment"]).toBe("production")
      expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`)
      expect(headers["x-command-code-version"]).toBe(CC_VERSION)
      expect(headers["accept"]).toBe("*/*")
      expect(headers["accept-language"]).toBe("*")
      expect(headers["sec-fetch-mode"]).toBe("cors")
      expect(headers["accept-encoding"]).toBe("br, gzip, deflate")
    }
  })

  test("预请求不带 x-session-id / x-project-slug / traceparent / x-taste-learning（#9 校准）", async () => {
    const { deps } = makeDeps()
    await runPreflight(deps)
    const fetchImpl = deps.fetchImpl as FetchLike & { calls: RecordedCall[] }
    for (const call of fetchImpl.calls) {
      const headerNames = Object.keys(call.init.headers as Record<string, string>).map((name) => name.toLowerCase())
      expect(headerNames).not.toContain("x-session-id")
      expect(headerNames).not.toContain("x-project-slug")
      expect(headerNames).not.toContain("traceparent")
      expect(headerNames).not.toContain("x-taste-learning")
      expect(headerNames).not.toContain("x-co-flag")
    }
  })

  test("版本值缺失时省略 x-command-code-version 键（四层兜底皆空的极端场景）", async () => {
    const { deps } = makeDeps({ getVersion: () => Promise.resolve(undefined) })
    await runPreflight(deps)
    const fetchImpl = deps.fetchImpl as FetchLike & { calls: RecordedCall[] }
    for (const call of fetchImpl.calls) {
      expect((call.init.headers as Record<string, string>)["x-command-code-version"]).toBeUndefined()
    }
  })

  test("指纹 body 原样上送；lifecycle body 形状（sess_<16hex> 无关随机 / mode / os / cliVersion）", async () => {
    const { deps } = makeDeps()
    await runPreflight(deps)
    const fetchImpl = deps.fetchImpl as FetchLike & { calls: RecordedCall[] }

    const fingerprintCall = fetchImpl.calls.find((call) => call.url === FINGERPRINT_ENDPOINT)!
    expect(fingerprintCall.init.method).toBe("POST")
    expect(JSON.parse(String(fingerprintCall.init.body))).toEqual(FAKE_FINGERPRINT)

    const lifecycleCall = fetchImpl.calls.find((call) => call.url === LIFECYCLE_ENDPOINT)!
    const event = JSON.parse(String(lifecycleCall.init.body)) as {
      eventType: string
      metadata: { sessionId: string; cliVersion: string; mode: string; os: string }
    }
    expect(event.eventType).toBe("cli_session_exists")
    expect(event.metadata.sessionId).toMatch(/^sess_[0-9a-f]{16}$/)
    expect(event.metadata.cliVersion).toBe(CC_VERSION)
    expect(event.metadata.mode).toBe("interactive")
    expect(event.metadata.os).toBe(`${process.platform}-${process.arch}`)
  })

  test("lifecycle sess id 每次现造（两次发射互不相同，与 x-session-id 无关随机）", () => {
    const first = buildLifecycleEvent(CC_VERSION)
    const second = buildLifecycleEvent(CC_VERSION)
    expect(first.metadata.sessionId).not.toBe(second.metadata.sessionId)
    expect(first.metadata.sessionId).toMatch(/^sess_[0-9a-f]{16}$/)
  })

  test("请求 body 不含 key 原文", async () => {
    const { deps } = makeDeps()
    await runPreflight(deps)
    const fetchImpl = deps.fetchImpl as FetchLike & { calls: RecordedCall[] }
    for (const call of fetchImpl.calls) {
      expect(String(call.init.body)).not.toContain(API_KEY)
    }
  })
})

describe("并行与独立超时（D2）", () => {
  test("指纹与 lifecycle 同批并行上线（Promise.allSettled 求值期两请求均已发出）", async () => {
    const gates = [deferred(), deferred()]
    const urls: string[] = []
    const { deps } = makeDeps({
      fetchImpl: ((url: string | URL | Request) => {
        urls.push(String(url))
        return gates[urls.length - 1]!.promise
      }) as FetchLike,
    })
    const running = runPreflight(deps)
    await flush()
    // 两个请求都已在途（第一个未 resolve 前第二个已发出 = 并行）
    expect(urls.length).toBe(2)
    expect(new Set(urls)).toEqual(new Set([FINGERPRINT_ENDPOINT, LIFECYCLE_ENDPOINT]))
    gates[0]!.resolve(okResponse({ success: true }))
    gates[1]!.resolve(okResponse({ tracked: true }))
    await running
  })

  test("各自独立 3s 超时：双挂起 → advance 3s → 瞬时失败推进（60s × 2^0）", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const signals: Array<AbortSignal | undefined> = []
    const { deps, state } = makeDeps({
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined)
        return hangingResponse(init ?? {})
      }) as FetchLike,
    })
    const running = runPreflight(deps)
    await flush() // 让微任务链推进到两个 fetch 真正发出（超时 timer 此刻才注册）
    jest.advanceTimersByTime(PREFLIGHT_TIMEOUT_MS)
    await flush()
    await running

    // 两个 signal 是独立实例（独立超时）
    expect(signals.length).toBe(2)
    expect(signals[0]).not.toBe(signals[1])
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(true)

    // 超时 = 瞬时失败：退避第一档 60s
    expect(state.failCount).toBe(1)
    expect(state.nextAttemptAt - Date.now()).toBe(TRANSIENT_BASE_MS)
  })

  test("一先成功一挂起：成功方的结局不影响挂起方的独立计时", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const signals: Array<AbortSignal | undefined> = []
    const { deps, state } = makeDeps({
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined)
        // 指纹（先发出）立即成功；lifecycle（后发出）永挂
        return signals.length === 1 ? Promise.resolve(okResponse({ success: true })) : hangingResponse(init ?? {})
      }) as FetchLike,
    })
    const running = runPreflight(deps)
    await flush() // fetch 上线后再推时钟（同上）
    // lifecycle 已并行发出，且 3s 未到点前未被指纹的成功波及
    expect(signals.length).toBe(2)
    expect(signals[1]!.aborted).toBe(false)
    jest.advanceTimersByTime(PREFLIGHT_TIMEOUT_MS)
    await flush()
    await running
    expect(signals[1]!.aborted).toBe(true) // 挂起方独立到点
    expect(state.failCount).toBe(1) // 合记结局 transient（超时归瞬时）
  })
})

describe("结局分类与退避推进（D5）", () => {
  test("双 2xx → success：nextInitAt 落 8–10h 窗口，failCount 清零", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const { deps, state } = makeDeps()
    await runPreflight(deps)
    expect(state.failCount).toBe(0)
    expect(state.nextAttemptAt - Date.now()).toBeGreaterThanOrEqual(8 * HOUR)
    expect(state.nextAttemptAt - Date.now()).toBeLessThan(10 * HOUR)
  })

  test("任一 4xx → rejected：长冷却 8–10h（4xx 优先于瞬时）", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const { deps, state } = makeDeps({
      fetchImpl: ((url: string | URL | Request) =>
        Promise.resolve(statusResponse(String(url) === FINGERPRINT_ENDPOINT ? 401 : 503))) as FetchLike,
    })
    await runPreflight(deps)
    expect(state.failCount).toBe(0) // 4xx 不动 failCount（backoff.ts 语义）
    expect(state.nextAttemptAt - Date.now()).toBeGreaterThanOrEqual(8 * HOUR)
  })

  test("网络错/超时/5xx 任一 → transient：60s × 2^failCount", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const { deps, state } = makeDeps({
      fetchImpl: ((url: string | URL | Request) =>
        String(url) === FINGERPRINT_ENDPOINT
          ? Promise.resolve(statusResponse(503))
          : Promise.reject(new Error("socket down"))) as FetchLike,
    })
    await runPreflight(deps)
    expect(state.failCount).toBe(1)
    expect(state.nextAttemptAt - Date.now()).toBe(TRANSIENT_BASE_MS)
  })

  test("summarizePreflightResults 直接断言：4xx 优先于 rejected 的判定序", () => {
    const settled = (status: number) =>
      ({ status: "fulfilled", value: { status } }) as PromiseSettledResult<Response>
    const rejected = (reason: Error) => ({ status: "rejected", reason }) as PromiseSettledResult<Response>

    expect(summarizePreflightResults([settled(200), settled(200)]).outcome).toBe("success")
    expect(summarizePreflightResults([settled(401), settled(200)]).outcome).toBe("rejected")
    expect(summarizePreflightResults([settled(200), settled(503)]).outcome).toBe("transient")
    // 一个 4xx 一个 5xx：服务器明确说不 → 拒绝优先
    expect(summarizePreflightResults([settled(403), settled(500)]).outcome).toBe("rejected")
    expect(summarizePreflightResults([rejected(new Error("x")), settled(200)]).outcome).toBe("transient")
    const summary = summarizePreflightResults([settled(401), rejected(new Error("timeout-ish"))])
    expect(summary.details).toEqual(["401", "network-error"])
  })

  test("冷却/退避未到点：runPreflight 直接返回不发射", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const { deps, state } = makeDeps()
    await runPreflight(deps) // success → 8–10h 冷却
    const fetchImpl = deps.fetchImpl as FetchLike & { calls: RecordedCall[] }
    expect(fetchImpl.calls.length).toBe(2)

    await runPreflight(deps) // 冷却内：不发射
    expect(fetchImpl.calls.length).toBe(2)
    expect(state.nextAttemptAt).toBeGreaterThan(Date.now())

    // 推过冷却（10h 覆盖抖动上限）→ 重发
    jest.setSystemTime(new Date(Date.now() + 10 * HOUR))
    await runPreflight(deps)
    expect(fetchImpl.calls.length).toBe(4)
  })

  test("本地前置失败（指纹采集/版本解析意外）：preparation-failed 按瞬时处理", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const { deps, state } = makeDeps({ ensureFingerprintBody: () => Promise.reject(new Error("collect exploded")) })
    await runPreflight(deps)
    expect(state.failCount).toBe(1)
    expect(state.nextAttemptAt - Date.now()).toBe(TRANSIENT_BASE_MS)
  })

  test("fetchImpl 同步 throw：runPreflight 绝不向上抛，按瞬时处理（§5 总则）", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const { deps, state } = makeDeps({
      fetchImpl: () => {
        throw new Error("sync boom")
      },
    })
    await expect(runPreflight(deps)).resolves.toBeUndefined()
    expect(state.failCount).toBe(1)
  })
})

describe("失败只记日志不落盘（D5/D7）", () => {
  test("失败日志脱敏：key 只以短哈希出现；消息含 status/错误类别；XDG 目录零文件", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(1_000_000_000_000))
    const logger = collectingLogger()
    const { deps } = makeDeps({
      logger,
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) =>
        String(url) === FINGERPRINT_ENDPOINT ? Promise.resolve(statusResponse(403)) : hangingResponse(init)) as FetchLike,
    })
    const running = runPreflight(deps)
    await flush() // fetch 上线后再推时钟
    jest.advanceTimersByTime(PREFLIGHT_TIMEOUT_MS)
    await flush()
    await running

    const all = logger.messages.join("\n")
    expect(all).not.toContain(API_KEY)
    expect(all).toContain("cc-key#")
    expect(all).toContain("403")
    expect(logger.messages.some((message) => message.startsWith("warn:"))).toBe(true)

    // 失败不落盘：XDG 重定向目录内零产物（预请求无任何磁盘 IO）
    const entries = await fs.readdir(cacheRoot)
    expect(entries).toEqual([])
  })

  test("成功日志为 debug 级（默认安静）", async () => {
    const logger = collectingLogger()
    const { deps } = makeDeps({ logger })
    await runPreflight(deps)
    expect(logger.messages.length).toBe(1)
    expect(logger.messages[0]!.startsWith("debug:")).toBe(true)
    expect(logger.messages[0]).not.toContain(API_KEY)
  })
})

import { afterEach, describe, expect, jest, test } from "bun:test"
import {
  applyPreflightOutcome,
  initialPreflightState,
  JITTER_MS,
  SUCCESS_INTERVAL_MS,
  TRANSIENT_BASE_MS,
  TRANSIENT_CAP_MS,
} from "../../src/disguise/backoff.ts"

// 退避状态机全转移测试（disguise.md §5 + §11 参数速查；#30 验收标准）。
// 时间走 Date.now()，测试用 bun:test fake timers 固定时钟（testing.md §2）。

const T0 = 1_000_000_000_000
const HOUR = 3_600_000
const MIN = 60_000

afterEach(() => {
  jest.useRealTimers()
})

describe("瞬时失败（网络/超时/5xx）：60s × 2^failCount 封顶 15min", () => {
  test("逐次失败按指数递增、failCount 递增、第 5 次起封顶", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(T0))

    const expectedDelays = [1, 2, 3, 4].map((n) => TRANSIENT_BASE_MS * 2 ** (n - 1)).concat([TRANSIENT_CAP_MS, TRANSIENT_CAP_MS])
    expect(expectedDelays).toEqual([MIN, 2 * MIN, 4 * MIN, 8 * MIN, 15 * MIN, 15 * MIN])

    let state = initialPreflightState()
    let failCount = 0
    for (const expected of expectedDelays) {
      state = applyPreflightOutcome(state, "transient")
      failCount += 1
      expect(state.nextAttemptAt - T0).toBe(expected)
      expect(state.failCount).toBe(failCount)
    }
  })

  test("封顶恰为 15min，不越过", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(T0))

    let state = { nextAttemptAt: 0, failCount: 20 }
    state = applyPreflightOutcome(state, "transient")
    expect(state.nextAttemptAt - T0).toBe(15 * MIN)
    expect(state.failCount).toBe(21)
  })

  test("返回新状态对象，不改入参", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(T0))

    const before = initialPreflightState()
    const after = applyPreflightOutcome(before, "transient")
    expect(before.failCount).toBe(0)
    expect(after).not.toBe(before)
  })
})

describe("成功：nextInitAt = now + 8h + rand×2h，failCount 清零", () => {
  test("长驻补发节奏落 8–10h 窗口（rand×2h 上限不含端点）", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(T0))

    const state = applyPreflightOutcome(initialPreflightState(), "success")
    expect(state.failCount).toBe(0)
    expect(state.nextAttemptAt).toBeGreaterThanOrEqual(T0 + 8 * HOUR)
    expect(state.nextAttemptAt).toBeLessThan(T0 + 8 * HOUR + JITTER_MS)
  })

  test("连续瞬时失败后成功：退避计数归零、窗口照常", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(T0))

    let state = initialPreflightState()
    for (let i = 0; i < 6; i++) state = applyPreflightOutcome(state, "transient")
    expect(state.failCount).toBe(6)

    state = applyPreflightOutcome(state, "success")
    expect(state.failCount).toBe(0)
    expect(state.nextAttemptAt).toBeGreaterThanOrEqual(T0 + 8 * HOUR)
  })

  test("抖动常量对齐 §11：8h + rand×2h", () => {
    expect(SUCCESS_INTERVAL_MS).toBe(8 * HOUR)
    expect(JITTER_MS).toBe(2 * HOUR)
  })
})

describe("4xx 拒绝：长冷却 8h + rand×2h", () => {
  test("冷却窗口同成功节奏；failCount 保持不动（规格仅指明成功清零）", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(T0))

    const withHistory = { nextAttemptAt: 0, failCount: 3 }
    const state = applyPreflightOutcome(withHistory, "rejected")
    expect(state.nextAttemptAt).toBeGreaterThanOrEqual(T0 + 8 * HOUR)
    expect(state.nextAttemptAt).toBeLessThan(T0 + 10 * HOUR)
    expect(state.failCount).toBe(3)
  })

  test("连续 4xx 冷却不递增、不叠加", () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(T0))

    let state = initialPreflightState()
    state = applyPreflightOutcome(state, "rejected")
    state = applyPreflightOutcome(state, "rejected")
    expect(state.nextAttemptAt - T0).toBeGreaterThanOrEqual(8 * HOUR)
    expect(state.nextAttemptAt - T0).toBeLessThan(10 * HOUR)
  })
})

describe("状态机与规格常量（§11 参数速查）", () => {
  test("退避基数 60s", () => {
    expect(TRANSIENT_BASE_MS).toBe(60_000)
  })
})

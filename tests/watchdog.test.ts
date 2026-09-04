import { afterEach, describe, expect, jest, test } from "bun:test"
import { createIdleWatchdog, IDLE_WATCHDOG_TIMEOUT_MS, mergeCancellation } from "../src/protocol/watchdog.ts"

// 看门狗（docs/spec/protocol.md §4）：300s 空闲、无总超时、事件重置；
// 取消合并形状：AbortSignal.any(看门狗, 调用方) 谁先响都生效（testing.md §1.1）。

const TIMEOUT = IDLE_WATCHDOG_TIMEOUT_MS // 300_000

afterEach(() => {
  jest.useRealTimers()
})

describe("空闲看门狗：300s 计时与事件重置", () => {
  test("无任何事件：300s 到点触发（signal aborted、fired=true、reason 为看门狗标记）", () => {
    jest.useFakeTimers()
    const watchdog = createIdleWatchdog()
    expect(watchdog.fired).toBe(false)
    expect(watchdog.signal.aborted).toBe(false)

    jest.advanceTimersByTime(TIMEOUT - 1)
    expect(watchdog.fired).toBe(false)
    expect(watchdog.signal.aborted).toBe(false)

    jest.advanceTimersByTime(1)
    expect(watchdog.fired).toBe(true)
    expect(watchdog.signal.aborted).toBe(true)
  })

  test("有事件重置：300s 内 reset 推迟触发点，不误杀活跃流", () => {
    jest.useFakeTimers()
    const watchdog = createIdleWatchdog()

    // 事件序列：每 290s 一次 reset——总时长远超 300s 也不触发（无总超时）
    for (let round = 0; round < 5; round++) {
      jest.advanceTimersByTime(290_000)
      expect(watchdog.fired).toBe(false)
      watchdog.reset()
    }

    // reset 后仍从零计 300s：290s 后不触发，再过 10s 触发
    jest.advanceTimersByTime(290_000)
    expect(watchdog.fired).toBe(false)
    jest.advanceTimersByTime(10_000)
    expect(watchdog.fired).toBe(true)
  })

  test("clear 后不再触发（流正常收尾释放定时器）", () => {
    jest.useFakeTimers()
    const watchdog = createIdleWatchdog()
    watchdog.clear()
    jest.advanceTimersByTime(TIMEOUT * 2)
    expect(watchdog.fired).toBe(false)
    expect(watchdog.signal.aborted).toBe(false)
  })

  test("fired 后 reset 不再重启计时（错误已定局）", () => {
    jest.useFakeTimers()
    const watchdog = createIdleWatchdog()
    jest.advanceTimersByTime(TIMEOUT)
    expect(watchdog.fired).toBe(true)
    watchdog.reset()
    jest.advanceTimersByTime(TIMEOUT)
    expect(watchdog.fired).toBe(true)
  })
})

describe("取消合并形状（§4：AbortSignal.any(看门狗, 调用方)）", () => {
  test("有调用方 signal：合并后看门狗先触发则合并信号 abort", () => {
    jest.useFakeTimers()
    const watchdog = createIdleWatchdog()
    const caller = new AbortController()
    const combined = mergeCancellation(watchdog, caller.signal)
    expect(combined.aborted).toBe(false)

    jest.advanceTimersByTime(TIMEOUT)
    expect(watchdog.fired).toBe(true)
    expect(combined.aborted).toBe(true)
  })

  test("有调用方 signal：调用方先 abort 则合并信号 abort（谁先响都生效）", () => {
    const watchdog = createIdleWatchdog()
    const caller = new AbortController()
    const combined = mergeCancellation(watchdog, caller.signal)

    caller.abort()
    expect(combined.aborted).toBe(true)
    expect(watchdog.fired).toBe(false) // 看门狗本身未被触发
  })

  test("无调用方 signal：直接用看门狗 signal（等价形状）", () => {
    const watchdog = createIdleWatchdog()
    expect(mergeCancellation(watchdog)).toBe(watchdog.signal)
  })
})

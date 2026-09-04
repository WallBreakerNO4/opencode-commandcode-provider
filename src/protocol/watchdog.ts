/**
 * 协议核心·超时与取消（契约：docs/spec/protocol.md §4）。
 *
 * - 300 秒空闲看门狗（常量，暂不配置化）：持续未收到任何新事件即判定上游
 *   失联 → abort 上游 + 抛可重试错误（retry-after 5s，见 errors.ts
 *   `watchdogTimeoutError`）。连接阶段计入空闲（「连首字节都没等到」本身
 *   就是最大的空闲），因此看门狗从 fetch 发起前启动。
 * - 无总超时——健康长回合不被固定时限误杀，只有真失联才断开。本模块只有
 *   「空闲计时」，不累计任何总时长。
 * - 取消合并由调用方用 `AbortSignal.any([watchdog.signal, 调用方 abortSignal])`
 *   完成（本文件导出 `mergeCancellation` 辅助，谁先响都生效）。
 *
 * 实现用 setTimeout + AbortController 而非 `AbortSignal.timeout`：看门狗要
 * 「每次收到事件重置计时」，timeout 信号是一次性的、无法重置。
 */

/** 空闲看门狗时长：300 秒（§4 常量，暂不配置化） */
export const IDLE_WATCHDOG_TIMEOUT_MS = 300_000

export interface IdleWatchdog {
  /** abort 时置位；调用方经 `AbortSignal.any` 与自己的取消信号合并后控制上游 fetch */
  readonly signal: AbortSignal
  /** 是否已到点触发（区分「看门狗断开」与「调用方取消」两条 abort 路径） */
  readonly fired: boolean
  /** 每次收到上游新事件调用：重置空闲计时 */
  reset(): void
  /** 流正常收尾后调用：停止计时并释放定时器（避免残留 timer 悬挂进程） */
  clear(): void
}

/** 到点触发时 abort 的 reason 标识：fetch 侧据此可区分失联断开 */
export const WATCHDOG_ABORT_REASON = Symbol("commandcode.idle-watchdog")

/** 创建空闲看门狗；创建即开始计时（连接阶段计入空闲，§4）。时长即常量。 */
export function createIdleWatchdog(): IdleWatchdog {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let fired = false

  function arm(): void {
    clear()
    timer = setTimeout(() => {
      fired = true
      controller.abort(WATCHDOG_ABORT_REASON)
    }, IDLE_WATCHDOG_TIMEOUT_MS)
  }

  function clear(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  arm()

  return {
    signal: controller.signal,
    get fired() {
      return fired
    },
    reset() {
      if (fired) return
      arm()
    },
    clear() {
      clear()
    },
  }
}

/**
 * 取消合并：`AbortSignal.any` 的封装——看门狗 signal 与调用方 abortSignal
 * 谁先 abort 谁生效（§4 取消合并条款；两路信号的行为差异见执行层：
 * 看门狗到点 → 合成可重试错误，调用方取消 → 传播 abort 不合成错误）。
 */
export function mergeCancellation(watchdog: IdleWatchdog, callerSignal?: AbortSignal): AbortSignal {
  return callerSignal === undefined ? watchdog.signal : AbortSignal.any([watchdog.signal, callerSignal])
}

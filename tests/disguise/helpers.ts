/**
 * 伪装模块测试共用的注入桩（testing.md §2 形态）：记录式 logger、挂起到 signal
 * 到点的 fetch 响应、可控 deferred、微任务冲刷。依赖各自测试文件缓存目录的
 * settle 类辅助不在此列（绑定各文件 fixture 路径）。
 */

import type { DisguiseLogger } from "../../src/disguise/logger.ts"

/** 收集全部日志消息的 fake logger（断言脱敏与级别用） */
export function collectingLogger(): DisguiseLogger & { messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    debug: (message) => messages.push(`debug:${message}`),
    warn: (message) => messages.push(`warn:${message}`),
  }
}

/**
 * 挂起至 signal 到点才 reject 的 fetch 响应（模拟网关挂起）。AbortSignal.timeout
 * 由 fake timers 驱动到点（testing.md §2：纳入 fake heap）；注意调用方若在 mock
 * fetch 发出前就 advance，timer 尚未注册、signal 永不到点。
 */
export function hangingResponse(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const signal = init?.signal ?? undefined
    if (signal === undefined) return
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

/** 手控结局的一次性 Response promise */
export function deferred(): { promise: Promise<Response>; resolve: (response: Response) => void; reject: (error: unknown) => void } {
  let resolve!: (response: Response) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Response>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 冲刷微任务：fetch mock resolve → 链推进（fs 等真实宏任务需另行让出，见各文件 settle） */
export async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

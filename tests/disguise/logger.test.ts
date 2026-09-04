import { describe, expect, test } from "bun:test"
import { consoleLogger, noopLogger } from "../../src/disguise/logger.ts"

// 注入式 logger 通道（disguise.md §7）：v2 glue 注入、v1/独立调用退化 console、测试注 no-op。

test("noopLogger 可调用且零副作用（测试默认注入）", () => {
  expect(() => {
    noopLogger.debug("debug message")
    noopLogger.warn("warn message")
  }).not.toThrow()
})

describe("consoleLogger 路由", () => {
  test("debug 走 console.debug，warn 走 console.warn", () => {
    const debugCalls: string[] = []
    const warnCalls: string[] = []
    const originalDebug = console.debug
    const originalWarn = console.warn
    console.debug = (message: string) => debugCalls.push(message)
    console.warn = (message: string) => warnCalls.push(message)
    try {
      const logger = consoleLogger()
      logger.debug("预请求成功")
      logger.warn("预请求失败 cc-key#36ff39cc")
    } finally {
      console.debug = originalDebug
      console.warn = originalWarn
    }
    expect(debugCalls).toEqual(["预请求成功"])
    expect(warnCalls).toEqual(["预请求失败 cc-key#36ff39cc"])
  })
})

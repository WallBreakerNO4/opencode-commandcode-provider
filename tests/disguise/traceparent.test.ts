import { describe, expect, test } from "bun:test"
import { generateTraceparent } from "../../src/disguise/traceparent.ts"

// traceparent（disguise.md §10 照抄清单，#9 抓包实测吻合）：00-<32hex>-<16hex>-01，逐请求新造。

const TRACEPARENT_SHAPE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/

test("形状：版本恒 00、trace-id 32 hex、span-id 16 hex、flag 恒 01", () => {
  const value = generateTraceparent()
  expect(value).toMatch(TRACEPARENT_SHAPE)
})

test("逐请求新造：连续生成零复用", () => {
  const values = new Set(Array.from({ length: 100 }, () => generateTraceparent()))
  expect(values.size).toBe(100)
  for (const value of values) {
    expect(value).toMatch(TRACEPARENT_SHAPE)
  }
})

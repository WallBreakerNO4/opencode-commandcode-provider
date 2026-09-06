/**
 * `traceparent` 头（disguise.md §10 照抄清单，#9 抓包实测吻合）：
 * `00-<32hex>-<16hex>-01`——版本恒 `00`（W3C Trace Context 当前版本）、
 * trace-id 16 随机字节、parent-span-id 8 随机字节、flag 恒 `01`。
 * 逐请求新造、跨请求零复用；只进 generate 主请求，不进预请求与 models。
 */

import { randomBytes } from "node:crypto"

export function generateTraceparent(traceId?: string): string {
  return `00-${traceId ?? randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`
}

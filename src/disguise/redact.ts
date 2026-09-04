/**
 * 日志脱敏（disguise.md §7，老板红线：不泄露敏感信息）：
 * - apiKey 只以 `cc-key#` + sha256 前 8 位 hex 出现，日志中零原文；
 * - thumbmark / sessionId / trace-id 本身即伪标识符，截断为前 12 位 hex + `…`；
 * - Authorization 头 / 完整 key 永不整串输出——错误日志只记 HTTP status 与错误
 *   类别、不序列化请求头，该纪律由调用方遵守，无对应纯函数。
 */

import { sha256Hex } from "./hash.js"

/** apiKey 的日志形态：`cc-key#` + sha256(apiKey) 前 8 位 hex */
export function redactApiKey(apiKey: string): string {
  return `cc-key#${sha256Hex(apiKey).slice(0, 8)}`
}

/** 伪标识符（thumbmark 64hex / sessionId uuid / trace-id 32hex）截断为前 12 位 hex + `…`；
 * uuid 的连字符剥除后再取，保证截出的是纯 hex 位。 */
export function redactIdentifier(id: string): string {
  return `${id.replace(/-/g, "").slice(0, 12)}…`
}

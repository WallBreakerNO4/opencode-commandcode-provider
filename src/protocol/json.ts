/**
 * 协议核心内部共用的 JSON 结构小工具。上游 wire 数据一律经 `JSON.parse` 到达，
 * 这里只做形状守卫，不做语义解释。
 */

/** 宽松对象守卫：非 null 非 数组的对象才可按字段读取 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

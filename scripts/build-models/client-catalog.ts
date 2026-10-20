/**
 * view=client 远程 catalog 解析：官方 1.84.0 起 CLI 运行时的模型发现权威
 * （`GET /provider/v1/models?view=client`）。响应顶层
 * `{schemaVersion, catalogVersion, refreshAfterSeconds, roles, data}`，本模块只消费
 * `catalogVersion` 与 `data` 里的目录条目，其余字段忽略。
 *
 * 与内嵌目录（bundle 逆向）共用 `CatalogEntry` 形状：Go plan 判据、产物组装与
 * 对账断言对两源一视同仁。null 与缺失同义（官方用 null 表达「无值」）。
 */

import type { CatalogEntry } from "./bundle.ts"

export class ClientCatalogParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClientCatalogParseError"
  }
}

export interface ClientCatalog {
  readonly catalogVersion: string
  readonly entries: readonly CatalogEntry[]
}

export function parseClientCatalog(input: unknown): ClientCatalog {
  const root = asRecord(input)
  if (root === null) throw new ClientCatalogParseError("view=client 响应顶层不是对象")
  const catalogVersion = root["catalogVersion"]
  if (typeof catalogVersion !== "string" || catalogVersion.length === 0) {
    throw new ClientCatalogParseError("view=client 响应缺非空字符串 catalogVersion")
  }
  const data = root["data"]
  if (!Array.isArray(data)) {
    throw new ClientCatalogParseError("view=client 响应缺 data 数组")
  }

  const entries: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const [index, raw] of data.entries()) {
    const entry = parseEntry(raw, index)
    if (seen.has(entry.id)) {
      throw new ClientCatalogParseError(`view=client data[${index}].id「${entry.id}」重复——id 是模型主键`)
    }
    seen.add(entry.id)
    entries.push(entry)
  }
  return { catalogVersion, entries }
}

function parseEntry(raw: unknown, index: number): CatalogEntry {
  const path = `data[${index}]`
  const object = asRecord(raw)
  if (object === null) throw new ClientCatalogParseError(`view=client ${path} 不是对象`)

  const id = requireString(object, "id", path)
  const name = optionalString(object, "name", path)
  const display = optionalRecord(object, "display", path)
  const label = display === undefined ? undefined : optionalString(display, "label", `${path}.display`)
  const badge = display === undefined ? undefined : optionalString(display, "badge", `${path}.display`)
  const reasoningEfforts = optionalStringArray(object, "reasoningEfforts", path)
  const explicitReasoning = optionalBoolean(object, "reasoning", path)
  const reasoning = explicitReasoning ?? (reasoningEfforts === undefined ? undefined : reasoningEfforts.length > 0)
  const contextWindow =
    optionalNumber(object, "context_length", path) ?? optionalNumber(object, "contextWindow", path)
  const maxOutputTokens = optionalNumber(object, "maxOutputTokens", path)
  const inputModalities = optionalStringArray(object, "inputModalities", path)
  const hidden = optionalBoolean(object, "hidden", path)
  // 套餐判据是官方契约的必填字段：缺失即结构漂移，宁可构建失败也不静默漏模型
  const minimumPlan = requireString(object, "minimumPlan", path)

  return {
    id,
    minimumPlan,
    ...(name !== undefined ? { name } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputModalities !== undefined ? { inputModalities } : {}),
    ...(hidden !== undefined ? { hidden } : {}),
    ...(badge !== undefined ? { badge } : {}),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function requireString(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new ClientCatalogParseError(`view=client ${path}.${key} 必须是非空字符串`)
  }
  return value
}

function optionalString(object: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = object[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new ClientCatalogParseError(`view=client ${path}.${key} 必须是字符串`)
  return value
}

function optionalBoolean(object: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = object[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw new ClientCatalogParseError(`view=client ${path}.${key} 必须是布尔`)
  return value
}

function optionalNumber(object: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = object[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ClientCatalogParseError(`view=client ${path}.${key} 必须是有限数字`)
  }
  return value
}

function optionalStringArray(object: Record<string, unknown>, key: string, path: string): readonly string[] | undefined {
  const value = object[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ClientCatalogParseError(`view=client ${path}.${key} 必须是字符串数组`)
  }
  return value
}

function optionalRecord(object: Record<string, unknown>, key: string, path: string): Record<string, unknown> | undefined {
  const value = object[key]
  if (value === undefined || value === null) return undefined
  const record = asRecord(value)
  if (record === null) throw new ClientCatalogParseError(`view=client ${path}.${key} 必须是对象`)
  return record
}

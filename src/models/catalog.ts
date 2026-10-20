/**
 * `view=client` catalog 响应的运行时解析（契约：docs/dev/spec/model-pipeline.md §3/§4，
 * 事实层：#61 实测形状）。
 *
 * 官方 CLI 1.84.0 起以 `GET /provider/v1/models?view=client` 作为模型发现源。运行时
 * 只消费顶层 `catalogVersion`（条件请求的 ETag 基准）、`refreshAfterSeconds`（刷新
 * 节奏）与 `data` 条目的 `id` / `name` / `context_length`：发现权威已归产物全集
 * （cascade.ts），catalog 仅作 context / name 的字段级权威。`roles` / `pricing` /
 * `zdr` / `aliases` / `display.*` 等其余字段不搬运进解析结果（未知字段忽略）。
 *
 * 条目字段用 `null` 表达「无值」（官方口径），与缺失同义；`refreshAfterSeconds`
 * 只影响节奏、`catalogVersion` 只作 ETag 基准，二者缺失或非法时都不丢整份
 * catalog 的字段级权威（分别回落默认 900s / 放弃条件请求）。
 */

import { asRecord } from "../protocol/json.js"

/** 官方当前声明的刷新节奏（秒）；响应缺省或非法时的回落值 */
export const DEFAULT_CATALOG_REFRESH_SECONDS = 900

/** 单条 catalog 条目中运行时消费的字段 */
export interface CatalogEntry {
  readonly id: string
  readonly name?: string
  readonly contextLength?: number
}

export interface ClientCatalog {
  /** ETag 基准；上游缺省时仍可消费条目，只是每次全量拉取 */
  readonly catalogVersion?: string
  readonly refreshAfterSeconds: number
  readonly models: readonly CatalogEntry[]
}

export type CatalogParseResult =
  | { readonly ok: true; readonly catalog: ClientCatalog }
  | { readonly ok: false; readonly detail: string }

export function parseClientCatalog(input: unknown): CatalogParseResult {
  const root = asRecord(input)
  if (root === null) return fail("顶层不是 JSON 对象")
  const rawCatalogVersion = root["catalogVersion"]
  if (rawCatalogVersion !== undefined && rawCatalogVersion !== null) {
    if (typeof rawCatalogVersion !== "string" || rawCatalogVersion.length === 0) {
      return fail("catalogVersion 必须是非空字符串")
    }
  }
  const catalogVersion = typeof rawCatalogVersion === "string" ? rawCatalogVersion : undefined
  const data = root["data"]
  if (!Array.isArray(data)) return fail("data 必须是数组")
  const refreshAfterSeconds = parseRefreshAfterSeconds(root["refreshAfterSeconds"])

  const models: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const [index, raw] of data.entries()) {
    const entry = asRecord(raw)
    if (entry === null) return fail(`data[${index}] 不是对象`)
    const id = entry["id"]
    if (typeof id !== "string" || id.length === 0) return fail(`data[${index}].id 必须是非空字符串`)
    if (seen.has(id)) return fail(`data[${index}].id「${id}」重复——id 是模型主键`)
    seen.add(id)
    const name = optionalString(entry["name"])
    if (name === INVALID) return fail(`data[${index}]「${id}」.name 必须是字符串`)
    const contextLength = optionalPositiveNumber(entry["context_length"])
    if (contextLength === INVALID) return fail(`data[${index}]「${id}」.context_length 必须是正数`)
    models.push({
      id,
      ...(name !== undefined ? { name } : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
    })
  }
  return {
    ok: true,
    catalog: {
      ...(catalogVersion !== undefined ? { catalogVersion } : {}),
      refreshAfterSeconds,
      models,
    },
  }
}

/** 非法哨兵：区分「字段缺失/为 null」与「字段存在但类型不对」 */
const INVALID = Symbol("invalid")

function optionalString(value: unknown): string | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined
  return typeof value === "string" ? value : INVALID
}

function optionalPositiveNumber(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : INVALID
}

function parseRefreshAfterSeconds(value: unknown): number {
  const parsed = optionalPositiveNumber(value)
  return parsed === undefined || parsed === INVALID ? DEFAULT_CATALOG_REFRESH_SECONDS : parsed
}

function fail(detail: string): CatalogParseResult {
  return { ok: false, detail }
}

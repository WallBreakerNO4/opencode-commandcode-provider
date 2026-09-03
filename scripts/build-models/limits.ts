/**
 * limits 补全链（规格 model-pipeline.md §1.1 / §2.4）：
 *   context:   bundle contextWindow → 同 family 借用 → models.dev limit.context → 常量 200000
 *   maxOutput: bundle maxOutputTokens → 同 family 借用 → models.dev limit.output → 常量 32000
 * 每个值记录 provenance（bundle / family / models-dev / constant）进构建日志——
 * 编造值必须可审计（用户故事 36）。family 借用只看 bundle 值、不传递（防止编造值成链）。
 */

import type { CatalogEntry } from "./bundle.ts"
import type { ModelsDevLimits } from "./modelsdev.ts"

export type LimitProvenance = "bundle" | "family" | "models-dev" | "constant"
export type LimitField = "context" | "maxOutput"

export interface LimitResolution {
  readonly field: LimitField
  readonly value: number
  readonly provenance: LimitProvenance
  /** family 借用源 id / models.dev 匹配位置；bundle 与 constant 无来源 */
  readonly source?: string
}

export const FALLBACK_CONTEXT = 200000
export const FALLBACK_MAX_OUTPUT = 32000

/**
 * family 定义：同 vendor 下按「-」逐级缩短的最长公共前缀；vendor 本身是最后一级
 * 兜底（tencent/hy3-paid 缺值可向同厂商 hy4-preview 借）。候选按长到短尝试，
 * 同键下多个供体取 id 排序最小者（确定性，可审计）。
 */
export function familyKeys(id: string): string[] {
  const slash = id.indexOf("/")
  const vendor = slash === -1 ? "" : id.slice(0, slash)
  const model = slash === -1 ? id : id.slice(slash + 1)
  // 全长键起头，随后在「-」「.」分隔符处由长到短截原始前缀（保留原分隔形态），
  // 最后以 vendor 本身收尾。点号是 Qwen3.6 / Qwen3.8 这类同代分代边界，与 - 同权。
  const keys: string[] = [vendor === "" ? model : `${vendor}/${model}`]
  for (let i = model.length - 1; i >= 1; i--) {
    const ch = model[i]
    if (ch === "-" || ch === ".") {
      const partial = model.slice(0, i)
      keys.push(vendor === "" ? partial : `${vendor}/${partial}`)
    }
  }
  if (vendor !== "") keys.push(vendor)
  return keys
}

function bundleLimit(entry: CatalogEntry, field: LimitField): number | undefined {
  return field === "context" ? entry.contextWindow : entry.maxOutputTokens
}

function borrowFromFamily(id: string, catalog: readonly CatalogEntry[], field: LimitField): LimitResolution | undefined {
  for (const key of familyKeys(id)) {
    const donors = catalog
      .filter((candidate) => candidate.id !== id && hasFamilyKey(candidate.id, key) && bundleLimit(candidate, field) !== undefined)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    const donor = donors[0]
    const value = donor === undefined ? undefined : bundleLimit(donor, field)
    if (donor !== undefined && value !== undefined) {
      return { field, value, provenance: "family", source: donor.id }
    }
  }
  return undefined
}

/** 候选与 family 键匹配：恰好相等，或以「键 + -」/「键 + .」为前缀——点号是 Qwen3.6 / Qwen3.8 这类同代分代边界，与 - 同权 */
function hasFamilyKey(candidateId: string, key: string): boolean {
  return candidateId === key || candidateId.startsWith(`${key}-`) || candidateId.startsWith(`${key}.`)
}

export function resolveLimit(
  field: LimitField,
  entry: CatalogEntry,
  catalog: readonly CatalogEntry[],
  dev: ModelsDevLimits | undefined,
): LimitResolution {
  const own = bundleLimit(entry, field)
  if (own !== undefined) return { field, value: own, provenance: "bundle" }

  const family = borrowFromFamily(entry.id, catalog, field)
  if (family !== undefined) return family

  if (dev !== undefined) {
    const devValue = field === "context" ? dev.context : dev.output
    if (typeof devValue === "number") {
      return { field, value: devValue, provenance: "models-dev", source: dev.source }
    }
  }

  return { field, value: field === "context" ? FALLBACK_CONTEXT : FALLBACK_MAX_OUTPUT, provenance: "constant" }
}

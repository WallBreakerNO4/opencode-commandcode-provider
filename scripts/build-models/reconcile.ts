/**
 * 对账与断言（规格 §2.5）：任一失败 = 构建失败 + 自动开 issue，不静默出产物。
 * 规格四条 + 两条源自规格字段表的一致性断言：
 * 1. 值域：normalize 后 Min plan ⊆ {Go, GOAT, Pro, Max}（新取值 = 新套餐上线，人工确认套餐序）；
 * 2. 产物 id ⊆ /models API id 集合（bundle 的隐藏 free 等条目不进产物）；
 * 3. 产物非空（首次构建无分布基线可比，空产物必须硬失败，防 0 模型静默发布）；
 * 4. 分布监控：相对上次成功构建的分布，任一档 |Δ| > MAX_PLAN_DISTRIBUTION_DRIFT → 人工复核。
 *    规格基线数字（Go 40 / GOAT 4 / Pro 13 / Max 5，1.37.0 时点）是初始参考值，
 *    实现采用「与上次成功构建比」的监控语义：正常发版 +1/+2 不阻塞 30 分钟 SLA，
 *    跳变（批量套餐调整 / 解析器坏列）才触发人工——突变检测的本意。
 * 5. Efforts 逐值一致（§1.1：models.md Efforts 列与 bundle reasoningEfforts 同源）：
 *    两处都有值的模型必须逐值相等——上游内部不一致意味着其中一处已坏，人工裁决；
 *    单边缺失不在此断言（「—」= 模型自决的官方语义与 bundle 缺省等价）。
 * 6. 模态词表（§1.1：取值仅 ["text"] / ["text","image"]）：新模态出现 = 网关投递
 *    能力未经验证，advertise 超出协议层转换能力会放行后静默丢弃，必须人工确认
 *    协议层支持后扩词表。
 * 断言失败聚合输出（一次跑完全部断言再抛），开 issue 时信息一次给全。
 */

import type { CatalogEntry } from "./bundle.ts"
import type { ModelsMdRow } from "./models-md.ts"
import { PLAN_VALUES, type PlanName } from "./models-md.ts"

export type PlanDistribution = Record<PlanName, number>

/** 任一档相对上次成功构建的漂移超过该值即断言失败（Go 42 档的 ~12%，正常发版 +1/+2 不触发） */
export const MAX_PLAN_DISTRIBUTION_DRIFT = 5

export interface ReconcileFailure {
  readonly assertion: string
  readonly detail: string
}

export class ReconcileError extends Error {
  constructor(public readonly failures: readonly ReconcileFailure[]) {
    super(`对账断言失败 ${failures.length} 项：\n${failures.map((f) => `- [${f.assertion}] ${f.detail}`).join("\n")}`)
    this.name = "ReconcileError"
  }
}

export function assertPlanValueDomain(rows: readonly ModelsMdRow[]): ReconcileFailure | undefined {
  const unknown = new Map<string, number>()
  for (const row of rows) {
    if (!(PLAN_VALUES as readonly string[]).includes(row.minPlan)) {
      unknown.set(row.minPlanRaw, (unknown.get(row.minPlanRaw) ?? 0) + 1)
    }
  }
  if (unknown.size === 0) return undefined
  const detail = [...unknown.entries()].map(([raw, count]) => `${JSON.stringify(raw)} ×${count}`).join("、") +
    `——新 Min plan 取值出现意味着新套餐上线，需人工确认套餐序并更新 PLAN_VALUES`
  return { assertion: "Min plan 值域", detail }
}

export function assertIdsSubset(productIds: readonly string[], apiIds: ReadonlySet<string>): ReconcileFailure | undefined {
  const missing = productIds.filter((id) => !apiIds.has(id))
  if (missing.length === 0) return undefined
  return {
    assertion: "产物 id ⊆ /models API id 集合",
    detail: `以下 ${missing.length} 个产物 id 不在 /models API 清单中（bundle 隐藏 free 等条目不得进产物）：${missing.join("、")}`,
  }
}

export function assertArtifactNonEmpty(productIds: readonly string[]): ReconcileFailure | undefined {
  if (productIds.length > 0) return undefined
  return { assertion: "产物非空", detail: "Go plan 过滤后产物为空——解析或过滤链路必有问题，拒绝发布空产物" }
}

export function assertDistributionStable(
  current: PlanDistribution,
  prev: PlanDistribution | undefined,
): ReconcileFailure | undefined {
  if (prev === undefined) return undefined // 首次构建：记录基线，无从比对
  const drifts = PLAN_VALUES.map((plan) => ({ plan, delta: current[plan] - prev[plan] }))
  const breaches = drifts.filter((d) => Math.abs(d.delta) > MAX_PLAN_DISTRIBUTION_DRIFT)
  if (breaches.length === 0) return undefined
  const detail =
    `当前 ${formatDistribution(current)} vs 上次成功构建 ${formatDistribution(prev)}；` +
    `超阈档位：${breaches.map((d) => `${d.plan} ${d.delta > 0 ? "+" : ""}${d.delta}`).join("、")}（阈值 ±${MAX_PLAN_DISTRIBUTION_DRIFT}）。` +
    `分布突变需人工复核：确认是官方正常发版则更新 data 分支基线，否则排查解析链路`
  return { assertion: "Min plan 分布监控", detail }
}

export function formatDistribution(distribution: PlanDistribution): string {
  return PLAN_VALUES.map((plan) => `${plan} ${distribution[plan]}`).join(" / ")
}

/** §1.1 模态词表：网关可投递口径的当前词表；上游扩模态必须经人工确认协议层支持后在此扩词表 */
const ALLOWED_INPUT_MODALITIES = new Set(["text", "image"])

export function assertModalityVocabulary(
  mdRows: readonly ModelsMdRow[],
  catalog: readonly CatalogEntry[],
): ReconcileFailure | undefined {
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]))
  const violations: string[] = []
  for (const row of mdRows) {
    if (row.minPlan !== "Go") continue
    const entry = catalogById.get(row.id)
    const modalities = entry?.inputModalities
    if (modalities === undefined) continue // 缺字段由 emit 的 fail-fast 覆盖
    const unknown = modalities.filter((modality) => !ALLOWED_INPUT_MODALITIES.has(modality))
    if (unknown.length > 0) violations.push(`${row.id}：[${modalities.join("、")}]`)
  }
  if (violations.length === 0) return undefined
  return {
    assertion: "inputModalities 词表",
    detail: `以下模型出现词表外模态（当前词表：text / image）：${violations.join("；")}。` +
      "新模态 = 网关投递能力未经验证，需人工确认协议层转换支持后更新 ALLOWED_INPUT_MODALITIES，否则放行会静默丢弃",
  }
}

export function assertEffortsConsistency(
  mdRows: readonly ModelsMdRow[],
  catalog: readonly CatalogEntry[],
): ReconcileFailure | undefined {
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]))
  const mismatches: string[] = []
  for (const row of mdRows) {
    const entry = catalogById.get(row.id)
    const mdEfforts = row.efforts
    const bundleEfforts = entry?.reasoningEfforts
    if (mdEfforts === undefined || bundleEfforts === undefined) continue
    if (mdEfforts.length !== bundleEfforts.length || mdEfforts.some((effort, index) => effort !== bundleEfforts[index])) {
      mismatches.push(`${row.id}：models.md [${mdEfforts.join("、")}] vs bundle [${bundleEfforts.join("、")}]`)
    }
  }
  if (mismatches.length === 0) return undefined
  return {
    assertion: "Efforts 逐值一致",
    detail: `models.md Efforts 列与 bundle reasoningEfforts 同源，实测出现分歧：${mismatches.join("；")}。上游内部不一致说明其中一处已变，需人工裁决以哪处为准`,
  }
}

export function runReconcile(assertions: ReadonlyArray<ReconcileFailure | undefined>): void {
  const failures = assertions.filter((failure): failure is ReconcileFailure => failure !== undefined)
  if (failures.length > 0) throw new ReconcileError(failures)
}

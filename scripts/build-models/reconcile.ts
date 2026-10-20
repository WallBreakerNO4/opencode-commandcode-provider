/**
 * 对账与断言（规格 §2.5）：任一失败 = 构建失败 + 自动开 issue，不静默出产物。
 * 1. 值域：minimumPlan ⊆ {individual-go, individual-goat, individual-pro,
 *    individual-max, individual-provider}（新取值 = 官方调整档位体系，人工确认）；
 * 2. 产物非空（打掉「解析/过滤链路坏了还发布 0 模型」的静默风险）；
 * 3. Go 计数监控：individual-go 非隐藏条目数相对上次成功构建漂移 > ±5 → 人工复核，
 *    防批量套餐调整或坏数据静默通过；
 * 4. 模态词表：只看进产物的 Go 非隐藏条目；新模态出现 = 网关投递能力未经验证，
 *    advertise 超出协议层转换能力会放行后静默丢弃，必须人工确认协议层支持后扩词表。
 * 断言失败聚合输出（一次跑完全部断言再抛），开 issue 时信息一次给全。
 */

import type { CatalogEntry } from "./bundle.ts"
import { isGoPlanVisible } from "./plan.ts"

/** 官方 minimumPlan 词表：新值出现即构建失败，交人工确认档位体系 */
export const PLAN_VALUES = [
  "individual-go",
  "individual-goat",
  "individual-pro",
  "individual-max",
  "individual-provider",
] as const

/** individual-go 非隐藏计数相对上次成功构建的漂移阈值（59 条的 ~8%，正常发版 +1/+2 不触发） */
export const MAX_GO_COUNT_DRIFT = 5

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

export function assertPlanValueDomain(entries: readonly CatalogEntry[]): ReconcileFailure | undefined {
  const unknown = new Map<string, number>()
  for (const entry of entries) {
    if (entry.minimumPlan === undefined) continue
    if (!(PLAN_VALUES as readonly string[]).includes(entry.minimumPlan)) {
      unknown.set(entry.minimumPlan, (unknown.get(entry.minimumPlan) ?? 0) + 1)
    }
  }
  if (unknown.size === 0) return undefined
  const detail = [...unknown.entries()].map(([value, count]) => `${JSON.stringify(value)} ×${count}`).join("、") +
    `——新 minimumPlan 取值出现意味着官方调整档位体系，需人工确认并更新 PLAN_VALUES`
  return { assertion: "Min plan 值域", detail }
}

export function assertArtifactNonEmpty(productIds: readonly string[]): ReconcileFailure | undefined {
  if (productIds.length > 0) return undefined
  return { assertion: "产物非空", detail: "Go plan 过滤后产物为空——解析或过滤链路必有问题，拒绝发布空产物" }
}

export function assertGoCountStable(current: number, prev: number | undefined): ReconcileFailure | undefined {
  if (prev === undefined) return undefined // 首次构建：记录基线，无从比对
  const delta = current - prev
  if (Math.abs(delta) <= MAX_GO_COUNT_DRIFT) return undefined
  const detail =
    `当前 individual-go 非隐藏计数 ${current} vs 上次成功构建 ${prev}（漂移 ${delta > 0 ? "+" : ""}${delta}，阈值 ±${MAX_GO_COUNT_DRIFT}）。` +
    `计数突变需人工复核：确认是官方正常发版则更新 data 分支基线，否则排查 catalog 解析链路`
  return { assertion: "Go 模型计数监控", detail }
}

/** §1.1 模态词表：网关可投递口径的当前词表；上游扩模态必须经人工确认协议层支持后在此扩词表 */
const ALLOWED_INPUT_MODALITIES = new Set(["text", "image"])

export function assertModalityVocabulary(entries: readonly CatalogEntry[]): ReconcileFailure | undefined {
  const violations: string[] = []
  for (const entry of entries) {
    if (!isGoPlanVisible(entry)) continue
    const modalities = entry.inputModalities
    if (modalities === undefined) continue // 缺字段由 emit 的 fail-fast 覆盖
    const unknown = modalities.filter((modality) => !ALLOWED_INPUT_MODALITIES.has(modality))
    if (unknown.length > 0) violations.push(`${entry.id}：[${modalities.join("、")}]`)
  }
  if (violations.length === 0) return undefined
  return {
    assertion: "inputModalities 词表",
    detail: `以下模型出现词表外模态（当前词表：text / image）：${violations.join("；")}。` +
      "新模态 = 网关投递能力未经验证，需人工确认协议层转换支持后更新 ALLOWED_INPUT_MODALITIES，否则放行会静默丢弃",
  }
}

export function runReconcile(assertions: ReadonlyArray<ReconcileFailure | undefined>): void {
  const failures = assertions.filter((failure): failure is ReconcileFailure => failure !== undefined)
  if (failures.length > 0) throw new ReconcileError(failures)
}

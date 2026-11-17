/**
 * 对账与断言（规格 §2.5）：任一失败 = 构建失败 + 自动开 issue，不静默出产物。
 * 1. 值域：minimumPlan ⊆ {individual-go, individual-goat, individual-pro,
 *    individual-max, individual-provider}（新取值 = 官方调整档位体系，人工确认）；
 * 2. 产物非空（打掉「解析/过滤链路坏了还发布 0 模型」的静默风险）；
 * 3. Go 计数监控：individual-go 非隐藏条目数相对上次成功构建漂移 > ±5 → 人工复核，
 *    防批量套餐调整或坏数据静默通过。
 * 模态词表不再走断言：词表外模态由 clipInputModalities 裁剪后再进产物并记录日志/元数据
 * （issue #66：上游 advertise 超前于网关投递能力——file 模态当前无法经 /alpha/generate
 * 投递，实测见 docs/dev/spec/model-pipeline.md §1.1；裁剪而非失败，保住构建可用性）。
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

/**
 * §1.1 模态词表：网关可投递口径的当前词表。
 * 词表外模态不扩词表直接进产物：上游 advertise 超前于网关投递能力（issue #66 实测：
 * `file` 模态的正确 wire 形态 `document` 块网关协议层不转换，流内报 ModelMessage[]
 * schema 错误），广告出去只会放行后静默丢弃。扩词表的前置条件是
 * `scripts/probe-file-delivery.ts` 实测确认网关已支持投递。
 */
const ALLOWED_INPUT_MODALITIES = new Set(["text", "image"])

export interface ModalityClipResult {
  readonly entries: CatalogEntry[]
  /** 被裁掉的模态记录（modelId → 剥除的模态），无裁剪时为空 Map */
  readonly clips: ReadonlyMap<string, readonly string[]>
}

/**
 * 词表外模态裁剪（issue #66 定案）：只处理 Go 可见条目（与原断言的过滤口径一致），
 * 把 `inputModalities` 裁到 ALLOWED_INPUT_MODALITIES 内，返回新条目数组，不原地修改。
 * `inputModalities` 缺失的条目原样保留（缺字段由 emit 的 fail-fast 覆盖），
 * 非 Go 可见条目同理（不进产物，无需裁剪）。
 */
export function clipInputModalities(entries: readonly CatalogEntry[]): ModalityClipResult {
  const clips = new Map<string, readonly string[]>()
  const clipped = entries.map((entry) => {
    if (!isGoPlanVisible(entry)) return entry
    const modalities = entry.inputModalities
    if (modalities === undefined) return entry
    const kept: string[] = []
    const removed: string[] = []
    for (const modality of modalities) {
      if (ALLOWED_INPUT_MODALITIES.has(modality)) kept.push(modality)
      else removed.push(modality)
    }
    if (removed.length === 0) return entry
    clips.set(entry.id, removed)
    return { ...entry, inputModalities: kept }
  })
  return { entries: clipped, clips }
}

/**
 * file 模态扩散监控清单（全量 catalog 口径，不分档位 / hidden）：返回 inputModalities
 * 含 "file" 的条目 id，按字典序稳定排序。workflow 用计数变化决定是否开 issue 提醒复测
 * （阈值 >5，见 .github/workflows/models-pipeline.yml）；当前真实值见 issue #66
 * （meta/muse-ember 与 meta/muse-wonder-1.0）。
 */
export function listFileCapableModels(entries: readonly CatalogEntry[]): readonly string[] {
  return entries
    .filter((entry) => entry.inputModalities?.includes("file") ?? false)
    .map((entry) => entry.id)
    .sort()
}

export function runReconcile(assertions: ReadonlyArray<ReconcileFailure | undefined>): void {
  const failures = assertions.filter((failure): failure is ReconcileFailure => failure !== undefined)
  if (failures.length > 0) throw new ReconcileError(failures)
}

/**
 * 运行时三层级联合并（契约：docs/spec/model-pipeline.md §3）。
 *
 * 原则：**每字段单一天窗**，权威 = 离网关事实最近的来源，包内快照永远最后（§3 字段表）：
 * - 发现（暴露哪些 id）：API ∩ 产物层——产物拉取失败时快照顶替产物角色，交集规则
 *   不变（「快照兜发现时同规则」）；API 整体失败时发现退化为产物层 id 清单。
 * - `context` / `name`：API 权威（`context_length` 是网关实际执行值；name 同为
 *   API 字段），字段级缺失时逐级回落产物 → 快照。
 * - `efforts` / variants：产物层独供，无兜底链。
 * - `reasoning` / `inputModalities` / `maxOutput`：产物层权威；「快照」兜底由产物
 *   解析的整体弃用语义结构性保证——坏产物进不到本模块，只可能整层换成快照。
 * - `tool_call`：常量 `true`，在宿主消费映射（mapping.ts）落键。
 *
 * 纯函数、无 I/O：拉取、TTL、变更签名与降级重试归模型管线 II（#34）；本模块只把
 * 已解析的层合并成宿主消费映射的直接输入，并暴露产物层来源供降级日志注明退到了哪层。
 */

import type { ApiModelEntry } from "./api.js"
import type { Artifact } from "./artifact.js"

/**
 * 级联解析后的单模型：字段取值已定天窗，是宿主消费映射（mapping.ts）的直接输入。
 * 当前与 `ArtifactModel` 同构属有意为之——独立命名表达它是级联出口这个领域概念，
 * 将来 API 独有字段落进运行时（如模型自报能力）后两边分化。
 */
export interface ResolvedModel {
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
  readonly inputModalities: readonly string[]
  readonly efforts?: readonly string[]
  readonly context: number
  readonly maxOutput: number
}

export interface ModelLayers {
  /** `/provider/v1/models` 解析结果；缺省 = API 失败，发现退化为产物层 id 清单 */
  readonly api?: readonly ApiModelEntry[]
  /** 构建产物；缺省 = 拉取/解析失败，快照顶替产物角色 */
  readonly artifact?: Artifact
  /** 包内快照：与产物同 schema、随插件发版内置，永远可用 */
  readonly snapshot: Artifact
}

/** 产物角色由谁扮演——模型管线 II 的降级日志据此注明退到了哪层（§5） */
export type ProductLayer = "artifact" | "snapshot"

export interface CascadeResult {
  readonly models: readonly ResolvedModel[]
  readonly productLayer: ProductLayer
}

export function mergeModelLayers(layers: ModelLayers): CascadeResult {
  const product = layers.artifact ?? layers.snapshot
  const productLayer: ProductLayer = layers.artifact !== undefined ? "artifact" : "snapshot"
  const apiById =
    layers.api === undefined ? undefined : new Map(layers.api.map((entry) => [entry.id, entry]))

  const models: ResolvedModel[] = []
  // 顺序跟随产物层（官方目录序）：迭代产物条目并以 API 集合过滤，即「API 有产物无 →
  // 隐藏（已下架）」；「API 有产物无」的条目根本不进入本循环——可能是非 Go 档新模型，
  // 防止 403 漏到用户面前（暴露规则，保守）。
  for (const productModel of product.models) {
    const apiEntry = apiById?.get(productModel.id)
    if (apiById !== undefined && apiEntry === undefined) continue
    models.push({
      id: productModel.id,
      context: apiEntry?.contextLength ?? productModel.context,
      name: apiEntry?.name ?? productModel.name,
      reasoning: productModel.reasoning,
      inputModalities: productModel.inputModalities,
      ...(productModel.efforts !== undefined ? { efforts: productModel.efforts } : {}),
      maxOutput: productModel.maxOutput,
    })
  }
  return { models, productLayer }
}

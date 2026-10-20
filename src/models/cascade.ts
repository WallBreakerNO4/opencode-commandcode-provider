/**
 * 运行时三层级联合并（契约：docs/dev/spec/model-pipeline.md §3）。
 *
 * 原则：**每字段单一天窗**，权威 = 离网关事实最近的来源，包内快照永远最后（§3 字段表）：
 * - 发现（暴露哪些 id）：**产物全集**——产物拉取失败时快照顶替产物角色；catalog 不
 *   参与发现、不做交集过滤。上游已下架但产物尚未更新时条目照常注册（选中后由网关
 *   报错，与官方 CLI 用户承担一致的风险面）；官方标记 hidden / 非 Go 档的条目在
 *   构建侧已被过滤，不会进产物。
 * - `context` / `name`：client catalog 权威（`context_length` 是网关实际执行值；name
 *   同为 catalog 字段），字段级缺失时回落产物 → 快照。
 * - `efforts` / variants：产物层独供，无兜底链。
 * - `reasoning` / `inputModalities` / `maxOutput`：产物层权威；「快照」兜底由产物
 *   解析的整体弃用语义结构性保证——坏产物进不到本模块，只可能整层换成快照。
 * - `tool_call`：常量 `true`，在宿主消费映射（mapping.ts）落键。
 *
 * 纯函数、无 I/O：拉取、TTL、变更签名与降级重试归模型管线（pipeline.ts）；本模块只把
 * 已解析的层合并成宿主消费映射的直接输入，并暴露产物层来源供降级日志注明退到了哪层。
 */

import type { Artifact } from "./artifact.js"
import type { CatalogEntry } from "./catalog.js"

/**
 * 级联解析后的单模型：字段取值已定天窗，是宿主消费映射（mapping.ts）的直接输入。
 * 当前与 `ArtifactModel` 同构属有意为之——独立命名表达它是级联出口这个领域概念，
 * 将来 catalog 独有字段落进运行时后两边分化。
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
  /** `view=client` 解析结果；缺省 = catalog 失败，context/name 回落产物层 */
  readonly catalog?: readonly CatalogEntry[]
  /** 构建产物；缺省 = 拉取/解析失败，快照顶替产物角色 */
  readonly artifact?: Artifact
  /** 包内快照：与产物同 schema、随插件发版内置，永远可用 */
  readonly snapshot: Artifact
}

/** 产物角色由谁扮演——模型管线的降级日志据此注明退到了哪层（§5） */
export type ProductLayer = "artifact" | "snapshot"

export interface CascadeResult {
  readonly models: readonly ResolvedModel[]
  readonly productLayer: ProductLayer
}

export function mergeModelLayers(layers: ModelLayers): CascadeResult {
  const product = layers.artifact ?? layers.snapshot
  const productLayer: ProductLayer = layers.artifact !== undefined ? "artifact" : "snapshot"
  const catalogById =
    layers.catalog === undefined ? undefined : new Map(layers.catalog.map((entry) => [entry.id, entry]))

  const models: ResolvedModel[] = []
  // 发现 = 产物全集：顺序跟随产物层（官方目录序）；catalog 独有条目不注册
  for (const productModel of product.models) {
    const catalogEntry = catalogById?.get(productModel.id)
    models.push({
      id: productModel.id,
      context: catalogEntry?.contextLength ?? productModel.context,
      name: catalogEntry?.name ?? productModel.name,
      reasoning: productModel.reasoning,
      inputModalities: productModel.inputModalities,
      ...(productModel.efforts !== undefined ? { efforts: productModel.efforts } : {}),
      maxOutput: productModel.maxOutput,
    })
  }
  return { models, productLayer }
}

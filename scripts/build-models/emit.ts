/**
 * 构建产物组装（schema v1，规格 model-pipeline.md §1 逐项）：
 * 顶层 {schemaVersion, generatedAt, sourceCliVersion, catalogVersion?, models}；
 * per-model {id, name, reasoning, inputModalities, efforts?, context, maxOutput}。
 * 无价格字段（v1 明确砍掉）；efforts 无档位不写字段、不造空数组；reasoning 缺省
 * 显式写 false；同版本内只许新增可选字段——本文件是产物形状的唯一出口。
 * 运行时消费侧的解析与同形类型在 `src/models/artifact.ts`（跨构建/运行时边界
 * 独立定义），改 schema 时两边同步。
 */

import type { CatalogEntry } from "./bundle.ts"
import { isGoPlanVisible } from "./plan.ts"
import { resolveLimit, type LimitField, type LimitResolution } from "./limits.ts"
import type { ModelsDevLimits } from "./modelsdev.ts"

export interface ArtifactModel {
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
  readonly inputModalities: readonly string[]
  readonly efforts?: readonly string[]
  readonly context: number
  readonly maxOutput: number
}

export interface Artifact {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly sourceCliVersion: string
  /** view=client 远程 catalog 的版本号；旧产物无此字段，旧解析器按未知字段忽略 */
  readonly catalogVersion?: string
  readonly models: readonly ArtifactModel[]
}

export interface ProvenanceRecord {
  readonly modelId: string
  readonly field: LimitField
  readonly value: number
  readonly provenance: LimitResolution["provenance"]
  readonly source?: string
}

export interface BuildResult {
  readonly artifact: Artifact
  readonly provenance: readonly ProvenanceRecord[]
}

/**
 * 产物组装：catalog 入参是「view=client ∪ 内嵌目录补集」的合并结果，
 * 此处按官方 Go plan 判据过滤并组装；客户端不做过滤。
 */
export function buildArtifact(
  sourceCliVersion: string,
  catalogVersion: string,
  generatedAt: string,
  catalog: readonly CatalogEntry[],
  devLookup: (id: string) => ModelsDevLimits | undefined,
): BuildResult {
  const goEntries = catalog.filter(isGoPlanVisible)

  const models: ArtifactModel[] = []
  const provenance: ProvenanceRecord[] = []
  for (const entry of goEntries) {
    // name：catalog 的 name 字段（label 是同值备份，见元数据调研 §五字段表）
    const name = entry.name ?? entry.label
    if (name === undefined) {
      throw new Error(`模型「${entry.id}」catalog 条目缺 name/label——展示名为必填，拒绝猜值`)
    }
    // inputModalities：必填字段，缺失即上游结构变化
    if (entry.inputModalities === undefined) {
      throw new Error(`模型「${entry.id}」catalog 条目缺 inputModalities——必填字段缺失，拒绝以 ["text"] 猜值掩盖`)
    }
    // reasoning：catalog 缺省该字段的模型即非推理模型，显式写 false
    const reasoning = entry.reasoning ?? false

    const context = resolveLimit("context", entry, catalog, devLookup(entry.id))
    const maxOutput = resolveLimit("maxOutput", entry, catalog, devLookup(entry.id))
    provenance.push(
      { modelId: entry.id, field: "context", value: context.value, provenance: context.provenance, source: context.source },
      { modelId: entry.id, field: "maxOutput", value: maxOutput.value, provenance: maxOutput.provenance, source: maxOutput.source },
    )

    const model: ArtifactModel = {
      id: entry.id,
      name,
      reasoning,
      inputModalities: entry.inputModalities,
      // efforts：无档位不写字段（规格 §1.1），有则严格透传 catalog 词表（不做任何档位词过滤）
      ...(entry.reasoningEfforts !== undefined && entry.reasoningEfforts.length > 0
        ? { efforts: entry.reasoningEfforts }
        : {}),
      context: context.value,
      maxOutput: maxOutput.value,
    }
    models.push(model)
  }

  return {
    artifact: { schemaVersion: 1, generatedAt, sourceCliVersion, catalogVersion, models },
    provenance,
  }
}

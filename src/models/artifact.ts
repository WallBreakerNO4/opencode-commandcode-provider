/**
 * 构建产物 schema v1 的运行时解析（契约：docs/spec/model-pipeline.md §1）。
 *
 * 产物经分发渠道以 JSON 到达运行时（拉取与缓存归模型管线 II，#34），本模块只负责
 * 把未知形状的已解析 JSON 变成可信的 `Artifact`。三条硬规则：
 * - 同版本内只允许新增可选字段：未知字段一律忽略、不搬运进解析结果（向前兼容）；
 * - 遇到大于已知上限的 `schemaVersion`：整体弃用该产物（调用方降级到包内快照 +
 *   告警），不做多版本兼容解析（§1.2）；
 * - 必填字段缺失或类型不对：整个产物判 malformed 整体弃用，不做逐模型挑拣——
 *   快照 = 最后已知良好产物，坏产物宁可整层让位（§5 的产物级降级粒度）。
 *
 * 产物形状的唯一出口在构建侧 `scripts/build-models/emit.ts`（其 `Artifact` 类型
 * 为组装权威）；本文件为运行时侧独立定义——跨构建/运行时边界不共享编译单元，
 * 两处字段须保持逐键兼容，改 schema 时两边同步。
 */

import { asRecord } from "../protocol/json.js"

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
  readonly models: readonly ArtifactModel[]
}

/** 运行时已知的产物 schema 上限；上游破坏性变更递增版本号后此处随之上调 */
const KNOWN_ARTIFACT_SCHEMA_VERSION = 1

export type ArtifactParseResult =
  | { readonly ok: true; readonly artifact: Artifact }
  | { readonly ok: false; readonly error: ArtifactParseError }

export type ArtifactParseError =
  | { readonly reason: "future-version"; readonly schemaVersion: number }
  | { readonly reason: "malformed"; readonly detail: string }

export function parseArtifact(input: unknown): ArtifactParseResult {
  const root = asRecord(input)
  if (root === null) return malformed("顶层不是 JSON 对象")
  const version = root["schemaVersion"]
  if (typeof version !== "number" || !Number.isInteger(version)) return malformed("schemaVersion 必须是整数")
  if (version > KNOWN_ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, error: { reason: "future-version", schemaVersion: version } }
  }
  if (version !== KNOWN_ARTIFACT_SCHEMA_VERSION) return malformed(`schemaVersion ${version} 低于已知下限`)
  const generatedAt = root["generatedAt"]
  if (typeof generatedAt !== "string" || generatedAt.length === 0) return malformed("generatedAt 必须是非空字符串")
  const sourceCliVersion = root["sourceCliVersion"]
  if (typeof sourceCliVersion !== "string" || sourceCliVersion.length === 0) {
    return malformed("sourceCliVersion 必须是非空字符串")
  }
  const rawModels = root["models"]
  if (!Array.isArray(rawModels)) return malformed("models 必须是数组")

  const models: ArtifactModel[] = []
  const seen = new Set<string>()
  for (const [index, raw] of rawModels.entries()) {
    const entry = asRecord(raw)
    if (entry === null) return malformed(`models[${index}] 不是对象`)
    const id = entry["id"]
    if (typeof id !== "string" || id.length === 0) return malformed(`models[${index}].id 必须是非空字符串`)
    if (seen.has(id)) return malformed(`models[${index}].id「${id}」重复——id 是模型主键`)
    seen.add(id)
    const name = entry["name"]
    if (typeof name !== "string" || name.length === 0) return malformed(`models[${index}]「${id}」.name 必须是非空字符串`)
    const reasoning = entry["reasoning"]
    if (typeof reasoning !== "boolean") return malformed(`models[${index}]「${id}」.reasoning 必须是布尔`)
    const rawModalities = entry["inputModalities"]
    const inputModalities = asStringArray(rawModalities)
    if (inputModalities === null) return malformed(`models[${index}]「${id}」.inputModalities 必须是字符串数组`)
    const context = entry["context"]
    if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) {
      return malformed(`models[${index}]「${id}」.context 必须是正数`)
    }
    const maxOutput = entry["maxOutput"]
    if (typeof maxOutput !== "number" || !Number.isFinite(maxOutput) || maxOutput <= 0) {
      return malformed(`models[${index}]「${id}」.maxOutput 必须是正数`)
    }
    const rawEfforts = entry["efforts"]
    let efforts: readonly string[] | undefined
    if (rawEfforts !== undefined) {
      const parsed = asStringArray(rawEfforts)
      if (parsed === null) return malformed(`models[${index}]「${id}」.efforts 必须是字符串数组`)
      efforts = parsed
    }
    models.push({
      id,
      name,
      reasoning,
      inputModalities,
      // efforts 无档位不写字段，与构建侧出口形状逐键一致
      ...(efforts !== undefined ? { efforts } : {}),
      context,
      maxOutput,
    })
  }

  return {
    ok: true,
    artifact: {
      schemaVersion: 1,
      generatedAt,
      sourceCliVersion,
      models,
    },
  }
}

function malformed(detail: string): ArtifactParseResult {
  return { ok: false, error: { reason: "malformed", detail } }
}

/** 字符串数组守卫：非数组或含非字符串项返回 null（空数组合法——语义由调用方定） */
function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  return value.every((item) => typeof item === "string") ? (value as string[]) : null
}

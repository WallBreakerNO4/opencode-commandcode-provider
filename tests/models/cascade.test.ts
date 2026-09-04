import { describe, expect, test } from "bun:test"
import { mergeModelLayers } from "../../src/models/cascade.ts"
import type { Artifact, ArtifactModel } from "../../src/models/artifact.ts"
import type { ApiModelEntry } from "../../src/models/api.ts"

/** 手写包内快照 fixture（同产物 schema；构建流水线 #28 独立产出正式产物，不构成本票依赖） */
function artifactFrom(models: ArtifactModel[], generatedAt = "2026-09-01T00:00:00.000Z"): Artifact {
  return { schemaVersion: 1, generatedAt, sourceCliVersion: "1.45.0", models }
}

/** API 层 fixture：id/name/context_length 取自调研文档实测形状 */
const API: ApiModelEntry[] = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest)", contextLength: 1000000 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
  // API 有产物无：可能是非 Go 档新模型，应被保守隐藏（id 取真实在册模型）
  { id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 },
]

const ARTIFACT = artifactFrom([
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5 (v45)",
    reasoning: true,
    inputModalities: ["text", "image"],
    efforts: ["low", "high", "max"],
    context: 999000,
    maxOutput: 64000,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash (latest)",
    reasoning: false,
    inputModalities: ["text"],
    context: 1000000,
    maxOutput: 32000,
  },
  // 产物有 API 无：已下架，发现权威是 API，应被隐藏
  {
    id: "retired/model",
    name: "Retired Model",
    reasoning: false,
    inputModalities: ["text"],
    context: 128000,
    maxOutput: 8192,
  },
])

/** 快照 fixture：数据停在更早版本，字段值与产物可区分（用于证明取值来自哪一层） */
const SNAPSHOT = artifactFrom([
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    reasoning: true,
    inputModalities: ["text", "image"],
    efforts: ["high", "max"],
    context: 200000,
    maxOutput: 32000,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: false,
    inputModalities: ["text"],
    context: 128000,
    maxOutput: 32000,
  },
], "2026-08-01T00:00:00.000Z")

describe("三层级联合并（规格 model-pipeline.md §3：每字段单一天窗，包内快照永远最后）", () => {
  test("完整级联：API 只供发现 + context + name，产物供其余元数据", () => {
    const result = mergeModelLayers({ api: API, artifact: ARTIFACT, snapshot: SNAPSHOT })
    expect(result.productLayer).toBe("artifact")
    // 发现 = API ∩ 产物，顺序跟随产物层（官方目录序，稳定）
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek/deepseek-v4-flash"])

    const [claude, deepseek] = result.models
    // context：API 权威（网关实际执行值）——产物值 999000 不得生效
    expect(claude!.context).toBe(1000000)
    expect(deepseek!.context).toBe(1000000)
    // name：API 权威——产物「Claude Sonnet 5 (v45)」不得生效
    expect(claude!.name).toBe("Claude Sonnet 5")
    // efforts / reasoning / inputModalities / maxOutput：产物权威（API 无此数据）
    expect(claude!.efforts).toEqual(["low", "high", "max"])
    expect(claude!.reasoning).toBe(true)
    expect(claude!.inputModalities).toEqual(["text", "image"])
    expect(claude!.maxOutput).toBe(64000)
    expect(deepseek!.efforts).toBeUndefined() // 无档位模型不出现 efforts
    expect(deepseek!.reasoning).toBe(false)
    expect(deepseek!.maxOutput).toBe(32000)
  })

  test("暴露规则四交叉：API 有产物无 → 隐藏；产物有 API 无 → 隐藏；交集暴露", () => {
    const result = mergeModelLayers({ api: API, artifact: ARTIFACT, snapshot: SNAPSHOT })
    const ids = result.models.map((model) => model.id)
    // API 有（gpt-5.5）产物无 → 隐藏（防非 Go 档 403 漏出）
    expect(ids).not.toContain("gpt-5.5")
    // 产物有（retired/model）API 无 → 隐藏（已下架，发现权威是 API）
    expect(ids).not.toContain("retired/model")
    // 交集两者都在
    expect(ids).toContain("claude-sonnet-5")
    expect(ids).toContain("deepseek/deepseek-v4-flash")
  })

  test("API 失败：发现退化为产物 id 清单（含 API 不认识的产物条目），元数据全部取产物", () => {
    const result = mergeModelLayers({ artifact: ARTIFACT, snapshot: SNAPSHOT })
    expect(result.productLayer).toBe("artifact")
    expect(result.models.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "deepseek/deepseek-v4-flash",
      "retired/model",
    ])
    const claude = result.models[0]!
    // API 缺席：context / name 回落到产物值
    expect(claude.context).toBe(999000)
    expect(claude.name).toBe("Claude Sonnet 5 (v45)")
    expect(claude.efforts).toEqual(["low", "high", "max"])
  })

  test("产物失败：快照顶替产物角色——发现仍是 API ∩ 快照（同规则），元数据取快照", () => {
    const result = mergeModelLayers({ api: API, artifact: undefined, snapshot: SNAPSHOT })
    expect(result.productLayer).toBe("snapshot")
    // 快照里没有 gpt-5.5 → API 独有条目照旧隐藏；顺序跟随快照目录序
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek/deepseek-v4-flash"])
    const [claude, deepseek] = result.models
    // context/name：API 权威不变；efforts/reasoning/inputModalities/maxOutput 取快照
    expect(deepseek!.context).toBe(1000000)
    expect(deepseek!.name).toBe("DeepSeek V4 Flash (latest)")
    expect(deepseek!.maxOutput).toBe(32000)
    expect(claude!.efforts).toEqual(["high", "max"])
    expect(claude!.context).toBe(1000000)
    expect(claude!.maxOutput).toBe(32000)
  })

  test("全离线（API 与产物都失败）：快照全量注册照常可用，元数据全取快照", () => {
    const result = mergeModelLayers({ artifact: undefined, snapshot: SNAPSHOT })
    expect(result.productLayer).toBe("snapshot")
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek/deepseek-v4-flash"])
    const claude = result.models[0]!
    expect(claude.context).toBe(200000)
    expect(claude.name).toBe("Claude Sonnet 5")
    expect(claude.efforts).toEqual(["high", "max"])
    expect(claude.maxOutput).toBe(32000)
  })

  test("字段级兜底链：API 条目缺 name / context_length 时回落产物层（防御上游字段级缺失）", () => {
    const partialApi: ApiModelEntry[] = [
      { id: "claude-sonnet-5", contextLength: 1000000 }, // 缺 name
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest)" }, // 缺 context_length
    ]
    const result = mergeModelLayers({ api: partialApi, artifact: ARTIFACT, snapshot: SNAPSHOT })
    const [claude, deepseek] = result.models
    expect(claude!.name).toBe("Claude Sonnet 5 (v45)")
    expect(claude!.context).toBe(1000000)
    expect(deepseek!.name).toBe("DeepSeek V4 Flash (latest)")
    expect(deepseek!.context).toBe(1000000)
  })

  test("API 成功但返回空清单：与产物交集为空 → 零模型暴露（保守，不回退快照）", () => {
    const result = mergeModelLayers({ api: [], artifact: ARTIFACT, snapshot: SNAPSHOT })
    expect(result.models).toEqual([])
  })
})

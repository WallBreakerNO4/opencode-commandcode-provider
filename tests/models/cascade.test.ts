import { describe, expect, test } from "bun:test"
import { mergeModelLayers } from "../../src/models/cascade.ts"
import type { Artifact, ArtifactModel } from "../../src/models/artifact.ts"
import type { CatalogEntry } from "../../src/models/catalog.ts"

/** 手写包内快照 fixture（同产物 schema；构建流水线 #28 独立产出正式产物，不构成本票依赖） */
function artifactFrom(models: ArtifactModel[], generatedAt = "2026-09-01T00:00:00.000Z"): Artifact {
  return { schemaVersion: 1, generatedAt, sourceCliVersion: "1.45.0", models }
}

/** catalog 层 fixture：只承载 id / name / context_length（view=client 的运行时子集） */
const CATALOG: CatalogEntry[] = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest)", contextLength: 1000000 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
  // catalog 有产物无：非 Go 档/隐藏条目不会进产物，运行时也不注册
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
  // 产物有 catalog 无：上游已下架/尚未同步到远程 catalog——照常注册（产物全集）
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

describe("三层级联合并（规格 model-pipeline.md §3：产物全集注册，每字段单一天窗）", () => {
  test("完整级联：发现 = 产物全集；catalog 只供 context + name，产物供其余元数据", () => {
    const result = mergeModelLayers({ catalog: CATALOG, artifact: ARTIFACT, snapshot: SNAPSHOT })
    expect(result.productLayer).toBe("artifact")
    // 顺序跟随产物层（官方目录序，稳定）；catalog 不参与发现
    expect(result.models.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "deepseek/deepseek-v4-flash",
      "retired/model",
    ])

    const [claude, deepseek, retired] = result.models
    // context：catalog 权威（网关实际执行值）——产物值 999000 不得生效
    expect(claude!.context).toBe(1000000)
    expect(deepseek!.context).toBe(1000000)
    // name：catalog 权威——产物「Claude Sonnet 5 (v45)」不得生效
    expect(claude!.name).toBe("Claude Sonnet 5")
    // efforts / reasoning / inputModalities / maxOutput：产物权威（catalog 无此数据）
    expect(claude!.efforts).toEqual(["low", "high", "max"])
    expect(claude!.reasoning).toBe(true)
    expect(claude!.inputModalities).toEqual(["text", "image"])
    expect(claude!.maxOutput).toBe(64000)
    expect(deepseek!.efforts).toBeUndefined() // 无档位模型不出现 efforts
    expect(deepseek!.reasoning).toBe(false)
    expect(deepseek!.maxOutput).toBe(32000)
    // 产物有 catalog 无：照常注册，context/name 回落产物值
    expect(retired!.context).toBe(128000)
    expect(retired!.name).toBe("Retired Model")
  })

  test("发现规则：产物有 catalog 无 → 照常注册；catalog 有产物无 → 不注册", () => {
    const result = mergeModelLayers({ catalog: CATALOG, artifact: ARTIFACT, snapshot: SNAPSHOT })
    const ids = result.models.map((model) => model.id)
    // cat-jam 类情形：远程 catalog 未收录但产物（官方源码口径）有 → 用户可见
    expect(ids).toContain("retired/model")
    // catalog 独有条目（非 Go/隐藏）不会被产物全集带出来
    expect(ids).not.toContain("gpt-5.5")
  })

  test("catalog 失败：模型列表不缩水（仍是产物全集），context/name 回落产物值", () => {
    const result = mergeModelLayers({ artifact: ARTIFACT, snapshot: SNAPSHOT })
    expect(result.productLayer).toBe("artifact")
    expect(result.models.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "deepseek/deepseek-v4-flash",
      "retired/model",
    ])
    const claude = result.models[0]!
    expect(claude.context).toBe(999000)
    expect(claude.name).toBe("Claude Sonnet 5 (v45)")
    expect(claude.efforts).toEqual(["low", "high", "max"])
  })

  test("产物失败：快照顶替产物角色——发现 = 快照全集，context/name 仍取 catalog", () => {
    const result = mergeModelLayers({ catalog: CATALOG, artifact: undefined, snapshot: SNAPSHOT })
    expect(result.productLayer).toBe("snapshot")
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek/deepseek-v4-flash"])
    const [claude, deepseek] = result.models
    expect(deepseek!.context).toBe(1000000)
    expect(deepseek!.name).toBe("DeepSeek V4 Flash (latest)")
    expect(deepseek!.maxOutput).toBe(32000)
    expect(claude!.efforts).toEqual(["high", "max"])
    expect(claude!.context).toBe(1000000)
    expect(claude!.maxOutput).toBe(32000)
  })

  test("全离线（catalog 与产物都失败）：快照全量注册照常可用，元数据全取快照", () => {
    const result = mergeModelLayers({ artifact: undefined, snapshot: SNAPSHOT })
    expect(result.productLayer).toBe("snapshot")
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek/deepseek-v4-flash"])
    const claude = result.models[0]!
    expect(claude.context).toBe(200000)
    expect(claude.name).toBe("Claude Sonnet 5")
    expect(claude.efforts).toEqual(["high", "max"])
    expect(claude.maxOutput).toBe(32000)
  })

  test("字段级兜底链：catalog 条目缺 name / context_length 时回落产物层（防御上游字段级缺失）", () => {
    const partialCatalog: CatalogEntry[] = [
      { id: "claude-sonnet-5", contextLength: 1000000 }, // 缺 name
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest)" }, // 缺 context_length
    ]
    const result = mergeModelLayers({ catalog: partialCatalog, artifact: ARTIFACT, snapshot: SNAPSHOT })
    const [claude, deepseek] = result.models
    expect(claude!.name).toBe("Claude Sonnet 5 (v45)")
    expect(claude!.context).toBe(1000000)
    expect(deepseek!.name).toBe("DeepSeek V4 Flash (latest)")
    expect(deepseek!.context).toBe(1000000)
  })

  test("catalog 成功但返回空清单：产物全集照常注册，context/name 回落产物值", () => {
    const result = mergeModelLayers({ catalog: [], artifact: ARTIFACT, snapshot: SNAPSHOT })
    expect(result.models.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "deepseek/deepseek-v4-flash",
      "retired/model",
    ])
    expect(result.models[0]!.context).toBe(999000)
    expect(result.models[0]!.name).toBe("Claude Sonnet 5 (v45)")
  })
})

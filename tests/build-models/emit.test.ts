import { describe, expect, test } from "bun:test"
import type { CatalogEntry } from "../../scripts/build-models/bundle.ts"
import { buildArtifact } from "../../scripts/build-models/emit.ts"
import type { ModelsDevLimits } from "../../scripts/build-models/modelsdev.ts"
import { isGoPlanVisible } from "../../scripts/build-models/plan.ts"

const CATALOG: CatalogEntry[] = [
  {
    id: "deepseek/deepseek-v4-pro",
    minimumPlan: "individual-go",
    name: "DeepSeek V4 Pro (latest)",
    reasoning: true,
    reasoningEfforts: ["high", "max"],
    contextWindow: 1000000,
    inputModalities: ["text", "image"],
  },
  // GLM-5.1：reasoning 缺省（显式 false）、无档位（不写 efforts）、context 缺（走 family/models-dev）
  { id: "zai-org/GLM-5.1", minimumPlan: "individual-go", name: "GLM-5.1", inputModalities: ["text"] },
  { id: "zai-org/GLM-5", minimumPlan: "individual-max", name: "GLM-5", reasoning: false, inputModalities: ["text"], contextWindow: 200000 },
  { id: "claude-opus-5", minimumPlan: "individual-max", name: "Claude Opus 5", reasoning: true, inputModalities: ["text"], contextWindow: 200000 },
  // 内嵌目录补集：远程 catalog 未收录，但 Go 档非隐藏 → 必须进产物
  {
    id: "stealth/cat-jam:free",
    minimumPlan: "individual-go",
    name: "Cat Jam",
    inputModalities: ["text"],
    contextWindow: 200000,
    hidden: false,
    badge: "free",
  },
  // Go 档但 hidden：不进产物（官方选择器也不展示）
  { id: "stealth/hidden-jam:free", minimumPlan: "individual-go", hidden: true, name: "Hidden Jam", inputModalities: ["text"] },
  // 无 minimumPlan（旧形状 / 结构漂移）：不可判定 Go，不进产物
  { id: "legacy/no-plan", name: "Legacy", inputModalities: ["text"] },
]

const DEV = (id: string): ModelsDevLimits | undefined =>
  id === "zai-org/GLM-5.1" ? { output: 65536, source: "zai/glm-5.1" } : undefined

describe("产物组装（schema v1 逐项，无价格字段）", () => {
  const { artifact, provenance } = buildArtifact(
    "1.84.0",
    "d6177bab",
    "2026-09-03T00:00:00.000Z",
    CATALOG,
    DEV,
  )

  test("顶层：schemaVersion/generatedAt/sourceCliVersion/catalogVersion/models", () => {
    expect(artifact.schemaVersion).toBe(1)
    expect(artifact.generatedAt).toBe("2026-09-03T00:00:00.000Z")
    expect(artifact.sourceCliVersion).toBe("1.84.0")
    expect(artifact.catalogVersion).toBe("d6177bab")
    expect(Object.keys(artifact).sort()).toEqual([
      "catalogVersion",
      "generatedAt",
      "models",
      "schemaVersion",
      "sourceCliVersion",
    ])
  })

  test("Go plan 过滤：minimumPlan === individual-go 且 hidden !== true", () => {
    expect(artifact.models.map((model) => model.id)).toEqual([
      "deepseek/deepseek-v4-pro",
      "zai-org/GLM-5.1",
      "stealth/cat-jam:free",
    ])
    expect(isGoPlanVisible(CATALOG[0]!)).toBe(true)
    expect(isGoPlanVisible(CATALOG[2]!)).toBe(false) // 非 Go 档
    expect(isGoPlanVisible(CATALOG[5]!)).toBe(false) // hidden
    expect(isGoPlanVisible(CATALOG[6]!)).toBe(false) // 无 minimumPlan
  })

  test("per-model 字段逐项（spec §1.1）：无 efforts 字段 / reasoning 显式 false / 无价格字段", () => {
    const [pro, glm] = artifact.models
    expect(Object.keys(pro!).sort()).toEqual(["context", "efforts", "id", "inputModalities", "maxOutput", "name", "reasoning"])
    expect(pro).toMatchObject({
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro (latest)",
      reasoning: true,
      inputModalities: ["text", "image"],
      efforts: ["high", "max"], // 严格透传 catalog 词表
      context: 1000000,
      maxOutput: 32000,
    })
    // 缺档位的模型：efforts 字段整个不出现（不造空数组）
    expect(Object.keys(glm!).sort()).toEqual(["context", "id", "inputModalities", "maxOutput", "name", "reasoning"])
    expect(glm!.reasoning).toBe(false) // catalog 缺省 → 显式 false
    // 整个产物无任何价格键
    expect(JSON.stringify(artifact)).not.toContain("cost")
    expect(JSON.stringify(artifact)).not.toContain("price")
  })

  test("limits 补全链 + provenance 进记录", () => {
    const glm = artifact.models[1]!
    // context：catalog 缺 → family（zai-org/GLM）；maxOutput：family 无供体 → models-dev
    expect(glm.context).toBe(200000)
    expect(glm.maxOutput).toBe(65536)
    const glmRecords = provenance.filter((record) => record.modelId === "zai-org/GLM-5.1")
    expect(glmRecords).toContainEqual({ modelId: "zai-org/GLM-5.1", field: "context", value: 200000, provenance: "family", source: "zai-org/GLM-5" })
    expect(glmRecords).toContainEqual({ modelId: "zai-org/GLM-5.1", field: "maxOutput", value: 65536, provenance: "models-dev", source: "zai/glm-5.1" })
    // 每模型两值全有 provenance
    expect(provenance).toHaveLength(artifact.models.length * 2)
  })

  test("fail-fast：Go 档条目缺 name / inputModalities 即抛错", () => {
    const noName: CatalogEntry[] = [{ id: "ghost/model", minimumPlan: "individual-go", inputModalities: ["text"] }]
    expect(() => buildArtifact("1", "c", "t", noName, DEV)).toThrow(/name\/label/)
    const noModality: CatalogEntry[] = [{ id: "ghost/model", minimumPlan: "individual-go", name: "Ghost" }]
    expect(() => buildArtifact("1", "c", "t", noModality, DEV)).toThrow(/inputModalities/)
  })
})

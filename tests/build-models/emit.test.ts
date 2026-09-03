import { describe, expect, test } from "bun:test"
import type { CatalogEntry } from "../../scripts/build-models/bundle.ts"
import { buildArtifact } from "../../scripts/build-models/emit.ts"
import type { ModelsMdRow } from "../../scripts/build-models/models-md.ts"
import type { ModelsDevLimits } from "../../scripts/build-models/modelsdev.ts"

const MD_ROWS: ModelsMdRow[] = [
  { id: "deepseek/deepseek-v4-pro", minPlanRaw: "Go and above", minPlan: "Go" },
  { id: "zai-org/GLM-5.1", minPlanRaw: "Go and above", minPlan: "Go" },
  { id: "claude-opus-5", minPlanRaw: "Max", minPlan: "Max" }, // 非 Go 档：不进产物
]

const CATALOG: CatalogEntry[] = [
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro (latest)",
    reasoning: true,
    reasoningEfforts: ["high", "max"],
    contextWindow: 1000000,
    inputModalities: ["text", "image"],
  },
  // GLM-5.1：reasoning 缺省（显式 false）、无档位（不写 efforts）、context 缺（走 family/models-dev）
  { id: "zai-org/GLM-5.1", name: "GLM-5.1", inputModalities: ["text"] },
  { id: "zai-org/GLM-5", name: "GLM-5", reasoning: false, inputModalities: ["text"], contextWindow: 200000 },
  { id: "claude-opus-5", name: "Claude Opus 5", reasoning: true, inputModalities: ["text"], contextWindow: 200000 },
]

const DEV = (id: string): ModelsDevLimits | undefined =>
  id === "zai-org/GLM-5.1" ? { output: 65536, source: "zai/glm-5.1" } : undefined

describe("产物组装（schema v1 逐项，无价格字段）", () => {
  const { artifact, provenance } = buildArtifact("1.45.0", "2026-09-03T00:00:00.000Z", MD_ROWS, CATALOG, DEV)

  test("顶层：schemaVersion/generatedAt/sourceCliVersion/models 四键", () => {
    expect(artifact.schemaVersion).toBe(1)
    expect(artifact.generatedAt).toBe("2026-09-03T00:00:00.000Z")
    expect(artifact.sourceCliVersion).toBe("1.45.0")
    expect(Object.keys(artifact).sort()).toEqual(["generatedAt", "models", "schemaVersion", "sourceCliVersion"])
  })

  test("Go plan 过滤：只保留 normalize == Go 的模型", () => {
    expect(artifact.models.map((model) => model.id)).toEqual(["deepseek/deepseek-v4-pro", "zai-org/GLM-5.1"])
  })

  test("per-model 字段逐项（spec §1.1）：无 efforts 字段 / reasoning 显式 false / 无价格字段", () => {
    const [pro, glm] = artifact.models
    expect(Object.keys(pro!).sort()).toEqual(["context", "efforts", "id", "inputModalities", "maxOutput", "name", "reasoning"])
    expect(pro).toMatchObject({
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro (latest)",
      reasoning: true,
      inputModalities: ["text", "image"],
      efforts: ["high", "max"], // 严格透传 bundle 词表
      context: 1000000,
      maxOutput: 32000,
    })
    // 缺档位的模型：efforts 字段整个不出现（不造空数组）
    expect(Object.keys(glm!).sort()).toEqual(["context", "id", "inputModalities", "maxOutput", "name", "reasoning"])
    expect(glm!.reasoning).toBe(false) // bundle 缺省 → 显式 false
    // 整个产物无任何价格键
    expect(JSON.stringify(artifact)).not.toContain("cost")
    expect(JSON.stringify(artifact)).not.toContain("price")
  })

  test("limits 补全链 + provenance 进记录", () => {
    const glm = artifact.models[1]!
    // context：bundle 缺 → family（zai-org/GLM）；maxOutput：family 无供体 → models-dev
    expect(glm.context).toBe(200000)
    expect(glm.maxOutput).toBe(65536)
    const glmRecords = provenance.filter((record) => record.modelId === "zai-org/GLM-5.1")
    expect(glmRecords).toContainEqual({ modelId: "zai-org/GLM-5.1", field: "context", value: 200000, provenance: "family", source: "zai-org/GLM-5" })
    expect(glmRecords).toContainEqual({ modelId: "zai-org/GLM-5.1", field: "maxOutput", value: 65536, provenance: "models-dev", source: "zai/glm-5.1" })
    // 每模型两值全有 provenance
    expect(provenance).toHaveLength(artifact.models.length * 2)
  })

  test("fail-fast：Go 档模型缺 bundle 条目 / 缺必填字段即抛错", () => {
    const rows: ModelsMdRow[] = [{ id: "ghost/model", minPlanRaw: "Go and above", minPlan: "Go" }]
    expect(() => buildArtifact("1", "t", rows, CATALOG, DEV)).toThrow(/bundle 目录缺少/)
    const noName: CatalogEntry[] = [{ id: "ghost/model", inputModalities: ["text"] }]
    expect(() => buildArtifact("1", "t", rows, noName, DEV)).toThrow(/name\/label/)
    const noModality: CatalogEntry[] = [{ id: "ghost/model", name: "Ghost" }]
    expect(() => buildArtifact("1", "t", rows, noModality, DEV)).toThrow(/inputModalities/)
  })
})

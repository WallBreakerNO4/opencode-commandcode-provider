import { describe, expect, test } from "bun:test"
import { parseArtifact } from "../../src/models/artifact.ts"

describe("构建产物解析（schema v1，规格 model-pipeline.md §1）", () => {
  test("合法 v1 产物：顶层与 per-model 键逐项落位，无档位不写 efforts、无价格字段", () => {
    const result = parseArtifact({
      schemaVersion: 1,
      generatedAt: "2026-09-03T00:00:00.000Z",
      sourceCliVersion: "1.45.0",
      models: [
        {
          id: "deepseek/deepseek-v4-flash",
          name: "DeepSeek V4 Flash (latest)",
          reasoning: true,
          inputModalities: ["text", "image"],
          efforts: ["high", "max"],
          context: 1000000,
          maxOutput: 32000,
        },
        {
          id: "zai-org/GLM-5.1",
          name: "GLM-5.1",
          reasoning: false,
          inputModalities: ["text"],
          context: 200000,
          maxOutput: 32000,
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { artifact } = result
    expect(artifact.schemaVersion).toBe(1)
    expect(artifact.generatedAt).toBe("2026-09-03T00:00:00.000Z")
    expect(artifact.sourceCliVersion).toBe("1.45.0")
    expect(Object.keys(artifact).sort()).toEqual(["generatedAt", "models", "schemaVersion", "sourceCliVersion"])
    const [deepseek, glm] = artifact.models
    expect(Object.keys(deepseek!).sort()).toEqual([
      "context",
      "efforts",
      "id",
      "inputModalities",
      "maxOutput",
      "name",
      "reasoning",
    ])
    expect(deepseek).toEqual({
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash (latest)",
      reasoning: true,
      inputModalities: ["text", "image"],
      efforts: ["high", "max"],
      context: 1000000,
      maxOutput: 32000,
    })
    // 缺档位的模型：efforts 字段整个不存在（不造空数组），同构建侧出口形状一致
    expect(Object.keys(glm!).sort()).toEqual([
      "context",
      "id",
      "inputModalities",
      "maxOutput",
      "name",
      "reasoning",
    ])
    expect(JSON.stringify(artifact)).not.toContain("cost")
    expect(JSON.stringify(artifact)).not.toContain("price")
  })

  test("未知字段忽略并剥除（向前兼容，§1.2）：顶层与 per-model 附加键都不进解析结果", () => {
    // 渠道特有概念 / 将来以可选字段回归的价格键，老客户端一律无视
    const result = parseArtifact({
      schemaVersion: 1,
      generatedAt: "2026-09-03T00:00:00.000Z",
      sourceCliVersion: "1.45.0",
      releaseTag: "v2026.09.03", // 未知顶层键
      models: [
        {
          id: "deepseek/deepseek-v4-flash",
          name: "DeepSeek V4 Flash (latest)",
          reasoning: true,
          inputModalities: ["text"],
          context: 1000000,
          maxOutput: 32000,
          cost: { input: 3, output: 15 }, // v1 无价格字段：出现即忽略
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact).sort()).toEqual(["generatedAt", "models", "schemaVersion", "sourceCliVersion"])
    expect(Object.keys(result.artifact.models[0]!).sort()).toEqual([
      "context",
      "id",
      "inputModalities",
      "maxOutput",
      "name",
      "reasoning",
    ])
  })

  test("schemaVersion 大于已知上限：整体弃用该产物，不做多版本兼容解析（§1.2）", () => {
    const result = parseArtifact({
      schemaVersion: 2,
      generatedAt: "2026-09-03T00:00:00.000Z",
      sourceCliVersion: "1.45.0",
      models: [],
    })
    expect(result).toEqual({ ok: false, error: { reason: "future-version", schemaVersion: 2 } })
  })

  test("schemaVersion 不是整数或低于下限：malformed", () => {
    for (const version of [0, -1, 1.5, "1", null, undefined]) {
      const result = parseArtifact({
        schemaVersion: version,
        generatedAt: "2026-09-03T00:00:00.000Z",
        sourceCliVersion: "1.45.0",
        models: [],
      })
      expect(result.ok).toBe(false)
      if (result.ok === false) expect(result.error.reason).toBe("malformed")
    }
  })

  test("per-model 畸形矩阵：必填字段缺失 / 类型不对 / id 重复 → 整体 malformed（不做逐模型挑拣）", () => {
    const good = {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash (latest)",
      reasoning: true,
      inputModalities: ["text"],
      context: 1000000,
      maxOutput: 32000,
    }
    const wrap = (models: unknown) => ({
      schemaVersion: 1,
      generatedAt: "2026-09-03T00:00:00.000Z",
      sourceCliVersion: "1.45.0",
      models,
    })
    const malformedModels: unknown[] = [
      good, // models 不是数组（元素直接当 models）
      [null],
      ["不是对象"],
      [{ ...good, id: "" }],
      [{ ...good, id: 42 }],
      [{ ...good, name: undefined }],
      [{ ...good, name: "" }],
      [{ ...good, reasoning: "yes" }],
      [{ ...good, inputModalities: "text" }],
      [{ ...good, inputModalities: ["text", 42] }],
      [{ ...good, context: 0 }],
      [{ ...good, context: "1M" }],
      [{ ...good, maxOutput: -1 }],
      [{ ...good, efforts: "high" }],
      [{ ...good, efforts: ["high", 42] }],
    ]
    for (const models of malformedModels) {
      const result = parseArtifact(wrap(models))
      expect(result.ok).toBe(false)
      if (result.ok === false) expect(result.error.reason).toBe("malformed")
    }
    // 顶层不是对象
    expect(parseArtifact("不是对象").ok).toBe(false)
    // id 重复 → malformed
    expect(parseArtifact(wrap([good, good])).ok).toBe(false)
  })

  test("空 models 数组合法：零模型产物可用（暴露规则会得到空清单，属保守行为）", () => {
    const result = parseArtifact({
      schemaVersion: 1,
      generatedAt: "2026-09-03T00:00:00.000Z",
      sourceCliVersion: "1.45.0",
      models: [],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.artifact.models).toEqual([])
  })
})

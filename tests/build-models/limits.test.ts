import { describe, expect, test } from "bun:test"
import type { CatalogEntry } from "../../scripts/build-models/bundle.ts"
import { FALLBACK_CONTEXT, FALLBACK_MAX_OUTPUT, familyKeys, resolveLimit } from "../../scripts/build-models/limits.ts"
import type { ModelsDevLimits } from "../../scripts/build-models/modelsdev.ts"

const CATALOG: CatalogEntry[] = [
  { id: "zai-org/GLM-5", contextWindow: 200000 }, // 无 maxOutputTokens：GLM-5.1 的 maxOutput 须落到 models-dev
  { id: "zai-org/GLM-5.2", contextWindow: 1000000 },
  { id: "zai-org/GLM-5.1" }, // 双缺：context 走 family，maxOutput 继续走链
  { id: "Qwen/Qwen3.6-Plus" }, // Qwen3.6 同代无供体，须借到 Qwen3 一级
  { id: "Qwen/Qwen3.8-27B", contextWindow: 262144, maxOutputTokens: 32768 },
  { id: "tencent/hy3-paid", contextWindow: 262144 },
  { id: "orphan/model-x" }, // 无 family 供体 → models-dev / 常量
]

describe("limits 补全链（bundle → family → models-dev → constant）+ provenance", () => {
  test("第 1 级：bundle 值直接命中", () => {
    expect(resolveLimit("context", CATALOG[0]!, CATALOG, undefined)).toEqual({
      field: "context",
      value: 200000,
      provenance: "bundle",
    })
  })

  test("第 2 级：同 family 借用（最长前缀优先，供体确定性，来源可审计）", () => {
    // zai-org/GLM-5.1 → family 键 zai-org/GLM 命中 GLM-5（GLM-5.2 在更长键 zai-org/GLM-5 上无值）
    const context = resolveLimit("context", CATALOG[2]!, CATALOG, undefined)
    expect(context).toEqual({ field: "context", value: 200000, provenance: "family", source: "zai-org/GLM-5" })
    // Qwen/Qwen3.6-Plus：Qwen3.6 同代只有自己（双缺）→ 缩到 Qwen3 借 Qwen3.8-27B
    expect(resolveLimit("context", CATALOG[3]!, CATALOG, undefined)).toEqual({
      field: "context",
      value: 262144,
      provenance: "family",
      source: "Qwen/Qwen3.8-27B",
    })
  })

  test("第 3 级：models.dev（context 与 maxOutput 可来自不同位置）", () => {
    const dev: ModelsDevLimits = { context: 204800, output: 65536, source: "zai/glm-5.1" }
    expect(resolveLimit("maxOutput", CATALOG[2]!, CATALOG, dev)).toEqual({
      field: "maxOutput",
      value: 65536,
      provenance: "models-dev",
      source: "zai/glm-5.1",
    })
  })

  test("第 4 级：常量兜底（200000 / 32000）", () => {
    // Qwen/Qwen3.6-Plus 双缺 + 空目录（无 family 供体、无 models-dev）
    expect(resolveLimit("context", CATALOG[3]!, [], undefined)).toEqual({
      field: "context",
      value: FALLBACK_CONTEXT,
      provenance: "constant",
    })
    expect(resolveLimit("maxOutput", CATALOG[3]!, [], undefined)).toEqual({
      field: "maxOutput",
      value: FALLBACK_MAX_OUTPUT,
      provenance: "constant",
    })
    expect(FALLBACK_CONTEXT).toBe(200000)
    expect(FALLBACK_MAX_OUTPUT).toBe(32000)
  })

  test("family 借用只看 bundle 值，不传递（防编造值成链）", () => {
    // 家族里只有「自己也没值」的成员时，借用必须落空继续走链，而不是借别人借来的值
    const catalog: CatalogEntry[] = [
      { id: "fam/a" },
      { id: "fam/a-b", contextWindow: 1000 },
      { id: "fam/a-c" },
    ]
    expect(resolveLimit("context", catalog[2]!, catalog, undefined).provenance).toBe("family")
    const noDonor: CatalogEntry[] = [
      { id: "fam/a" },
      { id: "fam/a-b" }, // 无 bundle 值
    ]
    expect(resolveLimit("context", noDonor[0]!, noDonor, undefined).provenance).not.toBe("family")
  })

  test("familyKeys：同 vendor 按「-」「.」逐级缩短，vendor 本身收尾", () => {
    expect(familyKeys("zai-org/GLM-5.1")).toEqual(["zai-org/GLM-5.1", "zai-org/GLM-5", "zai-org/GLM", "zai-org"])
    expect(familyKeys("Qwen/Qwen3.6-Plus")).toEqual([
      "Qwen/Qwen3.6-Plus",
      "Qwen/Qwen3.6",
      "Qwen/Qwen3",
      "Qwen",
    ])
    expect(familyKeys("claude-sonnet-5")).toEqual(["claude-sonnet-5", "claude-sonnet", "claude"])
  })
})

import { describe, expect, test } from "bun:test"
import type { CatalogEntry } from "../../scripts/build-models/bundle.ts"
import type { ModelsMdRow } from "../../scripts/build-models/models-md.ts"
import {
  assertArtifactNonEmpty,
  assertDistributionStable,
  assertEffortsConsistency,
  assertIdsSubset,
  assertModalityVocabulary,
  assertPlanValueDomain,
  MAX_PLAN_DISTRIBUTION_DRIFT,
  ReconcileError,
  runReconcile,
} from "../../scripts/build-models/reconcile.ts"

function row(id: string, minPlan: ModelsMdRow["minPlan"], minPlanRaw = minPlan, efforts?: string[]): ModelsMdRow {
  return { id, minPlanRaw, minPlan, ...(efforts !== undefined ? { efforts } : {}) }
}

describe("对账断言（任一失败 = 构建失败 + 开 issue，不静默出产物）", () => {
  test("值域断言：normalize 值 ⊆ {Go,GOAT,Pro,Max}，新取值即失败", () => {
    expect(assertPlanValueDomain([row("a", "Go"), row("b", "Max")])).toBeUndefined()
    // 模拟「新套餐取值」：normalize 结果不在词表内（parse 层会先产出这种行）
    const failure = assertPlanValueDomain([{ id: "a", minPlanRaw: "Ultra and above", minPlan: "Ultra" as ModelsMdRow["minPlan"] }])
    expect(failure?.assertion).toBe("Min plan 值域")
    expect(failure?.detail).toContain("Ultra and above")
  })

  test("id 子集断言：产物 id 不在 API 清单即失败并列出缺失", () => {
    expect(assertIdsSubset(["a", "b"], new Set(["a", "b", "c"]))).toBeUndefined()
    const failure = assertIdsSubset(["a", "MiniMaxAI/MiniMax-M3-Free"], new Set(["a"]))
    expect(failure?.assertion).toBe("产物 id ⊆ /models API id 集合")
    expect(failure?.detail).toContain("MiniMaxAI/MiniMax-M3-Free")
  })

  test("非空断言：空产物必失败（首次构建无分布基线时的 0 模型防线）", () => {
    expect(assertArtifactNonEmpty(["a"])).toBeUndefined()
    expect(assertArtifactNonEmpty([])?.assertion).toBe("产物非空")
  })

  test("分布监控：与上次成功构建比，漂移 ≤ 阈值通过、> 阈值失败", () => {
    const prev = { Go: 40, GOAT: 4, Pro: 13, Max: 5 }
    // 正常发版漂移（±2）不阻塞 30 分钟 SLA
    expect(assertDistributionStable({ Go: 42, GOAT: 6, Pro: 13, Max: 5 }, prev)).toBeUndefined()
    expect(MAX_PLAN_DISTRIBUTION_DRIFT).toBe(5)
    // 恰在阈值上通过
    expect(assertDistributionStable({ Go: 45, GOAT: 4, Pro: 13, Max: 5 }, prev)).toBeUndefined()
    // 跳变（解析器坏列 / 批量套餐调整）失败
    const breach = assertDistributionStable({ Go: 0, GOAT: 4, Pro: 13, Max: 5 }, prev)
    expect(breach?.assertion).toBe("Min plan 分布监控")
    expect(breach?.detail).toContain("Go -40")
    // 首次构建（无基线）跳过
    expect(assertDistributionStable({ Go: 0, GOAT: 0, Pro: 0, Max: 0 }, undefined)).toBeUndefined()
  })

  test("Efforts 逐值一致：两处都有值必须相等，单边缺失不触发", () => {
    const catalog: CatalogEntry[] = [
      { id: "a", reasoningEfforts: ["high", "max"] },
      { id: "b", reasoningEfforts: ["low"] },
    ]
    const rows: ModelsMdRow[] = [
      { id: "a", minPlanRaw: "Go and above", minPlan: "Go", efforts: ["high", "max"] },
      { id: "b", minPlanRaw: "Go and above", minPlan: "Go", efforts: ["low", "high"] },
      { id: "c", minPlanRaw: "Go and above", minPlan: "Go", efforts: ["high"] }, // bundle 无 efforts（单边）
    ]
    const failure = assertEffortsConsistency(rows, catalog)
    expect(failure?.assertion).toBe("Efforts 逐值一致")
    expect(failure?.detail).toContain("b")
    expect(failure?.detail).not.toContain("a：") // a 一致
    expect(failure?.detail).not.toContain("c") // 单边不触发
    expect(assertEffortsConsistency([{ id: "b", minPlanRaw: "Go and above", minPlan: "Go" }], catalog)).toBeUndefined()
  })

  test("模态词表：词表外模态必须人工裁决（新模态 = 网关投递能力未经验证）", () => {
    const catalog: CatalogEntry[] = [
      { id: "a", inputModalities: ["text", "image"] },
      { id: "b", inputModalities: ["text"] },
      { id: "c", inputModalities: ["text", "audio"] },
    ]
    const goRows: ModelsMdRow[] = [
      { id: "a", minPlanRaw: "Go and above", minPlan: "Go" },
      { id: "b", minPlanRaw: "Go and above", minPlan: "Go" },
    ]
    expect(assertModalityVocabulary(goRows, catalog)).toBeUndefined()
    const failure = assertModalityVocabulary(
      [...goRows, { id: "c", minPlanRaw: "Go and above", minPlan: "Go" }],
      catalog,
    )
    expect(failure?.assertion).toBe("inputModalities 词表")
    expect(failure?.detail).toContain("audio")
    // 非 Go 档不进产物，词表外模态不影响
    const nonGo: ModelsMdRow[] = [{ id: "c", minPlanRaw: "Max", minPlan: "Max" }]
    expect(assertModalityVocabulary(nonGo, catalog)).toBeUndefined()
  })

  test("runReconcile：聚合全部失败一次性抛出（开 issue 信息给全）", () => {
    expect(() => runReconcile([undefined, undefined])).not.toThrow()
    try {
      runReconcile([
        assertPlanValueDomain([{ id: "a", minPlanRaw: "Ultra and above", minPlan: "Ultra" as ModelsMdRow["minPlan"] }]),
        assertIdsSubset(["x"], new Set()),
        assertArtifactNonEmpty(["x"]),
        undefined,
      ])
      throw new Error("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(ReconcileError)
      const reconcile = error as ReconcileError
      expect(reconcile.failures).toHaveLength(2)
      expect(reconcile.message).toContain("2 项")
      expect(reconcile.message).toContain("值域")
      expect(reconcile.message).toContain("⊆")
    }
  })
})

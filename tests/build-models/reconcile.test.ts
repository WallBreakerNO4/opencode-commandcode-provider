import { describe, expect, test } from "bun:test"
import type { CatalogEntry } from "../../scripts/build-models/bundle.ts"
import {
  assertArtifactNonEmpty,
  assertGoCountStable,
  assertModalityVocabulary,
  assertPlanValueDomain,
  MAX_GO_COUNT_DRIFT,
  PLAN_VALUES,
  ReconcileError,
  runReconcile,
} from "../../scripts/build-models/reconcile.ts"

function entry(id: string, minimumPlan?: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return { id, ...(minimumPlan === undefined ? {} : { minimumPlan }), ...extra }
}

describe("对账断言（任一失败 = 构建失败 + 开 issue，不静默出产物）", () => {
  test("值域断言：individual-{go,goat,pro,max,provider} 五值合法，词表外新值即失败并聚合明细", () => {
    expect(PLAN_VALUES).toEqual([
      "individual-go",
      "individual-goat",
      "individual-pro",
      "individual-max",
      "individual-provider",
    ])
    expect(
      assertPlanValueDomain(PLAN_VALUES.map((plan, index) => entry(`m${index}`, plan))),
    ).toBeUndefined()
    // 旧形状条目没有 minimumPlan：不参与值域判定（也进不了 Go 过滤）
    expect(assertPlanValueDomain([entry("legacy")])).toBeUndefined()

    // 新套餐取值：同值聚合计数，不同值一并列出
    const failure = assertPlanValueDomain([
      entry("a", "individual-go"),
      entry("b", "individual-ultra"),
      entry("c", "individual-ultra"),
      entry("d", "teams-pro"),
    ])
    expect(failure?.assertion).toBe("Min plan 值域")
    expect(failure?.detail).toContain('"individual-ultra" ×2')
    expect(failure?.detail).toContain('"teams-pro" ×1')
  })

  test("非空断言：空产物必失败（首次构建无基线时的 0 模型防线）", () => {
    expect(assertArtifactNonEmpty(["a"])).toBeUndefined()
    expect(assertArtifactNonEmpty([])?.assertion).toBe("产物非空")
  })

  test("Go 计数监控：individual-go 非隐藏计数漂移 ≤ ±5 通过、超阈值失败", () => {
    expect(MAX_GO_COUNT_DRIFT).toBe(5)
    // 迁移基线 54 → 59：恰好 +5，不阻塞发布
    expect(assertGoCountStable(59, 54)).toBeUndefined()
    // 正常发版漂移（±2）不阻塞 30 分钟 SLA
    expect(assertGoCountStable(56, 54)).toBeUndefined()
    expect(assertGoCountStable(52, 54)).toBeUndefined()
    // 刚好越界即失败
    expect(assertGoCountStable(60, 54)?.assertion).toBe("Go 模型计数监控")
    expect(assertGoCountStable(48, 54)?.detail).toContain("-6")
    const breach = assertGoCountStable(0, 54)
    expect(breach?.detail).toContain("54")
    // 首次构建（无基线）跳过
    expect(assertGoCountStable(0, undefined)).toBeUndefined()
  })

  test("模态词表：只看进产物的 Go 非隐藏条目；词表外模态必须人工裁决", () => {
    const catalog: CatalogEntry[] = [
      entry("a", "individual-go", { inputModalities: ["text", "image"] }),
      entry("b", "individual-go", { inputModalities: ["text"] }),
      entry("c", "individual-go", { inputModalities: ["text", "audio"] }),
      entry("non-go", "individual-max", { inputModalities: ["text", "audio"] }),
      entry("hidden-go", "individual-go", { hidden: true, inputModalities: ["text", "audio"] }),
    ]
    expect(assertModalityVocabulary(catalog.slice(0, 2))).toBeUndefined()
    const failure = assertModalityVocabulary(catalog)
    expect(failure?.assertion).toBe("inputModalities 词表")
    expect(failure?.detail).toContain("c")
    expect(failure?.detail).toContain("audio")
    expect(failure?.detail).not.toContain("non-go")
    expect(failure?.detail).not.toContain("hidden-go")
  })

  test("runReconcile：聚合全部失败一次性抛出（开 issue 信息给全）", () => {
    expect(() => runReconcile([undefined, undefined])).not.toThrow()
    try {
      runReconcile([
        assertPlanValueDomain([entry("a", "individual-ultra")]),
        assertArtifactNonEmpty([]),
        undefined,
      ])
      throw new Error("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(ReconcileError)
      const reconcile = error as ReconcileError
      expect(reconcile.failures).toHaveLength(2)
      expect(reconcile.message).toContain("2 项")
      expect(reconcile.message).toContain("值域")
      expect(reconcile.message).toContain("非空")
    }
  })
})

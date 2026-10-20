import { describe, expect, test } from "bun:test"
import { DEFAULT_CATALOG_REFRESH_SECONDS, parseClientCatalog } from "../../src/models/catalog.ts"

describe("view=client catalog 响应解析（官方 1.84.0 形状）", () => {
  test("catalogVersion / refreshAfterSeconds / data 落位；运行时只保留 {id, name, contextLength}", () => {
    // 逐字段取官方实测形状（#61）：roles/pricing/zdr/aliases/behaviorProfile/category
    // 等运行时字段均不消费；display.label 不作 name 权威（条目自身 name 才是）
    const sample = {
      schemaVersion: 1,
      catalogVersion: "d6177bab",
      refreshAfterSeconds: 900,
      roles: { default: { id: "coder" } },
      features: { compaction: true },
      data: [
        {
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          display: { label: "Claude Sonnet 5", badge: "new" },
          context_length: 1000000,
          minimumPlan: "individual-go",
          hidden: false,
          reasoningEfforts: ["low", "high", "max"],
          inputModalities: ["text", "image"],
          maxOutputTokens: null,
          pricing: { input: 1, output: 2 },
          zdr: true,
          aliases: [],
          behaviorProfile: "default",
          category: "general",
        },
        {
          id: "deepseek/deepseek-v4-flash",
          name: "DeepSeek V4 Flash (latest)",
          context_length: 1000000,
        },
        // null 与缺失同义（官方用 null 表达「无值」）：name / context_length 缺省
        {
          id: "bare/model",
          name: null,
          context_length: null,
        },
      ],
    }
    const result = parseClientCatalog(sample)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.catalog.catalogVersion).toBe("d6177bab")
    expect(result.catalog.refreshAfterSeconds).toBe(900)
    expect(result.catalog.models).toEqual([
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest)", contextLength: 1000000 },
      { id: "bare/model" },
    ])
    // 运行时字段之外的未知字段不得流入下游
    const serialized = JSON.stringify(result.catalog)
    expect(serialized).not.toContain("minimumPlan")
    expect(serialized).not.toContain("pricing")
  })

  test("refreshAfterSeconds 缺失或非法 → 回落默认 900s（字段级容错，不丢整份 catalog）", () => {
    const bodies: unknown[] = [
      { catalogVersion: "v1", data: [] },
      { catalogVersion: "v1", data: [], refreshAfterSeconds: null },
      { catalogVersion: "v1", data: [], refreshAfterSeconds: "900" },
      { catalogVersion: "v1", data: [], refreshAfterSeconds: 0 },
      { catalogVersion: "v1", data: [], refreshAfterSeconds: -1 },
      { catalogVersion: "v1", data: [], refreshAfterSeconds: Number.POSITIVE_INFINITY },
    ]
    for (const body of bodies) {
      const result = parseClientCatalog(body)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.catalog.refreshAfterSeconds).toBe(DEFAULT_CATALOG_REFRESH_SECONDS)
    }
  })

  test("catalogVersion 缺失或 null → 仍消费条目，只是没有 ETag 基准（字段级容错）", () => {
    for (const body of [
      { data: [] },
      { catalogVersion: null, data: [] },
    ]) {
      const result = parseClientCatalog(body)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.catalog.catalogVersion).toBeUndefined()
    }
  })

  test("空 data 数组合法：catalog 只作字段级权威，模型列表由产物全集决定", () => {
    const result = parseClientCatalog({ catalogVersion: "v1", data: [] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.catalog.models).toEqual([])
  })

  test("畸形矩阵：非对象顶层 / 版本缺失 / data 缺失 / 条目缺 id / 重复 id / 字段类型不对 → 拒绝", () => {
    const bads: unknown[] = [
      null,
      "不是对象",
      { catalogVersion: 42, data: [] },
      { catalogVersion: "", data: [] },
      { catalogVersion: "" },
      { catalogVersion: "v1" }, // data 缺失
      { catalogVersion: "v1", data: "不是数组" },
      { catalogVersion: "v1", data: [null] },
      { catalogVersion: "v1", data: ["不是对象"] },
      { catalogVersion: "v1", data: [{ name: "缺 id" }] },
      { catalogVersion: "v1", data: [{ id: "" }] },
      { catalogVersion: "v1", data: [{ id: "a/b" }, { id: "a/b" }] },
      { catalogVersion: "v1", data: [{ id: "a/b", name: 42 }] },
      { catalogVersion: "v1", data: [{ id: "a/b", context_length: "1M" }] },
      { catalogVersion: "v1", data: [{ id: "a/b", context_length: 0 }] },
    ]
    for (const bad of bads) {
      const result = parseClientCatalog(bad)
      expect(result.ok).toBe(false)
      if (result.ok === false) expect(typeof result.detail).toBe("string")
    }
  })
})

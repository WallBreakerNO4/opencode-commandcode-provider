import { describe, expect, test } from "bun:test"
import { ClientCatalogParseError, parseClientCatalog } from "../../scripts/build-models/client-catalog.ts"

describe("view=client catalog 解析（1.84.0 形状）", () => {
  test("catalogVersion + 条目字段落位；null 与缺失同义；display.* 与 context_length 兼容", () => {
    const catalog = parseClientCatalog({
      schemaVersion: 1,
      catalogVersion: "d6177bab",
      refreshAfterSeconds: 900,
      roles: { default: { id: "coder" } }, // 未消费字段忽略
      data: [
        {
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          display: { label: "Claude Sonnet 5", badge: "free" },
          context_length: 1000000,
          maxOutputTokens: null,
          minimumPlan: "individual-go",
          hidden: false,
          reasoningEfforts: ["high", "max"],
          inputModalities: ["text", "image"],
        },
        {
          id: "minimax/minimax-m3.1-flash",
          name: "MiniMax M3.1 Flash",
          context_length: 200000,
          minimumPlan: "individual-go",
          reasoningEfforts: null,
          inputModalities: ["text"],
        },
      ],
    })

    expect(catalog.catalogVersion).toBe("d6177bab")
    const [sonnet, minimax] = catalog.entries
    expect(sonnet).toMatchObject({
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      label: "Claude Sonnet 5",
      badge: "free",
      contextWindow: 1000000,
      minimumPlan: "individual-go",
      hidden: false,
      reasoningEfforts: ["high", "max"],
      inputModalities: ["text", "image"],
      reasoning: true, // 无 reasoning 字段：按 efforts 非空推导
    })
    expect(minimax?.maxOutputTokens).toBeUndefined() // null 视为无值
    expect(minimax?.reasoningEfforts).toBeUndefined()
    expect(minimax?.reasoning).toBeUndefined() // 无 efforts：交给产物组装显式 false
  })

  test("判据字段必填：minimumPlan 缺失 / id 重复 / 形状不对即报错（不静默漏模型）", () => {
    const wrap = (data: unknown) => ({ catalogVersion: "v1", data })

    expect(() => parseClientCatalog(wrap([{ id: "a", name: "A" }]))).toThrow(/minimumPlan/)
    expect(() => parseClientCatalog(wrap([{ id: "a", minimumPlan: "individual-go" }, { id: "a", minimumPlan: "individual-go" }]))).toThrow(
      /重复/,
    )
    expect(() => parseClientCatalog({ data: [] })).toThrow(/catalogVersion/)
    expect(() => parseClientCatalog({ catalogVersion: "v1" })).toThrow(/data 数组/)
    expect(() => parseClientCatalog({ catalogVersion: "v1", data: ["x"] })).toThrow(/不是对象/)
    expect(() => parseClientCatalog(wrap([{ id: "a", minimumPlan: "individual-go", hidden: "yes" }]))).toThrow(/hidden/)
    expect(() => parseClientCatalog(wrap([{ id: "a", minimumPlan: "individual-go", context_length: "1M" }]))).toThrow(
      /context_length/,
    )
    expect(() => parseClientCatalog(wrap([{ id: "a", minimumPlan: "individual-go", inputModalities: [1] }]))).toThrow(
      /inputModalities/,
    )
  })

  test("解析失败统一抛 ClientCatalogParseError", () => {
    expect(() => parseClientCatalog("不是对象")).toThrow(ClientCatalogParseError)
  })
})

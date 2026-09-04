import { describe, expect, test } from "bun:test"
import { parseModelsApi } from "../../src/models/api.ts"

describe("/provider/v1/models 响应解析（事实层：model-metadata-sources.md §二实测形状）", () => {
  test("实测样例：六字段条目剥成 {id, name, contextLength}，created 动态时间戳结构性剔除", () => {
    // 逐字取自调研文档实测样例（model-metadata-sources.md §二，62 个模型节选）；
    // 第三条 id/context_length 取自 §三真矛盾记录（gpt-5.5 API 实测 400k），
    // name 文档未记载故缺省——顺带覆盖可选字段容错
    const sample = {
      object: "list",
      data: [
        {
          id: "claude-sonnet-5",
          object: "model",
          created: 1787931186,
          owned_by: "command-code",
          name: "Claude Sonnet 5",
          context_length: 1000000,
        },
        {
          id: "deepseek/deepseek-v4-flash",
          object: "model",
          created: 1787931186,
          owned_by: "command-code",
          name: "DeepSeek V4 Flash (latest)",
          context_length: 1000000,
        },
        {
          id: "gpt-5.5",
          object: "model",
          created: 1787931186,
          owned_by: "command-code",
          context_length: 400000,
        },
      ],
    }
    const result = parseModelsApi(sample)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models).toEqual([
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest)", contextLength: 1000000 },
      { id: "gpt-5.5", contextLength: 400000 },
    ])
    // created 一旦流入下游，变更签名（#34）就不可能稳定——入口处必须剔除干净
    expect(JSON.stringify(result.models)).not.toContain("created")
    expect(JSON.stringify(result.models)).not.toContain("owned_by")
  })

  test("name / context_length 缺失可容忍（防御性：级联对该字段回落产物层）", () => {
    const result = parseModelsApi({ object: "list", data: [{ id: "bare/model", object: "model", created: 1 }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models).toEqual([{ id: "bare/model" }])
  })

  test("空 data 数组合法：API 声称零模型（暴露规则将得到空交集）", () => {
    const result = parseModelsApi({ object: "list", data: [] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.models).toEqual([])
  })

  test("畸形矩阵：非对象顶层 / data 缺失 / 条目缺 id / 字段类型不对 → 拒绝", () => {
    const bads: unknown[] = [
      null,
      "不是对象",
      { object: "list" }, // data 缺失
      { object: "list", data: "不是数组" },
      { object: "list", data: [null] },
      { object: "list", data: ["不是对象"] },
      { object: "list", data: [{ object: "model", name: "缺 id" }] },
      { object: "list", data: [{ id: "" }] },
      { object: "list", data: [{ id: "a/b", name: 42 }] },
      { object: "list", data: [{ id: "a/b", context_length: "1M" }] },
      { object: "list", data: [{ id: "a/b", context_length: 0 }] },
    ]
    for (const bad of bads) {
      const result = parseModelsApi(bad)
      expect(result.ok).toBe(false)
      if (result.ok === false) expect(typeof result.detail).toBe("string")
    }
  })
})

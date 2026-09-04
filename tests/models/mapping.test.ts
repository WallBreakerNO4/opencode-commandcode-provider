import { describe, expect, test } from "bun:test"
import { toV1ModelEntry, toV1ModelMap, toV2ModelFields } from "../../src/models/mapping.ts"
import type { ResolvedModel } from "../../src/models/cascade.ts"

const WITH_EFFORTS: ResolvedModel = {
  id: "deepseek/deepseek-v4-flash",
  name: "DeepSeek V4 Flash (latest)",
  reasoning: true,
  inputModalities: ["text", "image"],
  efforts: ["high", "max"],
  context: 1000000,
  maxOutput: 32000,
}

const BASE: ResolvedModel = {
  id: "zai-org/GLM-5.1",
  name: "GLM-5.1",
  reasoning: false,
  inputModalities: ["text"],
  context: 200000,
  maxOutput: 32000,
}

describe("v1 消费映射（规格 §3.2：config models entry，无 cost）", () => {
  test("entry 字段逐项：tool_call 恒 true、attachment 按 image 模态、modalities/limit 形状", () => {
    const entry = toV1ModelEntry(WITH_EFFORTS)
    expect(Object.keys(entry).sort()).toEqual([
      "attachment",
      "id",
      "limit",
      "modalities",
      "name",
      "reasoning",
      "tool_call",
      "variants",
    ])
    expect(entry).toEqual({
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash (latest)",
      tool_call: true,
      reasoning: true,
      attachment: true, // inputModalities 含 image
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 1000000, output: 32000 },
      variants: { high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
    })
    expect(JSON.stringify(entry)).not.toContain("cost")
  })

  test("纯文本模型：attachment false", () => {
    expect(toV1ModelEntry(BASE).attachment).toBe(false)
  })

  test("无档位 → variants 空 map：不造任何变体（base 模型无档可选，即不发送 reasoning_effort）", () => {
    const entry = toV1ModelEntry(BASE)
    expect(entry.variants).toEqual({})
    expect(JSON.stringify(entry)).not.toContain("reasoningEffort")
  })

  test("档位零过滤：上游给什么透传什么（含将来可能出现的 none/minimal）", () => {
    const entry = toV1ModelEntry({ ...BASE, efforts: ["none", "minimal", "turbo-banana"] })
    expect(Object.keys(entry.variants).sort()).toEqual(["minimal", "none", "turbo-banana"])
  })

  test("toV1ModelMap：以 wire id 为键，含 `/` 的 id 原样保留", () => {
    const map = toV1ModelMap([WITH_EFFORTS, BASE])
    expect(Object.keys(map).sort()).toEqual(["deepseek/deepseek-v4-flash", "zai-org/GLM-5.1"])
    expect(map["deepseek/deepseek-v4-flash"]!.id).toBe("deepseek/deepseek-v4-flash")
  })
})

describe("v2 消费映射（规格 §3.2：Model.Info 字段，cost 省略）", () => {
  test("字段逐项：capabilities/limit/variants 数组形状", () => {
    const fields = toV2ModelFields(WITH_EFFORTS)
    expect(Object.keys(fields).sort()).toEqual(["capabilities", "id", "limit", "modelID", "name", "variants"])
    expect(fields).toEqual({
      id: "deepseek/deepseek-v4-flash",
      modelID: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash (latest)",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { context: 1000000, output: 32000 },
      variants: [
        { id: "high", settings: { reasoningEffort: "high" } },
        { id: "max", settings: { reasoningEffort: "max" } },
      ],
    })
    expect(JSON.stringify(fields)).not.toContain("cost")
  })

  test("无档位 → variants 空数组：不造任何变体", () => {
    expect(toV2ModelFields(BASE).variants).toEqual([])
  })

  test("档位零过滤 + 保序：数组 id 逐档透传", () => {
    const fields = toV2ModelFields({ ...BASE, efforts: ["none", "minimal", "xhigh", "turbo-banana"] })
    expect(fields.variants.map((variant) => variant.id)).toEqual(["none", "minimal", "xhigh", "turbo-banana"])
  })

  test("wire id 含 `/`：id 与 modelID 原样保留（模型 reference 按首个 `/` 切分，wire 不被切坏）", () => {
    const fields = toV2ModelFields(WITH_EFFORTS)
    expect(fields.id).toBe("deepseek/deepseek-v4-flash")
    expect(fields.modelID).toBe("deepseek/deepseek-v4-flash")
  })
})

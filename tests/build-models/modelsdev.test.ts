import { describe, expect, test } from "bun:test"
import { candidateGroups, lookupLimits } from "../../scripts/build-models/modelsdev.ts"

const API = {
  zai: {
    models: {
      "GLM-5": { limit: { context: 200000, output: 32000 } },
      "glm-5.1": { limit: { context: 204800 } },
    },
  },
  minimax: { models: { "MiniMax-M2.5": { limit: { context: 200000, output: 32000 } } } },
  alibaba: { models: { "qwen3.8-27b": { limit: { context: 262144, output: 65536 } } } },
  anthropic: { models: { "claude-sonnet-5": { limit: { context: 1000000, output: 64000 } } } },
  openai: { models: { "gpt-5.6-sol": { limit: { context: 400000 } } } },
  "tencent-tokenhub": { models: { "hy4-preview": { limit: { context: 1048576 } } } },
  // key 自带前缀的组（整串结尾匹配的适配对象）
  nvidia: { models: { "nvidia/nemotron-3-ultra-550b-a55b": { limit: { context: 131072 } } } },
  // 第三方聚合组（全库兜底扫描的对象）
  openrouter: { models: { "vendor/exotic-model": { limit: { context: 32000, output: 8000 } } } },
}

describe("models.dev 匹配（别名表 + 归一 + 全库兜底）", () => {
  test("前缀别名：zai-org / z-ai → zai；大小写差异走归一匹配", () => {
    expect(candidateGroups("zai-org/GLM-5")).toEqual(["zai"])
    expect(candidateGroups("z-ai/glm-5.3-flash")).toEqual(["zai"])
    const hit = lookupLimits(API, "zai-org/GLM-5")
    expect(hit).toMatchObject({ context: 200000, output: 32000, source: "zai/GLM-5" })
    expect(lookupLimits(API, "z-ai/glm-5.1")).toMatchObject({ context: 204800, source: "zai/glm-5.1" })
  })

  test("别名一对多：tencent → 三候选组按序尝试", () => {
    expect(candidateGroups("tencent/hy4-preview")).toEqual(["tencent-tokenhub", "tencent-coding-plan", "tencent-token-plan"])
    expect(lookupLimits(API, "tencent/hy4-preview")).toMatchObject({ context: 1048576, source: "tencent-tokenhub/hy4-preview" })
  })

  test("Qwen → alibaba；模型段归一（大小写 / _ → -）", () => {
    expect(candidateGroups("Qwen/Qwen3.8-27B")).toEqual(["alibaba"])
    expect(lookupLimits(API, "Qwen/Qwen3.8-27B")).toMatchObject({ context: 262144 })
  })

  test("无前缀 id：品牌映射（claude*→anthropic、gpt*→openai）", () => {
    expect(candidateGroups("claude-sonnet-5")).toEqual(["anthropic"])
    expect(lookupLimits(API, "claude-sonnet-5")).toMatchObject({ context: 1000000 })
    expect(lookupLimits(API, "gpt-5.6-sol")).toMatchObject({ context: 400000 })
  })

  test("key 自带前缀的组：整串结尾匹配", () => {
    expect(lookupLimits(API, "nvidia/nemotron-3-ultra-550b-a55b")).toMatchObject({ context: 131072 })
  })

  test("候选组全落空 → 全库兜底扫描仍可命中", () => {
    expect(lookupLimits(API, "exotic/exotic-model")).toMatchObject({ context: 32000, output: 8000, source: "openrouter/vendor/exotic-model" })
  })

  test("完全无匹配 → undefined（补全链落常量，不报错）", () => {
    expect(lookupLimits(API, "tencent/hy3-paid")).toBeUndefined()
    expect(lookupLimits(API, "unknown/model")).toBeUndefined()
  })

  test("api.json 形状异常不炸（返回 undefined）", () => {
    expect(lookupLimits(undefined, "zai-org/GLM-5")).toBeUndefined()
    expect(lookupLimits({}, "zai-org/GLM-5")).toBeUndefined()
  })

  test("limit 双缺 → 视为未命中，继续兜底扫描", () => {
    const api = { zai: { models: { "GLM-5": {} } }, other: { models: { "GLM-5": { limit: { context: 1 } } } } }
    expect(lookupLimits(api, "zai-org/GLM-5")).toMatchObject({ context: 1, source: "other/GLM-5" })
  })
})

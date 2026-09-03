import { describe, expect, test } from "bun:test"
import { BundleExtractError, extractCatalog, RefResolver } from "../../scripts/build-models/bundle.ts"

// 仿 1.45.0 真实 bundle 形态的最小样本：provider 常量在前、目录对象以 `={` 开头、
// 条目含引用 / !0 / 1e6 / maxOutputTokens / getter / 别名链。
const BUNDLE_FIXTURE = [
  'var NT="cmd";var NR="anthropic",$R="openai",FR="vercel-ai-gateway",BR="openrouter";',
  'var QR="chatComplete",XR="responses";',
  'var YR=FR,ZR="MiniMaxAI/MiniMax-M3-Free",eO={',
  "SONNET_5:{id:\"claude-sonnet-5\",inputModalities:[\"text\",\"image\"],provider:NR,spec:QR,label:\"Claude Sonnet 5\",name:\"Claude Sonnet 5\",description:\"speed\",reasoning:!0,reasoningEfforts:[\"low\",\"max\"],contextWindow:1e6,maxOutputTokens:32000},",
  "SONNET_4_6:{id:\"claude-sonnet-4-6\",inputModalities:[\"text\"],provider:NR,spec:QR,label:\"Claude Sonnet 4.6\",name:\"Claude Sonnet 4.6\",reasoning:!0,contextWindow:200000},",
  "MINIMAX_FREE:{id:\"MiniMaxAI/MiniMax-M3-Free\",inputModalities:[\"text\"],provider:ZR,spec:QR,label:\"MiniMax M3 Free\",name:\"MiniMax M3 Free\",reasoning:!1,get hidden(){return isEnded()},badge:\"free\"},",
  "GATEWAY_MODEL:{id:\"nvidia/nemotron-3\",inputModalities:[\"text\"],provider:YR,spec:XR,label:\"Nemotron\",name:\"Nemotron\",reasoning:!1},",
  "NO_CONTEXT:{id:\"zai-org/GLM-5.1\",inputModalities:[\"text\"],provider:BR,spec:QR,label:\"GLM-5.1\",name:\"GLM-5.1\"}",
  "};",
  "function isEnded(){return !0}",
  "var other={id:\"anthropic:claude-sonnet-5\",provider:\"Anthropic\",category:\"premium\"};",
].join("")

describe("bundle 逆向（锚点 + ={ 截取 + 标识符注入）", () => {
  test("从锚点 id 提取目录条目，引用/别名/getter 正确处理", () => {
    const entries = extractCatalog(BUNDLE_FIXTURE, { minEntries: 3 })
    expect(entries.map((entry) => entry.id)).toEqual([
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "MiniMaxAI/MiniMax-M3-Free",
      "nvidia/nemotron-3",
      "zai-org/GLM-5.1",
    ])

    const sonnet = entries[0]!
    expect(sonnet.provider).toBe("anthropic") // NR= 定义
    expect(sonnet.spec).toBe("chatComplete") // QR= 定义
    expect(sonnet.reasoning).toBe(true) // !0
    expect(sonnet.reasoningEfforts).toEqual(["low", "max"])
    expect(sonnet.contextWindow).toBe(1_000_000) // 1e6
    expect(sonnet.maxOutputTokens).toBe(32000)
    expect(sonnet.inputModalities).toEqual(["text", "image"])

    // 别名链 YR=FR="vercel-ai-gateway"
    expect(entries[3]!.provider).toBe("vercel-ai-gateway")
    expect(entries[3]!.spec).toBe("responses") // XR= 定义
    // getter 条目：函数体被跳过（hidden 无 plain 属性 → undefined），普通字段正常读取
    expect(entries[2]!.hidden).toBeUndefined()
    expect(entries[2]!.badge).toBe("free")
    // 价格表同 id（anthropic: 前缀）不被误当目录
    expect(entries.find((entry) => entry.id === "anthropic:claude-sonnet-5")).toBeUndefined()
    // reasoning 缺省条目不虚构
    expect(entries[4]!.reasoning).toBeUndefined()
    expect(entries[4]!.contextWindow).toBeUndefined()
  })

  test("任一锚点命中即可（SONNET_5 / deepseek 锚点）", () => {
    const shifted = BUNDLE_FIXTURE.replace("SONNET_4_6", "LEGACY_SONNET")
    expect(extractCatalog(shifted, { minEntries: 3 }).length).toBe(5)
  })

  test("全部锚点失效 → BundleExtractError（结构漂移交人工适配）", () => {
    const broken = BUNDLE_FIXTURE.replaceAll("claude-sonnet-4-6", "claude-x").replaceAll("claude-sonnet-5", "claude-y").replaceAll("deepseek/deepseek-v4-pro", "x")
    expect(() => extractCatalog(broken)).toThrow(BundleExtractError)
  })

  test("目录规模低于形状校验下限 → 拒绝（坏截取防线）", () => {
    const tiny = `var A="anthropic",C={ONE:{id:"claude-sonnet-4-6",provider:A,inputModalities:["text"]}};`
    expect(() => extractCatalog(tiny)).toThrow(/低于形状校验下限/)
  })

  test("RefResolver：多匹配位取首个干净定义；RHS 是代码形状时跳过继续找", () => {
    const resolver = new RefResolver(`var X="first";var code=function(){return 1};var Y=X;X2="not-x";`)
    expect(resolver.resolve("X")).toEqual({ kind: "primitive", value: "first" })
    expect(resolver.resolve("Y")).toEqual({ kind: "primitive", value: "first" }) // 别名链
    expect(resolver.resolve("MISSING")).toBeUndefined()
  })

  test("RefResolver：别名环不炸（返回 undefined）", () => {
    const resolver = new RefResolver(`var A=B,B=A;`)
    expect(resolver.resolve("A")).toBeUndefined()
  })
})

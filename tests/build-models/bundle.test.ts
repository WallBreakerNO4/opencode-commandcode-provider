import { describe, expect, test } from "bun:test"
import {
  BundleExtractError,
  extractCatalog,
  extractEmbeddedCatalog,
  RefResolver,
} from "../../scripts/build-models/bundle.ts"

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

// 仿 1.84.0 真实 bundle 形态：目录容器从「名字 → 条目」映射改为
// {catalogVersion, data:[条目...]}；字段改用 context_length / display.*；
// 删除 reasoning 字段；无值字段写 null；价格出现省略前导 0 的小数。
const BUNDLE_FIXTURE_184 = [
  'var RID="zai-org/GLM-5.1";',
  'var K={catalogVersion:"d6177bab",data:[',
  '{aliases:[],behaviorProfile:"anthropic-interleaved-v1",category:"premium",context_length:1e6,display:{badge:null,description:"x",group:"Anthropic",label:"Claude Sonnet 4.6",notice:null,order:62},hidden:!1,id:"claude-sonnet-4-6",inputModalities:["text","image"],maxOutputTokens:null,minimumPlan:"individual-pro",name:"Claude Sonnet 4.6",object:"model",owned_by:"command-code",pricing:{cacheReadCost:.3,cacheWriteCost:3.75,inputCost:3,outputCost:15},reasoningEfforts:["low","high"],zdr:!0},',
  '{aliases:[],behaviorProfile:"standard-v1",category:"opensource",context_length:256e3,display:{badge:"free",description:"y",group:"Open Source",label:"Kimi K2.6",notice:null,order:10},hidden:!1,id:"moonshotai/Kimi-K2.6",inputModalities:["text"],maxOutputTokens:32768,minimumPlan:"individual-go",name:"Kimi K2.6",object:"model",owned_by:"command-code",pricing:{cacheReadCost:.1,inputCost:.6,outputCost:3},reasoningEfforts:null,zdr:!1},',
  '{id:"stealth/cat-jam:free",name:"Cat Jam",inputModalities:["text"],minimumPlan:"individual-go",hidden:!1,context_length:2e5},',
  '{id:"deepseek/deepseek-v4-pro",name:"DeepSeek V4 Pro",inputModalities:["text"],reasoningEfforts:["off","high","max"],context_length:1e6},',
  '{id:RID,name:"GLM-5.1",inputModalities:["text"],reasoningEfforts:["high","max"],context_length:2e5}',
  '],schemaVersion:1,refreshAfterSeconds:900,roles:{default:{id:"coder"}},features:{compaction:!0}};',
  "function unrelated(){return 1}",
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

  test("1.84.0 形状：data 数组容器 / context_length / display.* / null 与 reasoning 推导", () => {
    const entries = extractCatalog(BUNDLE_FIXTURE_184, { minEntries: 3 })
    expect(entries.map((entry) => entry.id)).toEqual([
      "claude-sonnet-4-6",
      "moonshotai/Kimi-K2.6",
      "stealth/cat-jam:free",
      "deepseek/deepseek-v4-pro",
      "zai-org/GLM-5.1",
    ])

    const sonnet = entries[0]!
    expect(sonnet.label).toBe("Claude Sonnet 4.6") // display.label
    expect(sonnet.badge).toBeUndefined() // display.badge:null 视为无值
    expect(sonnet.contextWindow).toBe(1_000_000) // context_length
    expect(sonnet.maxOutputTokens).toBeUndefined() // null 视为无值
    expect(sonnet.reasoningEfforts).toEqual(["low", "high"])
    expect(sonnet.reasoning).toBe(true) // 无 reasoning 字段：按 efforts 非空推导
    expect(sonnet.minimumPlan).toBe("individual-pro")
    expect(sonnet.hidden).toBe(false)

    const kimi = entries[1]!
    expect(kimi.reasoning).toBe(false) // reasoningEfforts:null
    expect(kimi.reasoningEfforts).toBeUndefined()
    expect(kimi.badge).toBe("free") // display.badge
    expect(kimi.contextWindow).toBe(256_000)
    expect(kimi.maxOutputTokens).toBe(32768)
    expect(kimi.minimumPlan).toBe("individual-go")

    const catJam = entries[2]!
    expect(catJam.minimumPlan).toBe("individual-go")
    expect(catJam.hidden).toBe(false)

    const deepseek = entries[3]!
    expect(deepseek.label).toBeUndefined()
    expect(deepseek.reasoning).toBe(true)
    expect(deepseek.minimumPlan).toBeUndefined() // 旧形状条目没有该字段
  })

  test("任一锚点命中即可（SONNET_5 / deepseek 锚点）", () => {
    const shifted = BUNDLE_FIXTURE.replace("SONNET_4_6", "LEGACY_SONNET")
    expect(extractCatalog(shifted, { minEntries: 3 }).length).toBe(5)
  })

  test("全部锚点失效 → BundleExtractError（结构漂移交人工适配）", () => {
    const broken = BUNDLE_FIXTURE.replaceAll("claude-sonnet-4-6", "claude-x").replaceAll("claude-sonnet-5", "claude-y").replaceAll("deepseek/deepseek-v4-pro", "x")
    expect(() => extractCatalog(broken)).toThrow(BundleExtractError)
  })

  test("软兜底：解析失败返回空补集 + 告警文本，绝不抛错阻塞发布", () => {
    const broken = BUNDLE_FIXTURE.replaceAll("claude-sonnet-4-6", "claude-x").replaceAll("claude-sonnet-5", "claude-y").replaceAll("deepseek/deepseek-v4-pro", "x")
    const result = extractEmbeddedCatalog(broken)
    expect(result.entries).toEqual([])
    expect(result.warning).toContain("全部锚点失效")
  })

  test("软兜底：解析成功原样返回条目且无告警", () => {
    const result = extractEmbeddedCatalog(BUNDLE_FIXTURE_184, { minEntries: 3 })
    expect(result.warning).toBeUndefined()
    expect(result.entries.map((entry) => entry.id)).toContain("stealth/cat-jam:free")
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

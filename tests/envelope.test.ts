import { describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions, SharedV3Warning } from "@ai-sdk/provider"
import plugin from "../src/index.ts"
import { PROVIDER_ID, buildEnvelope, splitModelReference, type EnvelopeCallContext } from "../src/protocol/envelope.ts"

// 规格 §1 全表逐行（docs/spec/protocol.md），fixture 形状对照 capture/samples/generate.json
// 的真实 wire：七键骨架、params 语义字段、消息转换全表、tool_choice 四态、warnings 通道。

function context(overrides: Partial<EnvelopeCallContext> = {}): EnvelopeCallContext {
  return {
    modelId: "deepseek/deepseek-v4-flash",
    maxOutput: 64000,
    threadId: "df72321c-66e7-4f3b-8779-5b882e51727f",
    disguise: {
      config: { workingDir: "/repo", date: "2026-08-30" },
      permissionMode: "standard",
    },
    ...overrides,
  }
}

function build(prompt: LanguageModelV3CallOptions["prompt"], overrides: Partial<LanguageModelV3CallOptions> = {}, ctx = context()) {
  return buildEnvelope({ prompt, ...overrides }, ctx)
}

const userText = (text: string): LanguageModelV3CallOptions["prompt"] => [
  { role: "user", content: [{ type: "text", text }] },
]

describe("信封骨架（§1 七键）", () => {
  test("恰为七键且键序同规格；死键恒 null、伪装字段按填充点搬运", () => {
    const ctx = context()
    const { body } = build(userText("Say OK"), {}, ctx)
    expect(Object.keys(body)).toEqual(["config", "memory", "taste", "skills", "permissionMode", "threadId", "params"])
    expect(body.config).toBe(ctx.disguise.config)
    expect(body.memory).toBeNull()
    expect(body.taste).toBeNull()
    expect(body.skills).toBeNull()
    expect(body.permissionMode).toBe("standard")
    expect(body.threadId).toBe("df72321c-66e7-4f3b-8779-5b882e51727f")
  })

  test("params.stream 恒 true，model 为 wire id 原样透传（含 /）", () => {
    const { body } = build(userText("Say OK"))
    expect(body.params.stream).toBe(true)
    expect(body.params.model).toBe("deepseek/deepseek-v4-flash")
  })

  test("wire id 含多个 / 时整体透传不被切坏", () => {
    const { body } = build(userText("hi"), {}, context({ modelId: "meta/muse-spark-1.2-contributor" }))
    expect(body.params.model).toBe("meta/muse-spark-1.2-contributor")
  })

  test("模型 reference 按首个 / 切分，wire id 含 / 原样保留", () => {
    expect(splitModelReference("commandcode-go/deepseek/deepseek-v4-flash")).toEqual({
      providerId: "commandcode-go",
      wireId: "deepseek/deepseek-v4-flash",
    })
    expect(splitModelReference("xai/grok-4.5")).toEqual({ providerId: "xai", wireId: "grok-4.5" })
  })

  test("PROVIDER_ID 与入口插件 id 四处同名之一", () => {
    expect(PROVIDER_ID).toBe(plugin.id)
  })
})

describe("消息转换（§1.1 全表）", () => {
  test("system 消息提升进 params.system，多条以 \\n\\n 连接", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "system", content: "第一段" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: "第二段" },
    ]
    const { body } = build(prompt)
    expect(body.params.system).toBe("第一段\n\n第二段")
    expect(body.params.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
  })

  test("无 system 消息时不发 system 键", () => {
    const { body } = build(userText("hi"))
    expect("system" in body.params).toBe(false)
  })

  test("user 文本 part → {type:'text', text}", () => {
    const { body } = build(userText("Say OK"))
    expect(body.params.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Say OK" }] }])
  })

  test("user 图片 part：Uint8Array → data URL base64 可还原", () => {
    const bytes = new TextEncoder().encode("hi")
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "file", data: bytes, mediaType: "image/png" }] },
    ]
    const { body } = build(prompt)
    const [block] = (body.params.messages[0] as { content: Array<{ type: string; image?: string }> }).content
    expect(block?.type).toBe("image")
    expect(block?.image).toBe(`data:image/png;base64,${btoa("hi")}`)
  })

  test("user 图片 part：base64 字符串包装、data: URL 原样透传", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      {
        role: "user",
        content: [
          { type: "file", data: "aGVsbG8=", mediaType: "image/jpeg" },
          { type: "file", data: "data:image/webp;base64,AAAA", mediaType: "image/webp" },
        ],
      },
    ]
    const { body } = build(prompt)
    const content = (body.params.messages[0] as { content: Array<{ image: string }> }).content
    expect(content[0]?.image).toBe("data:image/jpeg;base64,aGVsbG8=")
    expect(content[1]?.image).toBe("data:image/webp;base64,AAAA")
  })

  test("URL 引用图片 → warnings 上报且丢弃，不静默吞", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "file", data: new URL("https://example.com/a.png"), mediaType: "image/png" }] },
    ]
    const { body, warnings } = build(prompt)
    expect(body.params.messages).toEqual([])
    expect(warnings.some((w) => w.type === "unsupported" && w.feature === "image URL input")).toBe(true)
  })

  test("assistant 文本 / reasoning / tool-call，input 保持对象", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "思考中" },
          { type: "text", text: "回答" },
          { type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { file_path: "/a" } },
        ],
      },
    ]
    const { body } = build(prompt)
    expect(body.params.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "思考中" },
          { type: "text", text: "回答" },
          { type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { file_path: "/a" } },
        ],
      },
    ])
  })

  test("assistant tool-call 的 input 为 JSON 字符串时解析为对象，解析失败保留原串", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "t", input: '{"x":1}' },
          { type: "tool-call", toolCallId: "c2", toolName: "t", input: "{not json" },
        ],
      },
    ]
    const { body } = build(prompt)
    const content = (body.params.messages[0] as { content: Array<{ input: unknown }> }).content
    expect(content[0]?.input).toEqual({ x: 1 })
    expect(content[1]?.input).toBe("{not json")
  })

  test("tool 结果消息：text → text、error-text → error-text（isError 语义）", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { type: "text", value: "内容" } },
          { type: "tool-result", toolCallId: "c2", toolName: "shell", output: { type: "error-text", value: "boom" } },
        ],
      },
    ]
    const { body } = build(prompt)
    expect(body.params.messages).toEqual([
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { type: "text", value: "内容" } },
          { type: "tool-result", toolCallId: "c2", toolName: "shell", output: { type: "error-text", value: "boom" } },
        ],
      },
    ])
  })

  test("tool 结果：json 序列化为 text、error-json / execution-denied 归 error-text", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "t", output: { type: "json", value: { ok: true } } },
          { type: "tool-result", toolCallId: "c2", toolName: "t", output: { type: "error-json", value: { err: 1 } } },
          { type: "tool-result", toolCallId: "c3", toolName: "t", output: { type: "execution-denied" } },
          { type: "tool-result", toolCallId: "c4", toolName: "t", output: { type: "execution-denied", reason: "用户拒绝" } },
        ],
      },
    ]
    const { body } = build(prompt)
    const content = (
      body.params.messages[0] as { content: Array<{ output: { type: string; value: string } }> }
    ).content
    expect(content[0]?.output).toEqual({ type: "text", value: '{"ok":true}' })
    expect(content[1]?.output).toEqual({ type: "error-text", value: '{"err":1}' })
    expect(content[2]?.output).toEqual({ type: "error-text", value: "Execution denied" })
    expect(content[3]?.output).toEqual({ type: "error-text", value: "用户拒绝" })
  })

  test("assistant 内嵌 tool-result 拆分为独立的 role:tool 消息", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "调用工具" },
          { type: "tool-result", toolCallId: "c1", toolName: "t", output: { type: "text", value: "结果" } },
        ],
      },
    ]
    const { body } = build(prompt)
    expect(body.params.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "调用工具" }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "t", output: { type: "text", value: "结果" } }],
      },
    ])
  })
})

describe("tools 与 tool_choice（§1.1 / §1.2）", () => {
  const functionTool = {
    type: "function" as const,
    name: "read_file",
    description: "读文件",
    inputSchema: { type: "object" as const, properties: { file_path: { type: "string" as const } } },
  }

  test("tools 定义 → Anthropic 风格 {type, name, description, input_schema}", () => {
    const { body } = build(userText("hi"), { tools: [functionTool] })
    expect(body.params.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "读文件",
        input_schema: { type: "object", properties: { file_path: { type: "string" } } },
      },
    ])
  })

  test("provider 工具无信封表达 → warnings 上报并略去", () => {
    const { body, warnings } = build(userText("hi"), {
      tools: [{ type: "provider", id: "acme.tool", name: "tool", args: {} }],
    })
    expect(body.params.tools).toBeUndefined()
    expect(warnings.some((w) => w.type === "unsupported" && w.feature.includes("tool"))).toBe(true)
  })

  test("tool_choice 四态：auto / none / required→any / 指定工具→{type:'tool', name}", () => {
    expect(build(userText("hi"), { tools: [functionTool], toolChoice: { type: "auto" } }).body.params.tool_choice).toEqual({ type: "auto" })
    expect(build(userText("hi"), { tools: [functionTool], toolChoice: { type: "none" } }).body.params.tool_choice).toEqual({ type: "none" })
    expect(build(userText("hi"), { tools: [functionTool], toolChoice: { type: "required" } }).body.params.tool_choice).toEqual({ type: "any" })
    expect(
      build(userText("hi"), { tools: [functionTool], toolChoice: { type: "tool", toolName: "read_file" } }).body.params.tool_choice,
    ).toEqual({ type: "tool", name: "read_file" })
  })

  test("tools 非空且调用方未指定 → 显式发 {type:'auto'}；无 tools → 不发 tool_choice", () => {
    expect(build(userText("hi"), { tools: [functionTool] }).body.params.tool_choice).toEqual({ type: "auto" })
    expect(build(userText("hi")).body.params.tool_choice).toBeUndefined()
  })
})

describe("参数处理（§1.2）", () => {
  test("max_tokens = min(调用方值, 级联 maxOutput, 网关墙)；未传用官方缺省 64e3", () => {
    const ctx = context({ maxOutput: 100_000 })
    expect(build(userText("hi"), { maxOutputTokens: 32000 }, ctx).body.params.max_tokens).toBe(32000)
    expect(build(userText("hi"), { maxOutputTokens: 128000 }, ctx).body.params.max_tokens).toBe(100_000)
    expect(build(userText("hi"), {}, ctx).body.params.max_tokens).toBe(64_000)
  })

  test("官方缺省 64e3 + 网关墙 200000（#42 / ADR 0002）", () => {
    // deepseek v4 系级联 384000（models.dev 第三方视角值），未传 → 官方 CLI 同款缺省 64e3
    expect(build(userText("hi"), {}, context({ maxOutput: 384_000 })).body.params.max_tokens).toBe(64_000)
    // 调用方显式传大值（宿主按 limit.output 传）→ 钳到网关 zod 校验上限 200000
    expect(
      build(userText("hi"), { maxOutputTokens: 384_000 }, context({ maxOutput: 384_000 })).body.params.max_tokens,
    ).toBe(200_000)
    expect(
      build(userText("hi"), { maxOutputTokens: 999_999 }, context({ maxOutput: 512_000 })).body.params.max_tokens,
    ).toBe(200_000)
    // 墙内调用方值尊重；级联比缺省小 → 级联生效
    expect(
      build(userText("hi"), { maxOutputTokens: 100_000 }, context({ maxOutput: 131_072 })).body.params.max_tokens,
    ).toBe(100_000)
    expect(build(userText("hi"), {}, context({ maxOutput: 32_000 })).body.params.max_tokens).toBe(32_000)
  })

  test("temperature / top_p / top_k 有则透传（snake_case 键），无则不发", () => {
    const withSampling = build(userText("hi"), { temperature: 0.7, topP: 0.9, topK: 40 }).body.params
    expect(withSampling.temperature).toBe(0.7)
    expect(withSampling.top_p).toBe(0.9)
    expect(withSampling.top_k).toBe(40)
    const withoutSampling = build(userText("hi")).body.params
    expect("temperature" in withoutSampling).toBe(false)
    expect("top_p" in withoutSampling).toBe(false)
    expect("top_k" in withoutSampling).toBe(false)
  })

  test("reasoning_effort 仅变体被选中时经 providerOptions.reasoningEffort 发送", () => {
    const variant = build(userText("hi"), {
      providerOptions: { "commandcode-go": { reasoningEffort: "max" } },
    }).body.params
    expect(variant.reasoning_effort).toBe("max")

    // 命名空间键随宿主而异（官方 CLI 抓包里在模型 provider 键下）：仍按通道读取
    const foreign = build(userText("hi"), {
      providerOptions: { deepseek: { reasoningEffort: "high" } },
    }).body.params
    expect(foreign.reasoning_effort).toBe("high")

    // base 模型未选变体：不发该字段
    const base = build(userText("hi"), { providerOptions: { gateway: { caching: "auto" } } }).body.params
    expect("reasoning_effort" in base).toBe(false)
  })
})

describe("越权参数 warnings 通道（§1.3）", () => {
  test("信封没有的调用参数一律 warnings 上报，不塞信封、不静默吞", () => {
    const { body, warnings } = build(userText("hi"), {
      stopSequences: ["END"],
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      seed: 42,
      responseFormat: { type: "text" },
    })
    const features = warnings.filter((w) => w.type === "unsupported").map((w) => w.feature)
    expect(features).toEqual(["stopSequences", "presencePenalty", "frequencyPenalty", "seed", "responseFormat"])
    const params = body.params as unknown as Record<string, unknown>
    for (const key of ["stop_sequences", "presence_penalty", "frequency_penalty", "seed", "response_format"]) {
      expect(key in params).toBe(false)
    }
  })

  test("干净调用 warnings 为空", () => {
    const { warnings } = build(userText("Say OK"), {
      tools: [
        { type: "function", name: "t", inputSchema: { type: "object" as const, properties: {} } },
      ],
      toolChoice: { type: "auto" },
    })
    expect(warnings).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { StreamTruncatedError, createNdjsonEventStream, normalizeFinishReason, normalizeUsage } from "../src/protocol/ndjson.ts"

// 规格 §2 事件全表逐事件（docs/spec/protocol.md）。fixture 素材取自
// capture/samples/generate.json 的真实 wire 形状（deepseek/deepseek-v4-flash 一轮）。

const MODEL_ID = "deepseek/deepseek-v4-flash"
const WARNINGS = [{ type: "unsupported", feature: "seed" }] as const

const encoder = new TextEncoder()

function makeStream() {
  return createNdjsonEventStream({ modelId: MODEL_ID, warnings: [...WARNINGS] })
}

function pushLines(stream: ReturnType<typeof makeStream>, lines: string[]): LanguageModelV3StreamPart[] {
  return stream.push(encoder.encode(lines.map((line) => `${line}\n`).join("")))
}

/** capture 样本：finish-step 收据（usage 为真实抓包形状） */
const CAPTURE_USAGE = {
  inputTokens: 16977,
  inputTokenDetails: { noCacheTokens: 11601, cacheReadTokens: 5376 },
  outputTokens: 27,
  outputTokenDetails: { textTokens: 2, reasoningTokens: 25 },
  totalTokens: 17004,
  raw: { prompt_tokens: 16977, completion_tokens: 27, total_tokens: 17004 },
  reasoningTokens: 25,
  cachedInputTokens: 5376,
}

const CAPTURE_FINISH_STEP = JSON.stringify({
  type: "finish-step",
  finishReason: "stop",
  rawFinishReason: "stop",
  usage: CAPTURE_USAGE,
  providerMetadata: { gateway: { generationId: "gen_01M19M8N3NYP2DAB2RRH2PVGN6" } },
  response: {
    id: "489472a3-20e1-4510-80f2-9ac8d490cfa7",
    timestamp: "2026-08-30T15:23:02.000Z",
    modelId: "deepseek-v4-flash",
  },
})

const CAPTURE_FINISH = JSON.stringify({
  type: "finish",
  finishReason: "stop",
  rawFinishReason: "stop",
  totalUsage: CAPTURE_USAGE,
})

describe("stream-start 与流生命周期", () => {
  test("head 恰产出一个 stream-start 且携带调用 warnings；重复调用为空", () => {
    const stream = makeStream()
    expect(stream.head()).toEqual([{ type: "stream-start", warnings: [...WARNINGS] }])
    expect(stream.head()).toEqual([])
  })

  test("start / start-step 不再额外产 part（流开始由 stream-start 承担）", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, ['{"type":"start"}', '{"type":"start-step","request":{"body":{}},"warnings":[]}'])
    expect(parts).toEqual([])
  })
})

describe("事件全表：正文与思考块", () => {
  test("text-start / text-delta / text-end 生命周期逐事件映射", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, [
      '{"type":"text-start","id":"txt-0"}',
      '{"type":"text-delta","id":"txt-0","text":"OK"}',
      '{"type":"text-end","id":"txt-0"}',
    ])
    expect(parts).toEqual([
      { type: "text-start", id: "txt-0" },
      { type: "text-delta", id: "txt-0", delta: "OK" },
      { type: "text-end", id: "txt-0" },
    ])
  })

  test("reasoning-start / delta / end 映射，providerMetadata 照收", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, [
      '{"type":"reasoning-start","id":"reasoning-0","providerMetadata":{"gateway":{"generationId":"gen_01M19M8N3NYP2DAB2RRH2PVGN6"}}}',
      '{"type":"reasoning-delta","id":"reasoning-0","text":"The"}',
      '{"type":"reasoning-end","id":"reasoning-0"}',
    ])
    expect(parts[0]).toEqual({
      type: "reasoning-start",
      id: "reasoning-0",
      providerMetadata: { gateway: { generationId: "gen_01M19M8N3NYP2DAB2RRH2PVGN6" } },
    })
    expect(parts[1]).toEqual({ type: "reasoning-delta", id: "reasoning-0", delta: "The" })
    expect(parts[2]).toEqual({ type: "reasoning-end", id: "reasoning-0" })
  })
})

describe("事件全表：增量工具参数（必做）与一次性 tool-call", () => {
  test("tool-input-start/delta/end 增量按序透传，长参数不丢不乱", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, [
      '{"type":"tool-input-start","id":"call_1","toolName":"write_file"}',
      '{"type":"tool-input-delta","id":"call_1","delta":"{\\"file_path\\":"}',
      '{"type":"tool-input-delta","id":"call_1","delta":"\\"/a.txt\\"}"}',
      '{"type":"tool-input-end","id":"call_1"}',
    ])
    expect(parts).toEqual([
      { type: "tool-input-start", id: "call_1", toolName: "write_file" },
      { type: "tool-input-delta", id: "call_1", delta: '{"file_path":' },
      { type: "tool-input-delta", id: "call_1", delta: '"/a.txt"}' },
      { type: "tool-input-end", id: "call_1" },
    ])
  })

  test("增量事件跨 chunk 切断（一行被劈成多段、含多字节 UTF-8 序列中间）仍完整拼回", () => {
    const stream = makeStream()
    stream.head()
    const whole = '{"type":"tool-input-delta","id":"call_1","delta":"中文字段"}\n'
    const bytes = encoder.encode(whole)
    const cut = 52 // 第一个多字节字符的第二个字节处
    const first = stream.push(bytes.slice(0, cut))
    const second = stream.push(bytes.slice(cut))
    expect(first).toEqual([])
    expect(second).toEqual([{ type: "tool-input-delta", id: "call_1", delta: "中文字段" }])
  })

  test("tool-call 字段名兼容：input│args│arguments 与 toolCallId│id", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, [
      '{"type":"tool-call","toolCallId":"c1","toolName":"read_file","input":{"file_path":"/a"}}',
      '{"type":"tool-call","id":"c2","toolName":"read_file","args":{"file_path":"/b"}}',
      '{"type":"tool-call","toolCallId":"c3","toolName":"read_file","arguments":{"file_path":"/c"}}',
    ])
    expect(parts).toEqual([
      { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: '{"file_path":"/a"}' },
      { type: "tool-call", toolCallId: "c2", toolName: "read_file", input: '{"file_path":"/b"}' },
      { type: "tool-call", toolCallId: "c3", toolName: "read_file", input: '{"file_path":"/c"}' },
    ])
  })

  test("tool-call 的 input 已是字符串时原样透传，缺失时兜底空对象", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, [
      '{"type":"tool-call","toolCallId":"c1","toolName":"t","input":"{\\"x\\":1}"}',
      '{"type":"tool-call","toolCallId":"c2","toolName":"t"}',
    ])
    expect(parts[0]).toEqual({ type: "tool-call", toolCallId: "c1", toolName: "t", input: '{"x":1}' })
    expect(parts[1]).toEqual({ type: "tool-call", toolCallId: "c2", toolName: "t", input: "{}" })
  })
})

describe("事件全表：收据与总账单", () => {
  test("finish-step 为收据：不立即产 finish part，response 元信息照收为 response-metadata", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, [CAPTURE_FINISH_STEP])
    expect(parts).toEqual([
      {
        type: "response-metadata",
        id: "489472a3-20e1-4510-80f2-9ac8d490cfa7",
        timestamp: new Date("2026-08-30T15:23:02.000Z"),
        modelId: "deepseek-v4-flash",
      },
    ])
  })

  test("finish 为总账单：恰产一个 finish part，usage=totalUsage 归一、finishReason 双形态", () => {
    const stream = makeStream()
    stream.head()
    pushLines(stream, [CAPTURE_FINISH_STEP])
    const [part] = pushLines(stream, [CAPTURE_FINISH])
    expect(part).toMatchObject({ type: "finish" })
    const finish = part as Extract<LanguageModelV3StreamPart, { type: "finish" }>
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" })
    expect(finish.usage.inputTokens).toEqual({ total: 16977, noCache: 11601, cacheRead: 5376, cacheWrite: undefined })
    expect(finish.usage.outputTokens).toEqual({ total: 27, text: 2, reasoning: 25 })
    const second = pushLines(stream, [CAPTURE_FINISH])
    expect(second).toEqual([])
  })

  test("response-metadata 事件照收（元信息字段缺省则不产 part）", () => {
    const stream = makeStream()
    stream.head()
    expect(pushLines(stream, ['{"type":"response-metadata","id":"resp_1"}'])).toEqual([{ type: "response-metadata", id: "resp_1" }])
    expect(pushLines(stream, ['{"type":"response-metadata"}'])).toEqual([])
  })
})

describe("usage 归一", () => {
  test("capture 样本 camelCase：noCache 取 noCacheTokens 优先", () => {
    const usage = normalizeUsage(CAPTURE_USAGE)
    expect(usage.inputTokens).toEqual({ total: 16977, noCache: 11601, cacheRead: 5376, cacheWrite: undefined })
    expect(usage.outputTokens).toEqual({ total: 27, text: 2, reasoning: 25 })
    expect(usage.raw).toEqual(CAPTURE_USAGE)
  })

  test("snake_case 双兼容；noCacheTokens 缺省时取 total − cacheRead", () => {
    const usage = normalizeUsage({
      input_tokens: 16977,
      output_tokens: 27,
      input_token_details: { cache_read_tokens: 5376 },
      output_token_details: { text_tokens: 27 },
    })
    expect(usage.inputTokens.total).toBe(16977)
    expect(usage.inputTokens.noCache).toBe(16977 - 5376)
    expect(usage.inputTokens.cacheRead).toBe(5376)
    expect(usage.outputTokens).toEqual({ total: 27, text: 27, reasoning: undefined })
  })

  test("prompt_tokens / completion_tokens 变体与缓存命中字段", () => {
    const usage = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_cache_hit_tokens: 40,
      prompt_cache_miss_tokens: 60,
      completion_tokens_details: { reasoning_tokens: 5 },
    })
    expect(usage.inputTokens.total).toBe(100)
    expect(usage.inputTokens.noCache).toBe(60)
    expect(usage.inputTokens.cacheRead).toBe(40)
    expect(usage.outputTokens.reasoning).toBe(5)
  })

  test("非对象 usage 兜底为零值形状", () => {
    const usage = normalizeUsage(undefined)
    expect(usage.inputTokens).toEqual({ total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined })
    expect(usage.outputTokens).toEqual({ total: undefined, text: undefined, reasoning: undefined })
  })
})

describe("finishReason 词表归一", () => {
  test("stop│end_turn → stop；tool_calls│tool-calls → tool-calls；length 三变体 → length", () => {
    expect(normalizeFinishReason("stop")).toEqual({ unified: "stop", raw: "stop" })
    expect(normalizeFinishReason("end_turn")).toEqual({ unified: "stop", raw: "end_turn" })
    expect(normalizeFinishReason("tool_calls")).toEqual({ unified: "tool-calls", raw: "tool_calls" })
    expect(normalizeFinishReason("tool-calls")).toEqual({ unified: "tool-calls", raw: "tool-calls" })
    expect(normalizeFinishReason("length")).toEqual({ unified: "length", raw: "length" })
    expect(normalizeFinishReason("max_tokens")).toEqual({ unified: "length", raw: "max_tokens" })
    expect(normalizeFinishReason("max_output_tokens")).toEqual({ unified: "length", raw: "max_output_tokens" })
  })

  test("表外值归 other，原文保留在 raw 不丢失", () => {
    expect(normalizeFinishReason("content_filter")).toEqual({ unified: "other", raw: "content_filter" })
    expect(normalizeFinishReason(undefined)).toEqual({ unified: "other", raw: undefined })
  })
})

describe("NDJSON 严格性（§6 否决项不回流）", () => {
  test("空行与 : 注释行跳过；未知事件类型静默忽略", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, [
      "",
      ": keep-alive comment",
      '{"type":"provider-metadata","providerMetadata":{"gateway":{"cost":"0.0026"}}}',
      '{"type":"totally-new-future-event","payload":{"x":1}}',
    ])
    expect(parts).toEqual([])
  })

  test("不做 SSE 双兼容：data: 前缀不被剥壳，按严格 NDJSON 报解析错误且不产生 text-delta", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, ['data: {"type":"text-delta","id":"t","text":"x"}'])
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe("error")
    expect(stream.push(encoder.encode("[DONE]\n"))).toEqual([]) // 错误后流终止，不再翻译
  })

  test("malformed JSON 行产错误 part（严格解析，不吞错）", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, ['{"type":"text-delta", broken'])
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe("error")
  })

  test("非事件形状的 JSON 行（数组 / 标量 / 缺 type）各自产错误 part", () => {
    for (const line of ["[1,2]", "42", '{"noTypeHere":true}']) {
      const stream = makeStream()
      stream.head()
      const parts = pushLines(stream, [line])
      expect(parts[0]?.type).toBe("error")
    }
  })
})

describe("半行残片两结局（§2 / §3 行 8）", () => {
  test("未收 finish-step：EOF 残片并入截断错误（STREAM_CLOSED、可重试、message 含 model id）", () => {
    const stream = makeStream()
    stream.head()
    pushLines(stream, ['{"type":"text-start","id":"txt-0"}'])
    stream.push(encoder.encode('{"type":"text-delta","id":"txt-0","text":"未完')) // 无换行
    const parts = stream.end()
    expect(parts).toHaveLength(1)
    const part = parts[0]
    expect(part?.type).toBe("error")
    const error = (part as { error: unknown }).error
    expect(error).toBeInstanceOf(StreamTruncatedError)
    const truncated = error as StreamTruncatedError
    expect(truncated.code).toBe("STREAM_CLOSED")
    expect(truncated.retriable).toBe(true)
    expect(truncated.partialLine).toBe('{"type":"text-delta","id":"txt-0","text":"未完')
    expect(truncated.message).toContain(MODEL_ID)
  })

  test("流关闭但整段无 finish-step（连残片都没有）同样报截断错误", () => {
    const stream = makeStream()
    stream.head()
    pushLines(stream, ['{"type":"text-start","id":"txt-0"}'])
    const parts = stream.end()
    expect(parts[0]?.type).toBe("error")
    expect((parts[0] as { error: StreamTruncatedError }).error).toBeInstanceOf(StreamTruncatedError)
  })

  test("已收 finish-step：EOF 残片按规格忽略，补发收据 finish part 正常收尾", () => {
    const stream = makeStream()
    stream.head()
    pushLines(stream, [CAPTURE_FINISH_STEP]) // 上游未发 finish 事件即断流
    stream.push(encoder.encode('{"type":"provider-met'))
    const parts = stream.end()
    expect(parts).toHaveLength(1)
    const finish = parts[0] as Extract<LanguageModelV3StreamPart, { type: "finish" }>
    expect(finish.type).toBe("finish")
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" })
    expect(finish.usage.inputTokens.total).toBe(16977)
    expect(finish.providerMetadata).toEqual({ gateway: { generationId: "gen_01M19M8N3NYP2DAB2RRH2PVGN6" } })
  })
})

describe("流中 error 事件（不吞错）", () => {
  test("error 事件浮出为 error part，message 含上游信息与 model id，其后事件不再翻译", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, [
      '{"type":"text-delta","id":"t","text":"前半"}',
      '{"type":"error","error":{"message":"upstream exploded"}}',
      '{"type":"finish","finishReason":"stop","totalUsage":{}}',
    ])
    const errorParts = parts.filter((part) => part.type === "error")
    expect(errorParts).toHaveLength(1)
    const message = (errorParts[0] as { error: Error }).error.message
    expect(message).toContain("upstream exploded")
    expect(message).toContain(MODEL_ID)
    expect(parts.some((part) => part.type === "finish")).toBe(false)
    expect(stream.end()).toEqual([])
  })

  test("error 事件兼容字符串 error 形状（message 含 model id）", () => {
    const stream = makeStream()
    stream.head()
    const parts = pushLines(stream, ['{"type":"error","error":"plain failure"}'])
    expect((parts[0] as { error: Error }).error.message).toContain("plain failure")
    expect((parts[0] as { error: Error }).error.message).toContain(MODEL_ID)
  })
})

describe("capture 样本整轮回放", () => {
  test("真实 wire 序列（start → reasoning → text → finish-step → finish → provider-metadata）全量映射", () => {
    const stream = makeStream()
    const parts = [
      ...stream.head(),
      ...pushLines(stream, [
        '{"type":"start"}',
        '{"type":"start-step","request":{"body":{}},"warnings":[]}',
        '{"type":"reasoning-start","id":"reasoning-0","providerMetadata":{"gateway":{"generationId":"gen_01M19M8N3NYP2DAB2RRH2PVGN6"}}}',
        '{"type":"reasoning-delta","id":"reasoning-0","text":"The"}',
        '{"type":"reasoning-delta","id":"reasoning-0","text":" user said OK."}',
        '{"type":"text-start","id":"txt-0"}',
        '{"type":"reasoning-end","id":"reasoning-0"}',
        '{"type":"text-delta","id":"txt-0","text":"OK"}',
        '{"type":"text-end","id":"txt-0"}',
        CAPTURE_FINISH_STEP,
        CAPTURE_FINISH,
        '{"type":"provider-metadata","providerMetadata":{"gateway":{"cost":"0.002607672"}}}',
      ]),
      ...stream.end(),
    ]
    expect(parts[0]).toEqual({ type: "stream-start", warnings: [...WARNINGS] })
    const types = parts.map((part) => part.type)
    expect(types).toEqual([
      "stream-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "text-start",
      "reasoning-end",
      "text-delta",
      "text-end",
      "response-metadata",
      "finish",
    ])
    const finish = parts.find((part) => part.type === "finish") as Extract<LanguageModelV3StreamPart, { type: "finish" }>
    expect(finish.finishReason.unified).toBe("stop")
    expect(finish.usage.outputTokens.total).toBe(27)
  })
})

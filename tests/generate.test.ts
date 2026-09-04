import { afterEach, describe, expect, jest, test } from "bun:test"
import { APICallError } from "@ai-sdk/provider"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { GENERATE_ENDPOINT, generateStream } from "../src/protocol/generate.ts"
import type { FetchLike } from "../src/protocol/json.ts"
import { StreamTruncatedError } from "../src/protocol/ndjson.ts"
import { CommandCodeApiCallError, watchdogTimeoutError } from "../src/protocol/errors.ts"

// 执行层集成（docs/spec/protocol.md §3–§4 + testing.md §2 的协议执行内核）：
// mock fetch（工厂 options.fetch 接缝）+ fake timers 驱动 300s 看门狗。
// LanguageModelV3 壳的装配归工厂票 #35；本层验证「一次上游调用」的错误映射、
// 看门狗、abort 传播与零输出合成。

const MODEL_ID = "deepseek/deepseek-v4-flash"
const BODY = { params: { model: MODEL_ID } } as never

const encoder = new TextEncoder()

function ndjsonResponse(...lines: string[]): Response {
  return new Response(encoder.encode(lines.map((line) => `${line}\n`).join("")))
}

function makeCall(opts: {
  fetchImpl?: import("../src/protocol/json.ts").FetchLike
  signal?: AbortSignal
  body?: unknown
  url?: string
}) {
  return generateStream({
    modelId: MODEL_ID,
    body: (opts.body as never) ?? BODY,
    headers: { authorization: "Bearer test" },
    fetchImpl: opts.fetchImpl ?? (async () => new Response("", { status: 200 })),
    signal: opts.signal,
    url: opts.url ?? GENERATE_ENDPOINT,
  })
}

/** 消费整个流：返回 parts 或捕获抛出的错误 */
async function collect(input: ReturnType<typeof makeCall>): Promise<{ parts: LanguageModelV3StreamPart[]; thrown: unknown }> {
  const parts: LanguageModelV3StreamPart[] = []
  try {
    for await (const part of input) parts.push(part)
    return { parts, thrown: undefined }
  } catch (error) {
    return { parts, thrown: error }
  }
}

const FINISH_USAGE_27 = {
  inputTokens: { total: 16977, noCache: 11601, cacheRead: 5376 },
  outputTokens: { total: 27, text: 2, reasoning: 25 },
}

afterEach(() => {
  jest.useRealTimers()
})

describe("2xx 好路径：mock NDJSON 流 → parts", () => {
  test("整轮（text + finish）正常产出，stream-start 携 warnings", async () => {
    const { parts, thrown } = await collect(
      makeCall({
        fetchImpl: async () =>
          ndjsonResponse(
            '{"type":"text-start","id":"t0"}',
            '{"type":"text-delta","id":"t0","text":"OK"}',
            '{"type":"text-end","id":"t0"}',
            '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":10,"outputTokens":2}}',
            '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":10,"outputTokens":2}}',
          ),
      }),
    )
    expect(thrown).toBeUndefined()
    expect(parts.map((part) => part.type)).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"])
    const finish = parts[parts.length - 1]
    expect(finish?.type).toBe("finish")
  })

  test("请求发出：POST 到 /alpha/generate、body 为信封 JSON、带调用方 headers", async () => {
    let seenUrl = ""
    let seenInit: RequestInit = {}
    const { parts } = await collect(
      makeCall({
        fetchImpl: async (url, init) => {
          seenUrl = String(url)
          seenInit = init ?? {}
          return ndjsonResponse('{"type":"finish-step","finishReason":"stop","usage":{}}')
        },
      }),
    )
    expect(seenUrl).toBe(GENERATE_ENDPOINT)
    expect(seenInit.method).toBe("POST")
    expect(JSON.parse(String(seenInit.body))).toEqual({ params: { model: MODEL_ID } })
    expect((seenInit.headers as Record<string, string>)?.["authorization"]).toBe("Bearer test")
    expect(parts.some((part) => part.type === "finish")).toBe(true)
  })
})

describe("行 1–6 端到端：HTTP 错误映射后 throw（APICallError 形态，可重试标注正确）", () => {
  test.each([
    [403, '{"error":{"message":"MODEL_NOT_IN_PLAN"}}', false, "MODEL_NOT_IN_PLAN"],
    [401, '{"error":{"message":"bad key"}}', false, "AUTH_ERROR"],
    [402, '{"error":{"message":"payment"}}', true, "PAYMENT_REQUIRED"],
    [429, '{"error":{"message":"slow"}}', true, "RATE_LIMITED"],
    [400, '{"error":{"message":"This model\'s maximum context length is 100000 tokens"}}', false, "CONTEXT_WINDOW_EXCEEDED"],
    [500, '{"error":{"message":"boom"}}', true, undefined],
    [503, '{"error":{"message":"unavailable"}}', true, undefined],
  ])("status %i → 抛出 APICallError（isRetryable=%s）", async (status, body, isRetryable, code) => {
    const { thrown } = await collect(
      makeCall({
        fetchImpl: async () => new Response(body, { status, headers: { "content-type": "application/json" } }),
      }),
    )
    expect(thrown).toBeDefined()
    expect(APICallError.isInstance(thrown)).toBe(true)
    const error = thrown as CommandCodeApiCallError
    expect(error.statusCode).toBe(status)
    expect(error.isRetryable).toBe(isRetryable)
    expect(error.message).toContain(MODEL_ID)
    if (code !== undefined) expect(error.code).toBe(code)
  })

  test("429 透传上游 retry-after", async () => {
    const { thrown } = await collect(
      makeCall({
        fetchImpl: async () => new Response("rate limited", { status: 429, headers: { "retry-after": "42" } }),
      }),
    )
    const error = thrown as CommandCodeApiCallError
    expect(error.retryAfterSeconds).toBe(42)
    expect(error.responseHeaders?.["retry-after"]).toBe("42")
  })

  test("403 MODEL_NOT_IN_PLAN 消息明确「不在套餐」且不指向 /connect", async () => {
    const { thrown } = await collect(
      makeCall({
        fetchImpl: async () =>
          new Response('{"error":{"message":"MODEL_NOT_IN_PLAN: not in plan"}}', { status: 403 }),
      }),
    )
    const message = (thrown as Error).message
    expect(message).toContain("不在当前套餐内")
    expect(message).not.toContain("/connect")
  })
})

describe("行 7：零输出合成 429（10s）", () => {
  test("finish-step + finish 但 outputTokens=0 且无 tool-call → error part（429/10s）替代 finish", async () => {
    const { parts, thrown } = await collect(
      makeCall({
        fetchImpl: async () =>
          ndjsonResponse(
            '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":5,"outputTokens":0}}',
            '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":0}}',
          ),
      }),
    )
    expect(thrown).toBeUndefined()
    expect(parts.some((part) => part.type === "finish")).toBe(false)
    const errorPart = parts.find((part) => part.type === "error")
    expect(errorPart).toBeDefined()
    const error = (errorPart as { error: CommandCodeApiCallError }).error
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error.statusCode).toBe(429)
    expect(error.isRetryable).toBe(true)
    expect(error.responseHeaders?.["retry-after"]).toBe("10")
    expect(error.message).toContain(MODEL_ID)
  })

  test("有 tool-call 的回合即使 outputTokens=0 也不合成零输出（防误杀工具回合）", async () => {
    const { parts, thrown } = await collect(
      makeCall({
        fetchImpl: async () =>
          ndjsonResponse(
            '{"type":"tool-call","toolCallId":"t1","toolName":"read","input":{"path":"a"}}',
            '{"type":"finish-step","finishReason":"tool_calls","usage":{"inputTokens":5,"outputTokens":0}}',
            '{"type":"finish","finishReason":"tool_calls","totalUsage":{"inputTokens":5,"outputTokens":0}}',
          ),
      }),
    )
    expect(thrown).toBeUndefined()
    expect(parts.some((part) => part.type === "finish")).toBe(true)
    expect(parts.some((part) => part.type === "error")).toBe(false)
  })

  test("正常输出回合不受零输出判定影响", async () => {
    const { parts } = await collect(
      makeCall({
        fetchImpl: async () =>
          ndjsonResponse(
            '{"type":"text-start","id":"t"}',
            '{"type":"text-delta","id":"t","text":"hi"}',
            '{"type":"text-end","id":"t"}',
            '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":5,"outputTokens":2}}',
            '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":2}}',
          ),
      }),
    )
    expect(parts.some((part) => part.type === "finish")).toBe(true)
    expect(parts.some((part) => part.type === "error")).toBe(false)
  })

  test("usage 缺失 outputTokens（未知）不合成零输出（防误杀）", async () => {
    const { parts } = await collect(
      makeCall({
        fetchImpl: async () =>
          ndjsonResponse(
            '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":5}}',
            '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5}}',
          ),
      }),
    )
    expect(parts.some((part) => part.type === "finish")).toBe(true)
    expect(parts.some((part) => part.type === "error")).toBe(false)
  })

  test("仅 finish-step、无 finish 事件（EOF 收据补发路径）零输出同样合成 429", async () => {
    // 上游发完 finish-step 即断流（无 finish 事件）：ndjson.end() 补发收据
    // finish part → 执行层零输出判定同样命中
    const { parts } = await collect(
      makeCall({
        fetchImpl: async () =>
          ndjsonResponse('{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":5,"outputTokens":0}}'),
      }),
    )
    expect(parts.some((part) => part.type === "finish")).toBe(false)
    const errorPart = parts.find((part) => part.type === "error")
    expect(errorPart).toBeDefined()
    const error = (errorPart as { error: CommandCodeApiCallError }).error
    expect(error.statusCode).toBe(429)
    expect(error.isRetryable).toBe(true)
    expect(error.responseHeaders?.["retry-after"]).toBe("10")
  })
})

describe("行 8–9：截断与流中 error 事件（不吞错）", () => {
  test("EOF 无 finish-step → error part（StreamTruncatedError 可重试）", async () => {
    const { parts, thrown } = await collect(
      makeCall({
        fetchImpl: async () => new Response(encoder.encode('{"type":"text-start","id":"t"}\n{"type":"text-delta","id":"t","text":"半')), // 半行截断
      }),
    )
    expect(thrown).toBeUndefined()
    const errorPart = parts.find((part) => part.type === "error")
    expect(errorPart).toBeDefined()
    const error = (errorPart as { error: StreamTruncatedError }).error
    expect(error).toBeInstanceOf(StreamTruncatedError)
    expect(error.isRetryable).toBe(true)
    expect(APICallError.isInstance(error)).toBe(true)
  })

  test("流中 error 事件浮出为 error part，已收 delta 保留", async () => {
    const { parts, thrown } = await collect(
      makeCall({
        fetchImpl: async () =>
          ndjsonResponse(
            '{"type":"text-delta","id":"t","text":"前半"}',
            '{"type":"error","error":{"message":"upstream exploded"}}',
            '{"type":"finish-step","finishReason":"stop","usage":{}}',
          ),
      }),
    )
    expect(thrown).toBeUndefined()
    expect(parts.some((part) => part.type === "text-delta")).toBe(true)
    const errorPart = parts.find((part) => part.type === "error")
    expect((errorPart as { error: CommandCodeApiCallError }).error.message).toContain("upstream exploded")
    expect((errorPart as { error: CommandCodeApiCallError }).error.message).toContain(MODEL_ID)
  })
})

describe("行 11 与网络层：响应前网络错误可重试", () => {
  test("fetch reject（DNS/连接拒绝）→ 网络错误、可重试", async () => {
    const { thrown } = await collect(
      makeCall({
        fetchImpl: async () => {
          throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.commandcode.ai")
        },
      }),
    )
    expect(thrown).toBeDefined()
    expect(APICallError.isInstance(thrown)).toBe(true)
    const error = thrown as CommandCodeApiCallError
    expect(error.isRetryable).toBe(true)
    expect(error.message).toContain(MODEL_ID)
    expect(error.message).toContain("网络错误")
  })

  test("HTTP 200 但读流中断（连接 reset）→ error part 可重试", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"text-delta","id":"t","text":"部'))
        controller.error(new TypeError("terminated: connection lost"))
      },
    })
    const { parts } = await collect(makeCall({ fetchImpl: async () => new Response(body, { status: 200 }) }))
    const errorPart = parts.find((part) => part.type === "error")
    expect(errorPart).toBeDefined()
    expect((errorPart as { error: CommandCodeApiCallError }).error.isRetryable).toBe(true)
  })
})

describe("看门狗（§4）：300s 空闲到点 abort 上游 + 可重试错误；连接期计入空闲", () => {
  test("响应挂起（连接阶段）300s 无事件 → 看门狗到点 abort fetch、抛可重试错误", async () => {
    jest.useFakeTimers()
    let seenSignal: AbortSignal | undefined
    const hangingFetch: FetchLike = (_url, init) => {
      const requestSignal = init?.signal ?? undefined
      seenSignal = requestSignal
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal.reason))
      })
    }
    const stream = makeCall({ fetchImpl: hangingFetch })
    const iterator = stream[Symbol.asyncIterator]()

    // 推进 fetch 挂起状态：300s 后看门狗触发 → fetch abort → 抛可重试错误
    const first = iterator.next()
    jest.advanceTimersByTime(300_000)
    let thrown: unknown
    try {
      await first
    } catch (error) {
      thrown = error
    }
    expect(seenSignal?.aborted).toBe(true)
    expect(thrown).toBeInstanceOf(CommandCodeApiCallError)
    const error = thrown as CommandCodeApiCallError
    expect(error.code).toBe("UPSTREAM_IDLE_TIMEOUT")
    expect(error.isRetryable).toBe(true)
    expect(error.responseHeaders?.["retry-after"]).toBe("5")
    expect(error.message).toContain(MODEL_ID)
    jest.useRealTimers()
  })

  test("流已开始但 300s 无新 chunk（上游失联）→ abort + watchdog error part", async () => {
    jest.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetchImpl: FetchLike = (_url, init) => {
      const requestSignal = init?.signal ?? undefined
      signal = requestSignal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"type":"text-start","id":"t"}\n'))
          requestSignal?.addEventListener("abort", () => controller.error(requestSignal.reason))
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }
    const iterator = makeCall({ fetchImpl })[Symbol.asyncIterator]()

    const head = await iterator.next() // 第一个 part：stream-start（head 产物）
    expect(head.done).toBe(false)
    expect((head.value as LanguageModelV3StreamPart).type).toBe("stream-start")

    const firstBody = await iterator.next() // 首个 chunk 的 parts（text-start）
    expect(firstBody.done).toBe(false)
    expect((firstBody.value as LanguageModelV3StreamPart).type).toBe("text-start")

    // 300s 无新事件 → 看门狗触发 → 读流中断 → error part（watchdog 错误）
    const second = iterator.next()
    jest.advanceTimersByTime(300_000)
    const secondResult = await second
    expect(secondResult.done).toBe(false)
    const errorPart = secondResult.value as Extract<LanguageModelV3StreamPart, { type: "error" }>
    expect(errorPart.type).toBe("error")
    expect(APICallError.isInstance(errorPart.error)).toBe(true)
    expect((errorPart.error as CommandCodeApiCallError).code).toBe("UPSTREAM_IDLE_TIMEOUT")
    expect((errorPart.error as CommandCodeApiCallError).isRetryable).toBe(true)
    const third = await iterator.next()
    expect(third.done).toBe(true)
    jest.useRealTimers()
  })

  test("看门狗错误对象形态：429/5s 可重试", () => {
    const error = watchdogTimeoutError(MODEL_ID, GENERATE_ENDPOINT, BODY)
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error.isRetryable).toBe(true)
    expect(error.responseHeaders?.["retry-after"]).toBe("5")
    expect(error.message).toContain(MODEL_ID)
  })
})

describe("行 10：客户端 abort → 上游 fetch abort，不合成任何错误", () => {
  test("调用方 abort → fetch signal abort 且流静默收尾（无 error part、无 throw）", async () => {
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const fetchImpl: FetchLike = (_url, init) => {
      const requestSignal = init?.signal ?? undefined
      seenSignal = requestSignal
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('{"type":"text-start","id":"t"}\n'))
          requestSignal?.addEventListener("abort", () => c.error(requestSignal.reason))
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }
    const iterator = makeCall({ fetchImpl, signal: controller.signal })[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)

    controller.abort() // 用户按停止键

    const rest: LanguageModelV3StreamPart[] = []
    let thrown: unknown
    try {
      for (;;) {
        const { done, value } = await iterator.next()
        if (done) break
        rest.push(value as LanguageModelV3StreamPart)
      }
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeUndefined() // 不合成错误
    expect(rest.every((part) => part.type !== "error")).toBe(true)
    expect(seenSignal?.aborted).toBe(true) // abort 传播到上游 fetch
  })

  test("连接阶段调用方 abort → 原样传播 AbortError（不包装成 provider 错误）", async () => {
    const controller = new AbortController()
    const fetchImpl: FetchLike = (_url, init) => {
      const requestSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal.reason))
      })
    }
    const stream = makeCall({ fetchImpl, signal: controller.signal })
    const iterator = stream[Symbol.asyncIterator]()
    const first = iterator.next()
    controller.abort(new DOMException("Aborted", "AbortError"))
    let thrown: unknown
    try {
      await first
    } catch (error) {
      thrown = error
    }
    // AbortError 原样传播（宿主识别为 aborted 而非错误），不包装成 provider 错误
    expect(thrown).toBeDefined()
    expect(thrown).not.toBeInstanceOf(CommandCodeApiCallError)
    expect((thrown as DOMException)?.name).toBe("AbortError")
  })
})

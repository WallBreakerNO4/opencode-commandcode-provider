import { describe, expect, test } from "bun:test"
import { APICallError } from "@ai-sdk/provider"
import {
  apiCallErrorFromHttpResponse,
  CommandCodeApiCallError,
  extractErrorMessage,
  isContextOverflowText,
  networkError,
  streamError,
  watchdogTimeoutError,
  zeroOutputError,
} from "../src/protocol/errors.ts"
import { StreamTruncatedError } from "../src/protocol/ndjson.ts"

// 错误映射十一行表全行（docs/spec/protocol.md §3），关键验收：
// - 错误对象一律 AI SDK APICallError 形态——宿主 APICallError.isInstance 能识别
//   （AI SDK 用 Symbol.for 标记跨副本识别，测试用 devDep @ai-sdk/provider 断言）
// - message 含 model id 与上游 message；可重试标注全部正确

const MODEL_ID = "deepseek/deepseek-v4-flash"
const URL = "https://api.commandcode.ai/alpha/generate"

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init)
}

describe("形态：AI SDK APICallError（宿主 isInstance 可识别）", () => {
  test("透传错误与合成错误都被宿主的 APICallError.isInstance 识别", () => {
    const mapped = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: {},
      status: 500,
      responseHeaders: headers(),
      responseBody: "boom",
    })
    expect(APICallError.isInstance(mapped)).toBe(true)
    expect(APICallError.isInstance(zeroOutputError(MODEL_ID, URL, {}))).toBe(true)
    expect(APICallError.isInstance(watchdogTimeoutError(MODEL_ID, URL, {}))).toBe(true)
    expect(APICallError.isInstance(networkError(MODEL_ID, URL, {}, new TypeError("fetch failed")))).toBe(true)
    expect(APICallError.isInstance(streamError(MODEL_ID, "流中错误"))).toBe(true)
    expect(APICallError.isInstance(new StreamTruncatedError("", MODEL_ID))).toBe(true)
  })

  test("错误对象为 Error 子类、name 与 AI SDK 一致、message 原样保留", () => {
    const error = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: { model: MODEL_ID },
      status: 429,
      responseHeaders: headers(),
      responseBody: '{"error":{"message":"slow down"}}',
    })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("AI_APICallError")
    expect(error).toBeInstanceOf(CommandCodeApiCallError)
  })
})

describe("行 1–2：401/403 的 MODEL_NOT_IN_PLAN 区分与认证错误", () => {
  test("403 含 MODEL_NOT_IN_PLAN → 模型不在套餐（非认证），不可重试，message 含模型 id 与上游 message", () => {
    const error = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: {},
      status: 403,
      responseHeaders: headers(),
      responseBody: '{"error":{"message":"MODEL_NOT_IN_PLAN: model not in your current plan"}}',
    })
    expect(error.code).toBe("MODEL_NOT_IN_PLAN")
    expect(error.statusCode).toBe(403)
    expect(error.isRetryable).toBe(false)
    expect(error.message).toContain(MODEL_ID)
    expect(error.message).toContain("不在当前套餐内")
    expect(error.message).toContain("model not in your current plan")
    expect(error.message).not.toContain("/connect")
  })

  test("401 无标记 → 认证错误，指向 /connect，不可重试", () => {
    const error = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: {},
      status: 401,
      responseHeaders: headers(),
      responseBody: '{"error":{"message":"invalid api key"}}',
    })
    expect(error.code).toBe("AUTH_ERROR")
    expect(error.statusCode).toBe(401)
    expect(error.isRetryable).toBe(false)
    expect(error.message).toContain("/connect")
    expect(error.message).toContain("invalid api key")
  })

  test("403 无 MODEL_NOT_IN_PLAN 标记 → 同样按认证错误处理", () => {
    const error = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: {},
      status: 403,
      responseHeaders: headers(),
      responseBody: '{"error":{"message":"forbidden"}}',
    })
    expect(error.code).toBe("AUTH_ERROR")
    expect(error.statusCode).toBe(403)
    expect(error.isRetryable).toBe(false)
  })
})

describe("行 3：402 → 配额窗口假设，可重试，默认退避 60s", () => {
  test("无上游 retry-after：合成 60s", () => {
    const error = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: {},
      status: 402,
      responseHeaders: headers(),
      responseBody: '{"error":{"message":"payment required"}}',
    })
    expect(error.statusCode).toBe(402)
    expect(error.isRetryable).toBe(true)
    expect(error.retryAfterSeconds).toBe(60)
    expect(error.responseHeaders?.["retry-after"]).toBe("60")
  })

  test("上游给了 retry-after：透传上游值", () => {
    const error = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: {},
      status: 402,
      responseHeaders: headers({ "retry-after": "120" }),
      responseBody: "payment required",
    })
    expect(error.isRetryable).toBe(true)
    expect(error.retryAfterSeconds).toBe(120)
    expect(error.responseHeaders?.["retry-after"]).toBe("120")
  })
})

describe("行 4：429 → 限流可重试，透传上游 retry-after", () => {
  test("透传 retry-after 头", () => {
    const error = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: {},
      status: 429,
      responseHeaders: headers({ "retry-after": "30" }),
      responseBody: '{"error":{"message":"rate limited"}}',
    })
    expect(error.statusCode).toBe(429)
    expect(error.isRetryable).toBe(true)
    expect(error.retryAfterSeconds).toBe(30)
    expect(error.responseHeaders?.["retry-after"]).toBe("30")
  })

  test("上游无 retry-after：缺省用默认退避（不合成）", () => {
    const error = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: {},
      status: 429,
      responseHeaders: headers(),
      responseBody: "rate limited",
    })
    expect(error.isRetryable).toBe(true)
    expect(error.retryAfterSeconds).toBeUndefined()
  })
})

describe("行 5：400 + 上下文超限特征 → 明确报「上下文窗口超限」，不可重试", () => {
  test("body 命中 context window 特征 → 上下文窗口超限错误", () => {
    const error = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: {},
      status: 400,
      responseHeaders: headers(),
      responseBody: '{"error":{"message":"This model\'s maximum context length is 200000 tokens"}}',
    })
    expect(error.code).toBe("CONTEXT_WINDOW_EXCEEDED")
    expect(error.isRetryable).toBe(false)
    expect(error.message).toContain("上下文窗口超限")
    expect(error.message).toContain(MODEL_ID)
    expect(error.message).toContain("maximum context length is 200000 tokens")
  })

  test("特征识别词表覆盖 context_length_exceeded 等网关表达", () => {
    for (const text of [
      "context_length_exceeded",
      "exceeds the context window",
      "input token count exceeds the maximum context length",
      "too many tokens",
      "maximum prompt length is 1000000",
    ]) {
      expect(isContextOverflowText(text)).toBe(true)
    }
  })

  test("413 类宽泛文案（request entity too large）不误报为上下文超限", () => {
    expect(isContextOverflowText("request entity too large")).toBe(false)
  })

  test("普通 400（非上下文超限）→ 按表外 4xx 透传、不可重试", () => {
    const error = apiCallErrorFromHttpResponse({
      modelId: MODEL_ID,
      url: URL,
      requestBodyValues: {},
      status: 400,
      responseHeaders: headers(),
      responseBody: '{"error":{"message":"bad request: unknown field"}}',
    })
    expect(error.statusCode).toBe(400)
    expect(error.isRetryable).toBe(false)
    expect(error.message).toContain("unknown field")
  })
})

describe("行 6：5xx 透传状态码，可重试", () => {
  for (const status of [500, 502, 503, 504]) {
    test(`${status} → 透传、可重试、message 含 model id 与上游 message`, () => {
      const error = apiCallErrorFromHttpResponse({
        modelId: MODEL_ID,
        url: URL,
        requestBodyValues: {},
        status,
        responseHeaders: headers(),
        responseBody: `{"error":{"message":"upstream ${status}"}}`,
      })
      expect(error.statusCode).toBe(status)
      expect(error.isRetryable).toBe(true)
      expect(error.message).toContain(MODEL_ID)
      expect(error.message).toContain(`upstream ${status}`)
    })
  }
})

describe("行 7：零输出合成 429（retry-after 10s）", () => {
  test("形态与语义：429、可重试、10s", () => {
    const error = zeroOutputError(MODEL_ID, URL, {})
    expect(error.statusCode).toBe(429)
    expect(error.isRetryable).toBe(true)
    expect(error.retryAfterSeconds).toBe(10)
    expect(error.responseHeaders?.["retry-after"]).toBe("10")
    expect(error.message).toContain(MODEL_ID)
  })
})

describe("行 8：截断（STREAM_CLOSED）可重试", () => {
  test("StreamTruncatedError 为 APICallError 形态、可重试、message 含 model id 与残片", () => {
    const error = new StreamTruncatedError('{"type":"text-delta","text":"未完', MODEL_ID)
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error.code).toBe("STREAM_CLOSED")
    expect(error.isRetryable).toBe(true)
    expect(error.message).toContain(MODEL_ID)
    expect(error.message).toContain("text-delta")
  })
})

describe("行 9：流中 error 事件浮出（交 OpenCode 判断，不吞错）", () => {
  test("streamError 形态：APICallError 形态、不带可重试标注、message 含 model id 与上游 message", () => {
    const error = streamError(MODEL_ID, "上游流中报错：upstream exploded")
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error.isRetryable).toBe(false) // 交 OpenCode 判断，provider 不表态
    expect(error.message).toContain(MODEL_ID)
    expect(error.message).toContain("upstream exploded")
  })
})

describe("行 11：响应前网络错误可重试", () => {
  test("DNS/连接拒绝类错误 → 网络错误、可重试、cause 保留", () => {
    const cause = new TypeError("fetch failed: getaddrinfo ENOTFOUND api.commandcode.ai")
    const error = networkError(MODEL_ID, URL, {}, cause)
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error.isRetryable).toBe(true)
    expect(error.message).toContain(MODEL_ID)
    expect(error.message).toContain("getaddrinfo ENOTFOUND")
  })
})

describe("错误信封解析（§3 底部约定）", () => {
  test('{"error":{"message":...}} 优先', () => {
    expect(extractErrorMessage('{"error":{"message":"inner msg"}}')).toBe("inner msg")
  })

  test("兜底 parsed.message（brent）", () => {
    expect(extractErrorMessage('{"message":"top msg"}')).toBe("top msg")
  })

  test("非 JSON body 兜底原文；空 body 给占位", () => {
    expect(extractErrorMessage("plain text error")).toBe("plain text error")
    expect(extractErrorMessage("")).toBe("（上游未返回可读信息）")
  })
})

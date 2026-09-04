/**
 * 协议核心·错误映射（契约：docs/spec/protocol.md §3 十一行表）。
 *
 * 错误对象一律是 AI SDK `APICallError` 形态：透传/合成 statusCode、标注
 * isRetryable（重试由 OpenCode 决定，provider 不自行重试）、message 含
 * model id 与上游 message。宿主对 provider 错误的分类靠
 * `APICallError.isInstance`——AI SDK 用全局 Symbol 标记跨副本识别
 * （`Symbol.for("vercel.ai.error.AI_APICallError")`，provider 3.0.8 实测），
 * 本模块零运行时依赖，只按同款机制在实例上打标记，宿主即可正确分类
 * （测试用 devDep @ai-sdk/provider 的 isInstance 断言验证）。
 *
 * 错误信封统一按 `{"error":{"message":"..."}}` 解析，兜底 `parsed.message`
 * （brent 实证），两处都拿不到时回退 HTTP 状态文本。
 */

import { IDLE_WATCHDOG_TIMEOUT_MS } from "./watchdog.js"

// AI SDK 错误标记：AISDKError 基类与 APICallError 子类各一个全局 symbol。
// 名称来自 @ai-sdk/provider 3.0.8 源码（src/errors/ai-sdk-error.ts 与
// api-call-error.ts），宿主与 provider 副本间靠 Symbol.for 全局注册表互认。
const AISDK_ERROR_MARKER = Symbol.for("vercel.ai.error")
const API_CALL_ERROR_MARKER = Symbol.for("vercel.ai.error.AI_APICallError")

/** AI SDK APICallError 的公开字段（provider 3.0.8 形状，零依赖复刻） */
export interface ApiCallErrorFields {
  /** 人类可读错误消息：必含 model id，尽量含上游 message（§3 总则） */
  message: string
  url?: string
  requestBodyValues?: unknown
  statusCode?: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  isRetryable: boolean
  /** 本插件附加：合成错误的推荐退避秒数（调用方/宿主可读） */
  retryAfterSeconds?: number
  cause?: unknown
}

/** 十一行表错误信封载体：AI SDK APICallError 形态（含跨包识别标记） */
export class CommandCodeApiCallError extends Error implements ApiCallErrorFields {
  readonly url?: string
  readonly requestBodyValues?: unknown
  readonly statusCode?: number
  readonly responseHeaders?: Record<string, string>
  readonly responseBody?: string
  readonly isRetryable: boolean
  readonly retryAfterSeconds?: number
  /** 合成错误的语义码（如零输出/看门狗超时），透传错误时为 undefined */
  readonly code?: string

  constructor(fields: ApiCallErrorFields & { code?: string }) {
    super(fields.message, { cause: fields.cause })
    // 与 AI SDK 同名：宿主按 name 兜底分类时不错认（真正识别走 Symbol 标记）
    this.name = "AI_APICallError"
    this.url = fields.url
    this.requestBodyValues = fields.requestBodyValues
    this.statusCode = fields.statusCode
    this.responseHeaders = fields.responseHeaders
    this.responseBody = fields.responseBody
    this.isRetryable = fields.isRetryable
    this.retryAfterSeconds = fields.retryAfterSeconds
    this.code = fields.code
    // 打 AI SDK 跨包识别标记：宿主的 APICallError.isInstance 由此通过
    ;(this as unknown as Record<symbol, boolean>)[AISDK_ERROR_MARKER] = true
    ;(this as unknown as Record<symbol, boolean>)[API_CALL_ERROR_MARKER] = true
  }
}

/** 十一行表行 7：零输出合成 429（retry-after 10s），防白跑一回合 */
export function zeroOutputError(modelId: string, url: string, requestBodyValues: unknown): CommandCodeApiCallError {
  return new CommandCodeApiCallError({
    code: "ZERO_OUTPUT",
    message: `[${modelId}] 上游回合零输出（模型未生成任何 token），已按可重试处理`,
    url,
    requestBodyValues,
    statusCode: 429,
    responseHeaders: { "retry-after": "10" },
    isRetryable: true,
    retryAfterSeconds: 10,
  })
}

/** 看门狗到点（§4）：上游 300s 无事件 = 失联，可重试（retry-after 5s） */
export function watchdogTimeoutError(modelId: string, url: string, requestBodyValues: unknown): CommandCodeApiCallError {
  return new CommandCodeApiCallError({
    code: "UPSTREAM_IDLE_TIMEOUT",
    message: `[${modelId}] 上游 ${IDLE_WATCHDOG_TIMEOUT_MS / 1000} 秒无事件（疑似失联），连接已断开，可重试`,
    url,
    requestBodyValues,
    statusCode: 429,
    responseHeaders: { "retry-after": "5" },
    isRetryable: true,
    retryAfterSeconds: 5,
  })
}

/** 行 11：响应前网络错误（DNS / 连接拒绝 / TLS），可重试 */
export function networkError(modelId: string, url: string, requestBodyValues: unknown, cause: unknown): CommandCodeApiCallError {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new CommandCodeApiCallError({
    message: `[${modelId}] 网络错误（无法连接上游：${reason}）`,
    url,
    requestBodyValues,
    isRetryable: true,
  })
}

/**
 * 流内错误（无 HTTP 状态可透传）：可重试性由错误自身语义决定（行 8 截断可
 * 重试；行 9 error 事件交 OpenCode 判断）。错误对象同为 APICallError 形态，
 * 宿主 fromError 分类与 message/responseBody 匹配照常生效。
 */
export function streamError(modelId: string, message: string, opts?: { isRetryable?: boolean; code?: string; cause?: unknown }): CommandCodeApiCallError {
  return new CommandCodeApiCallError({
    message: `[${modelId}] ${message}`,
    isRetryable: opts?.isRetryable ?? false,
    code: opts?.code,
  })
}

/**
 * 流关闭但未收到 `finish-step`：无法确认回复完整（§3 行 8，jiesou 的
 * STREAM_CLOSED）。APICallError 形态、可重试；`partialLine` 供排查。
 * （ndjson.ts re-export 本类，流解析层错误统一由此构造。）
 */
export class StreamTruncatedError extends CommandCodeApiCallError {
  /** 早期解析层消费者读取的兼容别名（与 isRetryable 同值） */
  readonly retriable = true
  /** EOF 时未完结的半行残片，并入错误供排查 */
  readonly partialLine: string

  constructor(partialLine: string, modelId: string) {
    const tail = partialLine ? `，截断残片：${clip(partialLine, 200)}` : ""
    super({
      message: `[${modelId}] 上游流在 finish-step 之前关闭，回复可能不完整${tail}`,
      isRetryable: true,
      code: "STREAM_CLOSED",
    })
    this.partialLine = partialLine
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 十一行表行 1–6 的 HTTP 层映射：把非 2xx 响应翻译成 APICallError 形态。
 * 401/403 按 body 是否含 MODEL_NOT_IN_PLAN 区分「模型不在套餐」与认证错误；
 * 402 按配额窗口假设合成 retry-after 60s；429 透传上游 retry-after（缺省不合成）；
 * 400 命中上下文超限特征时明确报「上下文窗口超限」；5xx 透传状态码。
 * 表外状态码：4xx 透传不可重试，5xx 可重试（真变更走规格修订，不在此发散）。
 */
export function apiCallErrorFromHttpResponse(input: {
  modelId: string
  url: string
  requestBodyValues: unknown
  status: number
  responseHeaders: Headers
  responseBody: string
}): CommandCodeApiCallError {
  const { modelId, url, requestBodyValues, status, responseHeaders, responseBody } = input
  const upstream = extractErrorMessage(responseBody)

  const headersRecord = headerRecord(responseHeaders)
  const retryAfter = responseHeaders.get("retry-after")

  // 行 1：401/403 + MODEL_NOT_IN_PLAN → 「模型不在套餐」，区别于认证失败
  if ((status === 401 || status === 403) && responseBody.includes("MODEL_NOT_IN_PLAN")) {
    return new CommandCodeApiCallError({
      code: "MODEL_NOT_IN_PLAN",
      message: `[${modelId}] 模型不在当前套餐内（MODEL_NOT_IN_PLAN）：${upstream}`,
      url,
      requestBodyValues,
      statusCode: status,
      responseHeaders: headersRecord,
      responseBody,
      isRetryable: false,
    })
  }

  // 行 2：401/403 其他 → 认证错误，指向 /connect 重新登录
  if (status === 401 || status === 403) {
    return new CommandCodeApiCallError({
      code: "AUTH_ERROR",
      message: `[${modelId}] 认证失败（${status}）：key 无效或已过期，请重新运行 /connect 登录。上游：${upstream}`,
      url,
      requestBodyValues,
      statusCode: status,
      responseHeaders: headersRecord,
      responseBody,
      isRetryable: false,
    })
  }

  // 行 3：402 → 配额窗口恢复假设，退避拉长（默认 60s；HTTP-date 格式的
  // retry-after 无法转秒数，按缺省 60s 处理）
  if (status === 402) {
    const parsed = retryAfter !== null ? Number(retryAfter) : NaN
    const upstreamSeconds = Number.isFinite(parsed) ? parsed : 60
    return new CommandCodeApiCallError({
      code: "PAYMENT_REQUIRED",
      message: `[${modelId}] 402 配额或计费问题（上游：${upstream}），按窗口恢复假设处理`,
      url,
      requestBodyValues,
      statusCode: status,
      responseHeaders: { ...headersRecord, "retry-after": String(upstreamSeconds) },
      responseBody,
      isRetryable: true,
      retryAfterSeconds: upstreamSeconds,
    })
  }

  // 行 4：429 → 限流，透传上游 retry-after；缺省用默认退避（不合成）
  if (status === 429) {
    const parsed = retryAfter !== null ? Number(retryAfter) : undefined
    return new CommandCodeApiCallError({
      code: "RATE_LIMITED",
      message: `[${modelId}] 429 限流（上游：${upstream}）`,
      url,
      requestBodyValues,
      statusCode: status,
      responseHeaders: headersRecord,
      responseBody,
      isRetryable: true,
      retryAfterSeconds: Number.isFinite(parsed as number) ? (parsed as number) : undefined,
    })
  }

  // 行 5：400 + 上下文超限特征 → 明确报「上下文窗口超限」
  if (status === 400 && isContextOverflowText(responseBody)) {
    return new CommandCodeApiCallError({
      code: "CONTEXT_WINDOW_EXCEEDED",
      message: `[${modelId}] 400 上下文窗口超限（请求超出模型上下文容量）：${upstream}`,
      url,
      requestBodyValues,
      statusCode: status,
      responseHeaders: headersRecord,
      responseBody,
      isRetryable: false,
    })
  }

  // 行 6：5xx 透传状态码，可重试
  if (status >= 500) {
    return new CommandCodeApiCallError({
      message: `[${modelId}] 上游 ${status}（${upstream}）`,
      url,
      requestBodyValues,
      statusCode: status,
      responseHeaders: headersRecord,
      responseBody,
      isRetryable: true,
    })
  }

  // 表外 4xx：透传、不可重试（规格外情形，行为保守）
  return new CommandCodeApiCallError({
    message: `[${modelId}] 上游 ${status}（${upstream}）`,
    url,
    requestBodyValues,
    statusCode: status,
    responseHeaders: headersRecord,
    responseBody,
    isRetryable: false,
  })
}

/** 错误信封解析：`{"error":{"message":...}}` 优先，兜底 `parsed.message`，再兜底截断原文 */
export function extractErrorMessage(responseBody: string): string {
  try {
    const parsed: unknown = JSON.parse(responseBody)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const error = record["error"]
      if (typeof error === "object" && error !== null && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>)["message"]
        if (typeof message === "string" && message.length > 0) return message
      }
      const message = record["message"]
      if (typeof message === "string" && message.length > 0) return message
    }
  } catch {
    // 非 JSON body 走兜底
  }
  const trimmed = responseBody.trim()
  return trimmed.length > 0 ? trimmed : "（上游未返回可读信息）"
}

/**
 * 上下文超限特征（400 body 文本判定）：命中即行 5「上下文窗口超限」。
 * 词表覆盖网关常见表达（context length / window / token limit / prompt 过长等），
 * 从 jiesou/brent 的判据与宿主 opencode 的 isContextOverflow 词表归纳。
 * 收敛到与「上下文容量」强相关的短语：宽泛的 413 类文案（request entity too
 * large 等）不放进来——图片超限的 400 不该被误报成上下文超限（§5 提示用户
 * 该缩图而非压缩上下文）。
 */
export function isContextOverflowText(bodyText: string): boolean {
  const patterns = [
    /context length/i,
    /context window/i,
    /context[_ -]?limit/i,
    /maximum context/i,
    /token limit/i,
    /too many tokens/i,
    /prompt is too long/i,
    /input is too long/i,
    /reduce the length/i,
    /context_length_exceeded/i,
    /model_context_window_exceeded/i,
    /maximum prompt length/i,
    /max context/i,
  ]
  return patterns.some((pattern) => pattern.test(bodyText))
}

/** Headers → 小写键 Record（透传进错误对象的 responseHeaders，宿主按小写键读） */
function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value
  })
  return record
}

/**
 * 协议核心·响应方向：`/alpha/generate` 的 NDJSON 事件流 → AI SDK stream part
 * （契约：docs/spec/protocol.md §2）。
 *
 * 严格 NDJSON：按行切分、逐行 `JSON.parse`；跳过空行与 `:` 注释行。不做 SSE 双兼容
 * （不剥 `data:`、不认 `[DONE]`、不做 `\r\n` 归一——§6 否决项：上游格式真变更时
 * 错误浮出、修改本项目适配，不预做兼容）。
 *
 * 事件消费全表：`start`/`start-step`（流开始，由 head 的 stream-start 承担）、
 * text/reasoning/tool-input 三组块生命周期（`tool-input-*` 增量必做）、
 * `tool-call`（字段名兼容 `input│args│arguments` 与 `toolCallId│id`）、
 * `finish-step` 收据、`finish` 总账单、`response-metadata` 照收、
 * `error` 不吞错、未知 type 静默忽略。
 *
 * 半行残片两结局（§2 / §3 行 8）：EOF 时已收 `finish-step` 则忽略残片并补发收据
 * finish part；未收到则并入截断错误（APICallError 形态的映射归协议核心 II）。
 */

import type {
  JSONObject,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
  SharedV3Warning,
} from "@ai-sdk/provider"
import { asRecord } from "./json.js"

/** 流关闭但未收到 `finish-step`：无法确认回复完整（§3 行 8，jiesou 的 STREAM_CLOSED）。
 * 重试交 OpenCode 决定，provider 不自行重试。 */
export class StreamTruncatedError extends Error {
  readonly code = "STREAM_CLOSED"
  readonly retriable = true
  /** EOF 时未完结的半行残片，并入错误供排查 */
  readonly partialLine: string

  constructor(partialLine: string, modelId: string) {
    const tail = partialLine ? `，截断残片：${clip(partialLine, 200)}` : ""
    super(`[${modelId}] 上游流在 finish-step 之前关闭，回复可能不完整${tail}`)
    this.name = "StreamTruncatedError"
    this.partialLine = partialLine
  }
}

export interface NdjsonStreamContext {
  /** wire id——错误 message 需含 model id（§3） */
  modelId: string
  /** 调用 warnings（buildEnvelope 产出），随首个 stream-start part 上报 */
  warnings: SharedV3Warning[]
}

export interface NdjsonEventStream {
  /** 流的第一个 part：`stream-start`（AI SDK 约定 warnings 随首个 part 交给调用方）。
   * 仅首次调用产出，之后返回空。 */
  head(): LanguageModelV3StreamPart[]
  /** 喂一段响应体字节（UTF-8 解码可跨 chunk、按 `\n` 切行、逐行翻译） */
  push(chunk: Uint8Array): LanguageModelV3StreamPart[]
  /** EOF：已收 finish-step → 补发收据 finish part；未收 → 截断错误 part */
  end(): LanguageModelV3StreamPart[]
}

interface StepReceipt {
  finishReason?: string
  usage: unknown
  providerMetadata?: SharedV3ProviderMetadata
}

/** 已通过「对象且含字符串 type」校验的行记录（即一个 NDJSON 事件） */
type NdjsonEvent = Record<string, unknown>

export function createNdjsonEventStream(context: NdjsonStreamContext): NdjsonEventStream {
  const decoder = new TextDecoder()
  let buffer = ""
  let receipt: StepReceipt | null = null
  let headEmitted = false
  let finishEmitted = false
  let abortedByError = false

  function errorPart(error: unknown): LanguageModelV3StreamPart {
    return { type: "error", error }
  }

  function withModelId(message: string): string {
    return `[${context.modelId}] ${message}`
  }

  function translateLine(line: string): LanguageModelV3StreamPart[] {
    if (line === "" || line.startsWith(":")) return []

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      abortedByError = true
      const reason = error instanceof Error ? error.message : String(error)
      return [errorPart(new Error(withModelId(`上游 NDJSON 行无法解析：${clip(line, 200)}（${reason}）`)))]
    }

    const record = asRecord(parsed)
    const type = record === null ? undefined : str(record["type"])
    if (record === null || type === undefined) {
      // 无事件形状的 JSON（数组、标量、缺 type 的对象）：严格 NDJSON 下视为行级损坏
      abortedByError = true
      return [errorPart(new Error(withModelId(`上游 NDJSON 行不是事件对象：${clip(line, 200)}`)))]
    }

    switch (type) {
      // 流开始由 head() 的 stream-start 承担（AI SDK 契约：warnings 必须随首个 part）
      case "start":
      case "start-step":
        return []
      case "text-start":
        return [{ type: "text-start", id: str(record["id"]) ?? "", ...providerMeta(record) }]
      case "text-delta":
        return [{ type: "text-delta", id: str(record["id"]) ?? "", delta: str(record["text"]) ?? "", ...providerMeta(record) }]
      case "text-end":
        return [{ type: "text-end", id: str(record["id"]) ?? "", ...providerMeta(record) }]
      case "reasoning-start":
        return [{ type: "reasoning-start", id: str(record["id"]) ?? "", ...providerMeta(record) }]
      case "reasoning-delta":
        return [{ type: "reasoning-delta", id: str(record["id"]) ?? "", delta: str(record["text"]) ?? "", ...providerMeta(record) }]
      case "reasoning-end":
        return [{ type: "reasoning-end", id: str(record["id"]) ?? "", ...providerMeta(record) }]
      case "tool-input-start":
        return [
          {
            type: "tool-input-start",
            id: str(record["id"]) ?? "",
            toolName: str(record["toolName"]) ?? str(record["name"]) ?? "",
            ...providerMeta(record),
          },
        ]
      case "tool-input-delta":
        return [
          {
            type: "tool-input-delta",
            id: str(record["id"]) ?? "",
            delta: str(record["delta"]) ?? str(record["text"]) ?? "",
            ...providerMeta(record),
          },
        ]
      case "tool-input-end":
        return [{ type: "tool-input-end", id: str(record["id"]) ?? "", ...providerMeta(record) }]
      case "tool-call": {
        // 字段名兼容（§2）：input│args│arguments 与 toolCallId│id
        const input = record["input"] ?? record["args"] ?? record["arguments"]
        return [
          {
            type: "tool-call",
            toolCallId: str(record["toolCallId"]) ?? str(record["id"]) ?? "",
            toolName: str(record["toolName"]) ?? str(record["name"]) ?? "",
            input: toolCallInputToString(input),
            ...providerMeta(record),
          },
        ]
      }
      case "finish-step": {
        receipt = {
          finishReason: str(record["finishReason"]) ?? str(record["rawFinishReason"]),
          usage: record["usage"],
          providerMetadata: providerMetaOf(record),
        }
        const parts: LanguageModelV3StreamPart[] = []
        const responseMetadata = responseMetadataPart(record["response"])
        if (responseMetadata !== null) parts.push(responseMetadata)
        return parts
      }
      case "finish": {
        if (finishEmitted) return []
        finishEmitted = true
        const usage = normalizeUsage(record["totalUsage"] ?? receipt?.usage)
        const finishReason = normalizeFinishReason(
          str(record["finishReason"]) ?? str(record["rawFinishReason"]) ?? receipt?.finishReason,
        )
        const providerMetadata = providerMetaOf(record) ?? receipt?.providerMetadata
        return [{ type: "finish", usage, finishReason, ...(providerMetadata !== undefined ? { providerMetadata } : {}) }]
      }
      case "response-metadata": {
        const part = responseMetadataPart(record)
        return part === null ? [] : [part]
      }
      case "error": {
        // §3 行 9：流中 error 事件不吞错，已收 delta 保留，错误浮出后终止翻译
        abortedByError = true
        return [errorPart(new Error(withModelId(extractErrorMessage(record))))]
      }
      default:
        // 未知 type 静默忽略——消费端向前兼容基本功（§2）
        return []
    }
  }

  function extractErrorMessage(record: NdjsonEvent): string {
    const error = record["error"]
    const errorRecord = asRecord(error)
    if (errorRecord !== null && typeof errorRecord["message"] === "string") return errorRecord["message"]
    if (typeof error === "string" && error) return error
    const message = record["message"]
    if (typeof message === "string" && message) return message
    return "上游流中报告了 error 事件，但未携带可读信息"
  }

  return {
    head() {
      if (headEmitted) return []
      headEmitted = true
      return [{ type: "stream-start", warnings: context.warnings }]
    },
    push(chunk: Uint8Array): LanguageModelV3StreamPart[] {
      if (abortedByError) return []
      buffer += decoder.decode(chunk, { stream: true })
      const parts: LanguageModelV3StreamPart[] = []
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        parts.push(...translateLine(line))
        if (abortedByError) break
      }
      return parts
    },
    end(): LanguageModelV3StreamPart[] {
      if (abortedByError) return []
      buffer += decoder.decode()
      const partial = /\S/.test(buffer) ? buffer : ""
      buffer = ""
      if (receipt === null) return [errorPart(new StreamTruncatedError(partial, context.modelId))]
      // 已收 finish-step：半行残片按规格忽略，流视为完整收尾，补发收据 finish part
      if (finishEmitted) return []
      finishEmitted = true
      return [finishPartFromReceipt(receipt)]
    },
  }
}

function finishPartFromReceipt(receipt: StepReceipt): LanguageModelV3StreamPart {
  const providerMetadata = receipt.providerMetadata
  return {
    type: "finish",
    usage: normalizeUsage(receipt.usage),
    finishReason: normalizeFinishReason(receipt.finishReason),
    ...(providerMetadata !== undefined ? { providerMetadata } : {}),
  }
}

// ---------------------------------------------------------------------------
// usage 与 finishReason 归一
// ---------------------------------------------------------------------------

/** usage 双 case 兼容（camelCase / snake_case，brent 实证两种都出现过）。
 * AI SDK `inputTokens.noCache` 取 `noCacheTokens` 优先、否则 total − cacheRead
 * （jiesou 规则）；cacheRead / reasoning 映射到对应字段；原始对象进 `raw` 保真。 */
export function normalizeUsage(raw: unknown): LanguageModelV3Usage {
  const record = asRecord(raw)
  if (record === null) return zeroUsage()

  const num = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) return value
    }
    return undefined
  }
  // 每个槽位按「camelCase 细节 → snake_case 细节 → 顶层 camelCase → 顶层 snake_case」取第一个数值
  const pick = (source: Record<string, unknown> | null, ...keys: string[]): unknown => {
    if (source === null) return undefined
    for (const key of keys) {
      const value = source[key]
      if (value !== undefined) return value
    }
    return undefined
  }

  const inputDetails =
    asRecord(record["inputTokenDetails"]) ?? asRecord(record["input_token_details"]) ?? asRecord(record["prompt_tokens_details"])
  const outputDetails =
    asRecord(record["outputTokenDetails"]) ?? asRecord(record["output_token_details"]) ?? asRecord(record["completion_tokens_details"])

  const inputTotal = num(pick(record, "inputTokens", "input_tokens", "prompt_tokens", "totalTokens", "total_tokens"))
  const cacheRead = num(
    pick(inputDetails, "cacheReadTokens", "cache_read_tokens"),
    pick(record, "cachedInputTokens", "cached_input_tokens"),
    pick(inputDetails, "cached_tokens"),
    record["prompt_cache_hit_tokens"],
  )
  const noCacheExplicit = num(pick(inputDetails, "noCacheTokens", "no_cache_tokens"), record["prompt_cache_miss_tokens"])

  return {
    inputTokens: {
      total: inputTotal,
      noCache: noCacheExplicit ?? (inputTotal !== undefined ? inputTotal - (cacheRead ?? 0) : undefined),
      cacheRead,
      cacheWrite: num(pick(inputDetails, "cacheWriteTokens", "cache_write_tokens")),
    },
    outputTokens: {
      total: num(pick(record, "outputTokens", "output_tokens", "completion_tokens")),
      text: num(pick(outputDetails, "textTokens", "text_tokens")),
      reasoning: num(pick(outputDetails, "reasoningTokens", "reasoning_tokens"), pick(record, "reasoningTokens", "reasoning_tokens")),
    },
    raw: record as JSONObject,
  }
}

function zeroUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

/** finishReason 词表归一（§2）：`stop│end_turn`、`tool_calls│tool-calls`、
 * `length│max_tokens│max_output_tokens`；表外值归 other、原文进 raw 不丢失 */
const FINISH_REASON_VOCABULARY: Record<string, LanguageModelV3FinishReason["unified"]> = {
  stop: "stop",
  end_turn: "stop",
  tool_calls: "tool-calls",
  "tool-calls": "tool-calls",
  length: "length",
  max_tokens: "length",
  max_output_tokens: "length",
}

export function normalizeFinishReason(raw: string | undefined): LanguageModelV3FinishReason {
  const unified = (raw !== undefined ? FINISH_REASON_VOCABULARY[raw] : undefined) ?? "other"
  return { unified, raw }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 信封 tool-call 的 `input`（AI SDK 要求 JSON 字符串）：对象序列化、字符串原样 */
function toolCallInputToString(input: unknown): string {
  if (input == null) return "{}"
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input)
  } catch {
    return "{}"
  }
}

function responseMetadataPart(value: unknown): Extract<LanguageModelV3StreamPart, { type: "response-metadata" }> | null {
  const record = asRecord(value)
  if (record === null) return null
  const id = str(record["id"])
  const timestamp = toDate(record["timestamp"])
  const modelId = str(record["modelId"])
  if (id === undefined && timestamp === undefined && modelId === undefined) return null
  return {
    type: "response-metadata",
    ...(id !== undefined ? { id } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
  }
}

function providerMetaOf(record: NdjsonEvent): SharedV3ProviderMetadata | undefined {
  return asRecord(record["providerMetadata"]) !== null ? (record["providerMetadata"] as SharedV3ProviderMetadata) : undefined
}

function providerMeta(record: NdjsonEvent): { providerMetadata?: SharedV3ProviderMetadata } {
  const providerMetadata = providerMetaOf(record)
  return providerMetadata !== undefined ? { providerMetadata } : {}
}

function toDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

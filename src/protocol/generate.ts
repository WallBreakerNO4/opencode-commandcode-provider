/**
 * 协议核心·执行层：一次 `/alpha/generate` 上游调用的完整驱动
 * （契约：docs/spec/protocol.md §3–§4，testing.md §2 的执行内核）。
 *
 * 本模块把零件串成可独立测试的「一次调用」：
 *   请求方向（调用方组装后传入）：body 信封（envelope.ts 构造，含图片预处理
 *   后的 prompt）、headers（伪装模块组装）、fetch 接缝。
 *   执行方向：300s 空闲看门狗 → `AbortSignal.any(看门狗, 调用方)` 统一控制
 *   fetch（谁先响都生效）→ 非 2xx 读 body 走错误映射表 → 2xx 把响应体逐
 *   chunk 喂 NDJSON 解析器并产出 stream part，事件到达即重置看门狗。
 *
 * 错误策略（§3）：provider 不自行重试、不吞错——HTTP 层错误直接 throw
 * （APICallError 形态，宿主据此决策重试），流内错误（截断 / error 事件 /
 * 零输出 / 看门狗到点）以 error part 浮现；客户端 abort 传播到上游 fetch，
 * 不合成任何错误。
 *
 * 零输出合成（行 7）在回合收尾处判定：finish part 已归一 usage 后若
 * outputTokens 为 0 且全程无 tool 活动 → 把正常收尾换成合成 429 error part
 * （retry-after 10s，防白跑一回合）。doStream 与 doGenerate 聚合共用本执行
 * 内核（#35 工厂的 doGenerate = 消费同一 generator），看门狗天然共享。
 *
 * 端点是产品常量；测试经注入的 fetch 接缝拦请求，不引入 base URL 类后门
 * （testing.md §3）。
 */

import type { LanguageModelV3StreamPart, SharedV3Warning } from "@ai-sdk/provider"
import type { CommandCodeEnvelope } from "./envelope.js"
import { createNdjsonEventStream } from "./ndjson.js"
import type { FetchLike } from "./json.js"
import {
  apiCallErrorFromHttpResponse,
  networkError,
  watchdogTimeoutError,
  zeroOutputError,
  type CommandCodeApiCallError,
} from "./errors.js"
import { createIdleWatchdog, mergeCancellation, type IdleWatchdog } from "./watchdog.js"

/** 上游端点（产品常量；与 CLI 信封协议绑定，见 protocol.md §1） */
export const GENERATE_ENDPOINT = "https://api.commandcode.ai/alpha/generate"

export { type FetchLike } from "./json.js"

export interface GenerateStreamInput {
  /** wire id——错误 message 与看门狗日志需要模型区分 */
  modelId: string
  /** 端点 URL（默认 GENERATE_ENDPOINT） */
  url?: string
  /** 调用 warnings（buildEnvelope 产出），随首个 stream-start part 上报 */
  warnings?: SharedV3Warning[]
  /** CLI 信封（伪装字段由伪装模块填好后传入，本模块零知识） */
  body: CommandCodeEnvelope
  /** 请求头全集（伪装头 + Authorization 由调用方组装） */
  headers: Record<string, string>
  /** 工厂 options.fetch 接缝（测试注 mock） */
  fetchImpl: FetchLike
  /** 调用方取消（用户停止键） */
  signal?: AbortSignal
}

/** 合成错误的公共上下文（APICallError 形态需 url 与 requestBodyValues） */
interface ErrorContext {
  modelId: string
  url: string
  body: CommandCodeEnvelope
}

/**
 * 发起一次上游流式调用，产出 AI SDK stream part。
 * HTTP 层错误（非 2xx / 响应前网络错误 / 看门狗到点）在此函数 await 时 throw；
 * 流内错误（截断、error 事件、零输出、读流中断）以 error part 浮现。
 * 迭代正常结束前自动释放看门狗定时器。
 */
export async function* generateStream(input: GenerateStreamInput): AsyncGenerator<LanguageModelV3StreamPart> {
  const ctx: ErrorContext = { modelId: input.modelId, url: input.url ?? GENERATE_ENDPOINT, body: input.body }
  const watchdog = createIdleWatchdog()
  const ndjson = createNdjsonEventStream({ modelId: ctx.modelId, warnings: input.warnings ?? [] })

  try {
    // 看门狗 + 调用方取消合并：谁先 abort 谁生效（§4 取消合并条款）
    const combined = mergeCancellation(watchdog, input.signal)

    let response: Response
    try {
      response = await input.fetchImpl(ctx.url, {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify(ctx.body),
        signal: combined,
      })
    } catch (error) {
      throw streamFailureError(classifyFailure(watchdog, input.signal), error, ctx)
    }

    if (!response.ok) {
      // 行 1–6：HTTP 层错误映射（读 body 后 throw；provider 不自行重试）
      const responseBody = await readBodySafely(response)
      throw apiCallErrorFromHttpResponse({
        modelId: ctx.modelId,
        url: ctx.url,
        requestBodyValues: ctx.body,
        status: response.status,
        responseHeaders: response.headers,
        responseBody,
      })
    }

    if (response.body === null) {
      // 响应无 body：按截断语义由流收尾报错（end() 产 error part）
      for (const part of ndjson.head()) yield part
      for (const part of ndjson.end()) yield part
      return
    }

    // 2xx：把响应体逐 chunk 喂 NDJSON 解析器
    const reader = response.body.getReader()
    for (const part of ndjson.head()) yield part

    // 行 7 判定所需的回合状态：全程是否出现过工具活动（tool-call / tool-input 增量）
    let sawToolActivity = false

    while (true) {
      let result: { done: boolean; value?: Uint8Array }
      try {
        result = await reader.read()
      } catch (error) {
        // 读流中断：与启动期同分类——看门狗到点 / 调用方取消 / 网络中断
        const failure = classifyFailure(watchdog, input.signal)
        if (failure === "caller-abort") return // 调用方取消：不合成错误，静默收尾
        yield errorPart(streamFailureError(failure, error, ctx))
        return
      }
      if (result.done) break

      watchdog.reset() // 有新数据 = 上游还活着

      const chunk = result.value
      if (chunk === undefined) break

      for (const part of ndjson.push(chunk)) {
        sawToolActivity ||= isToolActivity(part)
        const emitted = replaceZeroOutputFinish(part, sawToolActivity, ctx)
        if (emitted !== null) {
          yield emitted
          if (emitted.type === "error") return
          continue
        }
        yield part
      }
    }

    // EOF：半行残片两结局由解析器收尾（截断 error part / 补发收据 finish part）
    for (const part of ndjson.end()) {
      sawToolActivity ||= isToolActivity(part)
      const emitted = replaceZeroOutputFinish(part, sawToolActivity, ctx)
      if (emitted !== null) {
        yield emitted
        if (emitted.type === "error") return
        continue
      }
      yield part
    }
  } finally {
    watchdog.clear()
  }
}

/**
 * 行 7 零输出合成：正常收尾的 finish part 若 usage.outputTokens 为 0 且本回合
 * 无工具活动 → 换成合成 429 error part（retry-after 10s），防白跑一回合。
 * 不命中零输出条件时原样返回 null（调用方继续 yield 原 part）。
 */
function replaceZeroOutputFinish(
  part: LanguageModelV3StreamPart,
  sawToolActivity: boolean,
  ctx: ErrorContext,
): LanguageModelV3StreamPart | null {
  if (part.type !== "finish" || sawToolActivity) return null
  // outputTokens 显式为 0 才算零输出；缺失/未归一成功不合成（防误杀健康回合）
  if (part.usage.outputTokens?.total !== 0) return null
  return errorPart(zeroOutputError(ctx.modelId, ctx.url, ctx.body))
}

/** tool-call 或 tool-input-* 增量 = 回合有工具活动（行 7「无 tool-call」排除面） */
function isToolActivity(part: LanguageModelV3StreamPart): boolean {
  return part.type === "tool-call" || part.type.startsWith("tool-input")
}

function errorPart(error: unknown): LanguageModelV3StreamPart {
  return { type: "error", error }
}

/** 中断分类：看门狗到点 / 调用方取消 / 其他（网络或流损坏） */
type StreamFailure = "watchdog" | "caller-abort" | "network"

function classifyFailure(watchdog: IdleWatchdog, signal: AbortSignal | undefined): StreamFailure {
  if (watchdog.fired) return "watchdog"
  if (signal?.aborted === true) return "caller-abort"
  return "network"
}

/** 按中断分类产出错误对象：看门狗 → 超时错误；调用方取消 → 原错误；其他 → 网络错误 */
function streamFailureError(failure: StreamFailure, error: unknown, ctx: ErrorContext): CommandCodeApiCallError {
  if (failure === "watchdog") return watchdogTimeoutError(ctx.modelId, ctx.url, ctx.body)
  if (failure === "caller-abort") throw error // §3 行 10：不合成错误，原样传播
  return networkError(ctx.modelId, ctx.url, ctx.body, error)
}

/** 读错误响应体；读失败按空串兜底（错误映射的 responseBody 保真优先） */
async function readBodySafely(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

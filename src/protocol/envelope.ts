/**
 * 协议核心·请求方向：把 AI SDK 标准调用（LanguageModelV3CallOptions）翻译成
 * `/alpha/generate` 的 CLI 信封（契约：docs/spec/protocol.md §1）。
 *
 * 伪装字段只留填充点：`config` 块与顶层 `permissionMode` 由伪装模块提供（disguise.md
 * §9），本模块对其内容零知识、原样搬运；`memory` / `taste` / `skills` 是官方 CLI
 * 硬编码的 null 死键（#25 源码定案），在此写死；`threadId` 与 `x-session-id` 同值，
 * 由调用方从伪装模块的会话身份取。
 *
 * 越权参数策略（§1.3）：信封 `params` 没有的调用参数既不塞进信封也不静默吞掉，
 * 一律以 AI SDK call warnings 上报，由调用方在结果中可见。
 */

import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  LanguageModelV3ToolChoice,
  LanguageModelV3ToolResultOutput,
  SharedV3ProviderOptions,
  SharedV3Warning,
} from "@ai-sdk/provider"
import { asRecord } from "./json.js"

/** provider 唯一标识：v2 插件 id、v1 config 注入键、integrationID、模型 id 前缀四处同名 */
export const PROVIDER_ID = "commandcode-go"

/** 模型 reference（`provider/wire`）解析：按首个 `/` 切分，wire id 可含 `/` 原样透传 */
export function splitModelReference(reference: string): { providerId: string; wireId: string } {
  const slash = reference.indexOf("/")
  if (slash === -1) return { providerId: PROVIDER_ID, wireId: reference }
  return { providerId: reference.slice(0, slash), wireId: reference.slice(slash + 1) }
}

// ---------------------------------------------------------------------------
// CLI 信封 wire 形状
// ---------------------------------------------------------------------------

export interface EnvelopeTool {
  type: "function"
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export type EnvelopeToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "any" }
  | { type: "tool"; name: string }

export type EnvelopeTextBlock = { type: "text"; text: string }
export type EnvelopeImageBlock = { type: "image"; image: string }

export type EnvelopeAssistantBlock =
  | EnvelopeTextBlock
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }

export type EnvelopeToolResultBlock = {
  type: "tool-result"
  toolCallId: string
  toolName: string
  output: { type: "text" | "error-text"; value: string }
}

export type EnvelopeMessage =
  | { role: "user"; content: Array<EnvelopeTextBlock | EnvelopeImageBlock> }
  | { role: "assistant"; content: EnvelopeAssistantBlock[] }
  | { role: "tool"; content: EnvelopeToolResultBlock[] }

export interface EnvelopeParams {
  model: string
  messages: EnvelopeMessage[]
  system?: string
  tools?: EnvelopeTool[]
  tool_choice?: EnvelopeToolChoice
  max_tokens: number
  stream: true
  temperature?: number
  top_p?: number
  top_k?: number
  reasoning_effort?: string
}

/** 七键骨架；键序即规格 §1 列举序，构造时按此序赋值保持 wire 形状稳定 */
export interface CommandCodeEnvelope {
  config: Record<string, unknown>
  memory: null
  taste: null
  skills: null
  permissionMode: string
  threadId: string
  params: EnvelopeParams
}

/** 协议核心之外的调用上下文：模型管线与伪装模块的输入 */
export interface EnvelopeCallContext {
  /** wire id（provider 前缀剥除后），原样进 `params.model` */
  modelId: string
  /** 模型管线级联 `maxOutput`：`max_tokens` 的裁剪参考（models.dev 第三方视角值，
   * 非网关真值；仅当小于官方缺省 64e3 时生效，§1.2 / ADR 0002） */
  maxOutput: number
  /** 与 `x-session-id` 同值（伪装模块会话身份） */
  threadId: string
  /** 伪装模块提供的填充点内容，本模块零知识 */
  disguise: {
    config: Record<string, unknown>
    permissionMode: string
  }
}

// ---------------------------------------------------------------------------
// 信封构造
// ---------------------------------------------------------------------------

export function buildEnvelope(
  options: LanguageModelV3CallOptions,
  context: EnvelopeCallContext,
): { body: CommandCodeEnvelope; warnings: SharedV3Warning[] } {
  const warnings: SharedV3Warning[] = []
  warnUnsupportedCallParams(options, warnings)

  const { system, messages } = convertPrompt(options.prompt, warnings)
  const tools = convertTools(options.tools, warnings)
  const toolChoice = resolveToolChoice(options.toolChoice, tools !== undefined)
  const reasoningEffort = resolveReasoningEffort(options.providerOptions)

  const params: EnvelopeParams = {
    model: context.modelId,
    messages,
    ...(system !== undefined ? { system } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    max_tokens: resolveMaxTokens(options.maxOutputTokens, context.maxOutput),
    stream: true,
    ...(options.temperature != null ? { temperature: options.temperature } : {}),
    ...(options.topP != null ? { top_p: options.topP } : {}),
    ...(options.topK != null ? { top_k: options.topK } : {}),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
  }

  const body: CommandCodeEnvelope = {
    config: context.disguise.config,
    memory: null,
    taste: null,
    skills: null,
    permissionMode: context.disguise.permissionMode,
    threadId: context.threadId,
    params,
  }
  return { body, warnings }
}

/** `max_tokens` 缺省：官方 CLI 主对话路径常量 `tk = 64e3`（command-code 1.49.1
 * `dist/cli.mjs`，`max_tokens: t.maxOutputTokens ?? tk`），与 capture/samples/generate.json
 * 抓包（deepseek-v4-flash 实发 64000）互证（ADR 0002）。 */
const OFFICIAL_DEFAULT_MAX_TOKENS = 64_000

/** 网关对 `params.max_tokens` 的 zod 校验硬上限：#42 冒烟 400 实证
 * `Too big: expected number to be <=200000`；官方 CLI 缺省 64e3 永不触及，故线上未暴露。 */
const GATEWAY_MAX_TOKENS_CAP = 200_000

/** `max_tokens` = min(调用方值 ?? 官方缺省 64e3, 级联 maxOutput, 网关墙 200000)
 * （§1.2 / ADR 0002）：缺省复刻官方 CLI（伪装口径——官方从不发 models.dev 理论值）；
 * 级联值降级为裁剪参考（models.dev 第三方视角值，非网关真值）；墙防调用方显式
 * 传大值撞 400。 */
function resolveMaxTokens(callerValue: number | undefined, maxOutput: number): number {
  return Math.min(callerValue ?? OFFICIAL_DEFAULT_MAX_TOKENS, maxOutput, GATEWAY_MAX_TOKENS_CAP)
}

/** `tool_choice` 四态映射；tools 非空且调用方未指定时显式发 `{type:"auto"}`
 * （MAXeaglet 抓包验证的信封形状，不赌网关默认值）；无 tools 则不发。 */
function resolveToolChoice(
  choice: LanguageModelV3ToolChoice | undefined,
  hasTools: boolean,
): EnvelopeToolChoice | undefined {
  if (choice !== undefined) {
    switch (choice.type) {
      case "auto":
        return { type: "auto" }
      case "none":
        return { type: "none" }
      case "required":
        return { type: "any" }
      case "tool":
        return { type: "tool", name: choice.toolName }
    }
  }
  return hasTools ? { type: "auto" } : undefined
}

/** `reasoning_effort` 仅变体被选中时发送；接收通道为 `providerOptions.reasoningEffort`
 * ——OpenCode 把 variant 档位合并进 providerOptions 传入 LanguageModel（协议唯一路径）。
 * 命名空间键随宿主而异（本插件为 commandcode-go，官方 CLI 抓包里出现过 deepseek /
 * openaiCompatible 等），故按确定性优先序全命名空间扫描。 */
function resolveReasoningEffort(providerOptions: SharedV3ProviderOptions | undefined): string | undefined {
  if (providerOptions === undefined) return undefined
  const namespaces = Object.keys(providerOptions).sort((a, b) => {
    if (a === PROVIDER_ID) return -1
    if (b === PROVIDER_ID) return 1
    return 0
  })
  for (const namespace of namespaces) {
    const value = providerOptions[namespace]?.["reasoningEffort"]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/** §1.3：OpenCode 实证当前不传这些参数；真传来时不塞信封、不吞，warnings 上报 */
function warnUnsupportedCallParams(options: LanguageModelV3CallOptions, warnings: SharedV3Warning[]): void {
  const unsupported: Array<[feature: string, value: unknown]> = [
    ["stopSequences", options.stopSequences],
    ["presencePenalty", options.presencePenalty],
    ["frequencyPenalty", options.frequencyPenalty],
    ["seed", options.seed],
    ["responseFormat", options.responseFormat],
  ]
  for (const [feature, value] of unsupported) {
    if (value == null) continue
    warnings.push({
      type: "unsupported",
      feature,
      details: `CommandCode 网关信封不接收 ${feature}，已按协议忽略`,
    })
  }
}

// ---------------------------------------------------------------------------
// 消息转换（§1.1 全表）
// ---------------------------------------------------------------------------

export function convertPrompt(
  prompt: LanguageModelV3Prompt,
  warnings: SharedV3Warning[],
): { system: string | undefined; messages: EnvelopeMessage[] } {
  const systemParts: string[] = []
  const messages: EnvelopeMessage[] = []

  for (const message of prompt) {
    if (message.role === "system") {
      if (message.content.length > 0) systemParts.push(message.content)
      continue
    }
    if (message.role === "user") {
      const content: Array<EnvelopeTextBlock | EnvelopeImageBlock> = []
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text })
          continue
        }
        const image = convertImageFilePart(part, warnings)
        if (image !== null) content.push(image)
      }
      if (content.length > 0) messages.push({ role: "user", content })
      continue
    }
    if (message.role === "assistant") {
      const assistantBlocks: EnvelopeAssistantBlock[] = []
      const toolResults: EnvelopeToolResultBlock[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          assistantBlocks.push({ type: "text", text: part.text })
        } else if (part.type === "reasoning") {
          assistantBlocks.push({ type: "reasoning", text: part.text })
        } else if (part.type === "tool-call") {
          assistantBlocks.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: normalizeToolCallInput(part.input),
          })
        } else if (part.type === "tool-result") {
          toolResults.push(convertToolResult(part, warnings))
        } else {
          warnUnsupportedPart(part.type, warnings)
        }
      }
      if (assistantBlocks.length > 0) messages.push({ role: "assistant", content: assistantBlocks })
      if (toolResults.length > 0) messages.push({ role: "tool", content: toolResults })
      continue
    }
    // role: "tool"
    const blocks: EnvelopeToolResultBlock[] = []
    for (const part of message.content) {
      if (part.type === "tool-result") {
        blocks.push(convertToolResult(part, warnings))
      } else {
        warnUnsupportedPart(part.type, warnings)
      }
    }
    if (blocks.length > 0) messages.push({ role: "tool", content: blocks })
  }

  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, messages }
}

/** 图片 part → `data:<mediaType>;base64,...` data URL（§1.1 / §5 上游格式）。
 * 二进制与 base64 串同步可转；`data:` URL 原样透传；URL 引用无法同步转成 base64
 * data URL，按 §1.3 走 warnings 通道，不静默吞。 */
function convertImageFilePart(part: LanguageModelV3FilePart, warnings: SharedV3Warning[]): EnvelopeImageBlock | null {
  if (part.data instanceof Uint8Array) {
    return { type: "image", image: `data:${part.mediaType};base64,${bytesToBase64(part.data)}` }
  }
  if (typeof part.data === "string") {
    if (part.data.startsWith("data:")) return { type: "image", image: part.data }
    if (/^https?:\/\//i.test(part.data)) {
      warnUnsupportedImageSource(warnings)
      return null
    }
    return { type: "image", image: `data:${part.mediaType};base64,${part.data}` }
  }
  warnUnsupportedImageSource(warnings)
  return null
}

function warnUnsupportedImageSource(warnings: SharedV3Warning[]): void {
  warnings.push({
    type: "unsupported",
    feature: "image URL input",
    details: "以 URL 引用的图片无法直接放入信封的 base64 data URL，已丢弃",
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/** 信封 tool-call 的 `input` 为对象；宿主传 JSON 字符串时解析还原，解析失败保留原串 */
function normalizeToolCallInput(input: unknown): unknown {
  if (typeof input !== "string") return input
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

function convertToolResult(part: { toolCallId: string; toolName: string; output: LanguageModelV3ToolResultOutput }, warnings: SharedV3Warning[]): EnvelopeToolResultBlock {
  return { type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: convertToolResultOutput(part.output, warnings) }
}

/** AI SDK 六种 tool 输出 → 信封二态（text / error-text）。
 * `isError` 语义（error-text / error-json / execution-denied）一律 `error-text`；
 * json 类输出序列化为文本进信封。 */
function convertToolResultOutput(output: LanguageModelV3ToolResultOutput, warnings: SharedV3Warning[]): { type: "text" | "error-text"; value: string } {
  switch (output.type) {
    case "text":
      return { type: "text", value: output.value }
    case "json":
      return { type: "text", value: safeStringify(output.value) }
    case "error-text":
      return { type: "error-text", value: output.value }
    case "error-json":
      return { type: "error-text", value: safeStringify(output.value) }
    case "execution-denied":
      return { type: "error-text", value: output.reason ?? "Execution denied" }
    case "content": {
      const hasNonText = output.value.some((block) => block.type !== "text")
      if (hasNonText) {
        warnings.push({
          type: "unsupported",
          feature: "tool result content blocks",
          details: "信封 tool 结果仅支持文本，非文本块已丢弃",
        })
      }
      return {
        type: "text",
        value: output.value
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
      }
    }
  }
}

/** tools 定义 → Anthropic 风格 `{type:"function", name, description, input_schema}`；
 * provider 工具无信封表达，warnings 上报后略去 */
function convertTools(tools: LanguageModelV3CallOptions["tools"], warnings: SharedV3Warning[]): EnvelopeTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  const converted: EnvelopeTool[] = []
  for (const tool of tools) {
    if (tool.type !== "function") {
      warnings.push({
        type: "unsupported",
        feature: `${tool.type} tool "${tool.name}"`,
        details: "信封 tools 仅支持 function 定义，该工具已略去",
      })
      continue
    }
    converted.push({
      type: "function",
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      input_schema: (canonicalizeJson(asRecord(tool.inputSchema) ?? {}) as Record<string, unknown>),
    })
  }
  converted.sort((left, right) => left.name.localeCompare(right.name))
  return converted.length > 0 ? converted : undefined
}

function warnUnsupportedPart(partType: string, warnings: SharedV3Warning[]): void {
  warnings.push({
    type: "unsupported",
    feature: partType,
    details: `信封消息不支持 ${partType} 内容块，已丢弃`,
  })
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeJson(item)]),
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 协议核心·图片输入（契约：docs/spec/protocol.md §5）。
 *
 * 三种投递形态在此归一为「可同步转换」的 part data：
 * - `Uint8Array` / base64 字符串 / `data:` URL：无需预处理，直接交给信封构造
 *   （envelope.ts 的同步转换）。
 * - 外链 URL 引用（URL 对象或 http(s) 字符串）：**必须完整实现转换**——用调用方
 *   注入的 fetch（工厂 options.fetch 接缝，宿主包装实例自带超时）下载为
 *   `Uint8Array` 再进信封；下载失败/非 2xx 视为该图不可投递：丢弃 + warn
 *   （非静默，与「未声明模态丢弃」同级的防御降级，主文本请求照发）。
 *
 * 模态分支（老板红线级裁决的「放行后静默丢弃」禁止面）：
 * - 模型 `inputModalities` 含 `image` → 图片 part 全部放行（上述转换）。
 * - 未声明 `image` 的模型收到图片 → 丢弃 + logger.warn（防御路径：OpenCode UI
 *   本就不会让用户往纯文本模型贴图，能到这里说明是异常流）。
 * - mediaType 非 image/* 的 file part（pdf 等）：模态词表只有 text/image，
 *   任何非图片文件都不在「网关可投递」口径内 → 丢弃 + warn。
 *
 * 客户端不设尺寸限：超大图直接转换，超限由网关 400 按错误映射表浮出（§5）。
 */

import type { LanguageModelV3FilePart, LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { DisguiseLogger } from "../disguise/logger.js"
import type { FetchLike } from "./json.js"

export interface PrepareImagesContext {
  /** 模型管线级联 inputModalities（gateway 可投递口径词表，见 model-pipeline.md §1.1） */
  inputModalities: readonly string[]
  /** wire id——warn 日志需区分模型 */
  modelId: string
  /** 工厂 options.fetch 接缝（宿主包装实例；下载失败/非 2xx = 不可投递） */
  fetch: FetchLike
  /** 注入式 logger（disguise.md §7 形态）；测试注记录型 spy */
  logger: DisguiseLogger
}

/** 模型是否声明 image 模态 */
export function supportsImage(inputModalities: readonly string[] | undefined): boolean {
  return inputModalities !== undefined && inputModalities.includes("image")
}

/** part 是否为图片（mediaType 以 image/ 开头） */
export function isImageFilePart(part: unknown): part is LanguageModelV3FilePart & { mediaType: string } {
  if (typeof part !== "object" || part === null) return false
  const candidate = part as { type?: unknown; mediaType?: unknown }
  return candidate.type === "file" && typeof candidate.mediaType === "string" && candidate.mediaType.startsWith("image/")
}

/** data 是否为外链 URL 引用（URL 对象或 http(s) 字符串；`data:` 前缀不是外链） */
function isRemoteUrl(data: LanguageModelV3FilePart["data"]): data is URL | string {
  if (data instanceof URL) return true
  if (typeof data === "string") return /^https?:\/\//i.test(data)
  return false
}

/** 外链 URL 字符串化（URL 对象取 href） */
function urlText(data: URL | string): string {
  return typeof data === "string" ? data : data.href
}

/**
 * prompt 图片预处理：模态过滤 + 外链 URL 下载。
 * 返回新 prompt（消息级重建；含图片之外 part 的消息原样保留其余内容），
 * 下载失败或模态外的图片 part 被移除并在注入 logger 上 warn（绝不静默）。
 */
export async function preparePromptImages(prompt: LanguageModelV3Prompt, ctx: PrepareImagesContext): Promise<LanguageModelV3Prompt> {
  const imageSupported = supportsImage(ctx.inputModalities)
  let droppedImages = 0
  let droppedNonImageFiles = 0
  let droppedByDownload = 0

  const prepared: LanguageModelV3Prompt = []
  for (const message of prompt) {
    if (message.role !== "user") {
      prepared.push(message)
      continue
    }
    const content: typeof message.content = []
    for (const part of message.content) {
      if (part.type === "file") {
        if (!isImageFilePart(part)) {
          // 非图片 file part（pdf 等）：模态词表外，网关不可投递
          droppedNonImageFiles += 1
          continue
        }
        if (!imageSupported) {
          droppedImages += 1
          continue
        }
        const data = await resolveImageData(part, ctx)
        if (data === null) {
          droppedByDownload += 1
          continue
        }
        content.push({ ...part, data })
        continue
      }
      content.push(part)
    }
    prepared.push({ ...message, content })
  }

  if (!imageSupported && droppedImages > 0) {
    ctx.logger.warn(`[${ctx.modelId}] 模型未声明 image 模态，已丢弃 ${droppedImages} 张图片输入（防御路径）`)
  }
  if (droppedNonImageFiles > 0) {
    ctx.logger.warn(`[${ctx.modelId}] 收到非图片文件 part（模态词表仅 text/image），已丢弃 ${droppedNonImageFiles} 个`)
  }
  if (droppedByDownload > 0) {
    ctx.logger.warn(`[${ctx.modelId}] 有 ${droppedByDownload} 张外链图片下载失败/非 2xx，已丢弃（主请求照发）`)
  }
  return prepared
}

/**
 * 图片 data 就绪：外链 URL 下载为 Uint8Array；非外链（Uint8Array / base64 串 /
 * data: URL）原样保留交信封同步转换；下载失败/非 2xx/空响应返回 null
 * （调用方负责 warn 汇总）。
 */
async function resolveImageData(
  part: LanguageModelV3FilePart,
  ctx: PrepareImagesContext,
): Promise<LanguageModelV3FilePart["data"] | null> {
  if (!isRemoteUrl(part.data)) return part.data
  try {
    const response = await ctx.fetch(urlText(part.data))
    if (!response.ok) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length === 0) return null
    return bytes
  } catch {
    return null
  }
}

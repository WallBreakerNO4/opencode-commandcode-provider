/**
 * file 输入模态投递能力复测工具（issue #66，人工运行，不进测试套件）。
 *
 * 背景：上游 catalog 用 `inputModalities: ["text","image","file"]` 广告文件能力，但
 * `/alpha/generate` 的 wire 层当前无法投递文件——user content 块的 zod 枚举里没有
 * `file`；文件唯一可能的 wire 形态是 Anthropic 方言 `document` 块，然而网关内部
 * ModelMessage 转换层不处理它，流内报 `Invalid prompt: The messages do not match the
 * ModelMessage[] schema.`（跨模型一致）。因此构建流水线把 file 模态裁掉，只广告
 * text/image。本工具用于未来人工确认网关是否已补上 file 投递能力。
 *
 * 用法（bun 自动加载仓库根 `.env`）：
 *   bun scripts/probe-file-delivery.ts [--model <id>]
 * 默认模型 meta/muse-ember（file 模态 advertise 的首案）。key 只从环境变量
 * COMMANDCODE_API_KEY 读取，**绝不打印 key 或 Authorization 头**。
 *
 * 成本：每次运行 4 个探测请求，每请求约 $0.001。
 *
 * 判定：基线（纯 text）与 image 对照都 HTTP 200 且流完整（信封健康），并且
 * document（base64 或 URL 任一）出现完整生成流（有 text-delta / finish，无
 * ModelMessage[] 流内错误）→ 支持。退出码 0 = 支持，1 = 不支持。
 * 支持后才可以扩 ALLOWED_INPUT_MODALITIES（scripts/build-models/reconcile.ts）并实现
 * 协议层 file→document 转换。
 */

import { randomUUID } from "node:crypto"
import {
  type ConfigBlock,
  collectConfigBlock,
  createNodeConfigRuntime,
  PERMISSION_MODE,
} from "../src/disguise/config-block.ts"
import { buildGenerateHeaders } from "../src/disguise/headers.ts"
import { generateTraceparent } from "../src/disguise/traceparent.ts"

const ENDPOINT = "https://api.commandcode.ai/alpha/generate"
const DEFAULT_MODEL = "meta/muse-ember"
const PROMPT = "What does the attached file say? Answer with the exact text in it."
/** 单次探测的总超时：生成流 + 网关排队，留足余量（复测不是 SLA 链路） */
const PROBE_TIMEOUT_MS = 120_000
/** 与官方 CLI 主对话缺省一致（其它值会改变网关校验面，影响探测可复现性） */
const MAX_TOKENS = 64_000

/** 内置极简 PDF（单页，正文 PROBE FILE 66），用 base64 形态探测 document 块 */
const PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUg" +
  "L1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAg" +
  "UiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIg" +
  "Pj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDEwMCBUZCAoUFJP" +
  "QkUgRklMRSA2NikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAv" +
  "QmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAw" +
  "IG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzUg" +
  "MDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDUKJSVFT0YK"

/** 1×1 PNG（红色像素），证明信封的 Anthropic 方言 image 块通道健康 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

interface ProbeArgs {
  readonly model: string
}

function parseArgs(argv: readonly string[]): ProbeArgs {
  let model = DEFAULT_MODEL
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === "--model") {
      if (value === undefined) {
        throw new Error("--model 缺少值；用法：bun scripts/probe-file-delivery.ts [--model <id>]")
      }
      model = value
      i++
    } else {
      throw new Error(`未知参数「${flag ?? ""}」；用法：bun scripts/probe-file-delivery.ts [--model <id>]`)
    }
  }
  return { model }
}

/**
 * 版本头：照真实 CLI 发 `x-command-code-version`。取 npm 最新版本；
 * 查询失败时省略该头（网关实测不因此拒绝，但会失去一个伪装信号，故先告警）。
 */
async function resolveCliVersion(): Promise<string | undefined> {
  try {
    const response = await fetch("https://registry.npmjs.org/command-code/latest", {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    const payload = (await response.json()) as { version?: unknown }
    return typeof payload.version === "string" ? payload.version : undefined
  } catch {
    return undefined
  }
}

interface EnvelopeParams {
  model: string
  messages: Array<{ role: "user"; content: readonly unknown[] }>
  max_tokens: number
  stream: true
}

interface ProbeEnvelope {
  config: ConfigBlock
  memory: null
  taste: null
  skills: null
  permissionMode: string
  threadId: string
  params: EnvelopeParams
}

function buildProbeEnvelope(
  model: string,
  threadId: string,
  config: ConfigBlock,
  content: readonly unknown[],
): ProbeEnvelope {
  return {
    config,
    memory: null,
    taste: null,
    skills: null,
    permissionMode: PERMISSION_MODE,
    threadId,
    params: {
      model,
      messages: [{ role: "user", content }],
      max_tokens: MAX_TOKENS,
      stream: true,
    },
  }
}

interface StreamSummary {
  readonly text: string
  readonly sawTextDelta: boolean
  readonly sawFinish: boolean
  /** 流内 error 事件（含 ModelMessage[] schema 错误）的可读信息 */
  readonly streamError?: string
}

function pickErrorMessage(record: Record<string, unknown>): string {
  const error = record["error"]
  if (typeof error === "string" && error !== "") return error
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"]
    if (typeof message === "string" && message !== "") return message
  }
  const message = record["message"]
  return typeof message === "string" && message !== "" ? message : "流内 error 事件无正文"
}

/** 解析 NDJSON 响应：只看探测关心的 text-delta / finish / error，其余事件忽略 */
function summarizeStream(body: string): StreamSummary {
  let text = ""
  let sawTextDelta = false
  let sawFinish = false
  let streamError: string | undefined
  for (const line of body.split("\n")) {
    if (line === "" || line.startsWith(":")) continue
    let record: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (typeof parsed !== "object" || parsed === null) continue
      record = parsed as Record<string, unknown>
    } catch {
      continue
    }
    const type = record["type"]
    if (type === "text-delta" && typeof record["text"] === "string") {
      text += record["text"]
      sawTextDelta = true
    } else if (type === "finish" || type === "finish-step") {
      sawFinish = true
    } else if (type === "error" && streamError === undefined) {
      streamError = pickErrorMessage(record)
    }
  }
  return { text, sawTextDelta, sawFinish, ...(streamError !== undefined ? { streamError } : {}) }
}

interface ProbeResult {
  readonly name: string
  readonly status: number
  readonly transportError?: string
  readonly body: string
  readonly stream: StreamSummary
}

/** 单步探测成功 = HTTP 2xx + 完整生成流 + 无流内错误 */
function isHealthy(result: ProbeResult): boolean {
  return (
    result.transportError === undefined &&
    result.status >= 200 &&
    result.status < 300 &&
    result.stream.streamError === undefined &&
    (result.stream.sawTextDelta || result.stream.sawFinish)
  )
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function reportResult(index: number, total: number, result: ProbeResult): void {
  console.log("")
  console.log(`[${index}/${total}] ${result.name}`)
  if (result.transportError !== undefined) {
    console.log(`  HTTP：网络错误（${result.transportError}）`)
    return
  }
  console.log(`  HTTP ${result.status}`)
  const flags = `text-delta=${result.stream.sawTextDelta ? "yes" : "no"} finish=${result.stream.sawFinish ? "yes" : "no"}`
  if (isHealthy(result)) {
    console.log(`  ${flags}；回复摘要「${truncate(result.stream.text.trim() || "（无文本）", 200)}」`)
    return
  }
  if (result.stream.streamError !== undefined) {
    console.log(`  流内错误：${result.stream.streamError}`)
  } else {
    console.log(`  ${flags}`)
  }
  // 失败时完整打印响应体（可能是 4xx 校验错或流内 error 行）
  console.log("  响应体：")
  console.log(result.body === "" ? "  （空）" : result.body)
}

/** 单轮复测中不变的探测上下文：构造一次，4 次探测共享同一引用 */
interface ProbeContext {
  readonly model: string
  readonly threadId: string
  readonly config: ConfigBlock
  readonly apiKey: string
  readonly ccVersion: string | undefined
}

async function probe(ctx: ProbeContext, name: string, content: readonly unknown[]): Promise<ProbeResult> {
  const headers = buildGenerateHeaders({
    apiKey: ctx.apiKey,
    ccVersion: ctx.ccVersion,
    sessionId: ctx.threadId,
    workingDir: process.cwd(),
    traceparent: generateTraceparent(),
  })
  const body = JSON.stringify(buildProbeEnvelope(ctx.model, ctx.threadId, ctx.config, content))
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const text = await response.text()
    return { name, status: response.status, body: text, stream: summarizeStream(text) }
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : String(error)
    return { name, status: 0, transportError: reason, body: "", stream: { text: "", sawTextDelta: false, sawFinish: false } }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = process.env.COMMANDCODE_API_KEY
  if (apiKey === undefined || apiKey === "") {
    console.error("缺少 COMMANDCODE_API_KEY（本工具从环境变量读取；bun 会自动加载仓库根 .env）")
    process.exit(1)
  }

  const ccVersion = await resolveCliVersion()
  if (ccVersion === undefined) {
    console.warn("[warn] 无法查询 command-code 最新版本，x-command-code-version 头将省略")
  }
  const config = await collectConfigBlock(createNodeConfigRuntime())
  const threadId = randomUUID()
  const ctx: ProbeContext = { model: args.model, threadId, config, apiKey, ccVersion }

  console.log(`探测端点：${ENDPOINT}`)
  console.log(`模型：${args.model}（七键信封 + 伪装头，与真实插件请求同形）`)
  console.log("")

  const steps: Array<{ name: string; content: readonly unknown[] }> = [
    {
      name: "基线：纯 text（预期 200 正常生成流）",
      content: [{ type: "text", text: PROMPT }],
    },
    {
      name: "document · base64 PDF（media_type 为 snake_case 字面量 application/pdf）",
      content: [
        { type: "text", text: PROMPT },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_BASE64 } },
      ],
    },
    {
      name: "document · URL（W3C dummy.pdf）",
      content: [
        { type: "text", text: PROMPT },
        {
          type: "document",
          source: { type: "url", url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" },
        },
      ],
    },
    {
      name: "对照：Anthropic 方言 image 块（预期 200，证明信封健康）",
      content: [
        { type: "text", text: PROMPT },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
      ],
    },
  ]

  const results: ProbeResult[] = []
  for (const [index, step] of steps.entries()) {
    const result = await probe(ctx, step.name, step.content)
    results.push(result)
    reportResult(index + 1, steps.length, result)
  }

  const baseline = results[0]!
  const documentBase64 = results[1]!
  const documentUrl = results[2]!
  const imageControl = results[3]!
  const documentSupported = isHealthy(documentBase64) || isHealthy(documentUrl)
  const supported = isHealthy(baseline) && isHealthy(imageControl) && documentSupported

  console.log("")
  console.log("—— 判定 ——")
  console.log(
    `基线：${isHealthy(baseline) ? "健康" : "失败"}；` +
      `image 对照：${isHealthy(imageControl) ? "健康" : "失败"}；` +
      `document：base64 ${isHealthy(documentBase64) ? "支持" : "不支持"} / URL ${isHealthy(documentUrl) ? "支持" : "不支持"}`,
  )
  if (supported) {
    console.log("✅ 网关已支持 file 投递，可以扩词表并实现协议层转换")
    console.log("   前置确认后：更新 scripts/build-models/reconcile.ts 的 ALLOWED_INPUT_MODALITIES，并实现协议层 file→document 转换")
    process.exit(0)
  }
  console.log("❌ 网关仍不支持 file 投递（构建侧继续裁剪 file 模态）")
  process.exit(1)
}

if (import.meta.main) {
  await main()
}

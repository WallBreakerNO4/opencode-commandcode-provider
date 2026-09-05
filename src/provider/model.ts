/**
 * 工厂装配（#35 弹道合拢点）：协议核心（执行内核 generate.ts）× 伪装模块
 * （会话身份 / config 块 / 版本头 / 伪装头）× 模型管线（级联 limit 数据）组装成
 * 包导出的 `createCommandCode({name, apiKey, headers, fetch})` 工厂，内部实现
 * LanguageModelV3（契约形状：docs/research/v2-provider-contract.md §2 实测——
 * `finishReason` 为 `{unified, raw}` 对象、`usage` 嵌套结构、上游恒为流式 NDJSON、
 * `doGenerate` = `doStream` 聚合）。
 *
 * 工厂签名四键无 body；宿主按「模块第一个 `create*` 前缀导出」判据发现（v1/v2
 * 共用），返回 `{ languageModel(modelID) → LanguageModelV3 }`。模型 reference 按
 * 首个 `/` 切分 provider 与 wire id——wire id 自身可含 `/`（如
 * `deepseek/deepseek-v4-flash`），故仅 provider 段与本插件同名时才剥前缀，无前缀
 * reference 原样透传。
 *
 * doStream 主路径：预请求惰性检查（到点后台发射，主请求零等待）→ 会话身份派生
 * （从调用 headers 的 OpenCode 会话头确定性派生，缺失落 per-key 回退轮换）→ 图片
 * 预处理（模态过滤 + 外链下载）→ config 块与版本头并行就绪 → 信封构造（伪装字段
 * 填充点）→ 伪装头组装（`threadId` 与 `x-session-id` 同值）→ 300s 看门狗执行内核。
 * HTTP 层错误（非 2xx / 响应前网络错误 / 看门狗连接期到点）在 doStream await 时
 * 抛出（AI SDK 惯例，宿主 catch 分类）；流内错误（截断 / error 事件 / 零输出 /
 * 流中看门狗到点）以 error part 浮现（protocol.md §3）。
 *
 * 运行时共享：宿主每次模型请求都会重新调用工厂（v2 实测两遍/请求），预请求节奏
 * （D2 每进程一次）与模型管线刷新节奏（model-pipeline.md §4 TTL）必须跨工厂调用
 * 存活——伪装状态与管线为模块级单例；宿主逐次注入的 fetch / 自定义头 / logger 经
 * 接缝重指向最新值；key 相关状态（回退会话、预请求退避）由 DisguiseState 内部
 * per-key Map 承载。调用 headers 只作会话派生种子、不透传上游（`X-Session-Id` 等
 * 是宿主内部头，非 CLI 指纹）；工厂 options.headers（用户显式配置）透传且被伪装
 * 键覆盖防冲突。
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import { PERMISSION_MODE } from "../disguise/config-block.js"
import { buildGenerateHeaders } from "../disguise/headers.js"
import { consoleLogger, type DisguiseLogger } from "../disguise/logger.js"
import { createDisguiseState, type DisguiseState } from "../disguise/state.js"
import { parseArtifact, type Artifact } from "../models/artifact.js"
import { mergeModelLayers, type CascadeResult } from "../models/cascade.js"
import { createModelPipeline, type ModelPipeline } from "../models/pipeline.js"
import { PACKAGE_SNAPSHOT_JSON } from "../models/snapshot.js"
import { buildEnvelope, PROVIDER_ID, splitModelReference } from "../protocol/envelope.js"
import { generateStream } from "../protocol/generate.js"
import type { FetchLike } from "../protocol/json.js"
import { preparePromptImages } from "../protocol/images.js"

/**
 * 工厂入参：宿主调工厂时注入的 options（v2-provider-contract.md §1 实测形状）。
 * `fetch` 是宿主包装过的实例（超时与 chunk 处理由宿主侧完成），全部出网路径——
 * generate、models、产物 URL、版本查询、预请求——统一经它注入（testing.md §2）。
 */
export interface CommandCodeFactoryOptions {
  /** 宿主传入的 provider id；本插件四处同名常量（PROVIDER_ID），不用此值 */
  readonly name?: string
  readonly apiKey?: string
  /** 宿主/用户显式配置的 provider 级请求头，逐请求透传（伪装键优先，防冲突覆盖） */
  readonly headers?: Record<string, string>
  /** 出网接缝（json.ts FetchLike 形状，bun fetch 带 preconnect 静态属性、mock 实例难以满足其完整签名）；缺省 globalThis.fetch */
  readonly fetch?: FetchLike
  /**
   * modelsUrls 覆盖通道原样值（model-pipeline.md §1.3）：v1 `options.modelsUrls` /
   * v2 `settings.modelsUrls` 经宿主透传后在工厂 options 中以顶层键出现。构造时作
   * 初值；其后的调用经管线 rebindModelsUrls 重绑定（v2 的 config settings 首次
   * 工厂调用才可见，#36）。
   */
  readonly modelsUrls?: unknown
  /**
   * 注入式 logger（disguise.md §7 官方接缝；通道结论以 logger.ts 头注为准）。
   * 逐次工厂调用重指向最新注入值。
   */
  readonly logger?: DisguiseLogger
}

/** 工厂返回形状（v2-provider-contract.md §1：宿主经 languageModel(modelID) 取模型实例） */
export interface CommandCodeProvider {
  languageModel(modelID: string): LanguageModelV3
}

// ---------------------------------------------------------------------------
// 模块级运行时单例（跨工厂调用共享；见文件头「运行时共享」）
// ---------------------------------------------------------------------------

/** 逐次工厂调用重指向的注入接缝（宿主 fetch / provider 级头 / logger） */
interface ProviderSeam {
  fetch: FetchLike
  headers: Record<string, string>
  logger: DisguiseLogger
}

interface ProviderRuntime {
  state: DisguiseState
  pipeline: ModelPipeline
  /** 包内快照（已解析）：版本头兜底链 ④ 与管线初始层共用同一份 */
  snapshot: Artifact
  seam: ProviderSeam
  /** 稳定出网跳板：全部出网路径共用，逐次工厂调用重指向 seam.fetch 最新注入值 */
  trampoline: FetchLike
}

let runtime: ProviderRuntime | undefined

/**
 * 模型数据变更分发器：管线构造时只订阅这个稳定跳板，真实回调经
 * `ensureProviderRuntime` 注册（最后写入者生效）——v2 glue 接 `catalog.reload()`；
 * 插件热重载（setup 重跑）时旧 ctx 失效，重设让 reload 打到活 ctx 上。运行时由
 * 工厂先行构造（独立调用 / v1 形态）时无人注册，分发为 no-op。
 */
let onModelDataChange: ((cascade: CascadeResult) => void) | undefined

function loadPackageSnapshot(logger: DisguiseLogger): Artifact {
  const parsed = parseArtifact(PACKAGE_SNAPSHOT_JSON)
  if (parsed.ok) return parsed.artifact
  // 常量形状在编译期已定，此分支仅防御快照常量被改坏；兜底空清单保「永远可用」
  logger.warn(`包内快照解析失败（${JSON.stringify(parsed.error)}），以空清单兜底`)
  return { schemaVersion: 1, generatedAt: "", sourceCliVersion: "", models: [] }
}

/** 快照解析记忆化：latestCascade 的「运行时未构造」路径与运行时构造共用同一份；
 * 解析异常走 console warn（§7 生产退化通道——此路径无宿主 logger 可注入） */
let snapshotMemo: Artifact | undefined

function packageSnapshot(): Artifact {
  snapshotMemo ??= loadPackageSnapshot(consoleLogger())
  return snapshotMemo
}

/** 运行时构造参数：全部仅首次构造生效（幂等构造，后续调用忽略）；fetch/headers/
 * logger 构造后仍有逐次调用重指向的活接缝，modelsUrls 没有（管线构造时解析一次） */
export interface RuntimeInit {
  /** modelsUrls 的 config 通道原样值（v2 = settings.modelsUrls，glue 从 transform 捕获） */
  readonly modelsUrls?: unknown
  readonly fetch?: FetchLike
  readonly headers?: Record<string, string>
  readonly logger?: DisguiseLogger
  /** 模型数据变更回调（v2 glue 接 catalog.reload()）；不受幂等构造限制，任意时刻可重设 */
  readonly onModelDataChange?: (cascade: CascadeResult) => void
}

function getRuntime(init: RuntimeInit, startup: "start" | "defer" = "start"): ProviderRuntime {
  if (runtime !== undefined) return runtime
  const seam: ProviderSeam = {
    fetch: init.fetch ?? globalThis.fetch,
    headers: init.headers ?? {},
    logger: init.logger ?? consoleLogger(),
  }
  // 稳定出网跳板：伪装状态与管线构造时捕获本函数，全部出网路径（预请求 / models /
  // 产物 / 版本查询 / 图片下载 / generate）经它逐次转发到 seam.fetch 最新注入值
  const trampoline: FetchLike = (input, requestInit) => seam.fetch(input, requestInit)
  const trampolineLogger: DisguiseLogger = {
    debug: (message) => seam.logger.debug(message),
    warn: (message) => seam.logger.warn(message),
  }
  const snapshot = packageSnapshot()
  const state = createDisguiseState({
    fetch: trampoline,
    logger: trampolineLogger,
    // 版本头兜底链 ③/④ 接线（disguise.md §6）：产物层读管线内存（getter 调用时
    // 单例必已赋值），快照层读本包快照
    artifactSourceCliVersion: () => runtime?.pipeline.artifactSourceCliVersion(),
    snapshotSourceCliVersion: () => snapshot.sourceCliVersion,
  })
  const pipeline = createModelPipeline({
    snapshot,
    modelsUrls: init.modelsUrls,
    fetch: trampoline,
    logger: trampolineLogger,
    // 变更分发走模块级跳板：真实回调（catalog.reload）由 glue 注册、可随热重载重设
    onChange: (cascade) => onModelDataChange?.(cascade),
  })
  // 启动协商（#37）："start" = v2 节奏（零阻塞，首轮拉取转后台；v2 setup 与工厂
  // 独立调用都走它）；"defer" = v1 glue 的 config hook 构造后紧接 initializeOnce
  //（15s 预算拉一次、无后台刷新）。构造本身不指定形态——先后到达者定模式。
  if (startup === "start") pipeline.start()
  runtime = { state, pipeline, snapshot, seam, trampoline }
  return runtime
}

/**
 * v2 glue（#36）的运行时入口：幂等构造 + 变更回调注册。setup 语义下 modelsUrls
 * 的 config 通道（settings.modelsUrls）由 glue 在 transform 内捕获后传入；工厂侧
 * 宿主透传值只在工厂先行构造（独立调用 / v1 形态）时作构造初值。
 */
export function ensureProviderRuntime(init: RuntimeInit): void {
  if (init.onModelDataChange !== undefined) onModelDataChange = init.onModelDataChange
  getRuntime(init)
}

/**
 * v1 glue（#37）的运行时入口：v1 启动协商——幂等构造（不预启动）+ 启动拉取一次
 *（15s 总预算、失败用快照、此后无后台刷新，model-pipeline.md §4）。v1 config hook
 * 在注入模型清单前 await 本函数；运行时已被先行构造时（v2 setup / 工厂独立调用），
 * initializeOnce 的幂等守卫使本调用退化为「返回当前级联」。
 */
export async function ensureV1ProviderRuntime(init: RuntimeInit): Promise<CascadeResult> {
  const rt = getRuntime(init, "defer")
  await rt.pipeline.initializeOnce()
  return rt.pipeline.getModels()
}

/**
 * 当前级联（v2 glue 的 transform 回放数据源）：运行时已构造时读管线实时值（读时
 * 惰性检查 TTL，reload 回放顺带充当显式到期触发点）；未构造时为纯快照层——启动
 * 零阻塞的注册序：transform 先注册快照，后台拉取的变更经 reload 回放本函数更新。
 */
export function latestCascade(): CascadeResult {
  if (runtime !== undefined) return runtime.pipeline.getModels()
  return mergeModelLayers({ snapshot: packageSnapshot() })
}

// ---------------------------------------------------------------------------
// 工厂与 LanguageModelV3
// ---------------------------------------------------------------------------

export function createCommandCode(options: CommandCodeFactoryOptions): CommandCodeProvider {
  const rt = getRuntime(options)
  // 逐次调用重指向最新注入：宿主包装 fetch、provider 级自定义头、logger
  rt.seam.fetch = options.fetch ?? globalThis.fetch
  rt.seam.headers = options.headers ?? {}
  rt.seam.logger = options.logger ?? consoleLogger()
  // modelsUrls config 通道接驳（model-pipeline.md §1.3）：v2 宿主把 settings.modelsUrls
  // 合并进工厂 options（首次工厂调用前插件侧不可见——管线构造时按 env/默认列表启动，
  // 这里逐次重绑定，原值不变零开销）；v1 宿主的 options.modelsUrls 已由 glue 的
  // config hook 在构造时应用，管线在 v1 形态下忽略重绑定（无后台刷新，无需补拉）
  if (options.modelsUrls !== undefined) rt.pipeline.rebindModelsUrls(options.modelsUrls)
  const apiKey = options.apiKey ?? ""
  return {
    languageModel(modelID: string): LanguageModelV3 {
      return {
        specificationVersion: "v3",
        provider: PROVIDER_ID,
        modelId: modelID,
        supportedUrls: {},
        doStream: (callOptions) => doStream(rt, apiKey, modelID, callOptions),
        doGenerate: (callOptions) => doGenerate(rt, apiKey, modelID, callOptions),
      }
    },
  }
}

/**
 * reference 解析：`splitModelReference` 按首个 `/` 切分；wire id 自身可含 `/`，
 * 仅 provider 段与本插件同名（或无 `/` 的裸 id，其默认段即本插件）时才取切分结果，
 * 否则整串是无前缀 reference，原样透传。
 */
function resolveWireId(reference: string): string {
  const { providerId, wireId } = splitModelReference(reference)
  return providerId === PROVIDER_ID ? wireId : reference
}

/** 未注册模型的防御路径（级联查无此 id——注册与级联同源，正常路径永不触发）：
 * `max_tokens` 是信封必填字段，无级联真值可用时以调用方值为准，缺省兜构建侧同款
 * 上限常量（model-pipeline.md §1.1 maxOutput 补全链末级「常量 32000」——非本模块
 * 发明值）并打 warn 指明未注册；超限由网关 400 经错误映射表浮出，provider 不吞。 */
const FALLBACK_MAX_OUTPUT = 32_000

function fallbackMaxOutput(logger: DisguiseLogger, wireId: string, callerValue: number | undefined): number {
  logger.warn(
    `模型 ${wireId} 不在级联清单中（未注册或已下架），max_tokens 无级联上限可用` +
      `，按调用方值处理${callerValue === undefined ? `，缺省兜 ${FALLBACK_MAX_OUTPUT}` : ""}`,
  )
  return callerValue ?? FALLBACK_MAX_OUTPUT
}

/**
 * 一次调用的完整装配：产出执行内核的 stream part 生成器（doStream/doGenerate 共用，
 * 看门狗天然共享同一内核）。
 */
async function* callIterator(
  rt: ProviderRuntime,
  apiKey: string,
  modelID: string,
  options: LanguageModelV3CallOptions,
): AsyncGenerator<LanguageModelV3StreamPart> {
  const wireId = resolveWireId(modelID)

  // 预请求惰性检查（D5）：到点后台发射，主请求永不等待
  rt.state.maybeRunPreflight(apiKey)

  // 会话身份主路径（D3）：调用 headers 中 OpenCode 会话头任一存在即确定性派生；
  // 全部缺失落 per-key 回退轮换。threadId 与 x-session-id 同值由此一处保证。
  const sessionId = rt.state.resolveSessionId(apiKey, options.headers)

  // 模型 limit 数据（管线级联，stale-while-revalidate）：maxOutput 裁剪与图片模态
  const resolved = rt.pipeline.getModels().models.find((model) => model.id === wireId)
  const maxOutput = resolved?.maxOutput ?? fallbackMaxOutput(rt.seam.logger, wireId, options.maxOutputTokens)

  // 图片预处理（§5）：模态过滤 + 外链下载，不可投递者丢弃 + warn（绝不静默）
  const prompt = await preparePromptImages(options.prompt, {
    inputModalities: resolved?.inputModalities ?? [],
    modelId: wireId,
    fetch: rt.trampoline,
    logger: rt.seam.logger,
  })

  // 伪装填充点就绪：config 块（进程级冻结 + 24h 过期重采）与版本头（1.5s 竞速上限）并行
  const [configBlock, ccVersion] = await Promise.all([rt.state.getConfigBlock(), rt.state.getCommandCodeVersion()])

  const { body, warnings } = buildEnvelope(
    { ...options, prompt },
    {
      modelId: wireId,
      maxOutput,
      threadId: sessionId,
      // ConfigBlock → 信封填充点的零知识搬运：接口无索引签名，结构上仅此一处适配
      disguise: { config: configBlock as unknown as Record<string, unknown>, permissionMode: PERMISSION_MODE },
    },
  )

  // 伪装头组装；用户显式配置头垫底（被伪装键覆盖防冲突）；调用 headers 不透传
  const headers = {
    ...rt.seam.headers,
    ...buildGenerateHeaders({ apiKey, ccVersion, sessionId, workingDir: configBlock.workingDir }),
  }

  yield* generateStream({
    modelId: wireId,
    body,
    headers,
    fetchImpl: rt.trampoline,
    signal: options.abortSignal,
    warnings,
  })
}

/** doStream：主动推进首块（fetch 发起与 HTTP 层错误抛出在 await 时完成），
 * 其余部分包成 ReadableStream 交宿主。 */
async function doStream(
  rt: ProviderRuntime,
  apiKey: string,
  modelID: string,
  options: LanguageModelV3CallOptions,
): Promise<LanguageModelV3StreamResult> {
  const iterator = callIterator(rt, apiKey, modelID, options)
  const first = await iterator.next()
  let pending: LanguageModelV3StreamPart | undefined = first.done ? undefined : first.value

  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      if (pending !== undefined) {
        controller.enqueue(pending)
        pending = undefined
        return
      }
      try {
        const result = await iterator.next()
        if (result.done) controller.close()
        else controller.enqueue(result.value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      // 宿主弃流：走生成器 finally（看门狗定时器释放），上游 fetch 由宿主接缝管理
      void iterator.return(undefined)
    },
  })
  return { stream }
}

/** doGenerate = doStream 聚合（上游恒为流式）：text / reasoning 块按 id 归并、
 * tool-call 收拢增量、finish 收账；error part 无聚合通道，以 throw 浮出。 */
async function doGenerate(
  rt: ProviderRuntime,
  apiKey: string,
  modelID: string,
  options: LanguageModelV3CallOptions,
): Promise<LanguageModelV3GenerateResult> {
  const iterator = callIterator(rt, apiKey, modelID, options)
  const content: LanguageModelV3Content[] = []
  const warnings: SharedV3Warning[] = []
  /** 进行中的块（id → 块对象；对象引用已入 content，追加即聚合） */
  const open = new Map<string, { type: "text" | "reasoning"; text: string }>()
  let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
  let usage: LanguageModelV3Usage = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
  let providerMetadata: LanguageModelV3GenerateResult["providerMetadata"]

  for await (const part of iterator) {
    switch (part.type) {
      case "stream-start":
        warnings.push(...part.warnings)
        break
      case "text-start":
      case "reasoning-start": {
        const block = { type: part.type === "text-start" ? ("text" as const) : ("reasoning" as const), text: "" }
        open.set(part.id, block)
        content.push(block)
        break
      }
      case "text-delta":
      case "reasoning-delta": {
        const block = open.get(part.id)
        if (block !== undefined) block.text += part.delta
        break
      }
      case "text-end":
      case "reasoning-end":
        open.delete(part.id)
        break
      case "tool-call":
        content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
        break
      case "finish":
        finishReason = part.finishReason
        usage = part.usage
        if (part.providerMetadata !== undefined) providerMetadata = part.providerMetadata
        break
      case "error":
        // doGenerate 无流内错误通道：error part 一律抛出（宿主按 APICallError 分类）
        throw part.error
      default:
        // tool-input-* 增量已由一次性 tool-call 收拢；response-metadata 等不进 content
        break
    }
  }

  return {
    content,
    finishReason,
    usage,
    warnings,
    ...(providerMetadata !== undefined ? { providerMetadata } : {}),
  }
}

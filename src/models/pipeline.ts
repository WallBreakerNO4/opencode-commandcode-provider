/**
 * 模型管线运行时：刷新节奏与降级状态机（契约：docs/dev/spec/model-pipeline.md §4–§5、
 * 覆盖机制 models-url-override.md §4）。解析/级联（catalog.ts / cascade.ts）在此接上
 * 拉取、TTL 与重试。
 *
 * **刷新节奏**（§4）：
 * - 构建产物：按 modelsUrls 解析出的有序 URL 列表拉取、首个成功者胜；TTL 1h +
 *   随机抖动；内容 hash（signature.ts，只含 models）变化才触发下游动作（v2
 *   `catalog.reload()`）；渠道支持时带 ETag/Last-Modified 条件请求（304 = 未变，
 *   复用该渠道上次产物，不重下载不重解析）。
 * - `view=client` catalog：匿名拉取；TTL 跟随响应 `refreshAfterSeconds`（当前
 *   900s，缺失/非法回落默认值）；带 `If-None-Match` 条件请求（值为上次成功响应的
 *   catalogVersion），304 复用上次成功清单并重排 TTL；变更签名 = 排序后
 *   (id, context_length) 序列。
 * - **v2 形态**（`start`）：启动零阻塞——立即以包内快照注册返回，首轮拉取转后台，
 *   签名变化才回调 `onChange`（glue 接 catalog.reload()）。
 * - **v1 形态**（`initializeOnce`）：启动拉取一次（15s 总预算，跨渠道共享），失败
 *   用快照；之后不做后台刷新（v1 无 reload 机制）。
 *
 * **刷新驱动**：与伪装模块版本头同款惰性节奏——不挂 setInterval，读时（
 * `getModels`）或显式（`refreshIfDue`）检查 TTL 到点即后台刷新，
 * stale-while-revalidate：读永不等待在途拉取。
 *
 * **降级**（§5）：快照 = 「最后已知良好产物」的角色扮演者——产物/catalog 一旦成功
 * 拉到，后续刷新失败**沿用内存中的上次成功数据**（它就是最新鲜的最后已知良好
 * 数据，比内置快照新），只有从未成功过才落到内置快照；catalog 失败不缩小模型
 * 列表（发现 = 产物全集），只让 context/name 回落产物值。全部失败照常可用 +
 * 指数退避重试（30s 起、上限 30min），任一来源恢复即回到完整级联。所有降级路径
 * 打 warn 注明退到了哪层。
 *
 * 出网统一走注入的 fetch 接缝（testing.md §2）；时间直接取 `Date.now()`（fake
 * timers 驱动）。
 */

import type { FetchLike } from "../protocol/json.js"
import { parseArtifact, type Artifact } from "./artifact.js"
import { parseClientCatalog, type ClientCatalog } from "./catalog.js"
import { mergeModelLayers, type CascadeResult } from "./cascade.js"
import { artifactContentHash, catalogChangeSignature } from "./signature.js"
import { MODELS_URLS_ENV_VAR, resolveModelsUrls } from "./urls.js"

/** `view=client` catalog 端点（官方 CLI 1.84.0 起的发现源；匿名拉取） */
export const CLIENT_CATALOG_URL = "https://api.commandcode.ai/provider/v1/models?view=client"

/** 构建产物刷新 TTL：1h（§4） */
export const ARTIFACT_REFRESH_TTL_MS = 60 * 60 * 1000
/** 产物 TTL 随机抖动上限：+0～5min（错开整点、防雷群） */
export const ARTIFACT_TTL_JITTER_MS = 5 * 60 * 1000
/** 刷新失败指数退避基数：30s × 2^failCount（§5） */
export const REFRESH_RETRY_BASE_MS = 30 * 1000
/** 刷新失败指数退避上限：30min（§5） */
export const REFRESH_RETRY_CAP_MS = 30 * 60 * 1000
/** 单请求超时上限（v2 后台轮次逐请求计时） */
export const MODELS_FETCH_TIMEOUT_MS = 15 * 1000
/** v1 启动拉取的总预算：15s（§4，跨渠道共享——首渠道挂满预算即落快照） */
export const V1_STARTUP_TIMEOUT_MS = 15 * 1000

export interface PipelineLogger {
  debug(message: string): void
  warn(message: string): void
}

const defaultLogger: PipelineLogger = {
  debug: (message) => console.debug(message),
  warn: (message) => console.warn(message),
}

export interface ModelPipelineOptions {
  /** 包内快照（已解析的 Artifact）：启动即注册的初始层，产物从未成功时顶替产物角色 */
  readonly snapshot: Artifact
  /** modelsUrls 的 config 通道原样值（v1 工厂 options / v2 settings 透传的顶层键，未解析） */
  readonly modelsUrls?: unknown
  /** 出网接缝（工厂 options.fetch；缺省 globalThis.fetch） */
  readonly fetch?: FetchLike
  readonly logger?: PipelineLogger
  /** 下游动作（v2 catalog.reload()）：产物内容 hash 或 catalog 签名变化时回调，携带最新级联 */
  readonly onChange?: (cascade: CascadeResult) => void
}

export interface ModelPipeline {
  /** v2 形态：启动零阻塞——立即返回快照注册的级联，首轮拉取转后台 */
  start(): CascadeResult
  /** v1 形态：启动拉取一次（15s 总预算），失败用快照；此后不做后台刷新 */
  initializeOnce(): Promise<CascadeResult>
  /** 当前级联结果；读时惰性检查 TTL，到点转后台刷新（stale-while-revalidate，读不等待） */
  getModels(): CascadeResult
  /** 显式到期检查并触发后台刷新；返回在途轮次的落定 promise（宿主无读机会时的兜底触发点） */
  refreshIfDue(): Promise<void>
  /**
   * modelsUrls config 通道的运行时接驳（model-pipeline.md §1.3，#36）：v2 宿主把
   * `settings.modelsUrls` 合并进工厂 options 顶层——但那要等首次工厂调用才可见
   * （beta-18684 实测：transform 草稿不带 config settings，插件侧构造时拿不到），
   * 构造时管线只能按 env/默认列表启动。本方法在工厂调用时把 config 值重绑定进
   * 管线：原值未变零开销跳过（宿主按 key 缓存实例、工厂调用频次由 key 变化决定）；
   * 解析列表真变了才替换并立即触发一轮产物拉取（不等 TTL——用户切换镜像不该等
   * 1h）；非法值按 §1.3 回退并 warn。v1 形态（无后台刷新）不接驳。
   */
  rebindModelsUrls(config: unknown): void
  /**
   * 版本头兜底链 ③（disguise.md §6）：内存中已拉取构建产物的 `sourceCliVersion`。
   * 只读内存——不触发拉取、不等待；产物从未成功时 undefined（调用方落 ④ 快照层）。
   */
  artifactSourceCliVersion(): string | undefined
}

interface SourceOutcome {
  readonly attempted: boolean
  readonly ok: boolean
  readonly changed: boolean
  /** 失败原因摘要（warn 用）；成功为 undefined */
  readonly detail?: string
}

const idleOutcome: SourceOutcome = { attempted: false, ok: true, changed: false }

interface ChannelCache {
  readonly artifact: Artifact
  readonly etag?: string
  readonly lastModified?: string
}

export function createModelPipeline(options: ModelPipelineOptions): ModelPipeline {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const logger = options.logger ?? defaultLogger

  // modelsUrls 三通道解析（config > env > 默认）在构造时完成一次；解析永不失败、
  // 不阻断启动（urls.ts）。env 直读进程环境（models-url-override.md §3.1：v1/v2
  // 插件均在宿主进程内），测试以 config 通道与解析器参数注入直测，不碰该变量。
  // config 值的运行时接驳见 rebindModelsUrls（#36：v2 的 config settings 经工厂
  // options 才可见，构造时通常缺席）。
  let { urls } = resolveModelsUrls({
    config: options.modelsUrls,
    env: process.env[MODELS_URLS_ENV_VAR],
    logger,
  })
  /** 上次重绑定的 config 原值：宿主随工厂调用透传的 settings 未变即零开销跳过 */
  let modelsUrlsRaw: unknown = options.modelsUrls

  const snapshot = options.snapshot

  const state = {
    /** 上次成功产物（sticky——刷新失败不清空，它就是最新鲜的「最后已知良好产物」） */
    artifact: undefined as Artifact | undefined,
    artifactHash: undefined as string | undefined,
    /** 上次成功 catalog（sticky，同上；catalogVersion / refreshAfterSeconds 随它保留） */
    catalog: undefined as ClientCatalog | undefined,
    catalogSignature: undefined as string | undefined,
    nextArtifactAttemptAt: 0,
    nextCatalogAttemptAt: 0,
    artifactFailCount: 0,
    catalogFailCount: 0,
  }

  /** 宿主形态：initializeOnce → v1（此后刷新停用）；start → v2 */
  let mode: "v1" | "v2" | undefined
  let current: CascadeResult = mergeModelLayers({ snapshot })
  let roundInFlight: Promise<void> | undefined
  /** 条件请求记忆：每渠道上次成功响应的 validators + 解析产物（304 复用） */
  const channelCache = new Map<string, ChannelCache>()

  function recomputeCascade(): void {
    current = mergeModelLayers({ catalog: state.catalog?.models, artifact: state.artifact, snapshot })
  }

  function backoffDelay(failCount: number): number {
    return Math.min(REFRESH_RETRY_BASE_MS * 2 ** failCount, REFRESH_RETRY_CAP_MS)
  }

  function formatDelay(ms: number): string {
    return ms % 60_000 === 0 ? `${ms / 60_000}min` : `${Math.round(ms / 1000)}s`
  }

  /** 逐请求信号：v1 轮次直接以 15s 总预算信号为每请求上限（预算与请求上限合一，
   * 不叠加独立 per-request 计时器——两个同刻 15s 计时器触发次序不定，会让
   * 「预算耗尽即止损」的判断出现一拍竞态）；v2 轮次：仅单请求超时 */
  function requestSignal(deadline: AbortSignal | undefined): AbortSignal {
    return deadline ?? AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS)
  }

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** 应用一次成功产物：更新 sticky 层与 hash，重排 TTL；返回内容是否变化 */
  function applyArtifact(artifact: Artifact): boolean {
    const hash = artifactContentHash(artifact)
    const changed = state.artifactHash !== hash
    state.artifact = artifact
    state.artifactHash = hash
    state.artifactFailCount = 0
    state.nextArtifactAttemptAt = Date.now() + ARTIFACT_REFRESH_TTL_MS + Math.floor(Math.random() * ARTIFACT_TTL_JITTER_MS)
    // 镜像滞后自查点（models-url-override.md §4.4）：每次成功拉取都落 generatedAt
    logger.debug(
      `构建产物拉取成功：generatedAt=${artifact.generatedAt}，sourceCliVersion=${artifact.sourceCliVersion}，${artifact.models.length} 个模型`,
    )
    return changed
  }

  /**
   * 产物层：按 URL 列表顺序尝试，首个成功者胜（解析失败/非 2xx/超时都算该渠道
   * 失败，继续下一渠道——未来版本号是「这一份」产物被弃用，列表后位可能是旧但
   * 可读的副本）。全渠道失败才动退避与降级告警。
   */
  async function fetchArtifactIntoState(deadline: AbortSignal | undefined): Promise<SourceOutcome> {
    const failures: string[] = []
    for (const url of urls) {
      if (deadline?.aborted) {
        failures.push("启动预算耗尽，剩余渠道跳过")
        break
      }
      try {
        const cached = channelCache.get(url)
        const headers: Record<string, string> = { accept: "application/json" }
        if (cached?.etag !== undefined) headers["if-none-match"] = cached.etag
        if (cached?.lastModified !== undefined) headers["if-modified-since"] = cached.lastModified
        const response = await fetchImpl(url, { headers, signal: requestSignal(deadline) })
        if (response.status === 304 && cached !== undefined) {
          // 未变：复用该渠道上次产物（内容同上次成功响应，hash 比对后大概率无动作）
          return { attempted: true, ok: true, changed: applyArtifact(cached.artifact) }
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body: unknown = await response.json()
        const parsed = parseArtifact(body)
        if (!parsed.ok) {
          // 未来版本号 = 上游破坏性变更已发布，是最需要人看见的渠道级事件，
          // 单独 warn（其余渠道级失败只在整层降级时随汇总 warn 出现）
          if (parsed.error.reason === "future-version") {
            logger.warn(`构建产物渠道 ${url} 的产物 schemaVersion ${parsed.error.schemaVersion} 高于已知上限，整体弃用该产物`)
            failures.push(`${url} → schemaVersion ${parsed.error.schemaVersion} 高于已知上限，整体弃用`)
            continue
          }
          throw new Error(`产物解析失败：${parsed.error.detail}`)
        }
        channelCache.set(url, {
          artifact: parsed.artifact,
          etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined,
        })
        return { attempted: true, ok: true, changed: applyArtifact(parsed.artifact) }
      } catch (error) {
        failures.push(`${url} → ${describeError(error)}`)
        if (deadline?.aborted) break
      }
    }

    state.nextArtifactAttemptAt = Date.now() + backoffDelay(state.artifactFailCount)
    state.artifactFailCount += 1
    const summary = `构建产物拉取失败（${failures.join("；")}）`
    if (state.artifact === undefined) {
      logger.warn(`${summary}，包内快照顶替产物角色`)
    } else {
      logger.warn(`${summary}，沿用上次成功产物（相当于快照角色）`)
    }
    return { attempted: true, ok: false, changed: false, detail: failures.join("；") }
  }

  /** `If-None-Match` 值：服务端 ETag 即带引号的 catalogVersion；版本号含引号/换行符
   * 时不能安全进请求头，放弃条件请求（全量拉取代价可接受） */
  function catalogEtag(catalogVersion: string): string | undefined {
    return /["\r\n]/.test(catalogVersion) ? undefined : `"${catalogVersion}"`
  }

  /**
   * catalog 层：单次拉取 + 条件请求 + 签名比对；失败动退避（降级 warn 归轮次
   * 落定后统一打，判层才准确）。catalog 只作 context/name 的字段级权威，失败不
   * 影响模型列表（发现 = 产物全集）。
   */
  async function fetchCatalogIntoState(deadline: AbortSignal | undefined): Promise<SourceOutcome> {
    try {
      const headers: Record<string, string> = { accept: "application/json" }
      const cachedVersion = state.catalog?.catalogVersion
      const etag = cachedVersion === undefined ? undefined : catalogEtag(cachedVersion)
      if (etag !== undefined) headers["if-none-match"] = etag
      const response = await fetchImpl(CLIENT_CATALOG_URL, {
        headers,
        signal: requestSignal(deadline),
      })
      if (response.status === 304 && state.catalog !== undefined) {
        // 未变：复用上次成功清单（含其 refreshAfterSeconds），只重排节奏
        state.catalogFailCount = 0
        state.nextCatalogAttemptAt = Date.now() + state.catalog.refreshAfterSeconds * 1000
        logger.debug(`client catalog 未变化（catalogVersion=${state.catalog.catalogVersion ?? "未知"}），复用上次成功清单`)
        return { attempted: true, ok: true, changed: false }
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body: unknown = await response.json()
      const parsed = parseClientCatalog(body)
      if (!parsed.ok) throw new Error(`client catalog 解析失败：${parsed.detail}`)
      const signature = catalogChangeSignature(parsed.catalog.models)
      const changed = state.catalogSignature !== signature
      state.catalog = parsed.catalog
      state.catalogSignature = signature
      state.catalogFailCount = 0
      state.nextCatalogAttemptAt = Date.now() + parsed.catalog.refreshAfterSeconds * 1000
      logger.debug(
        `client catalog 拉取成功：catalogVersion=${parsed.catalog.catalogVersion ?? "未知"}，${parsed.catalog.models.length} 条，${parsed.catalog.refreshAfterSeconds}s 后刷新`,
      )
      return { attempted: true, ok: true, changed }
    } catch (error) {
      state.nextCatalogAttemptAt = Date.now() + backoffDelay(state.catalogFailCount)
      state.catalogFailCount += 1
      return { attempted: true, ok: false, changed: false, detail: describeError(error) }
    }
  }

  /** 一轮刷新：到点的来源并行拉取，落定后统一重算级联、判变更、触发下游 */
  function runRound(deadline?: AbortSignal): Promise<void> {
    if (roundInFlight !== undefined) return roundInFlight
    const task = (async () => {
      try {
        const wantArtifact = Date.now() >= state.nextArtifactAttemptAt
        const wantCatalog = Date.now() >= state.nextCatalogAttemptAt
        if (!wantArtifact && !wantCatalog) return
        const [artifactOutcome, catalogOutcome] = await Promise.all([
          wantArtifact ? fetchArtifactIntoState(deadline) : idleOutcome,
          wantCatalog ? fetchCatalogIntoState(deadline) : idleOutcome,
        ])
        recomputeCascade()
        // catalog 降级 warn 归轮次落定后统一打：degradedTo 依据最终产物层判层——
        // 在 fetch 内判会撞上并行产物拉取未落定的竞态（两个来源并行拉取）
        if (catalogOutcome.attempted && !catalogOutcome.ok) {
          if (state.catalog === undefined) {
            const degradedTo = current.productLayer === "artifact" ? "产物" : "快照"
            logger.warn(
              `client catalog 拉取失败（${catalogOutcome.detail}），context/name 回落${degradedTo}值，模型列表按${degradedTo}全集注册`,
            )
          } else {
            logger.warn(`client catalog 刷新失败（${catalogOutcome.detail}），沿用上次成功清单`)
          }
        }
        if (artifactOutcome.attempted && catalogOutcome.attempted && !artifactOutcome.ok && !catalogOutcome.ok) {
          // 全部来源失败（§5）：照常可用 + 指数退避；下次可试时刻取两来源的较早者
          const nextRetry = Math.min(state.nextArtifactAttemptAt, state.nextCatalogAttemptAt) - Date.now()
          const holding =
            state.artifact === undefined
              ? "包内快照全量注册照常可用（数据可能过期）"
              : "沿用上次成功数据照常可用"
          logger.warn(`模型数据全部来源失败：${holding}，${formatDelay(Math.max(nextRetry, 0))} 后指数退避重试`)
        }
        if ((artifactOutcome.changed || catalogOutcome.changed) && mode !== "v1") {
          try {
            options.onChange?.(current)
          } catch (error) {
            logger.warn(`模型管线 onChange 回调失败：${describeError(error)}`)
          }
        }
      } finally {
        roundInFlight = undefined
      }
    })()
    roundInFlight = task
    return task
  }

  /** 到期检查 + 后台刷新触发；返回在途轮次 promise（无动作立即落定） */
  function refreshIfDue(): Promise<void> {
    if (mode === "v1") return Promise.resolve()
    if (Date.now() >= state.nextArtifactAttemptAt || Date.now() >= state.nextCatalogAttemptAt) {
      void runRound()
    }
    return roundInFlight ?? Promise.resolve()
  }

  function rebindModelsUrls(config: unknown): void {
    if (mode !== "v2") return
    if (config === undefined) return
    // 原值未变（宿主随工厂调用透传同一 settings）→ 不重解析不打日志
    if (JSON.stringify(config) === JSON.stringify(modelsUrlsRaw)) return
    modelsUrlsRaw = config
    const resolved = resolveModelsUrls({
      config,
      env: process.env[MODELS_URLS_ENV_VAR],
      logger,
    })
    if (resolved.urls.join("\n") === urls.join("\n")) {
      urls = resolved.urls
      return
    }
    urls = resolved.urls
    // 用户显式替换列表：立即补一轮产物拉取（TTL 未到点也拉——镜像切换不该等 1h）；
    // 在途轮次仍用旧列表跑完，下一轮起走新列表（stale-while-revalidate）
    state.nextArtifactAttemptAt = 0
    void runRound()
  }

  return {
    start(): CascadeResult {
      if (mode !== undefined) {
        logger.warn("模型管线入口已初始化过，start() 忽略重复调用")
        return current
      }
      mode = "v2"
      // 零阻塞：首轮 fire-and-forget，快照级联先返回
      void runRound()
      return current
    },

    async initializeOnce(): Promise<CascadeResult> {
      if (mode === "v1") {
        // 幂等重入：v1 config 重载会重放 config hook，同一进程的启动协商只做一次，
        // 静默返回现值（模型清单已在首轮注入 config）
        return current
      }
      if (mode !== undefined) {
        logger.warn("模型管线已以 v2 形态启动，initializeOnce() 不切换形态——v1 启动拉取未执行，模型停在当前级联")
        return current
      }
      mode = "v1"
      await runRound(AbortSignal.timeout(V1_STARTUP_TIMEOUT_MS))
      // v1 无 reload 机制：本轮之后关闭一切后台刷新（applyArtifact 会在轮内重排
      // TTL，此处覆写为永不到期；refreshIfDue 的 mode 检查是第二道闸）
      state.nextArtifactAttemptAt = Number.POSITIVE_INFINITY
      state.nextCatalogAttemptAt = Number.POSITIVE_INFINITY
      return current
    },

    getModels(): CascadeResult {
      void refreshIfDue()
      return current
    },

    refreshIfDue,
    rebindModelsUrls,

    artifactSourceCliVersion(): string | undefined {
      return state.artifact?.sourceCliVersion
    },
  }
}

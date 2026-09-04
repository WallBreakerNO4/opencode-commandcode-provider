/**
 * modelsUrls 覆盖解析（契约：docs/spec/model-pipeline.md §1.3 覆盖机制条款 +
 * docs/research/models-url-override.md §4 定案）。
 *
 * 三通道优先级 config > env > 默认列表，语义为**整列表替换**——解析结果完整取代
 * 内置列表，不拼接不插位；包内快照不占列表位（快照兜底归 pipeline 的降级层，
 * 不经本函数）。非法值逐项校验：可解析且 http/https 的绝对 URL，非法项丢弃 +
 * 逐项 warn；值为非数组/非字符串或合法项为零时整体回退默认列表 + warn（config
 * 非法 → 试 env → 仍非法 → 默认，每级 warn）。任何路径不抛错、不阻断启动。
 *
 * 本函数为纯解析：`config` / `env` 以参数注入直测（models-url-override.md §3.2
 * 纪律——测试不使用 COMMANDCODE_MODELS_URLS 变量本身，保证「变量存在 ≠ 测试后门」）；
 * 生产侧由 pipeline 构造时传入 `process.env.COMMANDCODE_MODELS_URLS` 原值。
 */

/** 内置默认 URL 列表（ADR 0001：Release → npmmirror files → unpkg → raw data 分支） */
export const DEFAULT_MODELS_URLS: readonly string[] = [
  "https://github.com/WallBreakerNO4/opencode-commandcode-provider/releases/latest/download/models.json",
  "https://registry.npmmirror.com/@wallbreakerno4/opencode-commandcode-models/latest/files/models.json",
  "https://unpkg.com/@wallbreakerno4/opencode-commandcode-models@latest/models.json",
  "https://raw.githubusercontent.com/WallBreakerNO4/opencode-commandcode-provider/data/models.json",
]

/** 统一环境变量兜底通道（逗号分隔；用户配置面，非测试通道） */
export const MODELS_URLS_ENV_VAR = "COMMANDCODE_MODELS_URLS"

/** 解析结果来源：命中哪个通道 */
export type ModelsUrlsSource = "config" | "env" | "default"

/** 结构上与 disguise 的 DisguiseLogger 同形；有意不跨模块共享类型——models 对
 * disguise 保持零依赖，glue 注入同一个适配器即可同时满足两边 */
export interface ModelsUrlsLogger {
  debug(message: string): void
  warn(message: string): void
}

export interface ResolvedModelsUrls {
  readonly urls: readonly string[]
  readonly source: ModelsUrlsSource
}

export interface ResolveModelsUrlsInput {
  /** config 通道原样值：v1 工厂 options.modelsUrls / v2 settings 透传的顶层键，未解析 */
  readonly config?: unknown
  /** env 通道原值（process.env[MODELS_URLS_ENV_VAR]）；undefined = 未设置，空串视为未配置 */
  readonly env?: string | undefined
  readonly logger: ModelsUrlsLogger
}

/** 解析 modelsUrls：绝不抛错，任何非法输入都落到某个可用列表上 */
export function resolveModelsUrls(input: ResolveModelsUrlsInput): ResolvedModelsUrls {
  const configParsed = parseUrlList(input.config, input.logger)
  if (configParsed !== null) {
    input.logger.debug(`modelsUrls 生效来源=config，URL 列表：[${configParsed.join("，")}]`)
    return { urls: configParsed, source: "config" }
  }
  // env 未设置/空串静默跳过（视为未配置）；设了但整体非法才 warn 并逐级回退
  const envValue = input.env?.trim()
  if (envValue !== undefined && envValue.length > 0) {
    const envParsed = parseUrlList(envValue, input.logger)
    if (envParsed !== null) {
      input.logger.debug(`modelsUrls 生效来源=env，URL 列表：[${envParsed.join("，")}]`)
      return { urls: envParsed, source: "env" }
    }
  }
  input.logger.debug(`modelsUrls 生效来源=default，URL 列表：[${DEFAULT_MODELS_URLS.join("，")}]`)
  return { urls: DEFAULT_MODELS_URLS, source: "default" }
}

/**
 * 单通道值解析：数组或逗号分隔字符串 → 合法 URL 列表。
 * 逐项校验，非法项丢弃 + 逐项 warn；整体非法（非数组/非字符串、合法项为零）
 * warn 一次并返回 null（调用方逐级回退）。
 * 返回 null 只代表「该通道整体不可用」——通道内仍有合法项时不回退（逐项丢弃 ≠ 整体回退）。
 */
function parseUrlList(value: unknown, logger: ModelsUrlsLogger): readonly string[] | null {
  if (value === undefined) return null

  // 逗号分隔字符串先滤掉空段再进循环："a,,b"、尾逗号是格式噪音，静默跳过；
  // 数组不经预滤——显式写出的空串/空格串是用户笔误，照常 warn
  const rawItems: readonly unknown[] | null =
    typeof value === "string"
      ? value.split(",").filter((segment) => segment.trim().length > 0)
      : Array.isArray(value)
        ? value
        : null
  if (rawItems === null) {
    logger.warn(`modelsUrls 值非法（${preview(value)}）：须为 URL 数组或逗号分隔字符串，回退内置默认列表`)
    return null
  }

  const urls: string[] = []
  for (const [index, raw] of rawItems.entries()) {
    const item = typeof raw === "string" ? raw.trim() : undefined
    if (item === undefined || item.length === 0) {
      logger.warn(`modelsUrls[${index}] 非法项已丢弃（${preview(raw)}）：须为 http(s) 绝对 URL 字符串`)
      continue
    }
    if (!isHttpUrl(item)) {
      logger.warn(`modelsUrls[${index}] 非法项已丢弃：「${item}」：须为 http(s) 绝对 URL`)
      continue
    }
    urls.push(item)
  }

  if (urls.length === 0) {
    logger.warn(`modelsUrls 值非法（${preview(value)}）：合法项为零，回退内置默认列表`)
    return null
  }
  return urls
}

/** http/https 绝对 URL 校验（§1.3：可解析且协议为 http:/https:） */
function isHttpUrl(item: string): boolean {
  try {
    const url = new URL(item)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/** 原值预览：warn 里注明被回退的原始值（截断防日志爆炸） */
function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

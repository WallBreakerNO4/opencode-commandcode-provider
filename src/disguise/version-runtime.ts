/**
 * 版本头 `x-command-code-version` 状态机（disguise.md §6）：
 *
 * - **数据源顺序**：npm registry 直连 → jsDelivr 镜像，各挂 1.5s 超时
 *   （`AbortSignal.timeout`），任一成功即为一手拉取值；
 * - **初解析（D6b）**：进程内首次取值时启动拉取链并只等 1.5s——抢到用新值，
 *   抢不到先用兜底值放行、链转后台跑完；修 fire-and-forget「初期请求带陈旧值」
 *   的同时不让被墙的 npm 拖住首请求；
 * - **24h 惰性刷新（D6c）**：每次取值比对「距上次**成功**拉取是否超 24h」，到点
 *   后台触发拉取链。不挂 `setInterval`、不加抖动。全源失败时按字面语义每次取值
 *   都会重试——全断即 fail-fast（fetch 即刻 reject），fire-and-forget 无主请求
 *   代价，换网络恢复后的即时校准；
 * - **重估时刻（#19）**：版本值只在初解析与 24h 刷新两处重算，兜底链的
 *   artifact/snapshot 层此刻才被读取——期间模型管线产物刷新不引起版本头翻转；
 * - **兜底链**：竞速值（内存）→ 落盘缓存 → 产物 `sourceCliVersion`（只读内存
 *   getter，不触发拉取不等待）→ 包内快照 `sourceCliVersion`（version.ts 纯函数）。
 *   一手拉取成功才写落盘缓存（③ 的值不回写，§6）；写失败降兜底 + warn。
 *
 * 出网统一走注入的 fetch 接缝（testing.md §2：全部出网路径经工厂 options.fetch 注 mock）。
 */

import type { FetchLike } from "../protocol/json.js"
import { consoleLogger, type DisguiseLogger } from "./logger.js"
import { resolveCommandCodeVersion } from "./version.js"
import { readVersionCache, writeVersionCache, type VersionCacheEntry } from "./version-cache.js"

/** 初解析限时等待：超过即用兜底值放行，拉取链转后台 */
export const VERSION_RACE_MS = 1500
/** 单一数据源（npm / jsDelivr）的超时上限 */
export const VERSION_SOURCE_TIMEOUT_MS = 1500
/** 惰性刷新间隔（§11 参数速查：24h，无抖动） */
export const VERSION_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

const NPM_REGISTRY_URL = "https://registry.npmjs.org/command-code/latest"
const JSDELIVR_URL = "https://cdn.jsdelivr.net/npm/command-code/package.json"

export interface VersionResolverOptions {
  /** 出网接缝（工厂 options.fetch；缺省 globalThis.fetch） */
  fetch?: FetchLike
  logger?: DisguiseLogger
  /** 兜底链 ③：模型管线内存中已拉取产物的 sourceCliVersion（不触发拉取、不等待） */
  artifactSourceCliVersion?: () => string | undefined
  /** 兜底链 ④：包内快照的 sourceCliVersion（随插件发版更新） */
  snapshotSourceCliVersion?: () => string | undefined
}

export interface VersionResolver {
  /** 当前版本值；初解析未完成时等待（≤1.5s 竞速），四层皆空返回 undefined（调用方决定放行形态） */
  getVersion(): Promise<string | undefined>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createVersionResolver(options: VersionResolverOptions = {}): VersionResolver {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const logger = options.logger ?? consoleLogger()

  // 全部状态收在本闭包（§10 修写表：单一模块 state，非散装全局变量）
  let raced: string | undefined
  let cachedEntry: VersionCacheEntry | undefined
  let resolved: string | undefined
  let cacheRead: Promise<void> | undefined
  let initialResolution: Promise<void> | undefined
  let chainInFlight: Promise<void> | undefined
  /** 上次成功拉取的时刻（epoch ms）；0 = 从未成功（D6c 字面语义：此时每次取值都视为到期） */
  let lastFetchedAt = 0

  function recompute(): void {
    resolved = resolveCommandCodeVersion({
      raced,
      cached: cachedEntry?.version,
      artifact: options.artifactSourceCliVersion?.(),
      snapshot: options.snapshotSourceCliVersion?.(),
    })
  }

  function readCacheOnce(): Promise<void> {
    cacheRead ??= readVersionCache(logger).then((entry) => {
      cachedEntry = entry
    })
    return cacheRead
  }

  /** 单一数据源拉取：GET packument/package.json 取 `version`；非 2xx / 形状不对 / 超时一律 reject */
  async function fetchSourceVersion(url: string): Promise<string> {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(VERSION_SOURCE_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body: unknown = await response.json()
    const version = asRecord(body)?.["version"]
    if (typeof version !== "string" || version.length === 0) throw new Error("响应缺少 version 字段")
    return version
  }

  /**
   * 拉取链：npm 直连 → jsDelivr 镜像，先到者胜。成功即更新内存与兜底链并重估
   * （24h 刷新是规格允许的第二个重估时刻）；写缓存失败只 warn，不影响内存值。
   * 整体绝不 reject（调用方均为 fire-and-forget 或竞速等待，无 await 侧异常路径）。
   */
  function refreshChain(): Promise<void> {
    if (chainInFlight) return chainInFlight
    const task = (async () => {
      try {
        let version: string | undefined
        try {
          version = await fetchSourceVersion(NPM_REGISTRY_URL)
        } catch {
          version = await fetchSourceVersion(JSDELIVR_URL).catch(() => undefined)
        }
        if (version === undefined) return
        raced = version
        recompute() // 内存值先行更新（主请求永不等待磁盘）；落盘只服务下次进程的兜底链
        const entry: VersionCacheEntry = { version, fetchedAt: new Date().toISOString() }
        try {
          await writeVersionCache(entry)
          cachedEntry = entry
        } catch (error) {
          logger.warn(`版本缓存写入失败，降兜底值：${error instanceof Error ? error.message : String(error)}`)
        }
        lastFetchedAt = Date.now() // D6c 字面：成功拉取才记账
        logger.debug(`x-command-code-version 更新为 ${version}`)
      } finally {
        chainInFlight = undefined
      }
    })()
    chainInFlight = task
    return task
  }

  /** 初解析（仅一次）：读盘与竞速并行，1.5s 限时等链，超时落兜底链取值放行 */
  function resolveInitial(): Promise<void> {
    return (async () => {
      await Promise.race([refreshChain(), delay(VERSION_RACE_MS)])
      await readCacheOnce()
      recompute()
    })()
  }

  return {
    async getVersion(): Promise<string | undefined> {
      // 24h 惰性刷新（D6c 字面）：距上次成功拉取超 24h 即后台触发；失败链在下次
      // 取值时照常重试（全断即 fail-fast，无主请求代价）；chainInFlight 去重保证
      // 初解析期间与并发取值不重复发起
      if (Date.now() - lastFetchedAt >= VERSION_REFRESH_INTERVAL_MS) void refreshChain()
      initialResolution ??= resolveInitial()
      await initialResolution
      return resolved
    },
  }
}

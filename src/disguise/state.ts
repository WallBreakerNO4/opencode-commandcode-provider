/**
 * 伪装模块的状态与调度门面（disguise.md §1/§3/§5，#33）：
 *
 * - **per-key 内存 KeyState**（`Map<apiKey, KeyState>`，key 为 Map 键原文、绝不
 *   落盘绝不进日志——日志一律经 redactApiKey 短哈希）：指纹、回退会话、预请求
 *   调度；全局内存态（ccVersion、config 冻结）收在对应子模块；
 * - **指纹进程内稳定（D1）**：KeyState 只增不删，会话轮换只换 session 不删指纹，
 *   进程重启 = Map 清空、首见 key 重新采集并立即重报（MAXeaglet 同款重启语义）；
 * - **会话身份主路径（D3）**：doStream 调用 headers 中 `X-Session-Id` /
 *   `x-session-affinity`（v2 另有同值 `x-opencode-session`）任一存在即确定性派生
 *   `x-session-id`（session.ts 纯函数）——无需存储即保证同会话同 id、跨重启同 id；
 *   多头同场值不一致 warn（「值漂移打日志」的落地；跨请求漂移无法与正常的新会话
 *   区分，不告警防噪音）。全部缺失才落回退路径：per-key 随机 uuid v4、12h +
 *   0~1h 抖动惰性轮换；
 * - **预请求调度（D2/D5）**：startPreflight 对齐真实 CLI「每进程启动发一次」
 *   （幂等守卫）；主请求前 maybeRunPreflight 做惰性补发/退避重试检查，到点后台
 *   发射，主请求永不等待；
 * - 全部出网与采集依赖经构造 options 注入（工厂 options.fetch、注入式 logger、
 *   ConfigRuntime、兜底链 getter），测试零后门。
 */

import { randomUUID } from "node:crypto"
import type { FetchLike } from "../protocol/json.js"
import { initialPreflightState, type PreflightState } from "./backoff.js"
import { createFrozenConfigProvider, type FrozenConfigProvider } from "./config-freeze.js"
import type { ConfigBlock, ConfigRuntime } from "./config-block.js"
import { buildFingerprintBody, collectFingerprintComponents, type FingerprintBody } from "./fingerprint.js"
import { consoleLogger, type DisguiseLogger } from "./logger.js"
import { runPreflight } from "./preflight.js"
import { deriveSessionId } from "./session.js"
import { redactIdentifier } from "./redact.js"
import { createVersionResolver, type VersionResolver } from "./version-runtime.js"

/** 会话头查找优先级（session-visibility.md §6：v1 两键 + v2 同值第三键） */
const SESSION_HEADERS = ["X-Session-Id", "x-session-affinity", "x-opencode-session"] as const

/** 回退路径会话寿命：12h + 0~1h 抖动（§11 参数速查，惰性轮换） */
export const SESSION_TTL_BASE_MS = 12 * 60 * 60 * 1000
export const SESSION_TTL_JITTER_MS = 60 * 60 * 1000

export interface DisguiseStateOptions {
  /** 出网接缝（工厂 options.fetch；预请求与版本查询全部经此注入 mock） */
  fetch?: FetchLike
  /** 注入式 logger（§7；v2 glue 注 client.app.log 适配器，v1/独立调用退化 console） */
  logger?: DisguiseLogger
  /** config 采集 runtime 接缝（生产 createNodeConfigRuntime()，测试注 fake） */
  configRuntime?: ConfigRuntime
  /** 版本兜底链 ③：模型管线内存中已拉取产物的 sourceCliVersion */
  artifactSourceCliVersion?: () => string | undefined
  /** 版本兜底链 ④：包内快照的 sourceCliVersion */
  snapshotSourceCliVersion?: () => string | undefined
}

/** per-key 内存态（D1）；只增不删，进程重启即清空 */
interface KeyState {
  /** 指纹 body 采集 promise（进程内稳定：采集一次后复用，会话轮换不删） */
  fingerprintBody: Promise<FingerprintBody> | undefined
  /** 回退路径会话（主路径无过期语义，不落此字段，§1） */
  session: { id: string; expiresAt: number } | undefined
  /** 预请求调度（backoff.ts 状态机载体） */
  preflight: PreflightState
  /** 预请求 in-flight 守卫：任何时刻至多一轮在跑 */
  preflightInFlight: boolean
  /** 启动预请求已发过（对齐「每进程启动发一次」，D2） */
  startupPreflightStarted: boolean
}

export interface DisguiseState {
  /**
   * 进程启动预请求（D2）：指纹 + lifecycle 并行、各 3s 超时、fire-and-forget。
   * 幂等：每进程每 key 至多发一次；对 key 的首请求也可能先于本调用发生（此时
   * maybeRunPreflight 的首次检查即承担首发）。
   */
  startPreflight(apiKey: string): void
  /**
   * 主请求前的惰性检查（D5）：预请求到点（8–10h 补发 / 退避重试）即后台发射，
   * 未到点零开销返回。绝不阻塞调用方。
   */
  maybeRunPreflight(apiKey: string): void
  /**
   * 会话身份（D3）：主路径从 doStream headers 确定性派生；全部缺失落 per-key
   * 回退轮换。同步无 IO，主请求零等待。
   */
  resolveSessionId(apiKey: string, headers: Record<string, string | undefined> | undefined): string
  /** 版本头全局单值（D6）：初解析 1.5s 竞速 + 24h 惰性刷新；四层皆空返回 undefined */
  getCommandCodeVersion(): Promise<string | undefined>
  /** config 块（D9/§9.3）：进程级冻结 + 24h 过期后台重采，主请求除首次构建外零等待 */
  getConfigBlock(): Promise<ConfigBlock>
}

/** 大小写不敏感收集会话头；返回按优先级的种子与去重后的命中值（值漂移告警用） */
function collectSessionSeeds(headers: Record<string, string | undefined> | undefined) {
  const lower = new Map<string, string>()
  if (headers !== undefined) {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string" && value.length > 0) lower.set(key.toLowerCase(), value)
    }
  }
  const values: string[] = []
  for (const name of SESSION_HEADERS) {
    const value = lower.get(name.toLowerCase())
    if (value !== undefined && !values.includes(value)) values.push(value)
  }
  return { seed: values[0], values }
}

export function createDisguiseState(options: DisguiseStateOptions = {}): DisguiseState {
  const logger = options.logger ?? consoleLogger()
  const fetchImpl = options.fetch ?? globalThis.fetch

  const versionResolver: VersionResolver = createVersionResolver({
    fetch: fetchImpl,
    logger,
    artifactSourceCliVersion: options.artifactSourceCliVersion,
    snapshotSourceCliVersion: options.snapshotSourceCliVersion,
  })
  const configProvider: FrozenConfigProvider = createFrozenConfigProvider({
    runtime: options.configRuntime,
    logger,
  })

  const keys = new Map<string, KeyState>()

  function ensureKeyState(apiKey: string): KeyState {
    let state = keys.get(apiKey)
    if (state === undefined) {
      state = {
        fingerprintBody: undefined,
        session: undefined,
        preflight: initialPreflightState(),
        preflightInFlight: false,
        startupPreflightStarted: false,
      }
      keys.set(apiKey, state)
    }
    return state
  }

  function ensureFingerprintBody(state: KeyState): Promise<FingerprintBody> {
    state.fingerprintBody ??= collectFingerprintComponents()
      .then(buildFingerprintBody)
      .catch((error: unknown) => {
        // 采集承诺内部全降级；真 reject 时清槽允许下轮重试，本轮按瞬时失败推进
        state.fingerprintBody = undefined
        throw error
      })
    return state.fingerprintBody
  }

  function launchPreflight(state: KeyState, apiKey: string): void {
    if (state.preflightInFlight) return
    state.preflightInFlight = true
    void runPreflight({
      apiKey,
      preflight: state.preflight,
      fetchImpl,
      logger,
      getVersion: () => versionResolver.getVersion(),
      ensureFingerprintBody: () => ensureFingerprintBody(state),
    }).finally(() => {
      state.preflightInFlight = false
    })
  }

  return {
    startPreflight(apiKey: string): void {
      const state = ensureKeyState(apiKey)
      if (state.startupPreflightStarted) return
      state.startupPreflightStarted = true
      launchPreflight(state, apiKey)
    },

    maybeRunPreflight(apiKey: string): void {
      const state = ensureKeyState(apiKey)
      // 未到点（8–10h 补发窗口 / 退避与冷却未过）零开销返回；到点后台发射
      if (Date.now() < state.preflight.nextAttemptAt) return
      launchPreflight(state, apiKey)
    },

    resolveSessionId(apiKey: string, headers: Record<string, string | undefined> | undefined): string {
      const state = ensureKeyState(apiKey)
      const { seed, values } = collectSessionSeeds(headers)
      if (seed !== undefined) {
        if (values.length > 1) {
          // 主路径命中但多头值不一致（宿主改头名/漂移的异常信号），脱敏告警
          logger.warn(`会话头取值不一致，按 ${SESSION_HEADERS[0]} 优先取用 ${values.map(redactIdentifier).join(" / ")}`)
        }
        return deriveSessionId(seed)
      }
      // 回退路径：无法区分会话边界，per-key 随机 uuid + 12h + 0~1h 抖动惰性轮换（尽力而为）
      const existing = state.session
      if (existing !== undefined && Date.now() < existing.expiresAt) return existing.id
      const next = {
        id: randomUUID(),
        expiresAt: Date.now() + SESSION_TTL_BASE_MS + Math.floor(Math.random() * SESSION_TTL_JITTER_MS),
      }
      state.session = next
      return next.id
    },

    getCommandCodeVersion(): Promise<string | undefined> {
      return versionResolver.getVersion()
    },

    getConfigBlock(): Promise<ConfigBlock> {
      return configProvider.get()
    },
  }
}

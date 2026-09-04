/**
 * 伪装预请求（disguise.md §2/§4/§5）：指纹记录与 lifecycle 两个请求**并行**发出
 * （同一 `Promise.allSettled`），各自挂独立 3s 超时（`AbortSignal.timeout`）——
 * 修 MAXeaglet 无独立超时被网关挂起拖死主请求的真 bug（调研 §8.2）。
 *
 * 请求头照 #9 抓包校准全集（调研 §11.3）：`User-Agent: cli`、`x-cli-environment:
 * production`、accept 家族等；**不带** `x-session-id` / `x-project-slug` /
 * `traceparent` / `x-taste-learning`（抓包样本 capture/samples/ 证实预请求无此头，
 * 规格 disguise.md §2 同）；`x-co-flag` 真实 CLI 不发送，不存在。
 *
 * 结局三态合记（两请求合记，照抄 MAXeaglet 耦合结构）：两 2xx 成功；4xx 任一
 * 拒绝（优先于瞬时——服务器明确说「不」后继续敲门更像机器人）；网络错/超时/5xx
 * 任一瞬时。推进动作归 backoff.ts 状态机。本模块任何函数绝不向上抛——预请求的
 * 任何结局都不得影响主请求（§5 总则）。
 */

import { randomBytes } from "node:crypto"
import type { FetchLike } from "../protocol/json.js"
import { applyPreflightOutcome, type PreflightOutcome, type PreflightState } from "./backoff.js"
import type { FingerprintBody } from "./fingerprint.js"
import { consoleLogger, type DisguiseLogger } from "./logger.js"
import { redactApiKey } from "./redact.js"

/** 指纹记录预请求端点（调研 §11.3 抓包 ground truth） */
export const FINGERPRINT_ENDPOINT = "https://api.commandcode.ai/alpha/fingerprint/record"
/** lifecycle 事件预请求端点 */
export const LIFECYCLE_ENDPOINT = "https://api.commandcode.ai/alpha/lifecycle-events"
/** 每个预请求的独立超时（§11 参数速查：3s） */
export const PREFLIGHT_TIMEOUT_MS = 3000

/**
 * 预请求头全集（§2，#9 校准后照抄真实 CLI）。`x-command-code-version` 缺值时
 * 省略该键（四层兜底皆空的极端场景；真实 CLI 恒带）。
 */
export function buildPreflightHeaders(apiKey: string, ccVersion: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "User-Agent": "cli",
    "x-cli-environment": "production",
    accept: "*/*",
    "accept-language": "*",
    "sec-fetch-mode": "cors",
    "accept-encoding": "br, gzip, deflate",
    Authorization: `Bearer ${apiKey}`,
  }
  if (ccVersion !== undefined) headers["x-command-code-version"] = ccVersion
  return headers
}

/** lifecycle 事件 body（§4，#9 校准形状；wire 键序照抓包样本） */
export interface LifecycleEvent {
  eventType: "cli_session_exists"
  metadata: {
    sessionId: string
    cliVersion: string
    mode: "interactive"
    os: string
  }
}

/**
 * 构造 lifecycle 事件：`metadata.sessionId` 为与 `x-session-id` **无关**的随机
 * `sess_<16hex>`（#9 证实真实 CLI 两套 ID 互不引用，每进程现造，照抄）；`mode`
 * 恒 interactive（连 `-p` 一次性调用也报）；`os` 报真实 `platform-arch`。
 */
export function buildLifecycleEvent(ccVersion: string | undefined): LifecycleEvent {
  return {
    eventType: "cli_session_exists",
    metadata: {
      sessionId: `sess_${randomBytes(8).toString("hex")}`,
      cliVersion: ccVersion ?? "",
      mode: "interactive",
      os: `${process.platform}-${process.arch}`,
    },
  }
}

/** 单轮预请求的结局与可日志化细节（只含 HTTP status 与错误类别，不含头与 body） */
export interface PreflightRound {
  outcome: PreflightOutcome
  details: string[]
}

function describeFailure(reason: unknown): string {
  // AbortSignal.timeout 到点的 reject reason 是 DOMException TimeoutError
  return reason instanceof Error && reason.name === "TimeoutError" ? "timeout" : "network-error"
}

/**
 * 两请求合记结局：4xx 任一 → rejected（优先于瞬时）；网络错/超时/5xx 任一 →
 * transient；两 2xx → success。details 按请求序给出 status 或错误类别。
 */
export function summarizePreflightResults(results: readonly PromiseSettledResult<Response>[]): PreflightRound {
  const details: string[] = []
  let outcome: PreflightOutcome = "success"
  for (const result of results) {
    if (result.status === "rejected") {
      details.push(describeFailure(result.reason))
      if (outcome !== "rejected") outcome = "transient"
      continue
    }
    const status = result.value.status
    details.push(String(status))
    if (status >= 400 && status < 500) outcome = "rejected"
    else if ((status < 200 || status >= 300) && outcome !== "rejected") outcome = "transient"
  }
  return { outcome, details }
}

export interface PreflightDeps {
  apiKey: string
  /** 预请求调度状态载体（§5）；结局后经 applyPreflightOutcome 推进并合并回此对象 */
  preflight: PreflightState
  fetchImpl: FetchLike
  logger?: DisguiseLogger
  /** 当前版本头值（预请求与主请求共享全局单值，D6a） */
  getVersion: () => Promise<string | undefined>
  /** 指纹 body（KeyState 进程内缓存；采集失败 reject 时按瞬时失败处理） */
  ensureFingerprintBody: () => Promise<FingerprintBody>
}

/**
 * 执行一轮预请求：未到点（冷却/退避未过）直接返回；否则指纹 + lifecycle 并行
 * 上线，按结局推进状态机并记脱敏日志。**绝不向上抛**（§5：预请求任何结局都不
 * 影响主请求）。调用方以 fire-and-forget 方式触发，本函数内部也不可再等待其他
 * 会阻塞主请求的东西——版本初解析自带 1.5s 上限，指纹采集为本地系统调用。
 */
export async function runPreflight(deps: PreflightDeps): Promise<void> {
  const logger = deps.logger ?? consoleLogger()
  if (Date.now() < deps.preflight.nextAttemptAt) return

  let round: PreflightRound
  try {
    round = await executeRound(deps)
  } catch {
    // 本地前置（指纹采集/版本解析）意外失败：按瞬时失败处理，绝不外溢
    round = { outcome: "transient", details: ["preparation-failed"] }
  }

  // 纯函数返回新状态对象，此处合并回 KeyState 持有的载体
  Object.assign(deps.preflight, applyPreflightOutcome(deps.preflight, round.outcome))

  const key = redactApiKey(deps.apiKey)
  if (round.outcome === "success") {
    logger.debug(`伪装预请求成功（指纹+lifecycle） ${key}`)
  } else if (round.outcome === "rejected") {
    logger.warn(`伪装预请求被拒绝（4xx），进入长冷却 ${key} [${round.details.join(", ")}]`)
  } else {
    logger.warn(`伪装预请求瞬时失败，按退避状态机重试 ${key} [${round.details.join(", ")}]`)
  }
}

async function executeRound(deps: PreflightDeps): Promise<PreflightRound> {
  // 指纹采集（本地）与版本初解析并行就绪后，两请求才并行上线（Promise.allSettled：
  // 等两个都落定再合记结局，不因先失败者提前收场）
  const [fingerprintBody, ccVersion] = await Promise.all([deps.ensureFingerprintBody(), deps.getVersion()])
  const headers = buildPreflightHeaders(deps.apiKey, ccVersion)
  const results = await Promise.allSettled([
    deps.fetchImpl(FINGERPRINT_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(fingerprintBody),
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    }),
    deps.fetchImpl(LIFECYCLE_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(buildLifecycleEvent(ccVersion)),
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    }),
  ])
  return summarizePreflightResults(results)
}

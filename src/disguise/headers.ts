/**
 * generate 主请求的伪装头组装（disguise.md §2/§3/§10，#9 抓包 ground truth）。
 *
 * 头全集 = 预请求基础九键（preflight.ts buildPreflightHeaders 同源）+ 主请求专属四键：
 * - `x-session-id`：会话身份（§3 主路径派生值，调用方经 state.resolveSessionId 取得；
 *   与信封顶层 `threadId` 同值，#9 抓包定案）；
 * - `x-project-slug`：workingDir 哈希近似（§3，与 config 块 workingDir 同源）；
 * - `traceparent`：逐请求新造（每次调用本函数即新值，零复用）；
 * - `x-taste-learning`：恒 `"true"`（#25 注记：本插件人格按官方规则恒 true）。
 *
 * 预请求**不带**这四键的边界由预请求侧自己保证（§2）；`x-command-code-version`
 * 缺值时省略该键（四层兜底皆空的极端场景，与预请求同款处理）。
 */

import { buildPreflightHeaders } from "./preflight.js"
import { deriveProjectSlug } from "./slug.js"

export interface GenerateHeadersInput {
  apiKey: string
  /** 版本头全局单值（D6）；undefined 时省略 x-command-code-version */
  ccVersion: string | undefined
  /** 会话身份（与信封 threadId 同值，§3） */
  sessionId: string
  /** slug 派生来源；与 config 块 workingDir 同源（process.cwd()） */
  workingDir: string
  traceparent: string
}

/** 组装 generate 主请求伪装头全集；键序照抓包样本（基础集在前，会话四键在后） */
export function buildGenerateHeaders(input: GenerateHeadersInput): Record<string, string> {
  return {
    ...buildPreflightHeaders(input.apiKey, input.ccVersion),
    "x-session-id": input.sessionId,
    "x-project-slug": deriveProjectSlug(input.workingDir),
    "x-taste-learning": "true",
    traceparent: input.traceparent,
  }
}

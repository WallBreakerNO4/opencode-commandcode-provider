/**
 * 版本头 `x-command-code-version` 兜底链取值（disguise.md §6，#19 修订全链序）：
 * ① npm/jsDelivr 竞速成功值（内存）→ ② 落盘缓存值 → ③ 运行时已拉取构建产物的
 * `sourceCliVersion`（只读内存，不触发额外拉取、不等待，也不回写落盘缓存）→
 * ④ 包内快照 `sourceCliVersion`。
 *
 * 本模块只定取值顺序；竞速、24h 惰性刷新与落盘读写归状态层（#33）。
 * 空串视同无值——竞速失败或损坏缓存可能残留空串，不应短路后面的层。
 */

export interface CommandCodeVersionChain {
  /** ① npm/jsDelivr 竞速成功值（进程内存） */
  raced?: string | undefined
  /** ② 落盘的「上次成功拉取值」（version-cache.json） */
  cached?: string | undefined
  /** ③ 运行时已拉取构建产物的 sourceCliVersion（模型管线内存中已有才有值） */
  artifact?: string | undefined
  /** ④ 包内快照的 sourceCliVersion（随插件发版更新） */
  snapshot?: string | undefined
}

/** 按兜底链序返回首个非空版本；四层皆空时 undefined（调用方决定放行形态） */
export function resolveCommandCodeVersion(chain: CommandCodeVersionChain): string | undefined {
  for (const value of [chain.raced, chain.cached, chain.artifact, chain.snapshot]) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/**
 * 会话身份主路径（disguise.md §3）：OpenCode 会话标识 → 确定性 uuid v4。
 * sha256 摘要取前 16 字节（32 hex），修补 uuid v4 的版本位与变体位——无需任何
 * 存储即保证「同会话同 id、跨重启同 id」。回退路径（per-key 随机 uuid + 12–13h
 * 轮换）的存储与轮换语义归状态层（#33），不在本模块。
 */

import { sha256Digest } from "./hash.js"

/** uuid v4 版本位所在字节的掩码：低 4 位保留，高 4 位写 0100 */
const VERSION_MASK = 0x0f
const VERSION_V4 = 0x40

/** uuid 变体位所在字节的掩码：低 6 位保留，高 2 位写 10（RFC 4122 保留态） */
const VARIANT_MASK = 0x3f
const VARIANT_RFC4122 = 0x80

/**
 * 确定性派生 `x-session-id`：同输入恒得同一 uuid v4 形状的 id。
 * 摘要字节本身已是均匀分布，位修补只重写版本/变体两个半字节，不损失会话关联性。
 */
export function deriveSessionId(seed: string): string {
  const bytes = sha256Digest(seed).subarray(0, 16)
  bytes[6] = (bytes[6]! & VERSION_MASK) | VERSION_V4
  bytes[8] = (bytes[8]! & VARIANT_MASK) | VARIANT_RFC4122
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * 伪装模块共用哈希原语（调研 §1.2 的 sha256 辅助函数）：
 * `sha256(s) = hex(sha256(utf8(s)))`，输出 64 位小写 hex。
 */

import { createHash } from "node:crypto"

/** sha256(utf8(input)) → 64 位小写 hex */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

/** sha256(utf8(input)) 的 32 字节摘要，供截取与位修补类派生（会话 id、slug 字节流）使用 */
export function sha256Digest(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest()
}

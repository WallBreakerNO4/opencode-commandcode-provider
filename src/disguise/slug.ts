/**
 * `x-project-slug` 派生（disguise.md §3，#9 校准后改写）：真实 CLI 的 slug 由
 * workingDir 派生、跨会话恒定，形状为「小写字母数字短横分组 ×8 组、组长 4–11」，
 * 确切算法未知（逐段哈希链为最像假说，调研 §11.4）——本实现取形状一致的
 * workingDir 哈希近似。MAXeaglet 的 `users-dev-projects-*` 旧算法整体弃用。
 *
 * 字节流：sha256(workingDir) 作种子，耗尽后接 `sha256(种子#序号)` 哈希链续流；
 * 字符按 base36 取（256 ∤ 36，尾部 4 个字节值拒绝采样弃用以保均匀）；组长由
 * 同一字节流驱动。纯函数，同 workingDir 跨调用、跨会话、跨重启恒定。
 */

import { sha256Digest } from "./hash.js"

const GROUP_COUNT = 8
const GROUP_MIN = 4
const GROUP_MAX = 11

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"

/** base36 取字符的拒绝采样阈值：256 % 36 = 4，>= 252 的字节值弃用 */
const REJECT_ABOVE = 256 - (256 % BASE36.length)

function createByteStream(seed: string): () => number {
  let pool = sha256Digest(seed)
  let poolIndex = 0
  let chainCount = 0
  return () => {
    if (poolIndex >= pool.length) {
      chainCount += 1
      pool = sha256Digest(`${seed}#${chainCount}`)
      poolIndex = 0
    }
    return pool[poolIndex++]!
  }
}

/** 派生 `x-project-slug`：8 组、每组 4–11 字符、字符集 [0-9a-z]、短横连接 */
export function deriveProjectSlug(workingDir: string): string {
  const nextByte = createByteStream(workingDir)
  const groups: string[] = []
  for (let group = 0; group < GROUP_COUNT; group++) {
    const length = GROUP_MIN + (nextByte() % (GROUP_MAX - GROUP_MIN + 1))
    let chars = ""
    while (chars.length < length) {
      const byte = nextByte()
      if (byte >= REJECT_ABOVE) continue
      chars += BASE36[byte % BASE36.length]
    }
    groups.push(chars)
  }
  return groups.join("-")
}

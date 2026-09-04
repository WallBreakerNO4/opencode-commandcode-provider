import { describe, expect, test } from "bun:test"
import { sha256Digest } from "../../src/disguise/hash.ts"
import { deriveSessionId } from "../../src/disguise/session.ts"

// 会话 id 主路径派生（disguise.md §3）：sha256 → 前 16 字节 → 修补 uuid v4 版本/变体位。
// 确定性：同输入恒同输出、跨重启同 id（纯函数无存储）。

const UUID_V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("确定性", () => {
  test("同输入恒得同一 id（跨调用、跨进程即重启语义）", () => {
    const first = deriveSessionId("opencode-sess-abc")
    expect(deriveSessionId("opencode-sess-abc")).toBe(first)
    expect(deriveSessionId("opencode-sess-abc")).toBe("1a9cf3aa-90f3-49f3-9487-4f373b59e6b5")
  })

  test("不同会话种子得不同 id", () => {
    const ids = new Set(["a", "b", "session-1", "session-2", "x"].map(deriveSessionId))
    expect(ids.size).toBe(5)
  })
})

describe("uuid v4 形状（版本/变体位修补正确）", () => {
  test("固定种子锚点过 v4 正则", () => {
    expect(deriveSessionId("opencode-sess-abc")).toMatch(UUID_V4_SHAPE)
  })

  test("批量种子全部落在 v4 形状——摘要原值的版本/变体位均匀分布，修补后恒合规", () => {
    const ids = Array.from({ length: 200 }, (_, i) => deriveSessionId(`probe-${i}`))
    for (const id of ids) {
      expect(id).toMatch(UUID_V4_SHAPE)
    }
  })

  test("修补只动版本/变体两个字节的高位，其余字节与摘要逐位一致（格式化不错位）", () => {
    for (const seed of ["patch-probe", "opencode", "x", "0", "session-affinity-header-value"]) {
      const rawBytes = sha256Digest(seed).subarray(0, 16)
      const patchedBytes = Buffer.from(deriveSessionId(seed).replace(/-/g, ""), "hex")
      for (let i = 0; i < 16; i++) {
        if (i === 6) {
          // 版本位：高 4 位写 0100，低 4 位保留
          expect(patchedBytes[i]! >> 4).toBe(0x4)
          expect(patchedBytes[i]! & 0x0f).toBe(rawBytes[i]! & 0x0f)
        } else if (i === 8) {
          // 变体位：高 2 位写 10，低 6 位保留
          expect(patchedBytes[i]! & 0xc0).toBe(0x80)
          expect(patchedBytes[i]! & 0x3f).toBe(rawBytes[i]! & 0x3f)
        } else {
          expect(patchedBytes[i]!).toBe(rawBytes[i]!)
        }
      }
    }
  })
})

import { describe, expect, test } from "bun:test"
import { resolveCommandCodeVersion } from "../../src/disguise/version.ts"

// 版本兜底链四层取值顺序（disguise.md §6，#19 修订全链序）：
// ① 竞速成功值 → ② 落盘值 → ③ 运行时产物 sourceCliVersion → ④ 包内快照 sourceCliVersion。

describe("四层取值顺序", () => {
  test("仅一层在场时取该层", () => {
    expect(resolveCommandCodeVersion({ raced: "1.38.2" })).toBe("1.38.2")
    expect(resolveCommandCodeVersion({ cached: "1.37.0" })).toBe("1.37.0")
    expect(resolveCommandCodeVersion({ artifact: "1.36.0" })).toBe("1.36.0")
    expect(resolveCommandCodeVersion({ snapshot: "1.35.0" })).toBe("1.35.0")
  })

  test("多层并存按链序优先", () => {
    expect(resolveCommandCodeVersion({ raced: "1.38.2", cached: "1.37.0", artifact: "1.36.0", snapshot: "1.35.0" })).toBe("1.38.2")
    expect(resolveCommandCodeVersion({ cached: "1.37.0", artifact: "1.36.0", snapshot: "1.35.0" })).toBe("1.37.0")
    expect(resolveCommandCodeVersion({ artifact: "1.36.0", snapshot: "1.35.0" })).toBe("1.36.0")
  })

  test("高层为空串/undefined 时跳到下一层（竞速失败残留空串不短路）", () => {
    expect(resolveCommandCodeVersion({ raced: "", cached: "1.37.0", snapshot: "1.35.0" })).toBe("1.37.0")
    expect(resolveCommandCodeVersion({ raced: undefined, cached: undefined, artifact: undefined, snapshot: "1.35.0" })).toBe("1.35.0")
  })

  test("四层皆空 → undefined（调用方决定放行形态）", () => {
    expect(resolveCommandCodeVersion({})).toBeUndefined()
    expect(resolveCommandCodeVersion({ raced: "", cached: "", artifact: "", snapshot: "" })).toBeUndefined()
  })
})

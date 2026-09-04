import { describe, expect, test } from "bun:test"
import { deriveProjectSlug } from "../../src/disguise/slug.ts"

// project-slug 派生（disguise.md §3，#9 校准）：workingDir 哈希近似，形状一致——
// 8 组、组长 4–11、字符集小写字母数字短横；同 workingDir 跨会话恒定。

const SLUG_SHAPE = /^[0-9a-z]{4,11}(-[0-9a-z]{4,11}){7}$/

describe("形状断言", () => {
  test("8 组、组长 4–11、字符集 [0-9a-z]、短横连接（多 fixture 全过）", () => {
    const dirs = [
      "/home/tester/project-alpha",
      "/home/tester/project-beta",
      "/repo",
      "/Users/dev/work/tools/monorepo/sub",
      "/",
      "C:\\Users\\dev\\projects\\web",
      "/very/deeply/nested/directory/structure/with/many/segments/project",
    ]
    for (const dir of dirs) {
      const slug = deriveProjectSlug(dir)
      expect(slug).toMatch(SLUG_SHAPE)
      expect(slug.split("-")).toHaveLength(8)
      for (const group of slug.split("-")) {
        expect(group.length).toBeGreaterThanOrEqual(4)
        expect(group.length).toBeLessThanOrEqual(11)
      }
    }
  })

  test("固定 workingDir 锚点（算法漂移防线）", () => {
    expect(deriveProjectSlug("/home/tester/project-alpha")).toBe(
      "thowg3zh-952os-0rdypax9l3-alctm-kz5ilpo-qagc7q8l86z-30syoh7p-2hwvgrly",
    )
  })
})

describe("跨会话恒定", () => {
  test("同 workingDir 跨调用稳定（纯函数无存储，重启同值）", () => {
    expect(deriveProjectSlug("/repo")).toBe(deriveProjectSlug("/repo"))
  })

  test("不同 workingDir 派生不同 slug", () => {
    const slugs = new Set(["/a", "/b", "/home/x/one", "/home/x/two"].map(deriveProjectSlug))
    expect(slugs.size).toBe(4)
  })
})

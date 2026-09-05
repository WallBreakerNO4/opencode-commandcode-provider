import { describe, expect, test } from "bun:test"
import { selfNpmSpec } from "../../src/host/v1.ts"

// v1 自举 npm spec 推导（#37 真宿主验证定案的纯函数部分）：provider 的 npm spec 由宿主
// 原样定 arborist 缓存目录，而 plugin 列表的裸包名被宿主归一化为 `<name>@latest`
// ——注入裸包名会装出第二个模块实例。spec 必须从入口实际加载路径提取；提取失败
// 一律回退 file:// 入口 URL（免安装直接 import，单实例必中）。hooks 的宿主交互
// 行为仍归真宿主验证（testing.md §4），此处只测路径推导。
describe("v1 自举 npm spec 推导", () => {
  test("npm 安装形态：plugin 裸包名（宿主 @latest 归一化）→ 提取 @latest spec", () => {
    const url =
      "file:///home/u/.cache/opencode/packages/@wallbreakerno4/opencode-commandcode@latest/node_modules/@wallbreakerno4/opencode-commandcode/dist/index.js"
    expect(selfNpmSpec(url)).toBe("@wallbreakerno4/opencode-commandcode@latest")
  })

  test("npm 安装形态：版本钉死 plugin → 提取带版本的 spec", () => {
    const url =
      "file:///home/u/.cache/opencode/packages/@wallbreakerno4/opencode-commandcode@1.2.3/node_modules/@wallbreakerno4/opencode-commandcode/dist/index.js"
    expect(selfNpmSpec(url)).toBe("@wallbreakerno4/opencode-commandcode@1.2.3")
  })

  test("npm 安装形态：XDG 重定向的缓存根同样命中", () => {
    const url =
      "file:///tmp/iso/xdg/cache/opencode/packages/@wallbreakerno4/opencode-commandcode@latest/node_modules/@wallbreakerno4/opencode-commandcode/dist/index.js"
    expect(selfNpmSpec(url)).toBe("@wallbreakerno4/opencode-commandcode@latest")
  })

  test("本地 file:// 直载（无缓存目录形状）→ 回退入口 URL 原文", () => {
    const url = "file:///home/wall/self-project/other/opencode-commandcode-provider/dist/index.js"
    expect(selfNpmSpec(url)).toBe(url)
  })

  test("路径不含 node_modules 段 → 回退入口 URL 原文", () => {
    const url = "file:///home/u/proj/packages/dist/index.js"
    expect(selfNpmSpec(url)).toBe(url)
  })

  test("与 package.json name 同源：缓存形态提取出的包名段即自身包名", async () => {
    const { default: pkg } = (await import("../../package.json")) as { default: { name: string } }
    const url = `file:///home/u/.cache/opencode/packages/${pkg.name}@latest/node_modules/${pkg.name}/dist/index.js`
    expect(selfNpmSpec(url)).toBe(`${pkg.name}@latest`)
  })
})

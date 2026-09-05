import { describe, expect, test } from "bun:test"
import plugin, * as entry from "../src/index.ts"

// 包形状防回归断言（docs/spec/testing.md §1.4）：
// v1 宿主加载决策树依赖 default 的 {id, setup, server} 三键（#11 实测：带 id 缺 server
// 则整模块跳过并忽略全部命名导出）；v1/v2 的工厂判据是「模块第一个 create* 前缀导出」。
// 后续实现票不得使导出形状漂移。v1 hooks 的静态形状（#37）同属包契约——config/auth
// hook 的宿主交互行为仍归真宿主验证（testing.md §4），此处只锁形状与常量。
describe("包形状防回归", () => {
  test("default 导出恰为 {id, setup, server} 三键", () => {
    expect(Object.keys(plugin).sort()).toEqual(["id", "server", "setup"])
  })

  test("id 为 commandcode-go（v2 插件 id / v1 config 注入键 / integrationID / 模型 id 前缀四处同名）", () => {
    expect(plugin.id).toBe("commandcode-go")
  })

  test("setup 与 server 均为函数", () => {
    expect(typeof plugin.setup).toBe("function")
    expect(typeof plugin.server).toBe("function")
  })

  test("第一个 create* 前缀导出是 createCommandCode", () => {
    const createExports = Object.keys(entry).filter((key) => key.startsWith("create"))
    expect(createExports[0]).toBe("createCommandCode")
    expect(typeof entry.createCommandCode).toBe("function")
  })

  test("v1 server() 返回 {config, auth} hooks：auth 指向 commandcode-go、label 固定「Command Code API Key」", async () => {
    const hooks = await plugin.server({}, {})
    expect(Object.keys(hooks).sort()).toEqual(["auth", "config"])
    expect(typeof hooks.config).toBe("function")
    expect(hooks.auth.provider).toBe("commandcode-go")
    expect(hooks.auth.methods).toEqual([{ type: "api", label: "Command Code API Key" }])
    expect(typeof hooks.auth.loader).toBe("function")
  })
})

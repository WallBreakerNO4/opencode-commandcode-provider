/**
 * @wallbreakerno4/opencode-commandcode 的入口骨架：单包三导出，v1/v2 双宿主共用。
 *
 * 形状即契约（防回归断言见 tests/package-shape.test.ts）：
 * - default `{ id, setup, server }`——v2 宿主读 `id` + `setup`；v1 宿主加载器在
 *   default 带 `id` 时要求 `server` 也在场，缺 `server` 则整模块跳过并忽略全部
 *   命名导出（#11 真机实测），三键缺一不可。
 * - `createCommandCode` 工厂——v1/v2 共用的 provider 运行时入口，宿主按「模块
 *   第一个 `create*` 前缀导出」判据发现它，不得引入排位更靠前的 `create*` 导出；
 *   实现与其 options/provider 契约类型见 src/provider/model.ts（#35 工厂装配）。
 *
 * 入口保持零运行时依赖：不 import `@opencode-ai/plugin`（v2 的 define() 是恒等
 * 函数），避免被宿主 beta API 漂移绑架。
 */

/**
 * 单包三导出的 default 形状。
 * id 为字面量类型：该标识在 v2 插件 id、v1 config 注入键、integrationID、模型 id
 * 前缀 `commandcode-go/<wire>` 四处同名，写错任何一处即编译失败。
 */
export interface CommandCodePlugin {
  readonly id: "commandcode-go"
  /** v2 插件入口：OpenCode 2 `setup(ctx)`，模型注册等行为由后续实现票填充 */
  readonly setup: (context: unknown) => Promise<void> | void
  /** v1 插件入口：`server(input, options)` → hooks（options 为插件级配置） */
  readonly server: (input: unknown, options: unknown) => Promise<Record<string, never>>
}

export { createCommandCode, type CommandCodeFactoryOptions, type CommandCodeProvider } from "./provider/model.js"

export default {
  id: "commandcode-go",
  async setup() {},
  async server() {
    return {}
  },
} satisfies CommandCodePlugin

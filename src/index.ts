/**
 * @wallbreakerno4/opencode-commandcode 的入口骨架：单包三导出，v1/v2 双宿主共用。
 *
 * 形状即契约（防回归断言见 tests/package-shape.test.ts）：
 * - default `{ id, setup, server }`——v2 宿主读 `id` + `setup`（接线实现在
 *   src/host/v2.ts，#36）；v1 宿主加载器在 default 带 `id` 时要求 `server` 也在场，
 *   缺 `server` 则整模块跳过并忽略全部命名导出（#11 真机实测），三键缺一不可。
 * - `createCommandCode` 工厂——v1/v2 共用的 provider 运行时入口，宿主按「模块
 *   第一个 `create*` 前缀导出」判据发现它，不得引入排位更靠前的 `create*` 导出；
 *   实现与其 options/provider 契约类型见 src/provider/model.ts（#35 工厂装配）。
 *
 * 入口保持零运行时依赖：不 import `@opencode-ai/plugin`（v2 的 define() 是恒等
 * 函数），避免被宿主 beta API 漂移绑架。
 */

import { setupV2 } from "./host/v2.js"

/**
 * 入口模块自身的 file URL：v2 自指（#12 S1 定案）的锚点。宿主的 aisdk 工厂
 * 判据（「模块第一个 create* 前缀导出」）作用在**本入口模块**上，glue 子模块的
 * `import.meta.url` 指向 dist/host/v2.js，作 package 会半个月厂都找不到——必须
 * 以本入口的 URL 为准，且宿主以此路径再 import 时命中同一模块实例（单实例，
 * 伪装进程内状态安全的前提）。
 */
export const ENTRY_URL: string = import.meta.url

/**
 * 单包三导出的 default 形状。
 * id 为字面量类型：该标识在 v2 插件 id、v1 config 注入键、integrationID、模型 id
 * 前缀 `commandcode-go/<wire>` 四处同名，写错任何一处即编译失败。
 */
export interface CommandCodePlugin {
  readonly id: "commandcode-go"
  /** v2 插件入口：OpenCode 2 `setup(ctx)`（#36 宿主接线） */
  readonly setup: (context: unknown) => Promise<void> | void
  /** v1 插件入口：`server(input, options)` → hooks（options 为插件级配置） */
  readonly server: (input: unknown, options: unknown) => Promise<Record<string, never>>
}

export { createCommandCode, type CommandCodeFactoryOptions, type CommandCodeProvider } from "./provider/model.js"

export default {
  id: "commandcode-go",
  setup: setupV2,
  async server() {
    return {}
  },
} satisfies CommandCodePlugin

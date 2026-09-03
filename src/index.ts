/**
 * @wallbreakerno4/opencode-commandcode 的入口骨架：单包三导出，v1/v2 双宿主共用。
 *
 * 形状即契约（防回归断言见 tests/package-shape.test.ts）：
 * - default `{ id, setup, server }`——v2 宿主读 `id` + `setup`；v1 宿主加载器在
 *   default 带 `id` 时要求 `server` 也在场，缺 `server` 则整模块跳过并忽略全部
 *   命名导出（#11 真机实测），三键缺一不可。
 * - `createCommandCode` 工厂——v1/v2 共用的 provider 运行时入口，宿主按「模块
 *   第一个 `create*` 前缀导出」判据发现它，不得引入排位更靠前的 `create*` 导出。
 *
 * 入口保持零运行时依赖：不 import `@opencode-ai/plugin`（v2 的 define() 是恒等
 * 函数），契约用本文件的结构类型表达，避免被宿主 beta API 漂移绑架。
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

/**
 * 工厂入参：宿主调工厂时注入的 options（定案为 `{name, apiKey, headers, fetch}`，
 * 无 body）。`fetch` 是宿主包装过的实例，超时与 chunk 处理由宿主侧完成。
 */
export interface CommandCodeFactoryOptions {
  readonly name?: string
  readonly apiKey?: string
  readonly headers?: Record<string, string>
  readonly fetch?: typeof globalThis.fetch
}

export default {
  id: "commandcode-go",
  async setup() {},
  async server() {
    return {}
  },
} satisfies CommandCodePlugin

export function createCommandCode(_options: CommandCodeFactoryOptions): never {
  // 工厂被宿主调用的唯一出口是拿到 provider 实例，空壳无处可退，fail-fast 显错
  // 优于把半成品实例递给宿主后再在下游炸出无关报错。
  throw new Error("createCommandCode 尚未实现")
}

/**
 * 注入式 logger 通道（disguise.md §7）：伪装模块不直接依赖 OpenCode 客户端——
 * v1 启动阶段使用「静默 debug + console.warn」适配器，v2 插件 ctx 无 log 域
 * （beta d.ts 全字段核对，models-url-override.md §3.1）与独立调用退化 console，
 * 测试注 no-op。
 * 级别只用两档（§7 级别表）：`debug`（预请求成功、版本刷新成功，默认安静）、
 * `warn`（预请求失败、降级路径、落盘异常）。
 */

export interface DisguiseLogger {
  debug(message: string): void
  warn(message: string): void
}

export const noopLogger: DisguiseLogger = {
  debug() {},
  warn() {},
}

let v1SilentMode = false

/** v1 宿主已加载插件后，后续 provider 动态实例也必须隐藏正常 debug。 */
export function enableV1SilentMode(): void {
  v1SilentMode = true
}

export function isV1SilentModeEnabled(): boolean {
  return v1SilentMode
}

/** v1 与独立调用的退化通道：宿主未注入 logger 时保证伪装层日志有处可去 */
export function consoleLogger(): DisguiseLogger {
  return {
    debug: (message) => console.debug(message),
    warn: (message) => console.warn(message),
  }
}

/**
 * v1 config hook 在 OpenCode 完成实例初始化前执行；此阶段不能通过 client.app.log
 * 回写宿主，否则会重新进入同一初始化链路。正常诊断静默，异常仍经 warn 暴露。
 */
export function consoleWarnLogger(): DisguiseLogger {
  return {
    debug() {},
    warn: (message) => console.warn(message),
  }
}

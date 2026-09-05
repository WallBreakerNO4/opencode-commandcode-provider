/**
 * 注入式 logger 通道（disguise.md §7）：伪装模块不直接依赖 opencode 客户端——
 * v1 注 client.app.log 适配器（#37），v2 插件 ctx 无 log 域（beta d.ts 全字段
 * 核对，models-url-override.md §3.1）与独立调用退化 console，测试注 no-op。
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

/** v1 与独立调用的退化通道：宿主未注入 logger 时保证伪装层日志有处可去 */
export function consoleLogger(): DisguiseLogger {
  return {
    debug: (message) => console.debug(message),
    warn: (message) => console.warn(message),
  }
}

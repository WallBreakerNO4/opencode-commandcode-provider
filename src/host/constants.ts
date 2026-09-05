/**
 * v1/v2 glue 共享的宿主面常量（单源防漂移——v1 与 v2 宿主各自独立消费同一批
 * 注册字段，复制粘贴会让「多处同名」不变量悄悄分叉）。
 *
 * 同名约束出处：CONTEXT.md——provider 显示名在 v1 /connect 列表项、v2 目录与
 * provider 列表、v2 integration name 同用；认证方法 label 固定「Command Code
 * API Key」，v1 auth hook 与 v2 integration key method 同文案。
 */

/** provider 显示名「Command Code (Go)」（CONTEXT.md，两宿主同用） */
export const PROVIDER_DISPLAY_NAME = "Command Code (Go)"

/** 认证方法 label：「Command Code API Key」，/connect 认证输入框标题（CONTEXT.md） */
export const API_KEY_METHOD_LABEL = "Command Code API Key"

/** env 认证通道扫描的环境变量（与 .env.example 清单一致） */
export const API_KEY_ENV_VAR = "COMMANDCODE_API_KEY"

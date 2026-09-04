/**
 * 宿主消费映射（契约：docs/spec/model-pipeline.md §3.1/§3.2；字段形状细节：
 * docs/research/opencode-plugin-provider.md §3/§4）——把级联解析出的 ResolvedModel
 * 翻译成 v1 config models entry 与 v2 `Model.Info` 字段，由 v1/v2 glue 票（#36/#37）
 * 注入宿主。
 *
 * - v1：`{id, name, tool_call: true, reasoning, attachment, modalities,
 *   limit: {context, output}, variants}`；variants 为 map（档位 → 请求覆盖），值
 *   `{reasoningEffort}` 选中后由宿主合并进 model options，最终经
 *   `providerOptions.reasoningEffort` 抵达协议核心（#11 实测宿主行为，brent 参考
 *   实现同款）；`attachment` = inputModalities 含 image（可贴图开关）。
 * - v2：`capabilities: {tools, input, output}` + `limit` + `variants` 数组
 *   `[{id, settings: {reasoningEffort}}]`；`modelID` = wire id 原样（可含 `/`）。
 * - 无档位 → 空 map / 空数组：不造任何变体——base 模型无档可选，即不会发送
 *   `reasoning_effort`，交网关/模型自决（§3.1）。
 * - 档位零过滤：上游给什么透传什么（含将来可能出现的 none/minimal），不发明白名单。
 * - 价格字段 `cost`：schema v1 明确砍掉，两宿主均不写。
 */

import type { ResolvedModel } from "./cascade.js"

/** v1 variant 值：仅承载档位设置，形状经 #11 实测（宿主按 variant 合并 options） */
export interface V1Variant {
  readonly reasoningEffort: string
}

export interface V1ModelEntry {
  readonly id: string
  readonly name: string
  readonly tool_call: true
  readonly reasoning: boolean
  readonly attachment: boolean
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] }
  readonly limit: { readonly context: number; readonly output: number }
  readonly variants: Readonly<Record<string, V1Variant>>
}

/** v2 variant：`settings` 包相关，`reasoningEffort` 是 aisdk 系运行时包的档位设置键 */
export interface V2Variant {
  readonly id: string
  readonly settings: { readonly reasoningEffort: string }
}

/** v2 `Model.Info` 中由本插件填充的字段；目录键（id）与上游 id（modelID）同为 wire id */
export interface V2ModelFields {
  readonly id: string
  readonly modelID: string
  readonly name: string
  readonly capabilities: {
    readonly tools: true
    readonly input: readonly string[]
    readonly output: readonly string[]
  }
  readonly limit: { readonly context: number; readonly output: number }
  readonly variants: readonly V2Variant[]
}

export function toV1ModelEntry(model: ResolvedModel): V1ModelEntry {
  const variants: Record<string, V1Variant> = {}
  for (const effort of model.efforts ?? []) variants[effort] = { reasoningEffort: effort }
  return {
    id: model.id,
    name: model.name,
    tool_call: true,
    reasoning: model.reasoning,
    attachment: model.inputModalities.includes("image"),
    modalities: { input: model.inputModalities, output: ["text"] },
    limit: { context: model.context, output: model.maxOutput },
    variants,
  }
}

/** v1 config 的 models 块：以 wire id 为键（可含 `/`，原样保留） */
export function toV1ModelMap(models: readonly ResolvedModel[]): Record<string, V1ModelEntry> {
  return Object.fromEntries(models.map((model) => [model.id, toV1ModelEntry(model)]))
}

export function toV2ModelFields(model: ResolvedModel): V2ModelFields {
  return {
    id: model.id,
    modelID: model.id,
    name: model.name,
    capabilities: { tools: true, input: model.inputModalities, output: ["text"] },
    limit: { context: model.context, output: model.maxOutput },
    variants: (model.efforts ?? []).map((effort) => ({ id: effort, settings: { reasoningEffort: effort } })),
  }
}

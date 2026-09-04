/**
 * `/provider/v1/models` 响应的运行时解析（契约：docs/spec/model-pipeline.md §0/§3，
 * 事实层：docs/research/model-metadata-sources.md §二实测形状）。
 *
 * 该端点是发现（id 清单）、`context_length` 与 `name` 的权威（§3 字段表），匿名
 * 拉取即可。OpenAI 兼容样板字段 `object` / `owned_by` 与响应生成时刻的动态时间戳
 * `created` 在此剥除——`created` 一旦流入下游，变更签名（模型管线 II）就必然每次
 * 误判「列表变了」，所以在数据入口处结构性剔除，而不是靠下游记得跳过它。
 */

import { asRecord } from "../protocol/json.js"

/** 单条发现：`name` / `contextLength` 现网 62/62 全有，类型上可选以容忍上游字段级缺失 */
export interface ApiModelEntry {
  readonly id: string
  readonly name?: string
  readonly contextLength?: number
}

export type ModelsApiParseResult =
  | { readonly ok: true; readonly models: readonly ApiModelEntry[] }
  | { readonly ok: false; readonly detail: string }

export function parseModelsApi(input: unknown): ModelsApiParseResult {
  const root = asRecord(input)
  if (root === null) return fail("顶层不是 JSON 对象")
  const data = root["data"]
  if (!Array.isArray(data)) return fail("data 必须是数组")

  const models: ApiModelEntry[] = []
  for (const [index, raw] of data.entries()) {
    const entry = asRecord(raw)
    if (entry === null) return fail(`data[${index}] 不是对象`)
    const id = entry["id"]
    if (typeof id !== "string" || id.length === 0) return fail(`data[${index}].id 必须是非空字符串`)
    const name = entry["name"]
    if (name !== undefined && typeof name !== "string") return fail(`data[${index}]「${id}」.name 必须是字符串`)
    const contextLength = entry["context_length"]
    if (
      contextLength !== undefined &&
      (typeof contextLength !== "number" || !Number.isFinite(contextLength) || contextLength <= 0)
    ) {
      return fail(`data[${index}]「${id}」.context_length 必须是正数`)
    }
    models.push({
      id,
      ...(name !== undefined ? { name } : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
    })
  }
  return { ok: true, models }
}

function fail(detail: string): ModelsApiParseResult {
  return { ok: false, detail }
}

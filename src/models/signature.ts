/**
 * 模型管线变更签名（契约：docs/spec/model-pipeline.md §4 刷新与缓存）。
 *
 * - 产物：对 `models` 数组做内容 hash，变化才触发下游动作（v2 `catalog.reload()`）。
 *   只哈希 models——`generatedAt` 每次构建必变、`schemaVersion` 恒定，掺进来会把
 *   「内容没变」误判成「变了」；未知可选字段（向前兼容被忽略者）经运行时解析剥除，
 *   哈希的是客户端实际生效视图，上游加字段不触发无谓 reload。
 * - `/provider/v1/models`：变更签名 = 排序后 `(id, context_length)` 序列，**必须剔除
 *   `created`**——那是响应生成时刻的动态时间戳，不剔必每次误判「列表变了」（§4）。
 *   `created` / `owned_by` 已在 api.ts 数据入口结构性剥除，此处对解析结果再排序固化。
 *
 * 哈希输入是解析器构造的定键序对象，`JSON.stringify` 序列化稳定；sha256 只是给
 * 比较键一个定长摘要，防日志/调试时打印全量目录。
 */

import { createHash } from "node:crypto"

import type { ApiModelEntry } from "./api.js"
import type { Artifact } from "./artifact.js"

/** 产物内容 hash：models 数组的 sha256（hex） */
export function artifactContentHash(artifact: Artifact): string {
  return sha256(JSON.stringify(artifact.models))
}

/** API 变更签名：排序后 (id, context_length) 序列的 sha256（hex）；`created` 已在解析入口剥除 */
export function apiChangeSignature(models: readonly ApiModelEntry[]): string {
  const pairs = models
    .map((entry) => [entry.id, entry.contextLength ?? null] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return sha256(JSON.stringify(pairs))
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

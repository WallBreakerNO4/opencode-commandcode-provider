/**
 * 模型管线变更签名（契约：docs/dev/spec/model-pipeline.md §4 刷新与缓存）。
 *
 * - 产物：对 `models` 数组做内容 hash，变化才触发下游动作（v2 `catalog.reload()`）。
 *   只哈希 models——`generatedAt` 每次构建必变、`schemaVersion` 恒定，掺进来会把
 *   「内容没变」误判成「变了」；未知可选字段（向前兼容被忽略者）经运行时解析剥除，
 *   哈希的是客户端实际生效视图，上游加字段不触发无谓 reload。
 * - `view=client` catalog：变更签名 = 排序后 `(id, context_length)` 序列。发现权威
 *   是产物全集，catalog 只影响 context/name；name 只影响展示，catalogVersion /
 *   refreshAfterSeconds 只影响 ETag 与刷新节奏，均由管线直接采纳而不触发 reload。
 *
 * 哈希输入是解析器构造的定键序对象，`JSON.stringify` 序列化稳定；sha256 只是给
 * 比较键一个定长摘要，防日志/调试时打印全量目录。
 */

import { createHash } from "node:crypto"

import type { Artifact } from "./artifact.js"
import type { CatalogEntry } from "./catalog.js"

/** 产物内容 hash：models 数组的 sha256（hex） */
export function artifactContentHash(artifact: Artifact): string {
  return sha256(JSON.stringify(artifact.models))
}

/** catalog 变更签名：排序后 (id, context_length) 序列的 sha256（hex） */
export function catalogChangeSignature(models: readonly CatalogEntry[]): string {
  const pairs = models
    .map((entry) => [entry.id, entry.contextLength ?? null] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return sha256(JSON.stringify(pairs))
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

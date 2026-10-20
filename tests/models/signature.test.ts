import { describe, expect, test } from "bun:test"
import type { CatalogEntry } from "../../src/models/catalog.ts"
import { parseClientCatalog } from "../../src/models/catalog.ts"
import type { Artifact, ArtifactModel } from "../../src/models/artifact.ts"
import { artifactContentHash, catalogChangeSignature } from "../../src/models/signature.ts"

function artifactWith(models: ArtifactModel[], overrides: Partial<Artifact> = {}): Artifact {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    sourceCliVersion: "1.45.0",
    models,
    ...overrides,
  }
}

const MODELS: ArtifactModel[] = [
  { id: "m/b", name: "B", reasoning: false, inputModalities: ["text"], context: 128000, maxOutput: 8192 },
  { id: "m/a", name: "A", reasoning: true, inputModalities: ["text", "image"], efforts: ["high"], context: 200000, maxOutput: 32000 },
]

describe("产物内容 hash（§4：对 models 数组做内容 hash）", () => {
  test("同内容同 hash", () => {
    expect(artifactContentHash(artifactWith(MODELS))).toBe(artifactContentHash(artifactWith(structuredClone(MODELS))))
  })

  test("models 内容变化 → hash 变化", () => {
    const changed = artifactWith([
      ...MODELS,
      { id: "m/c", name: "C", reasoning: false, inputModalities: ["text"], context: 8000, maxOutput: 4096 },
    ])
    expect(artifactContentHash(artifactWith(MODELS))).not.toBe(artifactContentHash(changed))
  })

  test("generatedAt / sourceCliVersion 变化不改变 hash（只哈希 models）", () => {
    const rebuilt = artifactWith(MODELS, {
      generatedAt: "2026-09-02T00:00:00.000Z",
      sourceCliVersion: "1.46.0",
    })
    expect(artifactContentHash(artifactWith(MODELS))).toBe(artifactContentHash(rebuilt))
  })

  test("单字段值变化即 hash 变化（context 档位等元数据更新可感知）", () => {
    const touched = structuredClone(MODELS)
    touched[0] = { ...touched[0]!, context: 256000 }
    expect(artifactContentHash(artifactWith(MODELS))).not.toBe(artifactContentHash(artifactWith(touched)))
  })

  test("efforts 缺席与存在形状不同即 hash 不同（无档位模型不造空数组，两侧序列化形状不同）", () => {
    const withEfforts = artifactWith([{ ...MODELS[0]!, efforts: ["low"] }])
    const withoutEfforts = artifactWith([MODELS[0]!])
    expect(artifactContentHash(withEfforts)).not.toBe(artifactContentHash(withoutEfforts))
  })
})

describe("catalog 变更签名（§4：排序后 (id, context_length) 序列）", () => {
  test("同集合同签名——顺序无关（排序后比较）", () => {
    const a: CatalogEntry[] = [
      { id: "m/a", contextLength: 200000 },
      { id: "m/b", contextLength: 128000 },
    ]
    const b: CatalogEntry[] = [
      { id: "m/b", contextLength: 128000 },
      { id: "m/a", contextLength: 200000 },
    ]
    expect(catalogChangeSignature(a)).toBe(catalogChangeSignature(b))
  })

  test("context_length 变化 → 签名变化", () => {
    const before: CatalogEntry[] = [{ id: "m/a", contextLength: 200000 }]
    const after: CatalogEntry[] = [{ id: "m/a", contextLength: 400000 }]
    expect(catalogChangeSignature(before)).not.toBe(catalogChangeSignature(after))
  })

  test("id 清单增删 → 签名变化", () => {
    const before: CatalogEntry[] = [{ id: "m/a", contextLength: 200000 }]
    const after: CatalogEntry[] = [
      { id: "m/a", contextLength: 200000 },
      { id: "m/b", contextLength: 128000 },
    ]
    expect(catalogChangeSignature(before)).not.toBe(catalogChangeSignature(after))
  })

  test("name 变化不改变签名（name 是字段级权威但不是变更判据）", () => {
    const a: CatalogEntry[] = [{ id: "m/a", name: "Old Name", contextLength: 200000 }]
    const b: CatalogEntry[] = [{ id: "m/a", name: "New Name", contextLength: 200000 }]
    expect(catalogChangeSignature(a)).toBe(catalogChangeSignature(b))
  })

  test("catalogVersion / refreshAfterSeconds 变化不改变签名（元信息不进变更判据）", () => {
    const t0 = { catalogVersion: "v1", refreshAfterSeconds: 900, data: [{ id: "m/a", context_length: 200000 }] }
    const t1 = { catalogVersion: "v2", refreshAfterSeconds: 60, data: [{ id: "m/a", context_length: 200000 }] }
    const parsed0 = parseClientCatalog(t0)
    const parsed1 = parseClientCatalog(t1)
    expect(parsed0.ok && parsed1.ok).toBe(true)
    if (parsed0.ok && parsed1.ok) {
      expect(catalogChangeSignature(parsed0.catalog.models)).toBe(catalogChangeSignature(parsed1.catalog.models))
    }
  })

  test("缺 context_length 的条目以 null 占位参与签名（容忍上游字段级缺失且可感知补齐）", () => {
    const missing: CatalogEntry[] = [{ id: "m/a" }]
    const filled: CatalogEntry[] = [{ id: "m/a", contextLength: 200000 }]
    expect(catalogChangeSignature(missing)).not.toBe(catalogChangeSignature(filled))
  })
})

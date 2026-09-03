/**
 * models.dev `api.json` 匹配：仅构建侧 limits 补全源（§0 三来源架构）。
 *
 * 匹配规则照 docs/research/model-metadata-sources.md §三实测：
 * 1. CommandCode id 按 `/` 拆「前缀 + 模型 id」；无前缀按品牌映射（claude*→anthropic 等）；
 * 2. 前缀别名表（z-ai/zai-org→zai、Qwen→alibaba、tencent→三组并列等）；
 * 3. 组内依次：精确 id → 归一 id → 「前缀/模型id」整串结尾匹配；
 * 4. 全库兜底扫描（第三方聚合组，质量打折但 limits 仍可用）。
 * 匹配不上不报错——落常量兜底（provenance=constant），limits 补全链本就设计为逐级让位。
 */

export interface ModelsDevLimits {
  readonly context?: number
  readonly output?: number
  /** 匹配位置（审计用），形如 "zai/GLM-5.3" */
  readonly source: string
}

interface ModelsDevModel {
  limit?: { context?: number; output?: number }
}

type ModelsDevApi = Record<string, { models?: Record<string, ModelsDevModel> }>

/**
 * 前缀别名表：只收录「CommandCode 前缀 ≠ models.dev 组名」的改写。
 * 其余前缀原样（+小写）尝试——models.dev 组名基本小写。
 * tencent 是一对多：三个候选组按序尝试。
 */
const PREFIX_ALIASES: Record<string, readonly string[]> = {
  "z-ai": ["zai"],
  "zai-org": ["zai"],
  MiniMaxAI: ["minimax"],
  minimax: ["minimax"],
  Qwen: ["alibaba"],
  tencent: ["tencent-tokenhub", "tencent-coding-plan", "tencent-token-plan"],
}

/** 无前缀 id 的品牌映射（id 首段正则 → models.dev 组名） */
const BRAND_MAP: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^claude/i, ["anthropic"]],
  [/^gpt/i, ["openai"]],
  [/^gemini/i, ["google"]],
  [/^grok/i, ["xai"]],
]

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll("_", "-")
}

/** 返回该 id 应尝试的 models.dev provider 组名（按优先级） */
export function candidateGroups(id: string): readonly string[] {
  const slash = id.indexOf("/")
  if (slash === -1) {
    for (const [pattern, groups] of BRAND_MAP) {
      if (pattern.test(id)) return groups
    }
    return []
  }
  const prefix = id.slice(0, slash)
  const aliased = PREFIX_ALIASES[prefix]
  if (aliased !== undefined) return aliased
  return [prefix, prefix.toLowerCase()].filter((group, index, all) => all.indexOf(group) === index)
}

/** 组内匹配：精确 → 归一 → 整串结尾（适配 models.dev key 自带前缀的组，如 nvidia/…） */
function matchInGroup(models: Record<string, ModelsDevModel>, wireId: string, modelPart: string): { key: string; model: ModelsDevModel } | undefined {
  const exact = models[wireId]
  if (exact !== undefined) return { key: wireId, model: exact }

  const normModel = normalizeKey(modelPart)
  for (const [key, model] of Object.entries(models)) {
    if (normalizeKey(key) === normModel) return { key, model }
  }
  const normWire = normalizeKey(wireId)
  for (const [key, model] of Object.entries(models)) {
    if (normalizeKey(key).endsWith(`/${normWire}`) || normalizeKey(key).endsWith(`/${normModel}`)) {
      return { key, model }
    }
  }
  return undefined
}

function readLimits(source: string, model: ModelsDevModel): ModelsDevLimits | undefined {
  const context = model.limit?.context
  const output = model.limit?.output
  if (typeof context !== "number" && typeof output !== "number") return undefined
  return {
    ...(typeof context === "number" ? { context } : {}),
    ...(typeof output === "number" ? { output } : {}),
    source,
  }
}

/** 在 api.json 全库中为 CommandCode id 找 limits；找不到返回 undefined（补全链落下一级） */
export function lookupLimits(api: unknown, id: string): ModelsDevLimits | undefined {
  if (typeof api !== "object" || api === null) return undefined
  const root = api as ModelsDevApi

  const slash = id.indexOf("/")
  const modelPart = slash === -1 ? id : id.slice(slash + 1)

  for (const group of candidateGroups(id)) {
    const models = root[group]?.models
    if (models === undefined) continue
    const hit = matchInGroup(models, id, modelPart)
    if (hit !== undefined) {
      const limits = readLimits(`${group}/${hit.key}`, hit.model)
      if (limits !== undefined) return limits
    }
  }

  // 全库兜底扫描（第三方聚合组：neuralwatt / opencode / vercel 等，limits 仍是可用参考值）
  for (const [group, provider] of Object.entries(root)) {
    const models = provider?.models
    if (models === undefined) continue
    const hit = matchInGroup(models, id, modelPart)
    if (hit !== undefined) {
      const limits = readLimits(`${group}/${hit.key}`, hit.model)
      if (limits !== undefined) return limits
    }
  }
  return undefined
}

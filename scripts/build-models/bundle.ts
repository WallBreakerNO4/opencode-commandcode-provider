/**
 * bundle 逆向：从 `dist/cli.mjs`（minified 单行）提取模型目录。
 *
 * 方法来自 docs/research/model-metadata-sources.md §五（1.37.0 实测，1.45.0 复验）：
 * 1. 已知稳定的模型 id 作锚点（`id:"<锚点>"` 只在目录条目出现；价格表用
 *    `anthropic:` 前缀 id，不会误配）；
 * 2. 锚点向前找最近的 `={`——即目录对象的开头（目录条目是平铺字段，条目内部
 *    不可能再有 `={`，该前提由解析后的形状校验兜底）；
 * 3. 从 `={` 起交给 literal-parser 解析（结构保证只出不执行任何包内代码）；
 * 4. 目录里 minify 出的标识符引用（provider:NR、spec:QR、别名 YR=FR）在整份
 *    bundle 文本中做「字面量定义 / 别名链」文本解析求值——同样不执行代码。
 */

import {
  type Literal,
  LiteralSyntaxError,
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  lastEntry,
  parseValueAt,
} from "./literal-parser.ts"

/** 目录条目：只保留管线消费（或审计）需要的字段，其余忽略 */
export interface CatalogEntry {
  readonly id: string
  readonly name?: string
  readonly label?: string
  readonly reasoning?: boolean
  readonly reasoningEfforts?: readonly string[]
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly inputModalities?: readonly string[]
  readonly provider?: string
  readonly spec?: string
  readonly hidden?: boolean
  readonly badge?: string
}

/**
 * 锚点 id 候选：选「官方不可能轻易下架的老牌模型」，按稳定度排序。
 * 任一锚点命中即用；全部失效 = bundle 结构漂移，构建失败交人工适配。
 */
const CATALOG_ANCHOR_IDS = [
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "deepseek/deepseek-v4-pro",
] as const

/** 目录规模的形状校验下限：远小于任何真实版本（1.37.0=65、1.45.0=72），坏截取必低于此 */
const MIN_CATALOG_ENTRIES = 20

/**
 * 引用求值器：在 bundle 全文中做 `NAME=<字面量或别名>` 的文本解析。
 * 只接受字面量 RHS；RHS 是函数/调用等可执行形状时跳过该匹配位继续找。
 */
export class RefResolver {
  private readonly cache = new Map<string, Literal | undefined>()

  constructor(private readonly source: string) {}

  resolve(name: string, depth = 0, seen: Set<string> = new Set()): Literal | undefined {
    if (depth > 10) return undefined // 别名链深度上限
    if (seen.has(name)) return undefined // 环
    seen.add(name)
    // 只缓存顶层结果：递归中间结果受 seen 集影响，缓存会污染后续查询
    if (depth === 0 && this.cache.has(name)) return this.cache.get(name)
    const literal = this.findDefinition(name, depth, seen)
    if (depth === 0) this.cache.set(name, literal)
    return literal
  }

  private findDefinition(name: string, depth: number, seen: Set<string>): Literal | undefined {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // 定义位判定：NAME 前是边界（var 声明、逗号、分号、块开头、圆括号、行首或空白），
    // 排除 `.NAME=`（成员赋值）与 `xxNAME=`；NAME 后是 `=` 且不是 `==`/`=>`。
    const pattern = new RegExp(`(?<![A-Za-z0-9_$.])${escaped}\\s*=(?![=>])`, "g")
    for (;;) {
      const match = pattern.exec(this.source)
      if (match === null) return undefined
      const rhsStart = match.index + match[0].length
      try {
        const { literal } = parseValueAt(this.source, rhsStart)
        if (literal.kind === "ref") {
          const resolved = this.resolve(literal.name, depth + 1, seen)
          if (resolved !== undefined) return resolved
          continue // 该 RHS 是解析不了的标识符，试下一个匹配位
        }
        return literal
      } catch (error) {
        if (!(error instanceof LiteralSyntaxError)) throw error
        continue // RHS 不是可接受的数据形状（函数体等），试下一个匹配位
      }
    }
  }
}

export class BundleExtractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BundleExtractError"
  }
}

/** 从 bundle 全文提取模型目录；锚点全失效或形状校验不过时抛 BundleExtractError */
export function extractCatalog(source: string, options: { minEntries?: number } = {}): CatalogEntry[] {
  const minEntries = options.minEntries ?? MIN_CATALOG_ENTRIES
  const errors: string[] = []
  for (const anchorId of CATALOG_ANCHOR_IDS) {
    try {
      return extractCatalogWithAnchor(source, anchorId, minEntries)
    } catch (error) {
      if (!(error instanceof BundleExtractError)) throw error
      errors.push(`${anchorId}: ${error.message}`)
    }
  }
  throw new BundleExtractError(`全部锚点失效（bundle 结构可能已漂移，需人工适配）：\n${errors.join("\n")}`)
}

function extractCatalogWithAnchor(source: string, anchorId: string, minEntries: number): CatalogEntry[] {
  const anchorToken = `id:${JSON.stringify(anchorId)}`
  const anchorPos = source.indexOf(anchorToken)
  if (anchorPos === -1) {
    throw new BundleExtractError(`锚点 id「${anchorId}」未在 bundle 中找到`)
  }
  const braceStart = source.lastIndexOf("={", anchorPos)
  if (braceStart === -1) {
    throw new BundleExtractError(`锚点「${anchorId}」之前找不到「={」`)
  }
  const openBrace = braceStart + 1
  let parsed: Literal
  try {
    parsed = parseValueAt(source, openBrace).literal
  } catch (error) {
    if (error instanceof LiteralSyntaxError) {
      throw new BundleExtractError(`锚点「${anchorId}」定位的对象解析失败：${error.message}`)
    }
    throw error
  }
  if (parsed.kind !== "object") {
    throw new BundleExtractError(`锚点「${anchorId}」截取到的不是对象`)
  }

  const resolver = new RefResolver(source)
  const entries: CatalogEntry[] = []
  const problems: string[] = []
  for (const entry of parsed.entries) {
    const built = buildEntry(entry.value, resolver)
    if (typeof built === "string") {
      problems.push(`[${entry.key}] ${built}`)
      continue
    }
    entries.push(built)
  }
  if (entries.length < minEntries) {
    throw new BundleExtractError(
      `目录条目数 ${entries.length} 低于形状校验下限 ${minEntries}，截取大概率有误` +
        (problems.length > 0 ? `；问题明细：\n${problems.join("\n")}` : ""),
    )
  }
  const ids = new Set(entries.map((entry) => entry.id))
  if (!ids.has(anchorId)) {
    throw new BundleExtractError(`提取结果不含锚点 id「${anchorId}」，截取位置有误`)
  }
  return entries
}

/** 条目组装：消费字段解析失败即报错（fail-fast），未消费字段的引用解析失败也报错（保持数据纯度可审计） */
function buildEntry(value: Literal, resolver: RefResolver): CatalogEntry | string {
  if (value.kind !== "object") return "条目不是对象"
  type WritableCatalogEntry = { -readonly [K in keyof CatalogEntry]: CatalogEntry[K] }
  const entry = {} as WritableCatalogEntry

  const id = readStringField(value, "id", resolver)
  if (id === undefined) return "缺少字符串字段 id"
  entry.id = id

  const name = readStringField(value, "name", resolver)
  if (name !== undefined) entry.name = name
  const label = readStringField(value, "label", resolver)
  if (label !== undefined) entry.label = label

  const reasoning = readField(value, "reasoning", resolver)
  if (reasoning !== undefined) {
    const flag = asBoolean(reasoning)
    if (flag === undefined) return "reasoning 不是布尔"
    entry.reasoning = flag
  }

  const efforts = readField(value, "reasoningEfforts", resolver)
  if (efforts !== undefined) {
    const list = asStringArray(efforts)
    if (list === undefined) return "reasoningEfforts 不是字符串数组"
    entry.reasoningEfforts = list
  }

  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    const literal = readField(value, field, resolver)
    if (literal !== undefined) {
      const num = asNumber(literal)
      if (num === undefined) return `${field} 不是数字`
      entry[field] = num
    }
  }

  const modalities = readField(value, "inputModalities", resolver)
  if (modalities !== undefined) {
    const list = asStringArray(modalities)
    if (list === undefined) return "inputModalities 不是字符串数组"
    entry.inputModalities = list
  }

  for (const field of ["provider", "spec"] as const) {
    const literal = readField(value, field, resolver)
    if (literal !== undefined) {
      const str = asString(literal)
      if (str === undefined) return `${field} 解析后不是字符串`
      entry[field] = str
    }
  }

  const hidden = readField(value, "hidden", resolver)
  if (hidden !== undefined) {
    const flag = asBoolean(hidden)
    if (flag === undefined) return "hidden 不是布尔"
    entry.hidden = flag
  }

  const badge = readStringField(value, "badge", resolver)
  if (badge !== undefined) entry.badge = badge

  return entry
}

/** 读字段：值若是引用则求值；引用解析失败返回 undefined（由调用方按字段必要性处置） */
function readField(object: Extract<Literal, { kind: "object" }>, key: string, resolver: RefResolver): Literal | undefined {
  const literal = lastEntry(object, key)
  if (literal === undefined) return undefined
  if (literal.kind === "ref") return resolver.resolve(literal.name)
  return literal
}

function readStringField(object: Extract<Literal, { kind: "object" }>, key: string, resolver: RefResolver): string | undefined {
  const literal = readField(object, key, resolver)
  return literal === undefined ? undefined : asString(literal)
}

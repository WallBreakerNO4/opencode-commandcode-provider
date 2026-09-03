/**
 * models.md 解析：官方 CLI 包内 `dist/bundled/command-code-knowledge/reference/models.md`。
 *
 * 7 列 markdown 表格（8 个 provider 分节），行首模式 `| `wire-id` |`；
 * 按 `|` split 后 Min plan 在第 6 列（index 6）——规格 §2 定稿，列头断言防漂移。
 * normalize = 去掉后缀 " and above"（Max 为裸词，自然归一）。
 * 语义：Min plan 是能调用该模型的最便宜档位，套餐序 Go < GOAT < Pro < Max。
 */

export const PLAN_VALUES = ["Go", "GOAT", "Pro", "Max"] as const
export type PlanName = (typeof PLAN_VALUES)[number]

export const MIN_PLAN_COLUMN_INDEX = 6
/** Efforts 列（语义第 4 列 = split index 4）：与 bundle reasoningEfforts 同源，逐值一致（元数据调研 §四实测 30/30） */
export const EFFORTS_COLUMN_INDEX = 4

export interface ModelsMdRow {
  readonly id: string
  /** 原文取值，如 "Go and above" / "Max" */
  readonly minPlanRaw: string
  /** normalize 后取值，如 "Go" / "Max" */
  readonly minPlan: PlanName
  /** Efforts 列解析出的档位数组；「—」（模型自决）为 undefined */
  readonly efforts?: readonly string[]
}

export class ModelsMdParseError extends Error {
  constructor(message: string) {
    super(message)
    super.name = "ModelsMdParseError"
  }
}

/** 规格原文的列头单元格（用于列头断言：含 `Min plan` 且列位 = index 6） */
const MIN_PLAN_HEADER_CELL = "Min plan"

export function parseModelsMd(md: string): ModelsMdRow[] {
  const lines = md.split("\n")
  const headerLine = lines.find((line) => line.startsWith("|") && line.includes(MIN_PLAN_HEADER_CELL))
  if (headerLine === undefined) {
    throw new ModelsMdParseError("models.md 列头不含「Min plan」——官方文档结构已变，需人工适配")
  }
  const headerCells = headerLine.split("|")
  const headerIndex = headerCells.findIndex((cell) => cell.trim() === MIN_PLAN_HEADER_CELL)
  if (headerIndex !== MIN_PLAN_COLUMN_INDEX) {
    throw new ModelsMdParseError(
      `Min plan 列位漂移：断言 index ${MIN_PLAN_COLUMN_INDEX}，实际 index ${headerIndex}（列头：${headerLine.trim()}）`,
    )
  }

  const rows: ModelsMdRow[] = []
  for (const line of lines) {
    if (!/^\|\s*`/.test(line)) continue
    const cells = line.split("|")
    // 行形状：| id | name | context | efforts | price | plan | best | → split 后 9 段
    const idCell = cells[1]
    const planCell = cells[MIN_PLAN_COLUMN_INDEX]
    if (idCell === undefined || planCell === undefined) {
      throw new ModelsMdParseError(`模型行缺第 1 / 第 6 列，结构异常：${line.slice(0, 80)}`)
    }
    const id = idCell.trim().replace(/^`+|`+$/g, "")
    const minPlanRaw = planCell.trim()
    if (id === "" || minPlanRaw === "") {
      throw new ModelsMdParseError(`模型行 id 或 Min plan 为空：${line.slice(0, 80)}`)
    }
    // Efforts 列：仅解析结构，与 bundle 的逐值一致性由 reconcile 断言兜底
    const effortsRaw = (cells[EFFORTS_COLUMN_INDEX] ?? "").trim()
    const efforts = effortsRaw === "" || effortsRaw === "—"
      ? undefined
      : effortsRaw.split(",").map((s) => s.trim()).filter((s) => s !== "")
    rows.push({
      id,
      minPlanRaw,
      minPlan: normalizePlan(minPlanRaw) as ModelsMdRow["minPlan"],
      ...(efforts !== undefined && efforts.length > 0 ? { efforts } : {}),
    })
  }
  if (rows.length === 0) {
    throw new ModelsMdParseError("models.md 未解析出任何模型行（行首模式 `| `wire-id` |` 不匹配）")
  }
  return rows
}

/** normalize：去掉后缀 " and above"；其余取值交值域断言（reconcile）处置 */
export function normalizePlan(raw: string): string {
  return raw.endsWith(" and above") ? raw.slice(0, -" and above".length) : raw
}

/** Min plan 分布统计（对全量行，非仅 Go 档） */
export function emptyDistribution(): Record<PlanName, number> {
  return { Go: 0, GOAT: 0, Pro: 0, Max: 0 }
}

export function tallyDistribution(rows: readonly ModelsMdRow[]): Record<PlanName, number> {
  const distribution = emptyDistribution()
  for (const row of rows) {
    if ((PLAN_VALUES as readonly string[]).includes(row.minPlan)) {
      distribution[row.minPlan]++
    }
  }
  return distribution
}

import { describe, expect, test } from "bun:test"
import {
  MIN_PLAN_COLUMN_INDEX,
  ModelsMdParseError,
  normalizePlan,
  parseModelsMd,
  tallyDistribution,
} from "../../scripts/build-models/models-md.ts"

// 按 1.45.0 真实文件形态裁剪的最小样本：列头一行 + 数据行（含各 Min plan 取值）
const MD_FIXTURE = [
  "<!-- Generated from the Command Code docs -->",
  "",
  "## Open Source",
  "",
  "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
  "|---|---|---|---|---|---|---|",
  "| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro (latest) | 1M | high, max | $0.66/$1.98 · cache $0.022 | Go and above | long-context reasoning |",
  "| `Qwen/Qwen3.8-27B` | Qwen3.8 27B | 262K | — | $0.1/$0.4 | Go and above | coding |",
  "| `gpt-5.6-sol` | GPT-5.6 Sol | 400K | low, high, max | $1/$4 · cache $0.1 | GOAT and above | frontier coding |",
  "| `claude-opus-5` | Claude Opus 5 | 200K | high, max | $5/$25 · cache $0.5 | Max | hardest problems |",
  "| `tencent/hy4-preview` | Hunyuan 4 Preview | 1.05M | — | $0.834/$2.501 | Go and above | multimodal |",
  "",
  "Min plan is the cheapest plan that serves the model, ordered Go < GOAT < Pro < Max.",
].join("\n")

describe("models.md 解析（列头断言 + 第 6 列 + normalize）", () => {
  test("解析 id 与 Min plan；Min plan 位于 split 后 index 6", () => {
    const rows = parseModelsMd(MD_FIXTURE)
    expect(rows.map((row) => row.id)).toEqual([
      "deepseek/deepseek-v4-pro",
      "Qwen/Qwen3.8-27B",
      "gpt-5.6-sol",
      "claude-opus-5",
      "tencent/hy4-preview",
    ])
    expect(MIN_PLAN_COLUMN_INDEX).toBe(6)
    expect(rows.map((row) => row.minPlanRaw)).toEqual([
      "Go and above",
      "Go and above",
      "GOAT and above",
      "Max",
      "Go and above",
    ])
    expect(rows.map((row) => row.minPlan)).toEqual(["Go", "Go", "GOAT", "Max", "Go"])
  })

  test("normalize：去 \" and above\" 后缀；裸词 Max 自然归一", () => {
    expect(normalizePlan("Go and above")).toBe("Go")
    expect(normalizePlan("GOAT and above")).toBe("GOAT")
    expect(normalizePlan("Pro and above")).toBe("Pro")
    expect(normalizePlan("Max")).toBe("Max")
  })

  test("分布统计对全量行（非仅 Go 档）", () => {
    expect(tallyDistribution(parseModelsMd(MD_FIXTURE))).toEqual({ Go: 3, GOAT: 1, Pro: 0, Max: 1 })
  })

  test("断言：列头不含 Min plan → 报错（官方结构变更即失败，不静默）", () => {
    const broken = MD_FIXTURE.replace(" | Min plan | ", " | Plan | ")
    expect(() => parseModelsMd(broken)).toThrow(ModelsMdParseError)
    expect(() => parseModelsMd(broken)).toThrow(/Min plan/)
  })

  test("断言：Min plan 列位漂移 → 报错", () => {
    // 把 Min plan 挪到第 5 列（Best for 提前）——列序漂移必须被抓
    const shifted = MD_FIXTURE.replace(
      "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
      "| Id (use EXACTLY this) | Name | Context | Efforts | Min plan | $/1M in/out · cache read | Best for |",
    )
    expect(() => parseModelsMd(shifted)).toThrow(/列位漂移/)
  })

  test("断言：无任何模型行 → 报错", () => {
    const empty = MD_FIXTURE.split("\n").slice(0, 5).join("\n")
    expect(() => parseModelsMd(empty)).toThrow(/未解析出任何模型行/)
  })

  test("id 保留 wire id 原样（含 / 与大小写）", () => {
    const rows = parseModelsMd(MD_FIXTURE)
    expect(rows.find((row) => row.id === "tencent/hy4-preview")).toBeDefined()
    expect(rows.find((row) => row.id === "Qwen/Qwen3.8-27B")).toBeDefined()
  })

  test("Efforts 列（index 4）：逗号拆分为数组，「—」为 undefined", () => {
    const rows = parseModelsMd(MD_FIXTURE)
    expect(rows[0]!.efforts).toEqual(["high", "max"])
    expect(rows[3]!.efforts).toEqual(["high", "max"])
    expect(rows.find((row) => row.id === "tencent/hy4-preview")!.efforts).toBeUndefined()
  })
})

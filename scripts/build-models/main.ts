/**
 * 构建流水线主编排：输入获取 → 解析 → 对账断言 → 产物写出。
 *
 * 用法（bun 运行）：
 *   bun scripts/build-models/main.ts --out-dir <目录> [--cli-version <版本>] [--prev-meta <文件>]
 *
 * 输出两文件：<out-dir>/models.json（分发产物，schema v1）与 <out-dir>/build-meta.json
 * （变更检测基准 + 分布基线，随 data 分支发布；data 分支文件同时是下次构建的 --prev-meta）。
 *
 * 红线与顺序保证：对账断言全部通过之前不写任何产物文件（验收：断言失败不出产物）；
 * tarball 只做文本解析，绝不执行包内代码。
 */

import { createHash } from "node:crypto"
import { extractCatalog } from "./bundle.ts"
import { buildArtifact } from "./emit.ts"
import { familyKeys } from "./limits.ts"
import { lookupLimits } from "./modelsdev.ts"
import { parseModelsMd, emptyDistribution, tallyDistribution, PLAN_VALUES, type PlanName } from "./models-md.ts"
import { extractTarballText } from "./tarball.ts"
import {
  downloadTarball,
  fetchApiModels,
  fetchLatestCliRelease,
  fetchModelsDev,
  tarballUrlFor,
} from "./registry.ts"
import {
  assertArtifactNonEmpty,
  assertDistributionStable,
  assertEffortsConsistency,
  assertIdsSubset,
  assertModalityVocabulary,
  assertPlanValueDomain,
  formatDistribution,
  runReconcile,
  type PlanDistribution,
} from "./reconcile.ts"

const CLI_FILE = "dist/cli.mjs"
const MODELS_MD_FILE = "dist/bundled/command-code-knowledge/reference/models.md"

interface CliArgs {
  readonly outDir: string
  readonly cliVersion?: string
  readonly prevMetaPath?: string
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: { outDir?: string; cliVersion?: string; prevMetaPath?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === "--out-dir" && value !== undefined) {
      args.outDir = value
      i++
    } else if (flag === "--cli-version" && value !== undefined) {
      args.cliVersion = value
      i++
    } else if (flag === "--prev-meta" && value !== undefined) {
      args.prevMetaPath = value
      i++
    } else {
      throw new Error(`未知参数「${flag ?? ""}」；用法：--out-dir <目录> [--cli-version <版本>] [--prev-meta <文件>]`)
    }
  }
  if (args.outDir === undefined) throw new Error("缺少 --out-dir <目录>")
  return { outDir: args.outDir, cliVersion: args.cliVersion, prevMetaPath: args.prevMetaPath }
}

export interface BuildMeta {
  readonly schemaVersion: 1
  readonly sourceCliVersion: string
  readonly generatedAt: string
  readonly modelsDevSha256: string
  readonly modelsJsonSha256: string
  readonly planDistribution: PlanDistribution
  readonly modelsCount: number
}

export function readPrevDistribution(content: string): PlanDistribution | undefined {
  const meta = JSON.parse(content) as { planDistribution?: unknown }
  if (typeof meta !== "object" || meta === null || typeof meta.planDistribution !== "object" || meta.planDistribution === null) {
    throw new Error(`--prev-meta 文件形状不对（缺 planDistribution 对象）`)
  }
  const dist = meta.planDistribution as Record<string, unknown>
  const out = emptyDistribution()
  for (const plan of ["Go", "GOAT", "Pro", "Max"] as const) {
    const value = dist[plan]
    if (typeof value !== "number") {
      throw new Error(`--prev-meta 的 planDistribution.${plan} 不是数字`)
    }
    out[plan] = value
  }
  return out
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function log(message: string): void {
  console.log(message)
}

export async function runBuild(
  args: CliArgs,
  stdout: (line: string) => void = log,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ modelsJson: string; meta: BuildMeta }> {
  const deps = { fetch: fetchImpl }
  // 1. 上游版本：CLI 传入（workflow 用检测步取到的版本，防检测与构建之间 TOCTOU 漂移）或实时查询
  const release = args.cliVersion !== undefined
    ? { version: args.cliVersion, tarballUrl: tarballUrlFor(args.cliVersion) }
    : await fetchLatestCliRelease(deps)
  stdout(`[input] command-code@${release.version}`)

  // 2. tarball 下载 + 解包（仅文本提取，绝不执行包内代码）
  const tgz = await downloadTarball(release.tarballUrl, deps)
  stdout(`[input] tarball ${(tgz.length / 1024 / 1024).toFixed(2)} MB → 提取 ${CLI_FILE} 与 ${MODELS_MD_FILE} 文本`)
  const files = extractTarballText(tgz, [CLI_FILE, MODELS_MD_FILE])
  const cliSource = files.get(CLI_FILE)!
  const modelsMd = files.get(MODELS_MD_FILE)!

  // 3. bundle 逆向 + models.md 解析
  const catalog = extractCatalog(cliSource)
  stdout(`[bundle] 锚点截取目录 ${catalog.length} 条（含 bundle 独有的隐藏 free 条目）`)
  const mdRows = parseModelsMd(modelsMd)
  stdout(`[models.md] 解析 ${mdRows.length} 行`)

  // 4. /models 实时清单（对账） + models.dev（limits 补全 + 内容 hash 触发器）
  const apiIds = new Set(await fetchApiModels(deps))
  stdout(`[api] /provider/v1/models 返回 ${apiIds.size} 个 id`)
  const dev = await fetchModelsDev(deps)
  const devSha256 = sha256Hex(dev.bytes)
  stdout(`[models.dev] api.json sha256=${devSha256.slice(0, 16)}…`)

  // 5. 对账断言：任一失败抛 ReconcileError → main 捕获 → 非零退出，无产物落盘
  const distribution = tallyDistribution(mdRows)
  const prevDistribution = args.prevMetaPath === undefined ? undefined : readPrevDistribution(await Bun.file(args.prevMetaPath).text())
  const goIds = mdRows.filter((row) => row.minPlan === "Go").map((row) => row.id)
  runReconcile([
    assertPlanValueDomain(mdRows),
    assertIdsSubset(goIds, apiIds),
    assertArtifactNonEmpty(goIds),
    assertDistributionStable(distribution, prevDistribution),
    assertModalityVocabulary(mdRows, catalog),
    assertEffortsConsistency(mdRows, catalog),
  ])
  stdout(`[reconcile] 断言全过：值域 ⊆ {${PLAN_VALUES.join(",")}}；产物 ${goIds.length} id ⊆ API ${apiIds.size} id；分布 ${formatDistribution(distribution)}；模态词表与 Efforts 逐值一致`)

  // 6. 产物组装（Go plan 过滤 + limits 补全链 + provenance 日志）
  const devCache = new Map<string, ReturnType<typeof lookupLimits>>()
  const generatedAt = new Date().toISOString()
  const { artifact, provenance } = buildArtifact(release.version, generatedAt, mdRows, catalog, (id) => {
    const cached = devCache.get(id)
    if (cached !== undefined) return cached
    const limits = lookupLimits(dev.api, id)
    devCache.set(id, limits)
    return limits
  })
  for (const record of provenance) {
    const source = record.source === undefined ? "" : `（${record.source}）`
    stdout(`[limits] ${record.modelId} · ${record.field} = ${record.value} ← ${record.provenance}${source}`)
  }
  const byProvenance = tallyProvenance(provenance)
  const formatTally = (field: string): string =>
    Object.entries(byProvenance[field] ?? {})
      .map(([provenance, count]) => `${provenance} ${count}`)
      .join(" / ")
  stdout(`[limits] provenance 汇总：context ${formatTally("context")} ｜ maxOutput ${formatTally("maxOutput")}`)
  stdout(`[family] 家族键定义：同 vendor 按「-」逐级缩短的最长公共前缀；示例 ${familyKeys("zai-org/GLM-5.1").join(" → ")}`)

  // 7. 断言全过后才写产物
  const modelsJson = `${JSON.stringify(artifact, null, 2)}\n`
  const meta: BuildMeta = {
    schemaVersion: 1,
    sourceCliVersion: release.version,
    generatedAt,
    modelsDevSha256: devSha256,
    modelsJsonSha256: sha256Hex(new TextEncoder().encode(modelsJson)),
    planDistribution: distribution,
    modelsCount: artifact.models.length,
  }
  return { modelsJson, meta }
}

function tallyProvenance(provenance: readonly { field: string; provenance: string }[]): Record<string, Record<string, number>> {
  const tally: Record<string, Record<string, number>> = {}
  for (const record of provenance) {
    tally[record.field] ??= {}
    tally[record.field]![record.provenance] = (tally[record.field]![record.provenance] ?? 0) + 1
  }
  return tally
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  try {
    const { modelsJson, meta } = await runBuild(args)
    await Bun.write(`${args.outDir}/models.json`, modelsJson)
    await Bun.write(`${args.outDir}/build-meta.json`, `${JSON.stringify(meta, null, 2)}\n`)
    log(`[done] models.json（${meta.modelsCount} 模型，sha256=${meta.modelsJsonSha256.slice(0, 16)}…）与 build-meta.json 已写入 ${args.outDir}`)
  } catch (error) {
    // GitHub Actions ::error 注解 + 明细进 stderr：失败自动开 issue 的正文来源
    if (error instanceof Error) {
      console.error(`::error::构建失败：${error.message}`)
      if (error.stack !== undefined) console.error(error.stack)
    } else {
      console.error(`::error::构建失败：${String(error)}`)
    }
    process.exit(1)
  }
}

// 供 bun 直接执行；被测试 import 时静默
if (import.meta.main) {
  await main()
}

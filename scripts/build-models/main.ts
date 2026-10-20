/**
 * 构建流水线主编排：输入获取 → 合并 → 对账断言 → 产物写出。
 *
 * 用法（bun 运行）：
 *   bun scripts/build-models/main.ts --out-dir <目录> [--cli-version <版本>] [--prev-meta <文件>]
 *
 * 输出两文件：<out-dir>/models.json（分发产物，schema v1）与 <out-dir>/build-meta.json
 * （变更检测基准 + 计数基线，随 data 分支发布；data 分支文件同时是下次构建的 --prev-meta）。
 *
 * 产物集合 = view=client 远程 catalog 直出 ∪ 包内嵌目录补集（同一天然 Go plan 判据）。
 * 内嵌目录只做补集：tarball 下载 / 解包 / bundle 逆向任一失败都只告警，退回纯
 * view=client 集合，不阻塞发布。models.md 不参与构建（不含 hidden，无法判定集合）。
 *
 * 红线与顺序保证：对账断言全部通过之前不写任何产物文件（验收：断言失败不出产物）；
 * tarball 只做文本解析，绝不执行包内代码。
 */

import { createHash } from "node:crypto"
import type { CatalogEntry } from "./bundle.ts"
import { extractEmbeddedCatalog } from "./bundle.ts"
import { buildArtifact } from "./emit.ts"
import { familyKeys } from "./limits.ts"
import { lookupLimits } from "./modelsdev.ts"
import { isGoPlanVisible } from "./plan.ts"
import { extractTarballText } from "./tarball.ts"
import {
  downloadTarball,
  fetchClientCatalog,
  fetchLatestCliRelease,
  fetchModelsDev,
  tarballUrlFor,
} from "./registry.ts"
import {
  assertArtifactNonEmpty,
  assertGoCountStable,
  assertModalityVocabulary,
  assertPlanValueDomain,
  PLAN_VALUES,
  runReconcile,
} from "./reconcile.ts"

const CLI_FILE = "dist/cli.mjs"

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
  readonly catalogVersion: string
  readonly generatedAt: string
  readonly modelsDevSha256: string
  readonly modelsJsonSha256: string
  readonly goModelCount: number
  readonly modelsCount: number
}

/**
 * 读取上次成功构建的 individual-go 非隐藏计数。
 * 新基准用 `goModelCount`；#62 之前的旧 data 分支基准只有 `planDistribution.Go`，
 * 迁移首轮沿用同一口径，避免把历史基准误判成「无基线」。
 */
export function readPrevGoModelCount(content: string): number {
  const meta = JSON.parse(content) as unknown
  if (typeof meta !== "object" || meta === null) {
    throw new Error(`--prev-meta 文件形状不对（顶层不是对象）`)
  }
  const record = meta as Record<string, unknown>
  if (record.goModelCount !== undefined) {
    if (typeof record.goModelCount !== "number") {
      throw new Error(`--prev-meta 的 goModelCount 不是数字`)
    }
    return record.goModelCount
  }
  const distribution = record.planDistribution
  if (typeof distribution === "object" && distribution !== null) {
    const go = (distribution as Record<string, unknown>).Go
    if (typeof go === "number") return go
    if (go !== undefined) throw new Error(`--prev-meta 的 planDistribution.Go 不是数字`)
  }
  throw new Error(`--prev-meta 文件形状不对（缺 goModelCount / planDistribution.Go）`)
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function log(message: string): void {
  console.log(message)
}

/** view=client 直出 + 内嵌目录补集：同 id 时远程条目优先，补集不覆盖已知条目 */
function mergeCatalogs(
  remote: readonly CatalogEntry[],
  embedded: readonly CatalogEntry[],
): CatalogEntry[] {
  const merged = [...remote]
  const seen = new Set(remote.map((entry) => entry.id))
  for (const entry of embedded) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    merged.push(entry)
  }
  return merged
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

  // 2. view=client 远程 catalog（发现权威，失败即构建失败）
  const remote = await fetchClientCatalog(deps)
  stdout(`[input] view=client catalogVersion=${remote.catalogVersion}，目录 ${remote.entries.length} 条`)

  // 3. 包内嵌目录补集（软兜底：下载 / 解包 / 逆向任一失败只告警，不阻塞发布）
  let embedded: readonly CatalogEntry[] = []
  try {
    const tgz = await downloadTarball(release.tarballUrl, deps)
    const files = extractTarballText(tgz, [CLI_FILE])
    const result = extractEmbeddedCatalog(files.get(CLI_FILE)!)
    embedded = result.entries
    if (result.warning !== undefined) {
      stdout(`[warn] 内嵌目录解析失败，产物退化为纯 view=client 集合：${result.warning}`)
    } else {
      stdout(`[bundle] 内嵌目录 ${embedded.length} 条（Go 补集候选）`)
    }
  } catch (error) {
    stdout(`[warn] 内嵌目录获取失败，产物退化为纯 view=client 集合：${errorMessage(error)}`)
  }

  // 4. models.dev（limits 补全 + 内容 hash 触发器）
  const dev = await fetchModelsDev(deps)
  const devSha256 = sha256Hex(dev.bytes)
  stdout(`[models.dev] api.json sha256=${devSha256.slice(0, 16)}…`)

  // 5. 合并 + 对账断言：任一失败抛 ReconcileError → main 捕获 → 非零退出，无产物落盘
  const merged = mergeCatalogs(remote.entries, embedded)
  const goEntries = merged.filter(isGoPlanVisible)
  const goIds = goEntries.map((entry) => entry.id)
  const prevGoCount = args.prevMetaPath === undefined
    ? undefined
    : readPrevGoModelCount(await Bun.file(args.prevMetaPath).text())
  stdout(`[catalog] 合并目录 ${merged.length} 条（view=client ${remote.entries.length} + 内嵌补集 ${merged.length - remote.entries.length}）`)
  stdout(`[catalog] Go plan 可见 ${goIds.length} 条（individual-go 且非隐藏）`)
  runReconcile([
    assertPlanValueDomain(merged),
    assertArtifactNonEmpty(goIds),
    assertGoCountStable(goIds.length, prevGoCount),
    assertModalityVocabulary(merged),
  ])
  stdout(`[reconcile] 断言全过：minimumPlan ⊆ {${PLAN_VALUES.join(",")}}；产物 ${goIds.length} 条；模态词表一致`)

  // 6. 产物组装（Go plan 过滤 + limits 补全链 + provenance 日志）
  const devCache = new Map<string, ReturnType<typeof lookupLimits>>()
  const generatedAt = new Date().toISOString()
  const { artifact, provenance } = buildArtifact(
    release.version,
    remote.catalogVersion,
    generatedAt,
    merged,
    (id) => {
      const cached = devCache.get(id)
      if (cached !== undefined) return cached
      const limits = lookupLimits(dev.api, id)
      devCache.set(id, limits)
      return limits
    },
  )
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
    catalogVersion: remote.catalogVersion,
    generatedAt,
    modelsDevSha256: devSha256,
    modelsJsonSha256: sha256Hex(new TextEncoder().encode(modelsJson)),
    goModelCount: goIds.length,
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

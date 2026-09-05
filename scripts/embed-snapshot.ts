/**
 * 包内快照刷新（docs/spec/model-pipeline.md §5、发布流程 docs/release/release-process.md）：
 * 把最新构建产物嵌入插件主包，充当发版时刻的「最后已知良好产物」。
 *
 * 用法（发布流程第 1 步，发布前人工执行）：
 *
 *   pnpm embed-snapshot [产物 URL 或本地文件路径]
 *
 * 缺省源 = GitHub Release 最新 asset（`releases/latest/download/models.json`，
 * ADR-0001 主源渠道；github.com 不可达时可改传 data 分支 raw 或本地文件路径）。
 *
 * 纪律与 #28 构建侧同款：产物只做文本解析、绝不执行包内代码。拉到的 JSON 先过
 * 运行时同款 `parseArtifact` schema 校验，校验失败或快照空清单即拒绝写入、退出
 * 非零——包内快照永远来自构建产物，不存在手写形态。写入为逐字节原文，sha256
 * 与渠道产物一致、可直接对账。
 */

import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { parseArtifact } from "../src/models/artifact.js"

const DEFAULT_SOURCE_URL =
  "https://github.com/WallBreakerNO4/opencode-commandcode-provider/releases/latest/download/models.json"

const TARGET = fileURLToPath(new URL("../src/models/snapshot.json", import.meta.url))

const source = process.argv[2] ?? DEFAULT_SOURCE_URL

const raw =
  source.startsWith("http://") || source.startsWith("https://")
    ? Buffer.from(await (await fetch(source)).arrayBuffer())
    : await Bun.file(source).bytes()

const parsed = parseArtifact(JSON.parse(new TextDecoder().decode(raw)))
if (!parsed.ok) {
  const detail =
    parsed.error.reason === "future-version"
      ? `schemaVersion ${parsed.error.schemaVersion} 高于运行时已知上限——先升级运行时解析器再嵌入`
      : parsed.error.detail
  console.error(`产物 schema 校验失败，拒绝写入：${detail}`)
  process.exit(1)
}
const artifact = parsed.artifact
if (artifact.models.length === 0) {
  console.error("产物 models 为空清单——空快照无兜底价值，拒绝写入（对账断言异常请查构建流水线）")
  process.exit(1)
}

await writeFile(TARGET, raw)
const sha256 = createHash("sha256").update(raw).digest("hex")
console.log(
  `包内快照已更新：src/models/snapshot.json\n` +
    `  source: ${source}\n` +
    `  sha256: ${sha256}\n` +
    `  sourceCliVersion: ${artifact.sourceCliVersion}  generatedAt: ${artifact.generatedAt}\n` +
    `  models: ${artifact.models.length}`,
)

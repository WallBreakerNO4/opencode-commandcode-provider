/**
 * npm pack 产物检查（issue #38 验收项，发布流程 docs/release/release-process.md 的
 * 自动化防线）：真实执行 build + pack + 解包，对**发布产物本身**断言——
 * - 零运行时依赖：package.json 无 dependencies/peerDependencies/optionalDependencies
 *   （src 全部外部引用是 @ai-sdk/provider 类型与 node: 内建，类型在编译期擦除）；
 * - files 清单最小：包内路径白名单 = package.json + README.md + npm 自动收录项
 *   （LICENSE/NOTICE）+ dist/**，tests/docs/scripts/src 等一律不入包；
 * - 快照在包内：dist/models/snapshot.json 与 src 逐字节一致（embed-snapshot 的
 *   构建产物原文），经 parseArtifact schema 校验、非空清单；
 * - 入口形状在产物上成立（package-shape.test.ts 锁 src 形状，本文件锁 dist 形状）：
 *   default 三键、第一个 create* 导出、ENTRY_URL 自指锚点真实存在于包内（v2 自指
 *   注册的宿主再 import 目标）。
 *
 * tsc 全量编译 + pack 耗时超出 bun 默认单测超时，本文件放宽至 120s。
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArtifact } from "../src/models/artifact.js"

const repoRoot = resolve(import.meta.dir, "..")
const distDir = join(repoRoot, "dist")

function run(command: string, args: string[], cwd = repoRoot): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  return { ok: result.status === 0, output }
}

describe("npm pack 产物检查", () => {
  const packDir = mkdtempSync(join(tmpdir(), "ccpack-"))
  const extractDir = mkdtempSync(join(tmpdir(), "ccextract-"))
  let tarball: string
  let packedFiles: string[] = []

  afterAll(() => {
    rmSync(packDir, { recursive: true, force: true })
    rmSync(extractDir, { recursive: true, force: true })
  })

  beforeAll(() => {
    rmSync(distDir, { recursive: true, force: true })
    const build = run("pnpm", ["build"])
    if (!build.ok) console.error(build.output)
    expect(build.ok).toBe(true)
    const pack = run("pnpm", ["pack", "--pack-destination", packDir])
    if (!pack.ok) console.error(pack.output)
    expect(pack.ok).toBe(true)
    const tgzs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"))
    expect(tgzs).toHaveLength(1)
    tarball = join(packDir, tgzs[0]!)

    const tar = run("tar", ["-xzf", tarball, "-C", extractDir])
    if (!tar.ok) console.error(tar.output)
    expect(tar.ok).toBe(true)
    const walk = (dir: string, prefix: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`
        return entry.isDirectory() ? walk(join(dir, entry.name), rel) : [rel]
      })
    packedFiles = walk(join(extractDir, "package"), "").map((rel) => `package/${rel}`)
    expect(packedFiles.length).toBeGreaterThan(0)
  }, 120_000)

  test("files 清单最小：恰为 package.json + README.md + npm 自动收录文件 + dist/**", () => {
    // LICENSE/NOTICE 是 npm 恒定自动收录项（release-process.md §0 把补 LICENSE 列为
    // 发布前置）——必须放行，否则补许可当天本检查即误报
    const auto = /^package\/(LICENSE|LICENCE|NOTICE)/i
    const outside = packedFiles.filter(
      (f) =>
        f !== "package/package.json" && f !== "package/README.md" && !f.startsWith("package/dist/") && !auto.test(f),
    )
    expect(outside).toEqual([])
    expect(packedFiles).toContain("package/dist/index.js")
    expect(packedFiles).toContain("package/dist/index.d.ts")
  })

  test("零运行时依赖：package.json 无 dependencies/peerDependencies/optionalDependencies", () => {
    const pkg = JSON.parse(readFileSync(join(extractDir, "package", "package.json"), "utf8"))
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.peerDependencies).toBeUndefined()
    expect(pkg.optionalDependencies).toBeUndefined()
  })

  test("main/exports/types 指向包内真实文件", () => {
    const pkg = JSON.parse(readFileSync(join(extractDir, "package", "package.json"), "utf8"))
    for (const target of [pkg.main, pkg.types, pkg.exports["."].types, pkg.exports["."].import]) {
      expect(existsSync(join(extractDir, "package", target))).toBe(true)
    }
  })

  test("快照在包内：dist/models/snapshot.json 与 src 逐字节一致且 schema 校验非空", () => {
    const srcSnapshot = readFileSync(join(repoRoot, "src", "models", "snapshot.json"))
    const packedSnapshot = readFileSync(join(extractDir, "package", "dist", "models", "snapshot.json"))
    expect(createHash("sha256").update(packedSnapshot).digest("hex")).toBe(
      createHash("sha256").update(srcSnapshot).digest("hex"),
    )
    const parsed = parseArtifact(JSON.parse(packedSnapshot.toString("utf8")))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.artifact.models.length).toBeGreaterThan(0)
  })

  test("入口形状在产物上成立：default 三键、create* 判据、ENTRY_URL 自指锚点在包内", async () => {
    const mod = await import(`${extractDir}/package/dist/index.js`)
    expect(Object.keys(mod.default).sort()).toEqual(["id", "server", "setup"])
    expect(mod.default.id).toBe("commandcode-go")
    const createExports = Object.keys(mod).filter((key) => key.startsWith("create"))
    expect(createExports[0]).toBe("createCommandCode")
    const entryUrl = mod.ENTRY_URL
    expect(entryUrl.startsWith("file://")).toBe(true)
    expect(fileURLToPath(entryUrl)).toBe(join(extractDir, "package", "dist", "index.js"))
  })
})

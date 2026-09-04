import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fsModule from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { collectingLogger } from "./helpers.ts"

// 版本缓存 IO（disguise.md §6 唯一落盘物 + testing.md §2 落盘断言）：
// XDG_CACHE_HOME 重定向至临时目录（§3 认可的标准行为）；原子写形状（临时文件 +
// rename）经 mock.module 拦截 node:fs/promises 断言——fs 无工厂接缝，按 testing.md
// 的兜底通道处理。bun 的 mock.module 对已加载模块是 live-binding 热替换，真函数
// 引用必须先捕获再 mock，spy 才能回落到原始实现。

const rawFs = {
  mkdir: fsModule.mkdir.bind(fsModule),
  writeFile: fsModule.writeFile.bind(fsModule),
  rename: fsModule.rename.bind(fsModule),
  readFile: fsModule.readFile.bind(fsModule),
  readdir: fsModule.readdir.bind(fsModule),
  stat: fsModule.stat.bind(fsModule),
  mkdtemp: fsModule.mkdtemp.bind(fsModule),
  rm: fsModule.rm.bind(fsModule),
}

const fsCalls = {
  mkdir: [] as string[],
  writeFile: [] as string[],
  rename: [] as Array<[string, string]>,
}

mock.module("node:fs/promises", () => {
  const recording = {
    ...fsModule,
    mkdir: async (path: string, options?: Parameters<typeof rawFs.mkdir>[1]) => {
      fsCalls.mkdir.push(path)
      return rawFs.mkdir(path, options)
    },
    writeFile: async (path: string, data: string, options?: Parameters<typeof rawFs.writeFile>[2]) => {
      fsCalls.writeFile.push(path)
      return rawFs.writeFile(path, data, options)
    },
    rename: async (from: string, to: string) => {
      fsCalls.rename.push([from, to])
      return rawFs.rename(from, to)
    },
  }
  return { ...recording, default: fsModule }
})

const { resolveVersionCacheDir, resolveVersionCachePath, readVersionCache, writeVersionCache } = await import(
  "../../src/disguise/version-cache.ts"
)

let cacheRoot = ""

beforeEach(async () => {
  cacheRoot = await rawFs.mkdtemp(join(tmpdir(), "cc-version-cache-"))
  process.env["XDG_CACHE_HOME"] = cacheRoot
  fsCalls.mkdir.length = 0
  fsCalls.writeFile.length = 0
  fsCalls.rename.length = 0
})

afterEach(async () => {
  delete process.env["XDG_CACHE_HOME"]
  await rawFs.rm(cacheRoot, { recursive: true, force: true })
})

describe("路径解析", () => {
  test("XDG_CACHE_HOME 优先，默认 ~/.cache", () => {
    expect(resolveVersionCacheDir()).toBe(cacheRoot)
    delete process.env["XDG_CACHE_HOME"]
    expect(resolveVersionCacheDir()).toBe(join(homedir(), ".cache"))
  })

  test("缓存完整路径为 <cacheDir>/opencode-commandcode/version-cache.json", () => {
    expect(resolveVersionCachePath()).toBe(join(cacheRoot, "opencode-commandcode", "version-cache.json"))
  })
})

describe("原子写：临时文件 + rename", () => {
  test("先写 .tmp 再 rename 到最终路径，落盘内容为 {version, fetchedAt}", async () => {
    await writeVersionCache({ version: "1.38.2", fetchedAt: "2026-09-04T00:00:00.000Z" })

    const finalPath = resolveVersionCachePath()
    expect(fsCalls.mkdir).toEqual([join(cacheRoot, "opencode-commandcode")])
    expect(fsCalls.writeFile).toEqual([`${finalPath}.tmp`])
    expect(fsCalls.rename).toEqual([[`${finalPath}.tmp`, finalPath]])

    const raw = await rawFs.readFile(finalPath, "utf8")
    expect(JSON.parse(raw)).toEqual({ version: "1.38.2", fetchedAt: "2026-09-04T00:00:00.000Z" })
  })

  test("写成功后无临时文件残留", async () => {
    await writeVersionCache({ version: "1.38.2", fetchedAt: "2026-09-04T00:00:00.000Z" })
    const entries = await rawFs.readdir(join(cacheRoot, "opencode-commandcode"))
    expect(entries).toEqual(["version-cache.json"])
  })

  test("写前递归创建缓存目录", async () => {
    await writeVersionCache({ version: "1.38.2", fetchedAt: "2026-09-04T00:00:00.000Z" })
    const stats = await rawFs.stat(join(cacheRoot, "opencode-commandcode"))
    expect(stats.isDirectory()).toBe(true)
  })

  test("写失败向上抛（调用方降兜底 + warn）：XDG 指向普通文件时 mkdir 失败", () => {
    const notADir = join(cacheRoot, "occupied")
    return rawFs.writeFile(notADir, "not a directory").then(() => {
      process.env["XDG_CACHE_HOME"] = notADir
      expect(
        writeVersionCache({ version: "1.38.2", fetchedAt: "2026-09-04T00:00:00.000Z" }),
      ).rejects.toThrow()
    })
  })
})

describe("读取", () => {
  test("读回最近一次写入", async () => {
    await writeVersionCache({ version: "1.39.0", fetchedAt: "2026-09-04T12:00:00.000Z" })
    expect(await readVersionCache()).toEqual({ version: "1.39.0", fetchedAt: "2026-09-04T12:00:00.000Z" })
  })

  test("ENOENT（首次运行）静默返回 undefined", async () => {
    const logger = collectingLogger()
    expect(await readVersionCache(logger)).toBeUndefined()
    expect(logger.messages).toEqual([])
  })

  test("损坏 JSON 视同无值并 warn", async () => {
    const dir = join(cacheRoot, "opencode-commandcode")
    await rawFs.mkdir(dir, { recursive: true })
    await rawFs.writeFile(join(dir, "version-cache.json"), "{not json")
    const logger = collectingLogger()
    expect(await readVersionCache(logger)).toBeUndefined()
    expect(logger.messages.length).toBe(1)
    expect(logger.messages[0]!.startsWith("warn:")).toBe(true)
  })

  test("形状不对（缺字段/类型错）视同无值并 warn", async () => {
    const dir = join(cacheRoot, "opencode-commandcode")
    await rawFs.mkdir(dir, { recursive: true })
    await rawFs.writeFile(join(dir, "version-cache.json"), JSON.stringify({ version: 42, fetchedAt: null }))
    expect(await readVersionCache(collectingLogger())).toBeUndefined()
  })

  test("读失败（XDG 指向普通文件）warn 后返回 undefined，不向上抛", async () => {
    const notADir = join(cacheRoot, "occupied")
    await rawFs.writeFile(notADir, "not a directory")
    process.env["XDG_CACHE_HOME"] = notADir
    const logger = collectingLogger()
    expect(await readVersionCache(logger)).toBeUndefined()
    expect(logger.messages.length).toBe(1)
  })
})

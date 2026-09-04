/**
 * 版本缓存落盘（disguise.md §6 / D1）：伪装模块**唯一**的磁盘 IO。
 * 路径 `<XDG_CACHE_HOME 或 ~/.cache>/opencode-commandcode/version-cache.json`，
 * 内容 `{version, fetchedAt}`；写经临时文件 + rename 原子替换，读失败与损坏一律
 * 视为无值（ENOENT 是首次运行的正常态，静默；其余异常按「落盘异常」warn）。
 * key 与其他伪装状态与本文件无关——它们只活在内存（D1）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { DisguiseLogger } from "./logger.js"

/** version-cache.json 的一行：上次成功拉取的 CLI 版本与拉取时刻（ISO 8601） */
export interface VersionCacheEntry {
  readonly version: string
  readonly fetchedAt: string
}

/** 缓存目录解析：XDG_CACHE_HOME 非空优先（含测试重定向，testing.md §3 认可的标准行为），否则 ~/.cache */
export function resolveVersionCacheDir(): string {
  return process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache")
}

/** 缓存文件完整路径；env 每次现读（不缓存），重定向后同进程即刻生效 */
export function resolveVersionCachePath(): string {
  return join(resolveVersionCacheDir(), "opencode-commandcode", "version-cache.json")
}

/**
 * 原子写：先落同目录临时文件再 rename（同目录保证同一文件系统，rename 原子）。
 * 失败向上抛给调用方——缓存写失败不构成伪装失败，调用方降兜底 + warn。
 */
export async function writeVersionCache(entry: VersionCacheEntry): Promise<void> {
  const path = resolveVersionCachePath()
  const tmp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(entry), "utf8")
  await rename(tmp, path)
}

/** 缓存形状守卫：{version, fetchedAt} 双非空字符串才可信，其余（损坏/缺字段）视同无值 */
function parseEntry(raw: string): VersionCacheEntry | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const version = record["version"]
  const fetchedAt = record["fetchedAt"]
  if (typeof version !== "string" || version.length === 0) return undefined
  if (typeof fetchedAt !== "string" || fetchedAt.length === 0) return undefined
  return { version, fetchedAt }
}

/**
 * 读取上次成功拉取值；ENOENT（首次运行）静默返回 undefined，其余异常与损坏形状
 * warn 后返回 undefined。日志经注入式 logger（§7），无 logger 时静默。
 */
export async function readVersionCache(logger?: DisguiseLogger): Promise<VersionCacheEntry | undefined> {
  let raw: string
  try {
    raw = await readFile(resolveVersionCachePath(), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
    logger?.warn(`版本缓存读取失败，视同无值：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const entry = parseEntry(raw)
  if (entry === undefined) logger?.warn(`版本缓存形状损坏，视同无值：${resolveVersionCachePath()}`)
  return entry
}

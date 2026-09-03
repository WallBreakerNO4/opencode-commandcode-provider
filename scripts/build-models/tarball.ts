/**
 * npm tarball 解包：gzip + ustar 的最小实现（零依赖）。
 *
 * 红线：解包仅做文本解析、绝不执行包内代码——本模块只把字节还原为文件内容，
 * 不碰 package.json 的 scripts、不 spawn 任何进程。
 * Bun.gunzipSync 承担 gzip；ustar 头按 POSIX 手写解析（只需「按名取文件」，
 * pax/GNU longname 等扩展头读出即跳过——本包文件路径均短于 100 字符）。
 */

export class TarballError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TarballError"
  }
}

const BLOCK_SIZE = 512

export interface TarEntry {
  readonly name: string
  readonly data: Uint8Array
}

export function gunzip(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  try {
    return Bun.gunzipSync(data)
  } catch (error) {
    throw new TarballError(`gzip 解压失败（输入不是合法的 .tgz）：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 解出 tar 归档中的普通文件（目录 / 链接 / pax 头跳过） */
export function extractTarEntries(archive: Uint8Array<ArrayBuffer>): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(header)) break // 归档结束标志（两个零块，见第一个即停）
    offset += BLOCK_SIZE

    const name = readFixedString(header, 0, 100)
    const sizeField = readFixedString(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] ?? 48)
    const prefix = readFixedString(header, 345, 155)
    if (sizeField === "") {
      throw new TarballError(`tar 头 size 字段为空（offset=${offset - BLOCK_SIZE}，非 ustar 归档？）`)
    }
    const size = Number.parseInt(sizeField, 8)
    if (!Number.isInteger(size) || size < 0) {
      throw new TarballError(`tar 头 size 非法："${sizeField}"`)
    }

    const dataEnd = offset + size
    if (dataEnd > archive.length) {
      throw new TarballError(`tar 条目「${name}」数据越界（size=${size}）`)
    }
    // '0' 或 '\0' = 普通文件；'x'/'g'/'L' 等扩展头的 data 只承载元数据，跳过
    if ((typeflag === "0" || typeflag === "\0") && name !== "") {
      const fullName = prefix !== "" ? `${prefix}/${name}` : name
      entries.set(fullName, archive.slice(offset, dataEnd))
    }
    // 数据按 512 对齐
    offset = dataEnd + ((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE)
  }
  return entries
}

/** 解包 .tgz，返回「文件名 → 文本内容」；缺失任一请求路径即抛错 */
export function extractTarballText(tgz: Uint8Array<ArrayBuffer>, requiredSuffixes: readonly string[]): Map<string, string> {
  const entries = extractTarEntries(gunzip(tgz))
  const texts = new Map<string, string>()
  for (const [name, data] of entries) {
    texts.set(name, new TextDecoder().decode(data))
  }
  const resolved = new Map<string, string>()
  for (const suffix of requiredSuffixes) {
    const matches = [...texts.entries()].filter(([name]) => name === suffix || name.endsWith(`/${suffix}`))
    if (matches.length === 0) {
      throw new TarballError(`tarball 中找不到路径后缀「${suffix}」；实际条目：${[...texts.keys()].join(", ")}`)
    }
    if (matches.length > 1) {
      throw new TarballError(`tarball 中路径后缀「${suffix}」命中多条：${matches.map(([name]) => name).join(", ")}`)
    }
    resolved.set(suffix, matches[0]![1])
  }
  return resolved
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0)
}

function readFixedString(block: Uint8Array, start: number, length: number): string {
  let end = start
  const limit = start + length
  while (end < limit && block[end] !== 0) end++
  return new TextDecoder().decode(block.subarray(start, end)).trim()
}

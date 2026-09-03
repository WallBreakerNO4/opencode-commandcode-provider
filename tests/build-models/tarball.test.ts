import { describe, expect, test } from "bun:test"
import { extractTarEntries, extractTarballText, gunzip, TarballError } from "../../scripts/build-models/tarball.ts"

/** 手工构造 ustar 归档字节（测试自足，不依赖系统 tar） */
function tarHeader(name: string, size: number, typeflag: string = "0"): Uint8Array {
  const block = new Uint8Array(512)
  const write = (offset: number, text: string) => block.set(new TextEncoder().encode(text), offset)
  write(0, name)
  write(124, `${size.toString(8).padStart(11, "0")}\x00`)
  write(136, "0000000\x00") // mtime
  block[156] = typeflag.charCodeAt(0)
  write(257, "ustar\x0000")
  // 校验和：头 512 字节校验和字段取空格初值求和
  let checksum = 0
  for (const byte of block) checksum += byte
  write(148, `${checksum.toString(8).padStart(6, "0")}\0 `)
  return block
}

function pad(data: Uint8Array): Uint8Array {
  const padding = (512 - (data.length % 512)) % 512
  const out = new Uint8Array(data.length + padding)
  out.set(data)
  return out
}

function concat(blocks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = blocks.reduce((sum, block) => sum + block.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }
  return out
}

const ARCHIVE = concat([
  tarHeader("package/dist/cli.mjs", 9),
  pad(new TextEncoder().encode('var A="x"')),
  tarHeader("package/dist/bundled/command-code-knowledge/reference/models.md", 12),
  pad(new TextEncoder().encode("| `model` |\n")),
  tarHeader("package/dist/lib/", 0, "5"), // 目录条目跳过
  new Uint8Array(1024), // 结束零块 ×2
])

describe("tarball 解包（gzip + ustar 最小实现）", () => {
  test("gunzip + 条目提取：普通文件按名取出，目录跳过", () => {
    const compressed = Bun.gzipSync(ARCHIVE)
    expect(gunzip(compressed)).toEqual(ARCHIVE)

    const entries = extractTarEntries(gunzip(compressed))
    expect([...entries.keys()]).toEqual([
      "package/dist/cli.mjs",
      "package/dist/bundled/command-code-knowledge/reference/models.md",
    ])
    expect(new TextDecoder().decode(entries.get("package/dist/cli.mjs")!)).toBe('var A="x"')
    expect(new TextDecoder().decode(entries.get("package/dist/bundled/command-code-knowledge/reference/models.md")!)).toBe("| `model` |\n")
  })

  test("extractTarballText：后缀匹配取文本；缺失 / 多义即抛错", () => {
    const compressed = Bun.gzipSync(ARCHIVE)
    const files = extractTarballText(compressed, [
      "dist/cli.mjs",
      "dist/bundled/command-code-knowledge/reference/models.md",
    ])
    expect(files.get("dist/cli.mjs")).toBe('var A="x"')

    expect(() => extractTarballText(compressed, ["dist/missing.mjs"])).toThrow(TarballError)
  })

  test("非 gzip 输入 → TarballError", () => {
    expect(() => gunzip(new TextEncoder().encode("not a gzip"))).toThrow(TarballError)
  })
})

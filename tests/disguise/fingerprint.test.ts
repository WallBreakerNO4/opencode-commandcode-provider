import { describe, expect, test } from "bun:test"
import { sha256Digest, sha256Hex } from "../../src/disguise/hash.ts"
import { computeThumbmark, buildFingerprintBody, type FingerprintComponents } from "../../src/disguise/fingerprint.ts"

// 指纹哈希数学（调研 §1.2–§1.3；disguise.md §8）：固定输入注入断言（testing.md §1.2）。
// 采集器读真机不单测（testing.md §1.5），此处只锁哈希纯函数。

const BASE_COMPONENTS: FingerprintComponents = {
  machineIdHash: "a".repeat(64),
  macHashes: ["b".repeat(64), "c".repeat(64)],
  osUserHash: "d".repeat(64),
  hostnameHash: "e".repeat(64),
  gitEmailHash: "f".repeat(64),
  platform: "linux",
  arch: "x64",
  osRelease: "6.8.0-138-generic",
  cpuModel: "AMD Ryzen 9 7950X",
  cpuCount: 16,
  memGiB: 32,
  isContainer: false,
  timezone: "Asia/Shanghai",
  runtime: "cli",
  collectorVersion: 1,
}

describe("components 15 字段结构（调研 §1.4）", () => {
  test("字段名单恰为 15 项，与 wire 形状同名", () => {
    expect(Object.keys(BASE_COMPONENTS).sort()).toEqual(
      [
        "machineIdHash",
        "macHashes",
        "osUserHash",
        "hostnameHash",
        "gitEmailHash",
        "platform",
        "arch",
        "osRelease",
        "cpuModel",
        "cpuCount",
        "memGiB",
        "isContainer",
        "timezone",
        "runtime",
        "collectorVersion",
      ].sort(),
    )
  })
})

describe("thumbmark 联合哈希（调研 §1.3）", () => {
  test("固定输入锚点：拼接序 machineId→macs→osUser→hostname→gitEmail→platform→osRelease→cpuModel→cpuCount→memGiB", () => {
    expect(computeThumbmark(BASE_COMPONENTS)).toBe("cca5202e0ba490d9a16318269dd375780ad1527d551b4235e27ced57f6ade2e7")
  })

  test("输出为 64 位小写 hex；同输入恒同输出", () => {
    const thumbmark = computeThumbmark(BASE_COMPONENTS)
    expect(thumbmark).toMatch(/^[0-9a-f]{64}$/)
    expect(computeThumbmark({ ...BASE_COMPONENTS })).toBe(thumbmark)
  })

  test("「五字段不入哈希」：arch/timezone/isContainer/runtime/collectorVersion 变了 thumbmark 不变", () => {
    const base = computeThumbmark(BASE_COMPONENTS)
    expect(computeThumbmark({ ...BASE_COMPONENTS, arch: "arm64" })).toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, timezone: "Europe/Berlin" })).toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, isContainer: true })).toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, runtime: "vscode" })).toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, collectorVersion: 2 })).toBe(base)
  })

  test("参与联合哈希的字段任一变化都改变 thumbmark", () => {
    const base = computeThumbmark(BASE_COMPONENTS)
    expect(computeThumbmark({ ...BASE_COMPONENTS, machineIdHash: "1".repeat(64) })).not.toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, macHashes: [...BASE_COMPONENTS.macHashes, "2".repeat(64)] })).not.toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, osUserHash: "3".repeat(64) })).not.toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, hostnameHash: "4".repeat(64) })).not.toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, gitEmailHash: "5".repeat(64) })).not.toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, platform: "darwin" })).not.toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, osRelease: "24.3.0" })).not.toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, cpuModel: "Apple M4 Pro" })).not.toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, cpuCount: 10 })).not.toBe(base)
    expect(computeThumbmark({ ...BASE_COMPONENTS, memGiB: 48 })).not.toBe(base)
  })

  test("macHashes 按数组顺序参与拼接，顺序敏感", () => {
    const flipped = { ...BASE_COMPONENTS, macHashes: [...BASE_COMPONENTS.macHashes].reverse() }
    expect(computeThumbmark(flipped)).not.toBe(computeThumbmark(BASE_COMPONENTS))
  })
})

describe("buildFingerprintBody（record body 形状）", () => {
  test("thumbmark 重算、components 原样搬运", () => {
    const body = buildFingerprintBody(BASE_COMPONENTS)
    expect(body.thumbmark).toBe(computeThumbmark(BASE_COMPONENTS))
    expect(body.components).toBe(BASE_COMPONENTS)
    expect(Object.keys(body).sort()).toEqual(["components", "thumbmark"].sort())
  })
})

describe("哈希原语（调研 §1.2 sha256 定义）", () => {
  test("sha256Hex = hex(sha256(utf8))，64 位小写", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/)
  })

  test("sha256Digest 摘要 32 字节，与 hex 同源", () => {
    expect(Buffer.from(sha256Digest("abc")).toString("hex")).toBe(sha256Hex("abc"))
  })
})

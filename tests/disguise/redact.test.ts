import { describe, expect, test } from "bun:test"
import { redactApiKey, redactIdentifier } from "../../src/disguise/redact.ts"

// 日志脱敏（disguise.md §7）：key 原文与伪标识符原文在任何输出中不出现。

describe("apiKey 脱敏", () => {
  test("形态恰为 cc-key# + sha256 前 8 位 hex", () => {
    expect(redactApiKey("user_test")).toBe("cc-key#36ff39cc")
    expect(redactApiKey("user_SUPERSECRET123")).toBe("cc-key#b67bb608")
  })

  test("key 原文（含任何子串）不出现在输出中", () => {
    const secret = "user_SUPERSECRET123"
    const redacted = redactApiKey(secret)
    expect(redacted).not.toContain(secret)
    expect(redacted).not.toContain("SUPERSECRET")
    expect(redacted).not.toContain("user_")
    expect(redacted).toMatch(/^cc-key#[0-9a-f]{8}$/)
  })

  test("同 key 恒同短哈希、异 key 异短哈希", () => {
    expect(redactApiKey("user_a")).toBe(redactApiKey("user_a"))
    expect(redactApiKey("user_a")).not.toBe(redactApiKey("user_b"))
  })
})

describe("伪标识符脱敏", () => {
  test("uuid 剥连字符后截前 12 位 hex + …", () => {
    expect(redactIdentifier("df72321c-66e7-4f3b-8779-5b882e51727f")).toBe("df72321c66e7…")
  })

  test("64hex thumbmark 截前 12 位 + …", () => {
    expect(redactIdentifier("cca5202e0ba490d9a16318269dd375780ad1527d551b4235e27ced57f6ade2e7")).toBe("cca5202e0ba4…")
  })

  test("32hex trace-id 截前 12 位 + …", () => {
    expect(redactIdentifier("0af7651916cd43dd8448eb211c80319c")).toBe("0af7651916cd…")
  })

  test("伪标识符原文不出现在输出中（uuid 全文不可复原）", () => {
    const id = "df72321c-66e7-4f3b-8779-5b882e51727f"
    const redacted = redactIdentifier(id)
    expect(redacted).not.toBe(id)
    expect(redacted.length).toBe(13)
  })
})

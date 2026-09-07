import { describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import plugin from "../../src/index.ts"
import { PROVIDER_ID, buildEnvelope, type EnvelopeCallContext } from "../../src/protocol/envelope.ts"

// v1 宿主 chat.params hook（#46）：宿主对每次请求注入 `maxOutputTokens =
// min(limit.output, 32000)`（provider/transform.ts OUTPUT_TOKEN_MAX），三段式
// `?? 64000` 在真实链路永走不到。本 hook 对本 provider 一律置 undefined
//（照抄 codex.ts 既有模式：providerID 过滤 + 无条件清除），缺省信封 max_tokens
// 真正落 64000。hook 的宿主触发行为仍归真宿主验证（testing.md §4），此处只锁
// 纯行为：过滤 + 清除 + 清除值喂给信封的端到端缺省。

function paramsOutput(maxOutputTokens: number | undefined) {
  return { maxOutputTokens }
}

function envelopeContext(maxOutput: number): EnvelopeCallContext {
  return {
    modelId: "deepseek/deepseek-v4-flash",
    maxOutput,
    threadId: "df72321c-66e7-4f3b-8779-5b882e51727f",
    disguise: { config: { workingDir: "/repo" }, permissionMode: "standard" },
  }
}

const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

describe("chat.params hook 清宿主 32k 闸门（#46）", () => {
  test("本 provider：宿主注入的 32k 值被清为 undefined", async () => {
    const hooks = await plugin.server({}, {})
    const output = paramsOutput(32000)
    await hooks["chat.params"]({ model: { providerID: PROVIDER_ID } }, output)
    expect(output.maxOutputTokens).toBeUndefined()
  })

  test("他 provider：原样保留（不过界）", async () => {
    const hooks = await plugin.server({}, {})
    const output = paramsOutput(32000)
    await hooks["chat.params"]({ model: { providerID: "openai" } }, output)
    expect(output.maxOutputTokens).toBe(32000)
  })

  test("已是 undefined：保持 undefined（幂等）", async () => {
    const hooks = await plugin.server({}, {})
    const output = paramsOutput(undefined)
    await hooks["chat.params"]({ model: { providerID: PROVIDER_ID } }, output)
    expect(output.maxOutputTokens).toBeUndefined()
  })

  test("清除值喂给信封：缺省 max_tokens 落 64000（成功判据端到端）", async () => {
    const hooks = await plugin.server({}, {})
    const output = paramsOutput(32000)
    await hooks["chat.params"]({ model: { providerID: PROVIDER_ID } }, output)
    // deepseek v4 系级联 384000（models.dev 第三方视角值）：hook 清除后走 ?? 64000
    const { body } = buildEnvelope({ prompt, maxOutputTokens: output.maxOutputTokens }, envelopeContext(384_000))
    expect(body.params.max_tokens).toBe(64_000)
  })
})

// PROTOTYPE: LanguageModelV3 假实现（形状照 docs/research/v2-provider-contract.md §2）
// 目的：验证 v1.18.21 宿主是否接受 V3 spec（finishReason {unified, raw} 对象 + 嵌套 usage）
import { probe } from "./probe.js"

export function createFakeLanguageModel(modelId, tag = "v3") {
  const makeUsage = () => ({
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 2, text: 2, reasoning: 0 },
  })

  return {
    specificationVersion: tag,
    provider: "ccproto-proto",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      probe("fake-doGenerate", { modelId, promptKeys: Object.keys(options ?? {}) })
      return {
        content: [{ type: "text", text: "PROTO-PONG(v1-host)" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: makeUsage(),
      }
    },
    async doStream(options) {
      probe("fake-doStream", { modelId, promptKeys: Object.keys(options ?? {}) })
      const id = "proto-text-1"
      let sent = false
      return {
        stream: new ReadableStream({
          start(ctrl) {
            ctrl.enqueue({ type: "stream-start", warnings: [] })
            ctrl.enqueue({ type: "text-start", id })
            ctrl.enqueue({ type: "text-delta", id, delta: "PROTO-PONG " })
            ctrl.enqueue({ type: "text-delta", id, delta: "(v1-host)" })
            ctrl.enqueue({ type: "text-end", id })
            ctrl.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: makeUsage() })
            ctrl.close()
            sent = true
          },
        }),
      }
    },
  }
}

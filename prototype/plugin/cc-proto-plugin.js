// PROTOTYPE — 一次性验证插件，不是产品。
// 验证点：
//   A. ctx.catalog.transform 注册模型后，providers.ccproto.package = "aisdk:file://..." 能否走通
//   B. 模型级 package 双写（fake-2）与单写（fake-1）是否有差异（Breskott 的 UnsupportedPackageError 坑）
//   C. CCPROTO_HOOK=1 时，ctx.aisdk.hook("language") 直接注入 LanguageModelV3 的兜底路径
// 注意：不 import "@opencode-ai/plugin"——define() 是恒等函数，裸导出 {id, setup} 即可，零传递依赖。
import { appendFileSync } from "node:fs"

const PKG = process.env.CCPROTO_PKG ?? "aisdk:file:///home/wall/self-project/other/opencode-commandcode-provider/prototype/commandcode-proto/index.js"
const LOG = process.env.CCPROTO_LOG ?? "/tmp/opencode/cc-proto/cc-proto-factory.log"

function log(event, data) {
  try {
    appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), event, ...data }) + "\n")
  } catch {}
}

function hookLanguageModel(modelId) {
  const base = () => `HOOK-ECHO[${modelId}]: language hook alive`
  return {
    specificationVersion: "v3",
    provider: "ccproto",
    modelId,
    supportedUrls: {},
    async doStream() {
      log("hook.doStream", { modelId })
      const parts = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "h0" },
        { type: "text-delta", id: "h0", delta: base() },
        { type: "text-end", id: "h0" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ]
      let i = 0
      return {
        stream: new ReadableStream({
          pull(c) {
            if (i < parts.length) c.enqueue(parts[i++])
            else c.close()
          },
        }),
      }
    },
    async doGenerate() {
      log("hook.doGenerate", { modelId })
      return {
        content: [{ type: "text", text: base() }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      }
    },
  }
}

export default {
  id: "cc-proto",
  async setup(ctx) {
    log("plugin.setup", { pkg: PKG, hook: process.env.CCPROTO_HOOK === "1" })

    const registration = await ctx.catalog.transform((draft) => {
      // Provider：upsert 语义，config 里也声明了 package，这里兜底写齐
      draft.provider.update("ccproto", (p) => {
        p.name = "CommandCode Proto"
        p.package = PKG
        p.activation = "auto"
      })

      // fake-1：只有 provider 级 package（验证单写是否足够）
      draft.model.update("ccproto", "fake-1", (m) => {
        m.name = "Fake 1 (provider-level package)"
        m.modelID = "fake-1"
        m.capabilities = { tools: true, input: ["text"], output: ["text"] }
        m.limit = { context: 200000, output: 32000 }
        m.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
        m.status = "active"
        m.enabled = true
        m.variants = []
        m.time = { released: 0 }
      })

      // fake-2：模型级 package 双写（Breskott 声称的必要条件）
      draft.model.update("ccproto", "fake-2", (m) => {
        m.name = "Fake 2 (model-level package too)"
        m.modelID = "fake-2"
        m.package = PKG
        m.settings = {}
        m.capabilities = { tools: true, input: ["text"], output: ["text"] }
        m.limit = { context: 200000, output: 32000 }
        m.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
        m.status = "active"
        m.enabled = true
        m.variants = []
        m.time = { released: 0 }
      })

      draft.model.default.set("ccproto", "fake-1")
    })

    // C 路径：language hook 直接给出 LanguageModelV3，绕过包工厂
    if (process.env.CCPROTO_HOOK === "1") {
      await ctx.aisdk.hook(
        "language",
        (evt) => {
          if (evt.model.providerID !== "ccproto") return
          log("hook.language", { modelID: evt.model.modelID ?? evt.model.id, hasSDK: Boolean(evt.sdk) })
          evt.language = hookLanguageModel(evt.model.modelID ?? evt.model.id)
        },
        { providerID: "ccproto" },
      )
    }

    return () => registration.dispose()
  },
}

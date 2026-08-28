// PROTOTYPE — 一次性验证代码，不是产品。
// 问题：opencode2 beta (0.0.0-beta-18414) 能否通过 providers.<id>.package = "aisdk:file://<本文件>"
//       加载本包、调用 createCommandCode() 工厂、并消费其返回的 LanguageModelV3？
// 契约依据（opencode2 二进制取证 + @ai-sdk/provider@3.0.8 类型）：
//   - 加载器 = 内置 dynamic-provider 插件：file:// 直接 import，取第一个 create* 导出，以 options 调用
//   - 随后默认调用 sdk.languageModel(modelID) 取得 LanguageModelV3
//   - V3 必需：specificationVersion 'v3' / provider / modelId / supportedUrls / doGenerate / doStream
import { appendFileSync } from "node:fs"

const LOG = process.env.CCPROTO_LOG ?? "/tmp/opencode/cc-proto/cc-proto-factory.log"

function log(event, data) {
  try {
    appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), event, ...data }) + "\n")
  } catch {}
}

function userText(prompt) {
  for (const msg of prompt ?? []) {
    if (msg.role !== "user") continue
    for (const part of msg.content ?? []) {
      if (part.type === "text") return part.text
    }
  }
  return "(no user text)"
}

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

function makeFakeModel(options, modelId) {
  const reply = () => `ECHO[${modelId}]: ${options?.tag ?? "notag"} — factory alive`
  return {
    specificationVersion: "v3",
    provider: options?.name ?? "ccproto",
    modelId,
    supportedUrls: {},
    async doStream(callOptions) {
      log("doStream", { modelId, prompt: userText(callOptions?.prompt), settings: callOptions?.settings })
      const text = reply()
      const parts = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: text },
        { type: "text-end", id: "t0" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
      ]
      let i = 0
      const stream = new ReadableStream({
        pull(controller) {
          if (i < parts.length) controller.enqueue(parts[i++])
          else controller.close()
        },
      })
      return { stream }
    },
    async doGenerate(callOptions) {
      log("doGenerate", { modelId, prompt: userText(callOptions?.prompt) })
      return {
        content: [{ type: "text", text: reply() }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
      }
    },
  }
}

// 工厂：接收 provider options（含 name=providerID、settings 合并结果、包装过的 fetch），
// 返回带 languageModel(modelID) 的 provider 实例 —— 与 @ai-sdk/openai-compatible 等官方包同构。
export function createCommandCode(options = {}) {
  log("factory", {
    optionKeys: Object.keys(options),
    name: options?.name,
    baseURL: options?.baseURL,
    hasFetch: typeof options?.fetch === "function",
  })
  return {
    languageModel(modelId) {
      log("languageModel", { modelId })
      return makeFakeModel(options, modelId)
    },
  }
}

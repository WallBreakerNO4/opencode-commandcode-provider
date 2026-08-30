// PROTOTYPE — wayfinder #12（v2 自举链路实测）一次性代码，不是产品。
// 验证点：
//   S1. 插件 catalog.transform 设 p.package = "aisdk:<自身包名>"：npm.add → import 能否命中
//       已装插件包（不重装、无双实例），全链路 transform → 目录 → 工厂 → 流式回复
//   S2. ctx.integration.transform 能否为自定义 provider 注册 key/env 认证方法；
//       /connect（TUI）与 /api/integration/{id}/connect/key 写入的凭证能否经工厂 apiKey 到达
// 双实例检测：Symbol.for 全局注册表跨模块实例可见；若 aisdk 链把同包重装到另一路径再
// import，计数会 > 1，且 import.meta.url 会暴露第二份文件位置。
import { appendFileSync } from "node:fs"

const LOG = process.env.CCSELF_LOG ?? "/tmp/opencode/cc-self-proto/log.jsonl"
const PKG_NAME = "aisdk:@wallbreakerno4/cc-self-proto"

function log(event, data) {
  try {
    appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), event, ...data }) + "\n")
  } catch {}
}

const SEQ_KEY = Symbol.for("cc-self-proto.instance-seq")
globalThis[SEQ_KEY] = (globalThis[SEQ_KEY] ?? 0) + 1
const SEQ = globalThis[SEQ_KEY]
log("instance-load", { seq: SEQ, url: import.meta.url })

// ---- LanguageModelV3 假流（形状照 #5 契约：finishReason/usage 嵌套） ----
function makeFakeModel(modelID) {
  const text = `CCSELF-ECHO[${modelID}]: alive (instance ${SEQ})`
  const parts = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: text },
    { type: "text-end", id: "t0" },
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
    specificationVersion: "v3",
    provider: "ccself",
    modelId: modelID,
    supportedUrls: {},
    async doStream() {
      log("doStream", { seq: SEQ, modelID })
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
      log("doGenerate", { seq: SEQ, modelID })
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      }
    },
  }
}

// ---- aisdk 工厂：模块第一个 create* 导出（照 #5 契约） ----
export function createCommandCode(options = {}) {
  // 留痕工厂入参：apiKey 是本票 S2 的关键观测点（凭证流的终点）
  log("factory-call", {
    seq: SEQ,
    name: options.name,
    apiKey: options.apiKey,
    apiKeyType: typeof options.apiKey,
    optionKeys: Object.keys(options),
    hasFetch: typeof options.fetch === "function",
    headerKeys: Object.keys(options.headers ?? {}),
  })
  return {
    languageModel(modelID) {
      return makeFakeModel(modelID)
    },
  }
}

// ---- v2 插件入口：default 导出 {id, setup} ----
export default {
  id: "cc-self-proto",
  async setup(ctx) {
    log("plugin-setup", {
      seq: SEQ,
      url: import.meta.url,
      hasIntegration: typeof ctx.integration === "object",
      hasCatalog: typeof ctx.catalog === "object",
    })

    // S1：provider.package 指向自身（未发布包 → registry 404，若命中已装则直接 import）
    // 变体开关：一次注册 4 个 provider ID，二分定位「transform 注册后目录不可见」的字段原因
    const VARIANTS = {
      // ★ 自举 file:// 形态：package 指向插件自身文件（import.meta.url）→ 命中同一模块实例
      ccv0: (p) => {
        p.name = "V0 self-file-url"
        p.package = "aisdk:" + import.meta.url
        p.integrationID = "ccself"
        p.activation = "auto"
      },
      // 去 integrationID（branded 字段嫌疑）
      ccva: (p) => {
        p.name = "VA no-integrationID"
        p.package = PKG_NAME
        p.activation = "auto"
      },
      // 再去 default.set（在 VB 的 setup 分支控制）
      ccvb: (p) => {
        p.name = "VB no-default"
        p.package = PKG_NAME
        p.activation = "auto"
      },
      // #5 最小字段集（18414 已验证）
      ccvc: (p) => {
        p.name = "VC minimal"
        p.package = PKG_NAME
        p.activation = "auto"
      },
    }
    const MODEL_FIELDS = (m, label) => {
      m.name = label
      m.modelID = m.modelID || ""
      m.capabilities = { tools: true, input: ["text"], output: ["text"] }
      m.limit = { context: 200000, output: 32000 }
      m.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
      m.status = "active"
      m.enabled = true
      m.variants = []
      m.time = { released: 0 }
    }
    await ctx.catalog.transform((draft) => {
      for (const [id, fn] of Object.entries(VARIANTS)) {
        draft.provider.update(id, fn)
        draft.model.update(id, "fake-1", (m) => {
          MODEL_FIELDS(m, `Fake 1 (${id})`)
          m.modelID = "fake-1"
        })
      }
      draft.model.default.set("ccv0", "fake-1")
      // 探针 P1：config 空壳 provider（ccshell）+ transform 补 package/models
      draft.provider.update("ccshell", (p) => {
        p.name = "P1 shell + self-url"
        p.package = "aisdk:" + import.meta.url
        p.integrationID = "ccself"
        p.activation = "auto"
      })
      draft.model.update("ccshell", "fake-1", (m) => {
        MODEL_FIELDS(m, "Fake 1 (shell)")
        m.modelID = "fake-1"
      })
      // 探针 P2：给已有内置 provider（openai）transform 新增模型
      draft.model.update("openai", "fake-probe", (m) => {
        MODEL_FIELDS(m, "Fake probe (openai)")
        m.modelID = "fake-probe"
      })
      try {
        draft.model.default.set("ccv0", "fake-1")
        log("default.set", { ok: true })
      } catch (e) {
        log("default.set", { ok: false, error: String(e) })
      }
    })

    // S2：为不存在的 integration 注册 —— update 是否 upsert？method.update 依赖它吗？
    await ctx.integration.transform((draft) => {
      try {
        draft.update("ccself", (i) => {
          i.name = "Command Code (proto)"
        })
        log("integration.update", { ok: true })
      } catch (e) {
        log("integration.update", { ok: false, error: String(e) })
      }
      for (const [tag, input] of [
        ["key", { integrationID: "ccself", method: { type: "key", label: "Command Code API Key" } }],
        ["env", { integrationID: "ccself", method: { type: "env", names: ["CCSELF_ENV_KEY"] } }],
      ]) {
        try {
          draft.method.update(input)
          log("integration.method.update", { tag, ok: true })
        } catch (e) {
          log("integration.method.update", { tag, ok: false, error: String(e) })
        }
      }
    })

    // S2 自检：transform 之后立刻在插件进程内 list/get，判别「注册失败」vs「API 作用域问题」
    try {
      const listed = await ctx.integration.list()
      log("integration.list", {
        ids: (listed ?? []).map((x) => x.id),
        location: ctx.location?.directory,
      })
    } catch (e) {
      log("integration.list", { error: String(e) })
    }
    try {
      const got = ctx.integration.get ? undefined : undefined
      log("integration.get-probe", { note: "get is on draft only; skipped", hasGot: !!got })
    } catch {}

    return () => {}
  },
}

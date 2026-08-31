// PROTOTYPE 主入口：模拟未来 @wallbreakerno4/opencode-commandcode 的「单包三导出」形态
// - default {id, setup}      → v2 插件消费
// - createCommandCode 工厂   → v1 provider.<id>.npm 与 v2 aisdk: 前缀都取第一个 create* 导出
// - LegacyPlugin 命名导出函数 → 对照组：看 v1 legacy 加载器是否会把它和工厂一起误调
import { probe } from "./probe.js"
import { createFakeLanguageModel } from "./fake-model.js"

export default {
  id: "ccproto-proto",
  async setup(ctx) {
    probe("v2-style-setup-called", { ctxKeys: Object.keys(ctx ?? {}) })
    return () => {}
  },
  async server(input, options) {
    probe("v1-server-called", { inputKeys: Object.keys(input ?? {}) })
    return {
      "config": async (config) => {
        probe("v1-config-hook", { hadCcproto: !!config.provider?.ccproto })
        config.provider ??= {}
        config.provider.ccproto = {
          // fallback 指向本包主入口（file:// 免安装直 import），不设 CCPROTO_NPM_SPEC 也能全链路跑
          npm: process.env.CCPROTO_NPM_SPEC ||
            "file:///home/wall/self-project/other/opencode-commandcode-provider/prototype/v1-proto/pkg/index.js",
          name: "CCProto",
          env: ["CCPROTO_TEST_KEY"],
          options: {},
          models: {
            "fake-1": {
              id: "fake-1",
              name: "Fake One",
              tool_call: true,
              reasoning: false,
              attachment: false,
              temperature: true,
              limit: { context: 128000, output: 8192 },
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
              modalities: { input: ["text"], output: ["text"] },
            },
          },
        }
        probe("v1-config-injected", { npm: config.provider.ccproto.npm })
      },
      "auth": {
        provider: "ccproto",
        loader: async (auth, provider) => {
          const resolved = typeof auth === "function" ? await auth() : auth
          probe("v1-auth-loader", { resolvedAuthType: resolved?.type, providerId: provider?.id })
          return { apiKey: resolved?.key ?? "from-auth-loader-sentinel" }
        },
        methods: [
          { type: "api", label: "Command Code (proto)" },
        ],
      },
    }
  },
}

export const LegacyPlugin = async (input) => {
  probe("legacy-named-plugin-called", { inputKeys: Object.keys(input ?? {}) })
  return {}
}

export function createCommandCode(options) {
  probe("factory-called", {
    optionKeys: Object.keys(options ?? {}),
    name: options?.name,
    apiKeyShape: options?.apiKey === undefined ? undefined : `string(len=${String(options.apiKey).length})`,
    headerKeys: options?.headers ? Object.keys(options.headers) : undefined,
    bodyKeys: options?.body ? Object.keys(options.body) : undefined,
    hasFetch: typeof options?.fetch,
    baseURL: options?.baseURL,
  })
  return {
    languageModel(modelId) {
      probe("languageModel-called", { modelId })
      return createFakeLanguageModel(modelId)
    },
  }
}

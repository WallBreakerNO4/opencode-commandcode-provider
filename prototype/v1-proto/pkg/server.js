// PROTOTYPE ./server 子路径：v1 插件 glue 的「共存正解」形态
// 只有命名导出函数（v1 legacy 加载器全枚举、每个都得是函数），绝无 default 导出对象。
// config hook 注入 provider.<id>.npm（自举：指向本包），auth hook 注册 /connect 登录方式。
import { probe } from "./probe.js"

export const V1GluePlugin = async (input) => {
  probe("v1-glue-called", { inputKeys: Object.keys(input ?? {}) })

  return {
    "config": async (config) => {
      probe("v1-config-hook", {
        hadCcproto: !!config.provider?.ccproto,
        pluginList: config.plugin,
        npmSpec: process.env.CCPROTO_NPM_SPEC,
      })
      config.provider ??= {}
      config.provider.ccproto = {
        npm: process.env.CCPROTO_NPM_SPEC || "file:///dev/null",
        name: "CCProto",
        env: ["CCPROTO_TEST_KEY"],
        options: {
          // 故意不写 apiKey：让 auth.loader 的哨兵值说话（loader→工厂 options 管道验证）
          ...(process.env.CCPROTO_CONFIG_API_KEY
            ? { apiKey: process.env.CCPROTO_CONFIG_API_KEY }
            : {}),
        },
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
        // auth 参数是 () => Promise<Auth>（懒加载函数）
        const resolved = typeof auth === "function" ? await auth() : auth
        probe("v1-auth-loader", { resolvedAuthType: resolved?.type, providerId: provider?.id })
        // 哨兵：若管道通畅，工厂 options.apiKey 应收到它
        return { apiKey: resolved?.key ?? "from-auth-loader-sentinel" }
      },
      methods: [
        { type: "api", label: "Command Code (proto)" },
      ],
    },
  }
}

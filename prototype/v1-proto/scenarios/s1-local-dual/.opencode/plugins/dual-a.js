// PROTOTYPE dual-a（v2）：default {id, setup, server} 三合一双宿主形态
// 假设：v1 新式加载器读 server()（不炸），内嵌 v2 运行时读 setup()，互不干扰
import { appendFileSync } from "node:fs"

const LOG = process.env.CCPROTO_LOG
const probe = (event, data = {}) => {
  const line = JSON.stringify({ t: Date.now(), pid: process.pid, file: "dual-a", event, ...data })
  if (LOG) try { appendFileSync(LOG, line + "\n") } catch {}
  console.error("[ccproto-probe] " + line)
}

export default {
  id: "dual-a-hybrid",
  async setup(ctx) {
    probe("v2-setup-called", {
      ctxKeys: Object.keys(ctx ?? {}),
      hasCatalogTransform: typeof ctx?.catalog?.transform === "function",
      hasAisdkHook: typeof ctx?.aisdk?.hook === "function",
    })
    return () => {}
  },
  async server(input, options) {
    probe("v1-server-called", { inputKeys: Object.keys(input ?? {}) })
    return {
      config: async (config) => {
        probe("v1-server-config-hook", { hadCcproto: !!config.provider?.ccproto })
      },
    }
  },
}

export const DualAPlugin = async (input) => {
  probe("legacy-named-plugin-called", {})
  return {}
}

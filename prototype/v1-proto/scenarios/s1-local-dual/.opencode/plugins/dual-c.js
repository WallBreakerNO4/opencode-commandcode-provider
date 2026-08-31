// PROTOTYPE dual-c：纯命名函数导出（无 default）—— v1 正解形态
// 预期：命名插件被调用 ✓；同时 createCommandCode（create* 前缀函数导出）也被 legacy 全枚举误当插件调用！
import { appendFileSync } from "node:fs"

const LOG = process.env.CCPROTO_LOG
const probe = (event, data = {}) => {
  const line = JSON.stringify({ t: Date.now(), pid: process.pid, file: "dual-c", event, ...data })
  if (LOG) try { appendFileSync(LOG, line + "\n") } catch {}
  console.error("[ccproto-probe] " + line)
}

export const DualCPlugin = async (input) => {
  probe("legacy-named-plugin-called", { inputKeys: Object.keys(input ?? {}) })
  return {}
}

export function createCommandCode(input) {
  probe("factory-called-from-plugin-loader", {
    inputKeys: Object.keys(input ?? {}),
    looksLikePluginInput: !!(input && "client" in input && "project" in input),
  })
  return { languageModel: () => ({}) }
}

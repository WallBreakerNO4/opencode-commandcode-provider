// PROTOTYPE dual-b：default 对象但不带 id/server/tui + 命名函数导出
// 预期（源码推演）：detect 不认定 → 走 legacy 全枚举 → default 非函数 → TypeError "Plugin export is not a function"
import { appendFileSync } from "node:fs"

const LOG = process.env.CCPROTO_LOG
const probe = (event, data = {}) => {
  const line = JSON.stringify({ t: Date.now(), pid: process.pid, file: "dual-b", event, ...data })
  if (LOG) try { appendFileSync(LOG, line + "\n") } catch {}
  console.error("[ccproto-probe] " + line)
}

export default {
  async setup() {
    probe("v2-style-setup-called", {})
    return () => {}
  },
}

export const DualBPlugin = async (input) => {
  probe("legacy-named-plugin-called", { inputKeys: Object.keys(input ?? {}) })
  return {}
}

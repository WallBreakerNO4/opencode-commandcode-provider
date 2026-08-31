// PROTOTYPE 探针：留痕到 CCPROTO_LOG（JSON 行）+ stderr，一次性代码，不做错误处理
import { appendFileSync } from "node:fs"

const LOG = process.env.CCPROTO_LOG

export function probe(event, data = {}) {
  const line = JSON.stringify({ t: Date.now(), pid: process.pid, event, ...data })
  if (LOG) {
    try {
      appendFileSync(LOG, line + "\n")
    } catch {}
  }
  console.error("[ccproto-probe] " + line)
}

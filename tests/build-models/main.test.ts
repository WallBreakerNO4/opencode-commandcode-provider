import { describe, expect, test } from "bun:test"
import { readPrevDistribution, runBuild } from "../../scripts/build-models/main.ts"
import { ReconcileError } from "../../scripts/build-models/reconcile.ts"
import { extractTarballText } from "../../scripts/build-models/tarball.ts"

// —— 构造一份与真实包同形态的 tgz（单测全注入化，testing.md §0：无网络依赖）——

const CATALOG = [
  "var NR=\"anthropic\",FR=\"vercel-ai-gateway\";var QR=\"chatComplete\";",
  "var CATALOG={",
  "SONNET_5:{id:\"claude-sonnet-5\",inputModalities:[\"text\",\"image\"],provider:NR,spec:QR,label:\"Claude Sonnet 5\",name:\"Claude Sonnet 5\",reasoning:!0,reasoningEfforts:[\"high\",\"max\"],contextWindow:1e6,maxOutputTokens:64000},",
  "GLM_5_1:{id:\"zai-org/GLM-5.1\",inputModalities:[\"text\"],provider:FR,spec:QR,label:\"GLM-5.1\",name:\"GLM-5.1\",reasoning:!1},",
  "GLM_5:{id:\"zai-org/GLM-5\",inputModalities:[\"text\"],provider:FR,spec:QR,label:\"GLM-5\",name:\"GLM-5\",reasoning:!1,contextWindow:200000},",
  "OPUS_MAX:{id:\"claude-opus-5\",inputModalities:[\"text\"],provider:NR,spec:QR,label:\"Claude Opus 5\",name:\"Claude Opus 5\",reasoning:!0,reasoningEfforts:[\"max\"],contextWindow:200000,maxOutputTokens:32000},",
  "HIDDEN_FREE:{id:\"MiniMaxAI/MiniMax-M3-Free\",inputModalities:[\"text\"],provider:FR,spec:QR,label:\"M3 Free\",name:\"M3 Free\",reasoning:!1,get hidden(){return !0}},",
  // filler：凑过目录形状校验下限（真实目录 65+ 条，校验防坏截取）
  ...Array.from({ length: 20 }, (_, i) =>
    `FILLER_${i}:{id:"vendor/filler-model-${i}",inputModalities:["text"],provider:FR,spec:QR,label:"F${i}",name:"F${i}",reasoning:!1,contextWindow:1000},`,
  ),
  "};",
].join("")

const MODELS_MD = [
  "| Id | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
  "|---|---|---|---|---|---|---|",
  "| `claude-sonnet-5` | Claude Sonnet 5 | 1M | high, max | $1/$5 | Go and above | coding |",
  "| `zai-org/GLM-5.1` | GLM-5.1 | — | — | $1/$3 | Go and above | agent |",
  "| `claude-opus-5` | Claude Opus 5 | 200K | max | $5/$25 | Max | hard |",
].join("\n")

function tarBlock(name: string, content: string): Uint8Array {
  const data = new TextEncoder().encode(content)
  const block = new Uint8Array(512 + data.length + ((512 - (data.length % 512)) % 512))
  block.set(new TextEncoder().encode(name), 0)
  block.set(new TextEncoder().encode(data.length.toString(8).padStart(11, "0")), 124)
  block.set(data, 512)
  return block
}

const TGZ = Bun.gzipSync(
  new Uint8Array([
    ...tarBlock("package/dist/cli.mjs", CATALOG),
    ...tarBlock("package/dist/bundled/command-code-knowledge/reference/models.md", MODELS_MD),
    ...new Uint8Array(1024),
  ]),
)

// —— 注入化 fetch：三个上游（registry /models API / models.dev）——

const API_IDS = ["claude-sonnet-5", "zai-org/GLM-5.1", "claude-opus-5", "deepseek/deepseek-v4-pro"]

const FETCH: typeof globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
  const url = String(input)
  if (url.includes("registry.npmjs.org/command-code/latest")) {
    return Response.json({ version: "1.45.0", dist: { tarball: "https://registry.npmjs.org/command-code/-/command-code-1.45.0.tgz" } })
  }
  if (url.endsWith("command-code-1.45.0.tgz")) {
    return new Response(new Uint8Array(TGZ), { status: 200 })
  }
  if (url.includes("api.commandcode.ai")) {
    return Response.json({ object: "list", data: API_IDS.map((id) => ({ id, object: "model", created: 1, owned_by: "command-code", name: id, context_length: 1000000 })) })
  }
  if (url.includes("models.dev")) {
    return Response.json({
      zai: { models: { "GLM-5.1": { limit: { context: 204800, output: 65536 } } } },
    })
  }
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof globalThis.fetch

describe("main.ts 编排（输入注入化全链）", () => {
  test("全链构建：断言全过 → 产物 + build-meta；provenance 逐值进日志；隐藏 free 条目被 API 对账挡在产物外", async () => {
    const lines: string[] = []
    const { modelsJson, meta } = await runBuild({ outDir: "/tmp/unused" }, (line) => lines.push(line), FETCH)
    const artifact = JSON.parse(modelsJson) as { schemaVersion: number; sourceCliVersion: string; models: Array<{ id: string }> }

    expect(artifact.schemaVersion).toBe(1)
    expect(artifact.sourceCliVersion).toBe("1.45.0")
    expect(artifact.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "zai-org/GLM-5.1"])
    expect(meta.planDistribution).toEqual({ Go: 2, GOAT: 0, Pro: 0, Max: 1 })
    expect(meta.modelsCount).toBe(2)
    expect(meta.modelsDevSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(meta.modelsJsonSha256).toMatch(/^[0-9a-f]{64}$/)

    // 每个模型两个 limits 值的 provenance 都在日志里
    const limitLines = lines.filter((line) => line.startsWith("[limits] ") && !line.includes("汇总") && !line.includes("家族"))
    expect(limitLines).toHaveLength(4)
    expect(lines.some((line) => line.includes("claude-sonnet-5 · context = 1000000 ← bundle"))).toBe(true)
    expect(lines.some((line) => line.includes("zai-org/GLM-5.1 · maxOutput = 65536 ← models-dev（zai/GLM-5.1）"))).toBe(true)
  })

  test("--cli-version 入参固定版本（workflow 防 TOCTOU）", async () => {
    const { meta } = await runBuild({ outDir: "/tmp/unused", cliVersion: "1.45.0" }, () => {}, FETCH)
    expect(meta.sourceCliVersion).toBe("1.45.0")
  })

  test("断言失败：产物 id ⊄ API → ReconcileError，无产物返回", async () => {
    // 让 models.md 出现 API 之外且标注 Go 的 id（隐藏 free 条目混进表格的坏场景）
    const badMd = MODELS_MD.replace(
      "| `claude-opus-5` | Claude Opus 5 | 200K | max | $5/$25 | Max | hard |",
      "| `MiniMaxAI/MiniMax-M3-Free` | M3 Free | — | — | $0 | Go and above | free |",
    )
    const badTgz = Bun.gzipSync(
      new Uint8Array([
        ...tarBlock("package/dist/cli.mjs", CATALOG),
        ...tarBlock("package/dist/bundled/command-code-knowledge/reference/models.md", badMd),
        ...new Uint8Array(1024),
      ]),
    )
    const patched = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input)
      if (url.endsWith("command-code-1.45.0.tgz")) return new Response(new Uint8Array(badTgz), { status: 200 })
      return FETCH(input)
    }) as typeof globalThis.fetch

    expect(runBuild({ outDir: "/tmp/unused", cliVersion: "1.45.0" }, () => {}, patched)).rejects.toThrow(ReconcileError)
  })
  test("分布断言失败：注入伪造的上次分布（验收演练路径，与 workflow drill 同缝）", async () => {
    const prevMetaPath = `/tmp/opencode/cc-build-test-drill-${process.pid}.json`
    // 全零分布 vs fixture 当前 {Go:2,…}：Go 档漂移须超阈值（±5）才触发断言
    await Bun.write(
      prevMetaPath,
      JSON.stringify({ planDistribution: { Go: 100, GOAT: 0, Pro: 0, Max: 0 } }),
    )
    expect(
      runBuild({ outDir: "/tmp/unused", cliVersion: "1.45.0", prevMetaPath }, () => {}, FETCH),
    ).rejects.toThrow(/分布监控/)
    await Bun.write(prevMetaPath, "")
  })

  test("readPrevDistribution：形状不对即报错（drill / data 分支基准共用此入口）", () => {
    expect(readPrevDistribution(JSON.stringify({ planDistribution: { Go: 40, GOAT: 4, Pro: 13, Max: 5 } }))).toEqual({
      Go: 40,
      GOAT: 4,
      Pro: 13,
      Max: 5,
    })
    expect(() => readPrevDistribution("{}")).toThrow(/planDistribution/)
    expect(() => readPrevDistribution(JSON.stringify({ planDistribution: { Go: "40" } }))).toThrow(/不是数字/)
  })
})

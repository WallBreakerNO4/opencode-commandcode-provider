import { describe, expect, test } from "bun:test"
import { readPrevGoModelCount, runBuild } from "../../scripts/build-models/main.ts"
import { ReconcileError } from "../../scripts/build-models/reconcile.ts"

// —— 构造一份与真实包同形态的 tgz（单测全注入化，testing.md §0：无网络依赖）——

const EMBEDDED_CATALOG = [
  'var CATALOG={catalogVersion:"d6177bab",data:[',
  '{id:"claude-sonnet-5",name:"Claude Sonnet 5",inputModalities:["text","image"],reasoningEfforts:["high","max"],context_length:1e6,minimumPlan:"individual-go",hidden:!1},',
  '{id:"deepseek/deepseek-v4-pro",name:"DeepSeek V4 Pro",inputModalities:["text"],reasoningEfforts:["high","max"],context_length:1e6,minimumPlan:"individual-go",hidden:!1},',
  // 远程 catalog 未同步、内嵌目录已收录的 Go 档模型：补集必须进产物
  '{id:"stealth/cat-jam:free",name:"Cat Jam",inputModalities:["text"],context_length:2e5,minimumPlan:"individual-go",hidden:!1,badge:"free"},',
  // Go 档但 hidden：不进产物
  '{id:"stealth/hidden-jam:free",name:"Hidden Jam",inputModalities:["text"],context_length:2e5,minimumPlan:"individual-go",hidden:!0},',
  // 非 Go 档：不进产物
  '{id:"claude-opus-5",name:"Claude Opus 5",inputModalities:["text"],context_length:2e5,minimumPlan:"individual-max",hidden:!1},',
  // filler：凑过目录形状校验下限（真实目录 100+ 条，校验防坏截取）
  ...Array.from({ length: 20 }, (_, i) =>
    `{id:"vendor/filler-${i}",name:"F${i}",inputModalities:["text"],minimumPlan:"individual-max"},`,
  ),
  "],schemaVersion:1};",
].join("")

const CLIENT_CATALOG = {
  schemaVersion: 1,
  catalogVersion: "d6177bab",
  refreshAfterSeconds: 900,
  data: [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      display: { label: "Claude Sonnet 5" },
      context_length: 1000000,
      minimumPlan: "individual-go",
      hidden: false,
      reasoningEfforts: ["high", "max"],
      inputModalities: ["text", "image"],
      maxOutputTokens: null,
    },
    {
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      context_length: 1000000,
      minimumPlan: "individual-go",
      hidden: false,
      reasoningEfforts: ["high", "max"],
      inputModalities: ["text"],
      maxOutputTokens: 64000,
    },
    {
      // 官方已上线但内嵌目录 / models.md 未及时更新的新模型
      id: "minimax/minimax-m3.1-flash",
      name: "MiniMax M3.1 Flash",
      context_length: 200000,
      minimumPlan: "individual-go",
      hidden: false,
      reasoningEfforts: null,
      inputModalities: ["text"],
    },
    {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      context_length: 200000,
      minimumPlan: "individual-max",
      hidden: false,
      inputModalities: ["text"],
    },
    {
      id: "stealth/remote-hidden",
      name: "Remote Hidden",
      context_length: 200000,
      minimumPlan: "individual-go",
      hidden: true,
      inputModalities: ["text"],
    },
  ],
}

function tarBlock(name: string, content: string): Uint8Array {
  const data = new TextEncoder().encode(content)
  const block = new Uint8Array(512 + data.length + ((512 - (data.length % 512)) % 512))
  block.set(new TextEncoder().encode(name), 0)
  block.set(new TextEncoder().encode(data.length.toString(8).padStart(11, "0")), 124)
  block.set(data, 512)
  return block
}

function tgzWithCatalog(catalog: string): Uint8Array<ArrayBuffer> {
  return Bun.gzipSync(
    new Uint8Array([...tarBlock("package/dist/cli.mjs", catalog), ...new Uint8Array(1024)]),
  )
}

const TGZ = tgzWithCatalog(EMBEDDED_CATALOG)

// 破坏全部锚点：内嵌目录解析必然失败，走软兜底
const BROKEN_TGZ = tgzWithCatalog(
  EMBEDDED_CATALOG.replaceAll("claude-sonnet-5", "claude-x")
    .replaceAll("claude-sonnet-4-6", "claude-y")
    .replaceAll("deepseek/deepseek-v4-pro", "gone"),
)

// —— 注入化 fetch：registry / tarball / view=client / models.dev ——

const FETCH: typeof globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
  const url = String(input)
  if (url.includes("registry.npmjs.org/command-code/latest")) {
    return Response.json({ version: "1.84.0", dist: { tarball: "https://registry.npmjs.org/command-code/-/command-code-1.84.0.tgz" } })
  }
  if (url.endsWith("command-code-1.84.0.tgz")) {
    return new Response(new Uint8Array(TGZ), { status: 200 })
  }
  if (url.includes("provider/v1/models?view=client")) {
    return Response.json(CLIENT_CATALOG)
  }
  if (url.includes("api.commandcode.ai")) {
    throw new Error(`退役端点不应被调用：${url}`)
  }
  if (url.includes("models.dev")) {
    return Response.json({
      minimax: { models: { "minimax-m3.1-flash": { limit: { context: 256000, output: 65536 } } } },
    })
  }
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof globalThis.fetch

function withCatalog(data: unknown): typeof globalThis.fetch {
  return ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input)
    if (url.includes("provider/v1/models?view=client")) return Response.json({ ...CLIENT_CATALOG, data })
    return FETCH(input)
  }) as typeof globalThis.fetch
}

describe("main.ts 编排（view=client 直出 ∪ 内嵌目录补集）", () => {
  test("全链构建：远程 Go 条目 + 内嵌补集 cat-jam:free；hidden 与非 Go 档被挡在产物外", async () => {
    const lines: string[] = []
    const { modelsJson, meta } = await runBuild({ outDir: "/tmp/unused" }, (line) => lines.push(line), FETCH)
    const artifact = JSON.parse(modelsJson) as {
      schemaVersion: number
      sourceCliVersion: string
      catalogVersion?: string
      models: Array<{ id: string; name: string; reasoning: boolean; efforts?: string[] }>
    }

    expect(artifact.schemaVersion).toBe(1)
    expect(artifact.sourceCliVersion).toBe("1.84.0")
    expect(artifact.catalogVersion).toBe("d6177bab")
    expect(artifact.models.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "deepseek/deepseek-v4-pro",
      "minimax/minimax-m3.1-flash",
      "stealth/cat-jam:free",
    ])
    // cat-jam:free 永久回归：内嵌目录有、远程 catalog 无 → 仍进产物，且 hidden 不顶替
    expect(artifact.models.some((model) => model.id === "stealth/hidden-jam:free")).toBe(false)
    expect(artifact.models.some((model) => model.id === "stealth/remote-hidden")).toBe(false)
    expect(artifact.models.find((model) => model.id === "stealth/cat-jam:free")).toMatchObject({
      name: "Cat Jam",
      reasoning: false,
    })
    expect(artifact.models.find((model) => model.id === "deepseek/deepseek-v4-pro")?.efforts).toEqual(["high", "max"])

    expect(meta.sourceCliVersion).toBe("1.84.0")
    expect(meta.catalogVersion).toBe("d6177bab")
    expect(meta.goModelCount).toBe(4)
    expect(meta.modelsCount).toBe(4)
    expect(meta.modelsDevSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(meta.modelsJsonSha256).toMatch(/^[0-9a-f]{64}$/)

    expect(lines.some((line) => line.includes("[input] view=client catalogVersion=d6177bab"))).toBe(true)
    expect(lines.some((line) => line.includes("[bundle] 内嵌目录 25 条"))).toBe(true)
    // limits provenance 逐值可审计
    expect(lines.some((line) => line.includes("deepseek/deepseek-v4-pro · maxOutput = 64000 ← bundle"))).toBe(true)
    expect(lines.some((line) => line.includes("minimax/minimax-m3.1-flash · maxOutput = 65536 ← models-dev（minimax/minimax-m3.1-flash）"))).toBe(true)
    expect(lines.some((line) => line.includes("stealth/cat-jam:free · maxOutput = 32000 ← constant"))).toBe(true)
    // models.md 已从构建链退役
    expect(lines.some((line) => line.includes("models.md"))).toBe(false)
  })

  test("--cli-version 入参固定版本（workflow 防 TOCTOU）", async () => {
    const { meta } = await runBuild({ outDir: "/tmp/unused", cliVersion: "1.84.0" }, () => {}, FETCH)
    expect(meta.sourceCliVersion).toBe("1.84.0")
  })

  test("值域断言：minimumPlan 出现词表外新值 → 失败并聚合明细", async () => {
    const fetchImpl = withCatalog([
      ...CLIENT_CATALOG.data,
      {
        id: "future/ultra-model",
        name: "Ultra Model",
        context_length: 200000,
        minimumPlan: "individual-ultra",
        inputModalities: ["text"],
      },
    ])
    try {
      await runBuild({ outDir: "/tmp/unused", cliVersion: "1.84.0" }, () => {}, fetchImpl)
      throw new Error("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(ReconcileError)
      const reconcile = error as ReconcileError
      expect(reconcile.message).toContain("Min plan 值域")
      expect(reconcile.message).toContain("individual-ultra")
    }
  })

  test("Go 计数漂移：相对上次成功构建超 ±5 → 失败", async () => {
    const prevMetaPath = `/tmp/opencode/cc-build-test-drill-${process.pid}.json`
    await Bun.write(prevMetaPath, JSON.stringify({ goModelCount: 100 }))
    expect(
      runBuild({ outDir: "/tmp/unused", cliVersion: "1.84.0", prevMetaPath }, () => {}, FETCH),
    ).rejects.toThrow(/Go 模型计数监控/)
    await Bun.write(prevMetaPath, "")
  })

  test("内嵌目录解析失败：构建成功，产物退化为纯 view=client 集合 + 告警日志", async () => {
    const lines: string[] = []
    const patched = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input)
      if (url.endsWith("command-code-1.84.0.tgz")) return new Response(new Uint8Array(BROKEN_TGZ), { status: 200 })
      return FETCH(input)
    }) as typeof globalThis.fetch

    const { modelsJson, meta } = await runBuild({ outDir: "/tmp/unused", cliVersion: "1.84.0" }, (line) => lines.push(line), patched)
    const artifact = JSON.parse(modelsJson) as { catalogVersion?: string; models: Array<{ id: string }> }
    expect(artifact.models.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "deepseek/deepseek-v4-pro",
      "minimax/minimax-m3.1-flash",
    ])
    expect(artifact.catalogVersion).toBe("d6177bab")
    expect(meta.goModelCount).toBe(3)
    expect(lines.some((line) => line.includes("[warn]") && line.includes("产物退化为纯 view=client 集合"))).toBe(true)
  })

  test("tarball 下载失败：同样软兜底，不阻塞发布", async () => {
    const lines: string[] = []
    const patched = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input)
      if (url.endsWith("command-code-1.84.0.tgz")) return new Response("boom", { status: 500 })
      return FETCH(input)
    }) as typeof globalThis.fetch

    const { meta } = await runBuild({ outDir: "/tmp/unused", cliVersion: "1.84.0" }, (line) => lines.push(line), patched)
    expect(meta.goModelCount).toBe(3)
    expect(lines.some((line) => line.includes("[warn]") && line.includes("产物退化为纯 view=client 集合"))).toBe(true)
  })

  test("readPrevGoModelCount：新字段优先，兼容旧 planDistribution.Go；坏形状报错", () => {
    expect(readPrevGoModelCount(JSON.stringify({ goModelCount: 59 }))).toBe(59)
    // 旧 data 分支基准 / 旧 drill 输入：迁移首轮仍按 Go 计数比较
    expect(readPrevGoModelCount(JSON.stringify({ planDistribution: { Go: 54, GOAT: 10, Pro: 15, Max: 10 } }))).toBe(54)
    expect(readPrevGoModelCount(JSON.stringify({ planDistribution: { Go: 54 }, goModelCount: 59 }))).toBe(59)
    expect(() => readPrevGoModelCount("{}")).toThrow(/goModelCount/)
    expect(() => readPrevGoModelCount(JSON.stringify({ goModelCount: "59" }))).toThrow(/不是数字/)
    expect(() => readPrevGoModelCount(JSON.stringify({ planDistribution: { Go: "54" } }))).toThrow(/不是数字/)
  })
})

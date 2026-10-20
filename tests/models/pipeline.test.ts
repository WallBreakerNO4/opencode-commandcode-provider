import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import type { Artifact } from "../../src/models/artifact.ts"
import { DEFAULT_CATALOG_REFRESH_SECONDS } from "../../src/models/catalog.ts"
import {
  ARTIFACT_REFRESH_TTL_MS,
  ARTIFACT_TTL_JITTER_MS,
  CLIENT_CATALOG_URL,
  REFRESH_RETRY_BASE_MS,
  REFRESH_RETRY_CAP_MS,
  V1_STARTUP_TIMEOUT_MS,
  createModelPipeline,
} from "../../src/models/pipeline.ts"
import type { CascadeResult } from "../../src/models/cascade.ts"
import { DEFAULT_MODELS_URLS } from "../../src/models/urls.ts"
import type { FetchLike } from "../../src/protocol/json.ts"
import { hangingResponse } from "../disguise/helpers.ts"

// 模型管线运行时（model-pipeline.md §4–§5）：v2 启动零阻塞（快照先行注册）、v1
// 启动 15s 总预算失败用快照且不做后台刷新、TTL 节奏（产物 1h+抖动、catalog 跟随
// refreshAfterSeconds）、变更签名只含 (id, context_length)、降级路径全 warn 注明
// 回落哪层、指数退避 30s→30min、产物 ETag / catalog If-None-Match 条件请求。
// 出网经 fetch 接缝注 mock；时间走 fake timers——TTL/退避比较全用 setSystemTime
// （Date.now 驱动），advance 仅用于触发 AbortSignal 到点（version-runtime 同款纪律）。

const BASE = Date.parse("2026-09-05T00:00:00.000Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const URL_A = "https://cdn.test-a.example/models.json"
const URL_B = "https://cdn.test-b.example/models.json"

const SNAPSHOT: Artifact = {
  schemaVersion: 1,
  generatedAt: "2026-08-01T00:00:00.000Z",
  sourceCliVersion: "1.40.0",
  models: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, inputModalities: ["text", "image"], efforts: ["high"], context: 200000, maxOutput: 32000 },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: false, inputModalities: ["text"], context: 128000, maxOutput: 32000 },
  ],
}

// artifact/only 是 catalog 未收录的产物条目（cat-jam 类情形）：必须照常注册
const ARTIFACT_A = {
  schemaVersion: 1,
  generatedAt: "2026-09-01T00:00:00.000Z",
  sourceCliVersion: "1.45.0",
  models: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5 (v45)", reasoning: true, inputModalities: ["text", "image"], efforts: ["high", "max"], context: 999000, maxOutput: 64000 },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: false, inputModalities: ["text"], context: 1000000, maxOutput: 32000 },
    { id: "artifact/only", name: "Artifact Only", reasoning: false, inputModalities: ["text"], context: 64000, maxOutput: 8000 },
  ],
}

interface CatalogModel {
  id: string
  context_length: number
  name?: string
}

function catalogBody(
  models: CatalogModel[],
  options: { catalogVersion?: string; refreshAfterSeconds?: number } = {},
): unknown {
  return {
    schemaVersion: 1,
    catalogVersion: options.catalogVersion ?? "catalog-v1",
    refreshAfterSeconds: options.refreshAfterSeconds ?? 900,
    roles: { default: { id: "coder" } },
    data: models.map((model) => ({
      id: model.id,
      name: model.name,
      context_length: model.context_length,
      minimumPlan: "individual-go",
      hidden: false,
    })),
  }
}

const CATALOG_A = catalogBody([
  { id: "claude-sonnet-5", context_length: 1_000_000, name: "Claude Sonnet 5" },
  { id: "deepseek-v4-flash", context_length: 1_000_000, name: "DeepSeek V4 Flash" },
])

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } })
}

interface RecordedRequest {
  url: string
  headers: Record<string, string>
}

interface Harness {
  pipeline: ReturnType<typeof createModelPipeline>
  requests: RecordedRequest[]
  warns: string[]
  debugs: string[]
  changes: CascadeResult[]
}

function makeHarness(routes: (url: string, init: RequestInit | undefined) => Response | Promise<Response>, extra: { modelsUrls?: unknown; snapshot?: Artifact } = {}): Harness {
  const requests: RecordedRequest[] = []
  const warns: string[] = []
  const debugs: string[] = []
  const changes: CascadeResult[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input)
    requests.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } })
    return routes(url, init)
  }
  const pipeline = createModelPipeline({
    snapshot: extra.snapshot ?? SNAPSHOT,
    modelsUrls: extra.modelsUrls ?? [URL_A, URL_B],
    fetch: fetchImpl,
    logger: { debug: (message) => debugs.push(message), warn: (message) => warns.push(message) },
    onChange: (cascade) => changes.push(cascade),
  })
  return { pipeline, requests, warns, debugs, changes }
}

const artifactFetches = (requests: RecordedRequest[]) => requests.filter((request) => request.url !== CLIENT_CATALOG_URL)
const catalogFetches = (requests: RecordedRequest[]) => requests.filter((request) => request.url === CLIENT_CATALOG_URL)

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(BASE)
  // 隔离卫生：bun test 会加载 .env，防开发机环境泄漏进 config/env 通道判定；
  // 非测试通道本身——urls.test.ts 以参数注入直测三通道（models-url-override.md §3.2）
  delete process.env["COMMANDCODE_MODELS_URLS"]
})

afterEach(() => {
  jest.useRealTimers()
})

describe("常量对齐 §4/§5", () => {
  test("产物 TTL 1h+抖动、catalog 默认 TTL 900s、退避 30s→30min、v1 预算 15s", () => {
    expect(ARTIFACT_REFRESH_TTL_MS).toBe(HOUR)
    expect(ARTIFACT_TTL_JITTER_MS).toBe(5 * MINUTE)
    expect(DEFAULT_CATALOG_REFRESH_SECONDS * 1000).toBe(15 * MINUTE)
    expect(REFRESH_RETRY_BASE_MS).toBe(30_000)
    expect(REFRESH_RETRY_CAP_MS).toBe(30 * MINUTE)
    expect(V1_STARTUP_TIMEOUT_MS).toBe(15_000)
  })
})

describe("v2 形态：启动零阻塞（快照先行注册）", () => {
  test("start() 不等任何拉取立即返回快照级联；首轮后台落定后 onChange 送达完整级联", async () => {
    let resolveArtifact!: (response: Response) => void
    let resolveCatalog!: (response: Response) => void
    const harness = makeHarness((url) => {
      if (url === CLIENT_CATALOG_URL) return new Promise<Response>((resolve) => (resolveCatalog = resolve))
      return new Promise<Response>((resolve) => (resolveArtifact = resolve))
    })

    // 拉取全部挂起：start() 仍同步返回，模型列表 = 快照全量（v2 首帧可用）
    const initial = harness.pipeline.start()
    expect(initial.productLayer).toBe("snapshot")
    expect(initial.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek-v4-flash"])
    expect(harness.changes).toEqual([])

    resolveArtifact(jsonResponse(ARTIFACT_A))
    resolveCatalog(jsonResponse(CATALOG_A))
    await harness.pipeline.refreshIfDue()
    expect(harness.changes).toHaveLength(1)
    expect(harness.changes[0]!.productLayer).toBe("artifact")
    // 产物全集：catalog 未收录的 artifact/only 也在列表中
    expect(harness.changes[0]!.models.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "deepseek-v4-flash",
      "artifact/only",
    ])
    expect(harness.changes[0]!.models[0]!.context).toBe(1_000_000) // context 听 catalog
  })

  test("首轮全部失败：不触发 onChange（快照已注册，无变化即无下游动作）", async () => {
    const harness = makeHarness(() => Promise.reject(new TypeError("fetch failed")))
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.changes).toEqual([])
    expect(harness.pipeline.getModels().productLayer).toBe("snapshot")
    expect(harness.warns.some((message) => message.includes("全部来源失败"))).toBe(true)
  })
})

describe("变更签名（§4：catalog 只按 (id, context_length) 判变化）", () => {
  test("catalog 仅 name / catalogVersion / refreshAfterSeconds 变化 → 不触发 onChange", async () => {
    let round = 0
    const harness = makeHarness((url) => {
      if (url !== CLIENT_CATALOG_URL) return jsonResponse(ARTIFACT_A)
      round += 1
      return jsonResponse(
        catalogBody(
          [
            { id: "claude-sonnet-5", context_length: 1_000_000, name: `Claude Sonnet 5 (rename ${round})` },
            { id: "deepseek-v4-flash", context_length: 1_000_000, name: "DeepSeek V4 Flash" },
          ],
          { catalogVersion: `catalog-v${round}`, refreshAfterSeconds: round === 1 ? 900 : 600 },
        ),
      )
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.changes).toHaveLength(1)

    // catalog TTL 900s 到点重拉：仅 name / 版本 / 节奏变化
    jest.setSystemTime(BASE + 16 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(2)
    expect(harness.changes).toHaveLength(1) // 签名未变——不 reload
    // 数据仍被采纳（字段级权威），只是不触发下游 reload
    expect(harness.pipeline.getModels().models[0]!.name).toBe("Claude Sonnet 5 (rename 2)")
  })

  test("catalog context_length 变化 → 触发 onChange", async () => {
    let contextLength = 1_000_000
    const harness = makeHarness((url) => {
      if (url !== CLIENT_CATALOG_URL) return jsonResponse(ARTIFACT_A)
      return jsonResponse(
        catalogBody([
          { id: "claude-sonnet-5", context_length: contextLength, name: "Claude Sonnet 5" },
          { id: "deepseek-v4-flash", context_length: 1_000_000, name: "DeepSeek V4 Flash" },
        ]),
      )
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.changes).toHaveLength(1)

    contextLength = 400_000
    jest.setSystemTime(BASE + 16 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(harness.changes).toHaveLength(2)
    expect(harness.changes[1]!.models[0]!.context).toBe(400_000)
  })

  test("产物重建但 models 内容相同（仅 generatedAt 变）→ 不触发 onChange；新增条目（catalog 无）→ 触发且注册", async () => {
    let body: unknown = ARTIFACT_A
    const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(body)))
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.changes).toHaveLength(1)

    body = { ...ARTIFACT_A, generatedAt: "2026-09-02T00:00:00.000Z" } // 仅生成时刻变
    jest.setSystemTime(BASE + 2 * HOUR)
    await harness.pipeline.refreshIfDue()
    expect(harness.changes).toHaveLength(1) // generatedAt 不在 hash 内

    body = {
      ...ARTIFACT_A,
      models: [
        ...ARTIFACT_A.models,
        { id: "new-model", name: "New", reasoning: false, inputModalities: ["text"], context: 8000, maxOutput: 4096 },
      ],
    }
    jest.setSystemTime(BASE + 4 * HOUR)
    await harness.pipeline.refreshIfDue()
    expect(harness.changes).toHaveLength(2)
    expect(harness.changes[1]!.models.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "deepseek-v4-flash",
      "artifact/only",
      "new-model",
    ])
  })
})

describe("刷新节奏（§4：产物 TTL 1h+抖动、catalog 跟随 refreshAfterSeconds）", () => {
  test("catalog 默认 900s：14min 不重拉、16min 重拉；产物 1h 内不重拉、2h 重拉", async () => {
    const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)))
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.requests).toHaveLength(2) // 首渠道胜 = 产物 1 次 + catalog 1 次

    jest.setSystemTime(BASE + 14 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(harness.requests).toHaveLength(2) // 双双未到期

    jest.setSystemTime(BASE + 16 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(2) // catalog 到期
    expect(artifactFetches(harness.requests)).toHaveLength(1) // 产物未到期

    jest.setSystemTime(BASE + 59 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(artifactFetches(harness.requests)).toHaveLength(1) // 1h+抖动下界之前绝不重拉

    jest.setSystemTime(BASE + 2 * HOUR)
    await harness.pipeline.refreshIfDue()
    expect(artifactFetches(harness.requests)).toHaveLength(2) // 2h > 1h+5min 抖动上界
  })

  test("catalog TTL 跟随响应 refreshAfterSeconds（60s）：30s 不重拉、61s 重拉", async () => {
    const harness = makeHarness((url) =>
      url === CLIENT_CATALOG_URL
        ? jsonResponse(
            catalogBody(
              [
                { id: "claude-sonnet-5", context_length: 1_000_000, name: "Claude Sonnet 5" },
                { id: "deepseek-v4-flash", context_length: 1_000_000, name: "DeepSeek V4 Flash" },
              ],
              { refreshAfterSeconds: 60 },
            ),
          )
        : jsonResponse(ARTIFACT_A),
    )
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(1)

    jest.setSystemTime(BASE + 30_000)
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(1)

    jest.setSystemTime(BASE + 61_000)
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(2)
  })

  test("产物抖动带：Math.random=0 → 恰好 1h 到期；random≈1 → 1h+5min 才到期", async () => {
    const originalRandom = Math.random
    Math.random = () => 0
    try {
      const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)))
      harness.pipeline.start()
      await harness.pipeline.refreshIfDue()

      jest.setSystemTime(BASE + HOUR)
      await harness.pipeline.refreshIfDue()
      expect(artifactFetches(harness.requests)).toHaveLength(2)
    } finally {
      Math.random = originalRandom
    }
  })

  test("产物抖动带上界：random→1 时 1h 整不重拉、1h+5min 重拉", async () => {
    const originalRandom = Math.random
    Math.random = () => 0.999999
    try {
      const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)))
      harness.pipeline.start()
      await harness.pipeline.refreshIfDue()

      jest.setSystemTime(BASE + HOUR)
      await harness.pipeline.refreshIfDue()
      expect(artifactFetches(harness.requests)).toHaveLength(1)

      jest.setSystemTime(BASE + HOUR + ARTIFACT_TTL_JITTER_MS + 1)
      await harness.pipeline.refreshIfDue()
      expect(artifactFetches(harness.requests)).toHaveLength(2)
    } finally {
      Math.random = originalRandom
    }
  })
})

describe("降级行为（§5：每条路径 warn 注明退到哪层）", () => {
  test("产物全渠道失败 → 快照顶替产物角色（warn），catalog 正常 → context/name 取 catalog", async () => {
    const harness = makeHarness((url) =>
      url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : Promise.reject(new Error("HTTP 404")),
    )
    harness.pipeline.start()
    const result = await harness.pipeline.refreshIfDue().then(() => harness.pipeline.getModels())
    expect(result.productLayer).toBe("snapshot")
    // 快照里的两个 id 都在 catalog 清单中 → context/name 听 catalog
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek-v4-flash"])
    expect(result.models[0]!.context).toBe(1_000_000)
    expect(result.models[0]!.name).toBe("Claude Sonnet 5")
    expect(harness.warns.some((message) => message.includes("包内快照顶替产物角色"))).toBe(true)
  })

  test("catalog 失败 → 模型列表不缩水（产物全集），context/name 回落产物值 + warn", async () => {
    const harness = makeHarness((url) =>
      url === CLIENT_CATALOG_URL ? new Response("oops", { status: 500 }) : jsonResponse(ARTIFACT_A),
    )
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    const result = harness.pipeline.getModels()
    expect(result.productLayer).toBe("artifact")
    // 产物全集照常注册——catalog 缺席只影响 context/name
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek-v4-flash", "artifact/only"])
    expect(result.models[0]!.context).toBe(999_000) // catalog 缺席 → 产物值兜底
    expect(result.models[0]!.name).toBe("Claude Sonnet 5 (v45)")
    expect(harness.warns.some((message) => message.includes("client catalog 拉取失败") && message.includes("context/name 回落产物值"))).toBe(true)
  })

  test("产物与 catalog 都失败（从未成功）→ 快照全量注册 + 全部来源失败 warn", async () => {
    const harness = makeHarness(() => Promise.reject(new Error("offline")))
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    const result = harness.pipeline.getModels()
    expect(result.productLayer).toBe("snapshot")
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek-v4-flash"])
    expect(result.models[0]!.context).toBe(200_000) // 全量快照值
    expect(harness.warns.some((message) => message.includes("全部来源失败") && message.includes("包内快照全量注册"))).toBe(true)
  })

  test("sticky：曾成功后刷新失败 → 沿用上次成功产物（不倒退回内置快照）+ warn", async () => {
    let artifactHealthy = true
    const harness = makeHarness((url) => {
      if (url === CLIENT_CATALOG_URL) return jsonResponse(CATALOG_A)
      return artifactHealthy ? jsonResponse(ARTIFACT_A) : Promise.reject(new Error("HTTP 503"))
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.pipeline.getModels().productLayer).toBe("artifact")

    artifactHealthy = false
    jest.setSystemTime(BASE + 2 * HOUR)
    await harness.pipeline.refreshIfDue()
    const result = harness.pipeline.getModels()
    // 内存里的上次成功产物 = 最新鲜的「最后已知良好产物」，不倒退到更旧的内置快照
    expect(result.productLayer).toBe("artifact")
    expect(result.models[0]!.efforts).toEqual(["high", "max"])
    expect(harness.warns.some((message) => message.includes("沿用上次成功产物"))).toBe(true)
    // 无内容变化 → 无 onChange
    expect(harness.changes).toHaveLength(1)
  })

  test("sticky catalog：曾成功后刷新失败 → 沿用上次成功清单 + warn", async () => {
    let catalogHealthy = true
    const harness = makeHarness((url) => {
      if (url === CLIENT_CATALOG_URL) {
        return catalogHealthy ? jsonResponse(CATALOG_A) : Promise.reject(new Error("HTTP 503"))
      }
      return jsonResponse(ARTIFACT_A)
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.pipeline.getModels().models[0]!.context).toBe(1_000_000)

    catalogHealthy = false
    jest.setSystemTime(BASE + 16 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(harness.pipeline.getModels().models[0]!.context).toBe(1_000_000) // 上次成功值不丢
    expect(harness.warns.some((message) => message.includes("client catalog 刷新失败") && message.includes("沿用上次成功清单"))).toBe(true)
    expect(harness.changes).toHaveLength(1)
  })

  test("恢复：全部失败后任一来源恢复即回到完整级联并触发 onChange", async () => {
    let catalogHealthy = false
    let artifactHealthy = false
    const harness = makeHarness((url) => {
      if (url === CLIENT_CATALOG_URL) return catalogHealthy ? jsonResponse(CATALOG_A) : Promise.reject(new Error("offline"))
      return artifactHealthy ? jsonResponse(ARTIFACT_A) : Promise.reject(new Error("offline"))
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.pipeline.getModels().productLayer).toBe("snapshot")
    expect(harness.changes).toEqual([])

    catalogHealthy = true
    jest.setSystemTime(BASE + 31_000)
    await harness.pipeline.refreshIfDue()
    expect(harness.pipeline.getModels().productLayer).toBe("snapshot") // 产物仍未恢复
    expect(harness.pipeline.getModels().models[0]!.context).toBe(1_000_000) // catalog 已接管 context
    expect(harness.changes).toHaveLength(1) // catalog 签名 undefined → 有值

    artifactHealthy = true
    jest.setSystemTime(BASE + 92_000) // 产物第二次退避（60s 档）到点
    await harness.pipeline.refreshIfDue()
    expect(harness.pipeline.getModels().productLayer).toBe("artifact")
    expect(harness.changes).toHaveLength(2)
  })
})

describe("指数退避（§5：30s 起、上限 30min，fake timers 推进）", () => {
  test("失败后按 30s×2^n 重试，第 7 次起封顶 30min", async () => {
    const harness = makeHarness(() => Promise.reject(new Error("offline")))
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    let expected = harness.requests.length // 首轮：2 渠道全失败 + catalog = 3

    // 退避序列（秒）：30, 60, 120, 240, 480, 960——每档「差 1s 不到点 / 过 1s 重试」
    const gaps = [30, 60, 120, 240, 480, 960]
    let now = BASE
    for (const gap of gaps) {
      jest.setSystemTime(now + (gap - 1) * 1000)
      await harness.pipeline.refreshIfDue()
      expect(harness.requests.length).toBe(expected) // 未到点不重试
      jest.setSystemTime(now + (gap + 1) * 1000)
      await harness.pipeline.refreshIfDue()
      expected += 3 // 产物 2 渠道 + catalog 各重试一轮
      expect(harness.requests.length).toBe(expected)
      now += (gap + 1) * 1000
    }

    // 封顶验证：第 7 次失败后间隔恒为 30min（1920s 被压到 1800s）
    jest.setSystemTime(now + 29 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(harness.requests.length).toBe(expected)
    jest.setSystemTime(now + 31 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expected += 3
    expect(harness.requests.length).toBe(expected)
    expect(harness.warns.some((message) => message.includes("30min 后指数退避重试"))).toBe(true)
  })

  test("成功清零退避：恢复后回到 TTL 节奏而非退避档", async () => {
    let catalogHealthy = false
    const harness = makeHarness((url) => {
      if (url === CLIENT_CATALOG_URL) return catalogHealthy ? jsonResponse(CATALOG_A) : Promise.reject(new Error("offline"))
      return Promise.reject(new Error("offline"))
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()

    catalogHealthy = true
    jest.setSystemTime(BASE + 31_000) // 30s 退避到点
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(2) // catalog 恢复，failCount 清零

    jest.setSystemTime(BASE + 31_000 + 14 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(2) // 成功后按 900s TTL，14min 不重拉

    jest.setSystemTime(BASE + 31_000 + 16 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(3) // TTL 节奏（而非 60s 退避档）
  })
})

describe("条件请求（§4：渠道支持时带 ETag / If-None-Match）", () => {
  test("catalog 无 catalogVersion：仍采纳数据，后续请求不带 If-None-Match", async () => {
    const seen: Array<Record<string, string>> = []
    const harness = makeHarness((url, init) => {
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
      if (url !== CLIENT_CATALOG_URL) return jsonResponse(ARTIFACT_A)
      seen.push(headers)
      return jsonResponse({
        schemaVersion: 1,
        refreshAfterSeconds: 900,
        data: [
          { id: "claude-sonnet-5", context_length: 1_000_000, name: "Claude Sonnet 5" },
          { id: "deepseek-v4-flash", context_length: 1_000_000, name: "DeepSeek V4 Flash" },
        ],
      })
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.pipeline.getModels().models[0]!.context).toBe(1_000_000)

    jest.setSystemTime(BASE + 16 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(seen).toHaveLength(2)
    expect(seen[1]!["if-none-match"]).toBeUndefined()
  })

  test("二次拉取带 If-None-Match「catalogVersion」；304 复用上次 catalog 且不触发 reload", async () => {
    const seenValidators: Array<Record<string, string>> = []
    const harness = makeHarness((url, init) => {
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
      if (url === CLIENT_CATALOG_URL) {
        if (headers["if-none-match"] === undefined) return jsonResponse(CATALOG_A)
        seenValidators.push(headers)
        return new Response(null, { status: 304 })
      }
      return jsonResponse(ARTIFACT_A)
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.changes).toHaveLength(1)

    jest.setSystemTime(BASE + 16 * MINUTE)
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(2)
    expect(seenValidators[0]!["if-none-match"]).toBe('"catalog-v1"')
    // 304 = 上游未变：签名不变 → 无 reload，context 沿用上次成功清单
    expect(harness.changes).toHaveLength(1)
    expect(harness.pipeline.getModels().models[0]!.context).toBe(1_000_000)
  })

  test("304 后按上次成功 catalog 的 refreshAfterSeconds 重排 TTL", async () => {
    let catalogCalls = 0
    const harness = makeHarness((url) => {
      if (url !== CLIENT_CATALOG_URL) return jsonResponse(ARTIFACT_A)
      catalogCalls += 1
      return catalogCalls === 1
        ? jsonResponse(catalogBody(
            [
              { id: "claude-sonnet-5", context_length: 1_000_000, name: "Claude Sonnet 5" },
              { id: "deepseek-v4-flash", context_length: 1_000_000, name: "DeepSeek V4 Flash" },
            ],
            { refreshAfterSeconds: 600 },
          ))
        : new Response(null, { status: 304 })
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(1)

    jest.setSystemTime(BASE + 11 * MINUTE) // 10min TTL 到点 → 304
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(2)

    jest.setSystemTime(BASE + 11 * MINUTE + 9 * MINUTE) // 304 后 9min：未到 10min
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(2)

    jest.setSystemTime(BASE + 11 * MINUTE + 11 * MINUTE) // 304 后 11min：到点
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(3)
  })

  test("产物二次拉取带 If-None-Match / If-Modified-Since；304 复用上次产物不触发 reload", async () => {
    const seenValidators: Array<Record<string, string>> = []
    const harness = makeHarness((url, init) => {
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
      if (url === CLIENT_CATALOG_URL) return jsonResponse(CATALOG_A)
      if (headers["if-none-match"] === undefined) {
        return jsonResponse(ARTIFACT_A, { etag: '"abc123"', "last-modified": "Mon, 01 Sep 2026 00:00:00 GMT" })
      }
      seenValidators.push(headers)
      return new Response(null, { status: 304 })
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.changes).toHaveLength(1)

    jest.setSystemTime(BASE + 2 * HOUR)
    await harness.pipeline.refreshIfDue()
    expect(artifactFetches(harness.requests)).toHaveLength(2)
    const validators = seenValidators[0]!
    expect(validators["if-none-match"]).toBe('"abc123"')
    expect(validators["if-modified-since"]).toBe("Mon, 01 Sep 2026 00:00:00 GMT")
    // 304 = 上游未变：内容 hash 不变 → 无 reload
    expect(harness.changes).toHaveLength(1)
    expect(harness.pipeline.getModels().productLayer).toBe("artifact")
  })
})

describe("v1 形态：启动拉取一次（15s 超时），失败用快照，不做后台刷新", () => {
  test("双源成功：initializeOnce 返回完整级联，此后 TTL 到点也不再拉取", async () => {
    const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)))
    const result = await harness.pipeline.initializeOnce()
    expect(result.productLayer).toBe("artifact")
    expect(result.models[0]!.context).toBe(1_000_000)
    expect(harness.changes).toEqual([]) // v1 无 reload 机制

    jest.setSystemTime(BASE + 2 * HOUR)
    await harness.pipeline.refreshIfDue()
    expect(harness.requests).toHaveLength(2) // 零后台刷新（首渠道成功 = 产物 1 次 + catalog 1 次）
  })

  test("双源挂起：15s 总预算到点整体落快照 + warn；预算内第二渠道未被尝试", async () => {
    const harness = makeHarness((_url, init) => hangingResponse(init)) // 永不落定，仅 abort 唤醒
    const pending = harness.pipeline.initializeOnce()
    await Promise.resolve()
    jest.advanceTimersByTime(V1_STARTUP_TIMEOUT_MS)
    const result = await pending
    expect(result.productLayer).toBe("snapshot")
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek-v4-flash"])
    // 预算共享：首渠道挂满 15s 后剩余渠道跳过（不逐渠道再各挂 15s）
    expect(artifactFetches(harness.requests)).toHaveLength(1)
    expect(harness.warns.some((message) => message.includes("包内快照顶替产物角色"))).toBe(true)
    expect(harness.warns.some((message) => message.includes("context/name 回落快照值"))).toBe(true)
  })

  test("产物成功 + catalog 挂起：15s 到点返回产物全集（context/name 回落产物值）", async () => {
    const harness = makeHarness((url, init) =>
      url === CLIENT_CATALOG_URL ? hangingResponse(init) : jsonResponse(ARTIFACT_A),
    )
    const pending = harness.pipeline.initializeOnce()
    await Promise.resolve()
    jest.advanceTimersByTime(V1_STARTUP_TIMEOUT_MS)
    const result = await pending
    expect(result.productLayer).toBe("artifact")
    // catalog 缺席不缩小模型列表（artifact/only 也在）
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "deepseek-v4-flash", "artifact/only"])
    expect(result.models[0]!.context).toBe(999_000) // catalog 缺席 → 产物值
    expect(harness.warns.some((message) => message.includes("context/name 回落产物值"))).toBe(true)
  })

  test("v1 不触发 onChange（无 reload 机制）且重复入口调用被忽略", async () => {
    const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)))
    await harness.pipeline.initializeOnce()
    const startResult = harness.pipeline.start()
    expect(startResult.productLayer).toBe("artifact")
    expect(harness.warns.some((message) => message.includes("忽略重复调用"))).toBe(true)
    expect(harness.changes).toEqual([])
  })
})

describe("modelsUrls 覆盖（整列表替换在管线层生效）", () => {
  test("config 通道列表完整取代默认渠道——默认列表的任何主机零请求", async () => {
    const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)), {
      modelsUrls: ["https://custom.example/only.json"],
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(artifactFetches(harness.requests).map((request) => request.url)).toEqual(["https://custom.example/only.json"])
    expect(harness.debugs.some((message) => message.includes("来源=config"))).toBe(true)
  })

  test("config 缺席时走内置默认列表（来源=default 打日志）", async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input)
      seen.push(url)
      if (url === CLIENT_CATALOG_URL) return jsonResponse(CATALOG_A)
      return Promise.reject(new Error("HTTP 404"))
    }
    const pipeline = createModelPipeline({
      snapshot: SNAPSHOT,
      fetch: fetchImpl,
      logger: { debug: () => {}, warn: () => {} },
    })
    pipeline.start()
    await pipeline.refreshIfDue()
    // 请求序 = 内置默认列表全序（ADR 0001 四渠道，常量锁定断言见 urls.test.ts）
    expect(seen.filter((url) => url !== CLIENT_CATALOG_URL)).toEqual([...DEFAULT_MODELS_URLS])
  })

  test("schemaVersion 超已知上限的渠道被整体弃用：后续渠道顶上；全部超限 → 快照 + warn", async () => {
    const future = { ...ARTIFACT_A, schemaVersion: 2 }
    // 渠道 A 超限 → 弃用并落到渠道 B（首个「可读」产物胜）
    const harnessA = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : url === URL_A ? jsonResponse(future) : jsonResponse(ARTIFACT_A)))
    harnessA.pipeline.start()
    await harnessA.pipeline.refreshIfDue()
    expect(harnessA.pipeline.getModels().productLayer).toBe("artifact")
    expect(harnessA.warns.some((message) => message.includes("高于已知上限"))).toBe(true)

    // 双渠道都超限 → 产物层整体弃用 → 快照顶替
    const harnessB = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(future)))
    harnessB.pipeline.start()
    await harnessB.pipeline.refreshIfDue()
    expect(harnessB.pipeline.getModels().productLayer).toBe("snapshot")
    expect(harnessB.warns.some((message) => message.includes("包内快照顶替产物角色"))).toBe(true)
  })
})

describe("rebindModelsUrls（#36：v2 config 通道经工厂 options 运行时接驳）", () => {
  test("原值未变（宿主随工厂调用透传同一 settings）：零开销跳过——不重解析、不加轮次", async () => {
    const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)), {
      modelsUrls: [URL_A, URL_B],
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    const fetchesAfterFirstRound = harness.requests.length
    const sourceLogs = harness.debugs.filter((message) => message.includes("生效来源")).length

    harness.pipeline.rebindModelsUrls([URL_A, URL_B]) // 新数组实例、同值
    harness.pipeline.rebindModelsUrls([URL_A, URL_B])
    await harness.pipeline.refreshIfDue()
    expect(harness.requests.length).toBe(fetchesAfterFirstRound)
    expect(harness.debugs.filter((message) => message.includes("生效来源")).length).toBe(sourceLogs)
  })

  test("config 值变了：列表替换 + TTL 未到点也立即补拉新渠道，来源=config 打日志", async () => {
    const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)))
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(artifactFetches(harness.requests).every((request) => request.url === URL_A)).toBe(true)

    harness.pipeline.rebindModelsUrls("https://mirror.example/models.json")
    await harness.pipeline.refreshIfDue()
    const postRebind = artifactFetches(harness.requests).slice(-1)
    expect(postRebind.map((request) => request.url)).toEqual(["https://mirror.example/models.json"])
    expect(harness.debugs.some((message) => message.includes("生效来源=config"))).toBe(true)
  })

  test("重绑定非法值：按 §1.3 整体回退默认列表 + warn，不抛错不阻断", async () => {
    const harness = makeHarness((url) => {
      return url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)
    })
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()

    harness.pipeline.rebindModelsUrls({ not: "a url list" })
    await harness.pipeline.refreshIfDue()
    expect(harness.warns.some((message) => message.includes("回退内置默认列表"))).toBe(true)
    // 回退后按默认列表续拉（默认首渠道命中 fixture 产物）
    expect(artifactFetches(harness.requests).at(-1)!.url).toBe(DEFAULT_MODELS_URLS[0]!)
  })

  test("v1 形态不接驳：rebind 不触发任何刷新（v1 无后台刷新）", async () => {
    const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)))
    await harness.pipeline.initializeOnce()
    const total = harness.requests.length
    const sourceLogs = harness.debugs.filter((message) => message.includes("生效来源")).length

    harness.pipeline.rebindModelsUrls("https://mirror.example/models.json")
    await harness.pipeline.refreshIfDue()
    expect(harness.requests.length).toBe(total)
    expect(harness.debugs.filter((message) => message.includes("生效来源"))).toHaveLength(sourceLogs)
  })
})

describe("入口防护与回调健壮性", () => {
  test("start() 重复调用被忽略（不重复发起首轮）", async () => {
    const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)))
    harness.pipeline.start()
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()
    expect(harness.requests).toHaveLength(2) // 重复 start 不再发起首轮（首渠道胜 = 产物 1 次 + catalog 1 次）
    expect(harness.warns.some((message) => message.includes("忽略重复调用"))).toBe(true)
  })

  test("onChange 回调抛错不炸轮次，状态照常更新", async () => {
    const requests: RecordedRequest[] = []
    const warns: string[] = []
    const fetchImpl: FetchLike = async (input) => {
      requests.push({ url: String(input), headers: {} })
      if (String(input) === CLIENT_CATALOG_URL) return jsonResponse(CATALOG_A)
      return jsonResponse(ARTIFACT_A)
    }
    const pipeline = createModelPipeline({
      snapshot: SNAPSHOT,
      modelsUrls: [URL_A],
      fetch: fetchImpl,
      logger: { debug: () => {}, warn: (message) => warns.push(message) },
      onChange: () => {
        throw new Error("宿主回调炸了")
      },
    })
    pipeline.start()
    await pipeline.refreshIfDue()
    expect(pipeline.getModels().productLayer).toBe("artifact")
    expect(warns.some((message) => message.includes("onChange 回调失败"))).toBe(true)
  })

  test("getModels 读时惰性触发到点刷新（stale-while-revalidate：读立即返回旧值）", async () => {
    const harness = makeHarness((url) => (url === CLIENT_CATALOG_URL ? jsonResponse(CATALOG_A) : jsonResponse(ARTIFACT_A)))
    harness.pipeline.start()
    await harness.pipeline.refreshIfDue()

    jest.setSystemTime(BASE + 16 * MINUTE)
    const stale = harness.pipeline.getModels() // 读不等待，先回旧值
    expect(stale.models[0]!.context).toBe(1_000_000)
    await harness.pipeline.refreshIfDue()
    expect(catalogFetches(harness.requests)).toHaveLength(2)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import type { Artifact } from "../../src/models/artifact.ts"
import { MODELS_API_URL, createModelPipeline } from "../../src/models/pipeline.ts"
import type { FetchLike } from "../../src/protocol/json.ts"

// 级联降级全场景（testing.md §2）：本地 Bun.serve 扮默认 URL 列表的多渠道
// （4 条 URL 指向 localhost 不同端口，真实 loopback HTTP），验证：首成功者胜；
// 部分失败按序回退；全失败落包内快照；schemaVersion 超限弃用产物降快照；
// /models API 失败退化产物清单；全离线快照全量注册。API 一律经 fetch 接缝
// 拦截（绝不出网）；指数退避的时序推进归 pipeline.test.ts（fake timers）。
// 产物 JSON 不走 tests/fixtures/ 静态文件——内容需按渠道 tag 参数化以证明
// 「哪个渠道赢了」，内联生成器即 fixture 本体。

interface Channel {
  readonly url: string
  hits(): number
  stop(): void
}

function startChannel(handler: (request: Request) => Response | Promise<Response>): Channel {
  let hits = 0
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      hits += 1
      return handler(request)
    },
  })
  return { url: `http://127.0.0.1:${server.port}/models.json`, hits: () => hits, stop: () => server.stop(true) }
}

/** 造一个「确定已关闭」的端口（先占住再释放），模拟连接拒绝渠道 */
function closedPortChannel(): Channel {
  const server = Bun.serve({ port: 0, fetch: () => new Response("unused") })
  const url = `http://127.0.0.1:${server.port}/models.json`
  server.stop(true)
  return { url, hits: () => 0, stop: () => {} }
}

function artifactBody(tag: string, extraModels: Array<Record<string, unknown>> = [], schemaVersion = 1, efforts: string[] = ["high"]): unknown {
  return {
    schemaVersion,
    generatedAt: `2026-09-01T00:00:00.000Z (${tag})`,
    sourceCliVersion: "1.45.0",
    models: [
      // 渠道区分度放在产物独供字段（efforts）——name/context 是 API 权威，级联会被覆盖
      { id: "chan/one", name: `Chan One (${tag})`, reasoning: true, inputModalities: ["text"], efforts, context: 111_000, maxOutput: 11_000 },
      ...extraModels,
    ],
  }
}

const SNAPSHOT: Artifact = {
  schemaVersion: 1,
  generatedAt: "2026-08-01T00:00:00.000Z",
  sourceCliVersion: "1.40.0",
  models: [
    { id: "chan/one", name: "Chan One (snapshot)", reasoning: true, inputModalities: ["text"], efforts: ["high"], context: 222_000, maxOutput: 22_000 },
    { id: "snapshot/only", name: "Snapshot Only", reasoning: false, inputModalities: ["text"], context: 64_000, maxOutput: 8_000 },
  ],
}

const channels: Channel[] = []

function channel(handler: (request: Request) => Response | Promise<Response>): Channel {
  const ch = startChannel(handler)
  channels.push(ch)
  return ch
}

afterEach(() => {
  for (const ch of channels.splice(0)) ch.stop()
})

function apiResponse(status = 200, body: unknown = { object: "list", created: 1, data: [{ id: "chan/one", object: "model", created: 2, owned_by: "x", context_length: 333_000, name: "Chan One (api)" }] }): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** 建管线：API 经 fetch 接缝拦截（不出网），产物渠道走真实 loopback */
function makePipeline(channelUrls: readonly string[], apiBehavior: () => Response | Promise<Response>) {
  const warns: string[] = []
  const apiRequests: number[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input)
    if (url === MODELS_API_URL) {
      apiRequests.push(Date.now())
      return apiBehavior()
    }
    return fetch(input, init)
  }
  const pipeline = createModelPipeline({
    snapshot: SNAPSHOT,
    modelsUrls: channelUrls,
    fetch: fetchImpl,
    logger: { debug: () => {}, warn: (message) => warns.push(message) },
  })
  return { pipeline, warns, apiRequests }
}

describe("fixture server 级联降级全场景（testing.md §2）", () => {
  test("首成功者胜：四渠道全 200，只有渠道 1 被请求，元数据取其内容", async () => {
    const c1 = channel(() => new Response(JSON.stringify(artifactBody("c1", [], 1, ["low"])), { headers: { "content-type": "application/json" } }))
    const c2 = channel(() => new Response(JSON.stringify(artifactBody("c2", [], 1, ["medium"]))))
    const c3 = channel(() => new Response(JSON.stringify(artifactBody("c3", [], 1, ["xhigh"]))))
    const c4 = channel(() => new Response(JSON.stringify(artifactBody("c4", [], 1, ["max"]))))

    const { pipeline, apiRequests } = makePipeline([c1.url, c2.url, c3.url, c4.url], () => apiResponse())
    pipeline.start()
    await pipeline.refreshIfDue()

    expect(c1.hits()).toBe(1)
    expect(c2.hits()).toBe(0)
    expect(c3.hits()).toBe(0)
    expect(c4.hits()).toBe(0)
    expect(apiRequests).toHaveLength(1)

    const models = pipeline.getModels().models
    expect(models.map((model) => model.id)).toEqual(["chan/one"])
    // efforts = 产物独供 → 证明取的是渠道 1 的产物；name/context = API 权威覆盖
    expect(models[0]!.efforts).toEqual(["low"])
    expect(models[0]!.maxOutput).toBe(11_000)
    expect(models[0]!.name).toBe("Chan One (api)")
    expect(models[0]!.context).toBe(333_000)
  })

  test("按序回退：渠道 1 404、渠道 2 500 → 渠道 3 胜，渠道 4 未被尝试", async () => {
    const c1 = channel(() => new Response("not found", { status: 404 }))
    const c2 = channel(() => new Response("boom", { status: 500 }))
    const c3 = channel(() => new Response(JSON.stringify(artifactBody("c3", [], 1, ["xhigh"]))))
    const c4 = channel(() => new Response(JSON.stringify(artifactBody("c4", [], 1, ["max"]))))

    const { pipeline } = makePipeline([c1.url, c2.url, c3.url, c4.url], () => apiResponse())
    pipeline.start()
    await pipeline.refreshIfDue()

    expect(c1.hits()).toBe(1)
    expect(c2.hits()).toBe(1)
    expect(c3.hits()).toBe(1)
    expect(c4.hits()).toBe(0)
    expect(pipeline.getModels().models[0]!.efforts).toEqual(["xhigh"])
  })

  test("全落快照：404/500/连接拒绝/503 全失败 → 包内快照顶替，warn 注明", async () => {
    const c1 = channel(() => new Response("404", { status: 404 }))
    const c2 = channel(() => new Response("500", { status: 500 }))
    const c3 = closedPortChannel()
    const c4 = channel(() => new Response("503", { status: 503 }))

    const { pipeline, warns } = makePipeline([c1.url, c2.url, c3.url, c4.url], () => apiResponse())
    pipeline.start()
    await pipeline.refreshIfDue()

    const result = pipeline.getModels()
    expect(result.productLayer).toBe("snapshot")
    // API 成功 → 发现 = API ∩ 快照（snapshot/only 被 API 保守隐藏），元数据取快照层
    expect(result.models.map((model) => model.id)).toEqual(["chan/one"])
    expect(result.models[0]!.context).toBe(333_000) // API 正常：context 仍听 API
    expect(result.models[0]!.name).toBe("Chan One (api)")
    expect(result.models[0]!.maxOutput).toBe(22_000) // 快照层的 maxOutput（产物渠道值是 11_000）
    expect(warns.some((message) => message.includes("包内快照顶替产物角色"))).toBe(true)
  })

  test("schemaVersion 超上限：全部渠道整体弃用 → 快照顶替 + 告警；首个「可读」渠道仍优先于靠后渠道", async () => {
    // 全部超限 → 快照
    const f1 = channel(() => new Response(JSON.stringify(artifactBody("f1", [], 2))))
    const f2 = channel(() => new Response(JSON.stringify(artifactBody("f2", [], 7))))
    const { pipeline: p1, warns } = makePipeline([f1.url, f2.url], () => apiResponse())
    p1.start()
    await p1.refreshIfDue()
    expect(p1.getModels().productLayer).toBe("snapshot")
    expect(warns.some((message) => message.includes("高于已知上限，整体弃用"))).toBe(true)

    // 渠道 1 超限、渠道 2 可读 → 弃用渠道 1，渠道 2 胜（不做多版本兼容解析，但也不放弃整张列表）
    const m1 = channel(() => new Response(JSON.stringify(artifactBody("m1", [], 2))))
    const m2 = channel(() => new Response(JSON.stringify(artifactBody("m2", [], 1, ["medium"]))))
    const { pipeline: p2 } = makePipeline([m1.url, m2.url], () => apiResponse())
    p2.start()
    await p2.refreshIfDue()
    expect(p2.getModels().productLayer).toBe("artifact")
    expect(p2.getModels().models[0]!.efforts).toEqual(["medium"])
  })

  test("API 失败：发现退化为产物 id 清单（产物独有条目暴露、context 取产物值）+ warn", async () => {
    const c1 = channel(() =>
      new Response(
        JSON.stringify(artifactBody("c1", [{ id: "retired/model", name: "Retired", reasoning: false, inputModalities: ["text"], context: 777_000, maxOutput: 8_000 }])),
      ),
    )
    const { pipeline, warns, apiRequests } = makePipeline([c1.url], () => apiResponse(500))
    pipeline.start()
    await pipeline.refreshIfDue()

    expect(apiRequests).toHaveLength(1)
    const result = pipeline.getModels()
    expect(result.productLayer).toBe("artifact")
    // API 缺席 → 发现 = 产物 id 清单（含 API 不认识的条目），context 逐级回落产物值
    expect(result.models.map((model) => model.id)).toEqual(["chan/one", "retired/model"])
    expect(result.models[0]!.context).toBe(111_000)
    expect(result.models[0]!.name).toBe("Chan One (c1)")
    expect(warns.some((message) => message.includes("发现退化为产物 id 清单"))).toBe(true)
  })

  test("全离线：API + 全渠道失败 → 快照全量注册照常可用 + 全部来源失败 warn", async () => {
    const c1 = channel(() => new Response("404", { status: 404 }))
    const c2 = closedPortChannel()
    const { pipeline, warns } = makePipeline([c1.url, c2.url], () => apiResponse(502))
    pipeline.start()
    await pipeline.refreshIfDue()

    const result = pipeline.getModels()
    expect(result.productLayer).toBe("snapshot")
    expect(result.models.map((model) => model.id)).toEqual(["chan/one", "snapshot/only"])
    expect(result.models[0]!.context).toBe(222_000) // 全量快照值
    expect(result.models[0]!.maxOutput).toBe(22_000)
    expect(warns.some((message) => message.includes("全部来源失败") && message.includes("包内快照全量注册"))).toBe(true)
  })

  test("用户覆盖列表整列表替换：只打用户渠道，默认列表零流量（真 HTTP 佐证）", async () => {
    const only = channel(() => new Response(JSON.stringify(artifactBody("only", [], 1, ["max"]))))
    const { pipeline } = makePipeline([only.url], () => apiResponse())
    pipeline.start()
    await pipeline.refreshIfDue()
    expect(only.hits()).toBe(1)
    expect(pipeline.getModels().models[0]!.efforts).toEqual(["max"])
  })
})

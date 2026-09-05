import { beforeAll, afterEach, describe, expect, jest, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APICallError } from "@ai-sdk/provider"
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
// 经包入口导入工厂：同时验证「模块第一个 create* 导出」判据在真实入口上成立
import { createCommandCode } from "../../src/index.ts"
import { noopLogger } from "../../src/disguise/logger.ts"
import type { CommandCodeApiCallError } from "../../src/protocol/errors.ts"
import { GENERATE_ENDPOINT } from "../../src/protocol/generate.ts"
import type { FetchLike } from "../../src/protocol/json.ts"

// LanguageModelV3 集成全链（#35，契约：docs/spec/testing.md §2 + v2-provider-contract.md §2）：
// 全部出网路径统一经工厂 options.fetch 接缝注 mock（generate / 产物 URL / models API /
// 版本查询 / 预请求），无任何测试后门；时间用 bun:test fake timers 瞬推。
// 事实基础（provider 3.0.8 实测）：finishReason 为 {unified, raw} 对象、usage 嵌套。

const API_KEY = "integration-test-key"
const WIRE_ID = "deepseek/deepseek-v4-flash"
const PREFIXED_REFERENCE = `commandcode-go/${WIRE_ID}`
const ARTIFACT_URL = "https://fixture.commandcode.test/models.json"

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** 产物 fixture（tests/fixtures 精神：测试自带模型数据，不依赖包内真快照） */
const ARTIFACT_FIXTURE = {
  schemaVersion: 1,
  generatedAt: "2026-09-05T00:00:00Z",
  sourceCliVersion: "1.49.1",
  models: [
    {
      id: WIRE_ID,
      name: "DeepSeek V4 Flash",
      reasoning: true,
      inputModalities: ["text", "image"],
      efforts: ["high", "max"],
      context: 1_000_000,
      maxOutput: 32_000,
    },
    { id: "plain-model", name: "Plain Model", reasoning: false, inputModalities: ["text"], context: 128_000, maxOutput: 8_000 },
  ],
}

const ALL_EVENTS_NDJSON = readFileSync(new URL("../fixtures/ndjson/all-events.ndjson", import.meta.url), "utf8")

const MIN_STREAM =
  '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1}}\n' +
  '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":1,"outputTokens":1}}\n'

const encoder = new TextEncoder()

function ndjsonResponse(text: string): Response {
  return new Response(encoder.encode(text), { status: 200, headers: { "content-type": "application/x-ndjson" } })
}

interface CapturedCall {
  url: string
  init: RequestInit | undefined
}

/** mock fetch：按 URL 路由（generate → 测试给定；产物 URL → fixture；其余全 404），全调用留痕 */
function makeFetch(options: { generate?: (call: CapturedCall) => Response | Promise<Response> } = {}): {
  fetch: FetchLike
  calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    if (url === GENERATE_ENDPOINT) return options.generate ? await options.generate({ url, init }) : ndjsonResponse(MIN_STREAM)
    if (url === ARTIFACT_URL) return Response.json(ARTIFACT_FIXTURE)
    return new Response("not found", { status: 404 })
  }
  return { fetch: fetchImpl, calls }
}

const generateCalls = (calls: readonly CapturedCall[]): CapturedCall[] => calls.filter((call) => call.url === GENERATE_ENDPOINT)

function makeFactory(fetchImpl: FetchLike) {
  return createCommandCode({
    name: "commandcode-go",
    apiKey: API_KEY,
    headers: { "x-user-hint": "from-settings" },
    fetch: fetchImpl,
    modelsUrls: [ARTIFACT_URL],
    logger: noopLogger,
  })
}

const PROMPT: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "ping" }] }]

function callOptions(overrides: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions {
  return { prompt: PROMPT, ...overrides }
}

async function collectStream(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

/** 微任务泵：让「工厂调用 → 生成器 → fetch 发起」的微任务链走完（fake timers 下禁用 sleep） */
async function flushMicrotasks(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时")
    await Bun.sleep(5)
  }
}

const TOTAL_USAGE = {
  inputTokens: 16977,
  inputTokenDetails: { noCacheTokens: 11601, cacheReadTokens: 5376 },
  outputTokens: 27,
  outputTokenDetails: { textTokens: 2, reasoningTokens: 25 },
  totalTokens: 17004,
}

beforeAll(async () => {
  // 版本缓存落盘重定向至临时目录（testing.md §2/§3：XDG_CACHE_HOME 是 disguise.md §6
  // 本就 XDG 优先的标准行为，非测试后门）——不重定向会读到真机缓存，断言机器依赖
  process.env["XDG_CACHE_HOME"] = await mkdtemp(join(tmpdir(), "cc-factory-test-cache-"))

  // 预热共享运行时（模块级单例）：产物先落内存（版本头兜底链 ③ 才有值），
  // 再走一次完整 doStream 触发 config 块采集与版本初解析
  const { fetch } = makeFetch()
  const provider = makeFactory(fetch)
  await Bun.sleep(50)
  await collectStream((await provider.languageModel(PREFIXED_REFERENCE).doStream(callOptions())).stream)
})

afterEach(() => {
  jest.useRealTimers()
})

describe("工厂形状与 reference 解析", () => {
  test("languageModel 返回 LanguageModelV3 形状（v3 / provider / modelId / supportedUrls）", () => {
    const { fetch } = makeFetch()
    const provider = makeFactory(fetch)
    expect(Object.keys(provider).sort()).toEqual(["languageModel"])
    const model = provider.languageModel(PREFIXED_REFERENCE)
    expect(model.specificationVersion).toBe("v3")
    expect(model.provider).toBe("commandcode-go")
    expect(model.modelId).toBe(PREFIXED_REFERENCE)
    expect(model.supportedUrls).toEqual({})
    expect(typeof model.doStream).toBe("function")
    expect(typeof model.doGenerate).toBe("function")
  })

  test("工厂以宿主四键签名调用可用（无 body 键）", () => {
    const { fetch } = makeFetch()
    const provider = createCommandCode({ name: "commandcode-go", apiKey: API_KEY, headers: {}, fetch })
    const model = provider.languageModel(WIRE_ID)
    expect(model.specificationVersion).toBe("v3")
  })

  test("reference 解析：按首个 / 切分 provider 前缀，wire id 含 / 原样透传", async () => {
    const { fetch, calls } = makeFetch()
    const provider = makeFactory(fetch)
    await collectStream((await provider.languageModel(PREFIXED_REFERENCE).doStream(callOptions())).stream)
    await collectStream((await provider.languageModel(WIRE_ID).doStream(callOptions())).stream)
    const bodies = generateCalls(calls).map((call) => JSON.parse(String(call.init?.body)))
    expect(bodies).toHaveLength(2)
    expect(bodies[0].params.model).toBe(WIRE_ID)
    // 无前缀 reference 不被误剥（wire id 自身可含 /）
    expect(bodies[1].params.model).toBe(WIRE_ID)
  })
})

describe("doStream 全事件映射端到端（真实形状 NDJSON → stream part）", () => {
  test("全事件流：块生命周期、增量工具参数、usage 归一、finishReason {unified, raw}", async () => {
    const { fetch } = makeFetch({ generate: () => ndjsonResponse(ALL_EVENTS_NDJSON) })
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    const parts = await collectStream((await model.doStream(callOptions())).stream)

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "text-start",
      "text-delta",
      "text-end",
      "reasoning-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "response-metadata",
      "response-metadata",
      "finish",
    ])

    // 未知事件（provider-metadata / future-unknown-event）与注释行、空行、start 系静默
    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] })
    expect(parts[1]).toMatchObject({ type: "reasoning-start", id: "reasoning-0" })
    expect(parts[2]).toMatchObject({ type: "reasoning-delta", id: "reasoning-0", delta: "The user asked" })
    // 增量工具参数逐 delta 透传（长参数只发增量时一次性解析会丢参——必做项）
    expect(parts[9]).toMatchObject({ type: "tool-input-delta", id: "toolu-0", delta: '{"file_path":' })
    expect(parts[12]).toEqual({
      type: "tool-call",
      toolCallId: "toolu-0",
      toolName: "read_file",
      input: '{"file_path":"src/index.ts"}',
    })

    const finish = parts.find((part) => part.type === "finish") as Extract<LanguageModelV3StreamPart, { type: "finish" }>
    // provider 3.0.8 事实：finishReason 为对象、usage 嵌套；词表归一 + raw 保真
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" })
    expect(finish.usage.inputTokens).toEqual({ total: 16977, noCache: 11601, cacheRead: 5376, cacheWrite: undefined })
    expect(finish.usage.outputTokens).toEqual({ total: 27, text: 2, reasoning: 25 })
    expect(finish.usage.raw).toEqual(TOTAL_USAGE)
    expect(finish.providerMetadata).toMatchObject({ deepseek: { responseObject: "chat.completion.chunk" } })
  })

  test("warnings 通道端到端：不支持参数经 stream-start 上报", async () => {
    const { fetch } = makeFetch()
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    const parts = await collectStream((await model.doStream(callOptions({ stopSequences: ["END"] }))).stream)
    expect(parts[0]).toMatchObject({
      type: "stream-start",
      warnings: [{ type: "unsupported", feature: "stopSequences" }],
    })
  })
})

describe("doGenerate = doStream 聚合", () => {
  test("与 doStream 聚合一致（同输入同输出内容、同收据）", async () => {
    const { fetch } = makeFetch({ generate: () => ndjsonResponse(ALL_EVENTS_NDJSON) })
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    const result = await model.doGenerate(callOptions())

    expect(result.warnings).toEqual([])
    expect(result.content).toEqual([
      { type: "reasoning", text: "The user asked for a pong." },
      { type: "text", text: "pong" },
      { type: "tool-call", toolCallId: "toolu-0", toolName: "read_file", input: '{"file_path":"src/index.ts"}' },
    ])

    // 同输入下与流路径收据一致
    const parts = await collectStream((await model.doStream(callOptions())).stream)
    const finish = parts.find((part) => part.type === "finish") as Extract<LanguageModelV3StreamPart, { type: "finish" }>
    expect(result.finishReason).toEqual(finish.finishReason)
    expect(result.usage).toEqual(finish.usage)
  })

  test("流内 error part 无聚合通道，以 throw 浮出", async () => {
    const { fetch } = makeFetch({
      generate: () =>
        ndjsonResponse(
          '{"type":"text-start","id":"t"}\n{"type":"text-delta","id":"t","text":"partial"}\n{"type":"error","error":{"message":"mid-stream boom"}}\n',
        ),
    })
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    await expect(model.doGenerate(callOptions())).rejects.toThrow("mid-stream boom")
  })
})

describe("信封与伪装头主路径", () => {
  test("七键骨架、threadId 与 x-session-id 同值、伪装头全集照抓包", async () => {
    const { fetch, calls } = makeFetch()
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    await collectStream(
      (await model.doStream(callOptions({ headers: { "X-Session-Id": "ses-envelope" } }))).stream,
    )

    const call = generateCalls(calls)[0]!
    const headers = call.init?.headers as Record<string, string>
    const body = JSON.parse(String(call.init?.body))

    // 七键骨架，键序即规格 §1 列举序（wire 形状）
    expect(Object.keys(body)).toEqual(["config", "memory", "taste", "skills", "permissionMode", "threadId", "params"])
    expect(body.memory).toBeNull()
    expect(body.taste).toBeNull()
    expect(body.skills).toBeNull()
    expect(body.permissionMode).toBe("standard")
    // config 块九字段齐全（伪装模块填充点，协议核心零知识）
    expect(Object.keys(body.config).sort()).toEqual(
      ["currentBranch", "date", "environment", "gitStatus", "isGitRepo", "mainBranch", "recentCommits", "structure", "workingDir"],
    )
    // threadId 与 x-session-id 同值（#9 抓包定案）
    expect(body.threadId).toBe(headers["x-session-id"])

    // 伪装头全集（#9 抓包校准）
    expect(headers["content-type"]).toBe("application/json")
    expect(headers["User-Agent"]).toBe("cli")
    expect(headers["x-cli-environment"]).toBe("production")
    expect(headers["x-taste-learning"]).toBe("true")
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`)
    expect(headers["x-command-code-version"]).toBe(ARTIFACT_FIXTURE.sourceCliVersion) // 兜底链 ③
    expect(headers["x-project-slug"]).toMatch(/^[0-9a-z]{4,11}(-[0-9a-z]{4,11}){7}$/)
    expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(headers["x-session-id"]).toMatch(UUID_V4)
    // 用户显式配置头透传；调用 headers（宿主会话头）只作派生种子、不透传上游
    expect(headers["x-user-hint"]).toBe("from-settings")
    expect(headers["X-Session-Id"]).toBeUndefined()
  })

  test("模型 limit 注入：max_tokens 级联裁剪，reasoning_effort 仅变体被选中时发送", async () => {
    const { fetch, calls } = makeFetch()
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    // 未传 maxOutputTokens → 直接用级联 maxOutput；变体选中 → reasoning_effort 经 providerOptions 到达
    await collectStream(
      (await model.doStream(callOptions({ providerOptions: { "commandcode-go": { reasoningEffort: "max" } } }))).stream,
    )
    // 调用方传了 → 裁到 min(调用方值, maxOutput)
    await collectStream((await model.doStream(callOptions({ maxOutputTokens: 1234 }))).stream)
    // 调用方超大 → 裁到级联上限
    await collectStream((await model.doStream(callOptions({ maxOutputTokens: 999_999 }))).stream)
    // base（未选变体）→ 不发 reasoning_effort
    await collectStream((await model.doStream(callOptions())).stream)

    const bodies = generateCalls(calls).map((call) => JSON.parse(String(call.init?.body)))
    expect(bodies[0].params.max_tokens).toBe(32_000)
    expect(bodies[0].params.reasoning_effort).toBe("max")
    expect(bodies[1].params.max_tokens).toBe(1234)
    expect(bodies[1].params.reasoning_effort).toBeUndefined()
    expect(bodies[2].params.max_tokens).toBe(32_000)
    expect(bodies[3].params.reasoning_effort).toBeUndefined()
  })

  test("未注册模型的防御路径：max_tokens 兜调用方值，缺省兜 32000", async () => {
    const { fetch, calls } = makeFetch()
    const model = makeFactory(fetch).languageModel("never-registered")
    await collectStream((await model.doStream(callOptions())).stream)
    await collectStream((await model.doStream(callOptions({ maxOutputTokens: 777 }))).stream)
    const bodies = generateCalls(calls).map((call) => JSON.parse(String(call.init?.body)))
    expect(bodies[0].params.max_tokens).toBe(32_000)
    expect(bodies[1].params.max_tokens).toBe(777)
  })
})

describe("会话头派生（disguise.md §3 主路径）", () => {
  test("同会话 headers 恒同 x-session-id；不同会话不同 id", async () => {
    const { fetch, calls } = makeFetch()
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    await collectStream((await model.doStream(callOptions({ headers: { "X-Session-Id": "ses-alpha" } }))).stream)
    await collectStream((await model.doStream(callOptions({ headers: { "X-Session-Id": "ses-alpha" } }))).stream)
    await collectStream((await model.doStream(callOptions({ headers: { "x-session-affinity": "ses-beta" } }))).stream)

    const ids = generateCalls(calls).map((call) => (call.init?.headers as Record<string, string>)["x-session-id"])
    expect(ids[0]).toMatch(UUID_V4)
    expect(ids[1]).toBe(ids[0]) // 同会话恒同 id（确定性派生，跨重启亦然）
    expect(ids[2]).toMatch(UUID_V4)
    expect(ids[2]).not.toBe(ids[0]) // 不同会话不同 id
  })

  test("无会话头落回退路径：per-key 会话在寿命内稳定", async () => {
    const { fetch, calls } = makeFetch()
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    await collectStream((await model.doStream(callOptions())).stream)
    await collectStream((await model.doStream(callOptions())).stream)
    const ids = generateCalls(calls).map((call) => (call.init?.headers as Record<string, string>)["x-session-id"])
    expect(ids[0]).toMatch(UUID_V4)
    expect(ids[1]).toBe(ids[0])
  })
})

describe("abort 与错误链路端到端", () => {
  test("abort 传播：调用方取消 → 上游 fetch 收到 abort，错误原样传播不合成", async () => {
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const { fetch, calls } = makeFetch({
      generate: ({ init }) => {
        seenSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        })
      },
    })
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    const result = model.doStream(callOptions({ abortSignal: controller.signal }))
    await waitFor(() => generateCalls(calls).length === 1)
    controller.abort()

    let thrown: unknown
    try {
      await result
    } catch (error) {
      thrown = error
    }
    expect(seenSignal?.aborted).toBe(true)
    // §3 行 10：不合成错误——抛的是 abort 原因本身，非 APICallError 形态
    expect(APICallError.isInstance(thrown)).toBe(false)
    expect((thrown as Error).name).toBe("AbortError")
  })

  test("HTTP 层错误映射端到端（十一行表行 1/2/4/5/6 抽样）", async () => {
    const scenarios: Array<{
      name: string
      status: number
      body: string
      headers?: Record<string, string>
      check: (error: CommandCodeApiCallError) => void
    }> = [
      {
        name: "行 1：403 MODEL_NOT_IN_PLAN ≠ 认证失败",
        status: 403,
        body: '{"error":{"message":"upgrade plan","code":"MODEL_NOT_IN_PLAN"}}',
        check: (error) => {
          expect(error.code).toBe("MODEL_NOT_IN_PLAN")
          expect(error.isRetryable).toBe(false)
          expect(error.statusCode).toBe(403)
        },
      },
      {
        name: "行 2：401 认证错误",
        status: 401,
        body: '{"error":{"message":"bad key"}}',
        check: (error) => {
          expect(error.code).toBe("AUTH_ERROR")
          expect(error.isRetryable).toBe(false)
          expect(error.statusCode).toBe(401)
        },
      },
      {
        name: "行 4：429 透传 retry-after",
        status: 429,
        body: '{"error":{"message":"slow down"}}',
        headers: { "retry-after": "30" },
        check: (error) => {
          expect(error.code).toBe("RATE_LIMITED")
          expect(error.isRetryable).toBe(true)
          expect(error.retryAfterSeconds).toBe(30)
        },
      },
      {
        name: "行 5：400 上下文超限识别",
        status: 400,
        body: '{"error":{"message":"prompt is too long: 300000 tokens > maximum context"}}',
        check: (error) => {
          expect(error.code).toBe("CONTEXT_WINDOW_EXCEEDED")
          expect(error.isRetryable).toBe(false)
        },
      },
      {
        name: "行 6：5xx 透传状态码可重试",
        status: 502,
        body: "bad gateway",
        check: (error) => {
          expect(error.statusCode).toBe(502)
          expect(error.isRetryable).toBe(true)
        },
      },
    ]

    for (const scenario of scenarios) {
      const { fetch } = makeFetch({ generate: () => new Response(scenario.body, { status: scenario.status, headers: scenario.headers }) })
      const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
      let thrown: unknown
      try {
        await model.doStream(callOptions())
      } catch (error) {
        thrown = error
      }
      expect(APICallError.isInstance(thrown), scenario.name).toBe(true)
      const error = thrown as CommandCodeApiCallError
      expect(error.message).toContain(WIRE_ID)
      scenario.check(error)
    }
  })

  test("行 11：响应前网络错误可重试", async () => {
    const { fetch } = makeFetch({ generate: () => Promise.reject(new TypeError("fetch failed: DNS")) })
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    let thrown: unknown
    try {
      await model.doStream(callOptions())
    } catch (error) {
      thrown = error
    }
    expect(APICallError.isInstance(thrown)).toBe(true)
    const error = thrown as CommandCodeApiCallError
    expect(error.isRetryable).toBe(true)
    expect(error.statusCode).toBeUndefined()
    expect(error.message).toContain("fetch failed: DNS")
  })

  test("行 7：零输出合成 429（finish 被替换、retry-after 10s）", async () => {
    const { fetch } = makeFetch({
      generate: () =>
        ndjsonResponse(
          '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":100,"outputTokens":0}}\n{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":100,"outputTokens":0}}\n',
        ),
    })
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    const parts = await collectStream((await model.doStream(callOptions())).stream)
    expect(parts.map((part) => part.type)).toEqual(["stream-start", "error"])
    const errorPart = parts[1] as Extract<LanguageModelV3StreamPart, { type: "error" }>
    const error = errorPart.error as CommandCodeApiCallError
    expect(error.code).toBe("ZERO_OUTPUT")
    expect(error.isRetryable).toBe(true)
    expect(error.statusCode).toBe(429)
    expect(error.retryAfterSeconds).toBe(10)
  })

  test("行 8：流关闭无 finish-step → STREAM_CLOSED 截断错误", async () => {
    const { fetch } = makeFetch({ generate: () => ndjsonResponse('{"type":"text-start","id":"t"}\n{"type":"text-del') })
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    const parts = await collectStream((await model.doStream(callOptions())).stream)
    expect(parts.at(-1)?.type).toBe("error")
    const errorPart = parts.at(-1) as Extract<LanguageModelV3StreamPart, { type: "error" }>
    const error = errorPart.error as CommandCodeApiCallError
    expect(error.code).toBe("STREAM_CLOSED")
    expect(error.isRetryable).toBe(true)
  })

  test("行 9：流中 error 事件不吞错，已收 delta 保留", async () => {
    const { fetch } = makeFetch({
      generate: () =>
        ndjsonResponse('{"type":"text-start","id":"t"}\n{"type":"text-delta","id":"t","text":"partial"}\n{"type":"error","error":{"message":"mid-stream boom"}}\n'),
    })
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    const parts = await collectStream((await model.doStream(callOptions())).stream)
    expect(parts.map((part) => part.type)).toEqual(["stream-start", "text-start", "text-delta", "error"])
    const errorPart = parts.at(-1) as Extract<LanguageModelV3StreamPart, { type: "error" }>
    expect(String((errorPart.error as Error).message)).toContain("mid-stream boom")
  })
})

describe("看门狗（fake timers 瞬推 300s）", () => {
  test("连接期 300s 无事件：abort 上游、doStream 抛可重试错误", async () => {
    jest.useFakeTimers()
    let seenSignal: AbortSignal | undefined
    const { fetch, calls } = makeFetch({
      generate: ({ init }) => {
        seenSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        })
      },
    })
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    const result = model.doStream(callOptions())
    await flushMicrotasks() // fetch 已发起、看门狗已武装
    expect(generateCalls(calls)).toHaveLength(1)

    jest.advanceTimersByTime(300_000)
    let thrown: unknown
    try {
      await result
    } catch (error) {
      thrown = error
    }
    expect(seenSignal?.aborted).toBe(true)
    expect(APICallError.isInstance(thrown)).toBe(true)
    const error = thrown as CommandCodeApiCallError
    expect(error.code).toBe("UPSTREAM_IDLE_TIMEOUT")
    expect(error.isRetryable).toBe(true)
    expect(error.retryAfterSeconds).toBe(5)
    expect(error.message).toContain(WIRE_ID)
  })

  test("流中途 300s 无新事件：error part 浮出（可重试），流收尾", async () => {
    jest.useFakeTimers()
    const { fetch } = makeFetch({
      generate: ({ init }) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"type":"text-start","id":"t"}\n'))
            init?.signal?.addEventListener("abort", () => controller.error(new Error("upstream closed")))
          },
        })
        return new Response(body, { status: 200 })
      },
    })
    const model = makeFactory(fetch).languageModel(PREFIXED_REFERENCE)
    const { stream } = await model.doStream(callOptions())
    await flushMicrotasks()
    const reader = stream.getReader()
    expect((await reader.read()).value?.type).toBe("stream-start")
    expect((await reader.read()).value?.type).toBe("text-start")

    const pending = reader.read() // 挂在等下一段
    jest.advanceTimersByTime(300_000)
    const { value } = await pending
    expect(value?.type).toBe("error")
    const error = (value as Extract<LanguageModelV3StreamPart, { type: "error" }>).error as CommandCodeApiCallError
    expect(error.code).toBe("UPSTREAM_IDLE_TIMEOUT")
    expect(error.isRetryable).toBe(true)
    expect((await reader.read()).done).toBe(true)
  })
})

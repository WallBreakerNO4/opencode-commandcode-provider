import { describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { buildEnvelope, type EnvelopeCallContext } from "../src/protocol/envelope.ts"
import { preparePromptImages } from "../src/protocol/images.ts"
import type { FetchLike } from "../src/protocol/json.ts"
import type { DisguiseLogger } from "../src/disguise/logger.ts"

// 图片输入（docs/spec/protocol.md §5，老板红线级裁决）：声明 image 的模型收到
// 图片 → 完整转换进信封；未声明 → 丢弃 + warn；无客户端尺寸限。
// URL 引用下载经注入 fetch（工厂 options.fetch 接缝），模态分支经注入 logger。

const MODEL_ID = "deepseek/deepseek-v4-flash"
const logger = () => new DisguiseLoggerSpy()

class DisguiseLoggerSpy implements DisguiseLogger {
  debugLogs: string[] = []
  warnLogs: string[] = []
  debug(message: string): void {
    this.debugLogs.push(message)
  }
  warn(message: string): void {
    this.warnLogs.push(message)
  }
}

function filePart(data: Uint8Array | string | URL, mediaType = "image/png") {
  return { type: "file", data, mediaType } as const
}

function promptOf(parts: Array<{ type: "text"; text: string } | ReturnType<typeof filePart>>): LanguageModelV3Prompt {
  return [{ role: "user", content: [...parts] }]
}

function context(): EnvelopeCallContext {
  return {
    modelId: MODEL_ID,
    maxOutput: 64000,
    threadId: "df72321c-66e7-4f3b-8779-5b882e51727f",
    disguise: { config: {}, permissionMode: "standard" },
  }
}

/** 解析信封 body 中第一条 user 消息的 content（找 image 块） */
function imagesOf(prompt: LanguageModelV3Prompt): string[] {
  const { body } = buildEnvelope({ prompt } as LanguageModelV3CallOptions, context())
  const message = body.params.messages[0]
  if (message?.role !== "user") return []
  return message.content
    .filter((block) => block.type === "image")
    .map((block) => (block as { image: string }).image)
}

const okFetch: FetchLike = async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })

describe("§5 模态分支：声明 image 的模型", () => {
  test("Uint8Array 图片放行 → 信封 image 块为 data URL（可还原原字节）", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    const spy = logger()
    const prepared = await preparePromptImages(promptOf([filePart(bytes)]), {
      inputModalities: ["text", "image"],
      modelId: MODEL_ID,
      fetch: okFetch,
      logger: spy,
    })
    const images = imagesOf(prepared)
    expect(images).toHaveLength(1)
    expect(images[0]).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`)
    expect(spy.warnLogs).toEqual([])
  })

  test("URL 引用（URL 对象）→ 下载成功转 data URL，不丢弃", async () => {
    const bytes = new Uint8Array([9, 9, 9])
    const spy = logger()
    const prepared = await preparePromptImages(promptOf([filePart(new URL("https://example.com/a.png"))]), {
      inputModalities: ["text", "image"],
      modelId: MODEL_ID,
      fetch: async () => new Response(bytes, { status: 200 }),
      logger: spy,
    })
    const images = imagesOf(prepared)
    expect(images).toHaveLength(1)
    expect(images[0]).toBe(`data:image/png;base64,${btoa("\t\t\t")}`)
    expect(spy.warnLogs).toEqual([])
  })

  test("URL 字符串（http/https）同样下载转换", async () => {
    const bytes = new Uint8Array([7, 7])
    const prepared = await preparePromptImages(promptOf([filePart("https://example.com/b.png")]), {
      inputModalities: ["text", "image"],
      modelId: MODEL_ID,
      fetch: async () => new Response(bytes, { status: 200 }),
      logger: logger(),
    })
    expect(imagesOf(prepared)).toEqual([`data:image/png;base64,${btoa("\x07\x07")}`])
  })

  test("data: URL 字符串原样透传（envelope 同步转换不重复下载）", async () => {
    const dataUrl = "data:image/png;base64,AAAA"
    const spy = logger()
    const prepared = await preparePromptImages(promptOf([filePart(dataUrl)]), {
      inputModalities: ["text", "image"],
      modelId: MODEL_ID,
      fetch: okFetch,
      logger: spy,
    })
    expect(imagesOf(prepared)).toEqual([dataUrl])
  })

  test("大图不设客户端尺寸限：数 MB 图片照常转换（超限由网关 400 浮出）", async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(0xab)
    const prepared = await preparePromptImages(promptOf([filePart(bytes)]), {
      inputModalities: ["text", "image"],
      modelId: MODEL_ID,
      fetch: okFetch,
      logger: logger(),
    })
    const images = imagesOf(prepared)
    expect(images).toHaveLength(1)
    expect(images[0]).toContain("data:image/png;base64,")
  })
})

describe("§5 模态分支：未声明 image 的模型（防御路径）", () => {
  test("图片 part 全部丢弃 + warn，文本保留照发", async () => {
    const spy = logger()
    const prompt = promptOf([
      { type: "text", text: "看图说话" },
      filePart(new Uint8Array([1])),
      filePart(new Uint8Array([2])),
    ])
    const prepared = await preparePromptImages(prompt, {
      inputModalities: ["text"], // 未声明 image
      modelId: MODEL_ID,
      fetch: okFetch,
      logger: spy,
    })
    expect(imagesOf(prepared)).toEqual([])
    expect(spy.warnLogs.some((log) => log.includes("未声明 image"))).toBe(true)
    expect(spy.warnLogs.some((log) => log.includes("2 张"))).toBe(true)
    // 文本消息仍在（不因丢图把整条消息抹掉）
    const { body } = buildEnvelope({ prompt: prepared } as LanguageModelV3CallOptions, context())
    const first = body.params.messages[0]
    expect(first?.role).toBe("user")
    if (first?.role === "user") {
      expect(first.content).toEqual([{ type: "text", text: "看图说话" }])
    }
  })

  test("inputModalities 缺省/空数组视同未声明", async () => {
    const spy = logger()
    for (const inputModalities of [undefined as unknown as string[], []]) {
      const prepared = await preparePromptImages(promptOf([filePart(new Uint8Array([1]))]), {
        inputModalities,
        modelId: MODEL_ID,
        fetch: okFetch,
        logger: spy,
      })
      expect(imagesOf(prepared)).toEqual([])
    }
    expect(spy.warnLogs.length).toBeGreaterThan(0)
  })
})

describe("§5 其他 file part 与 URL 下载失败", () => {
  test("mediaType 非 image/* 的 file part（pdf 等）丢弃 + warn（模态词表外）", async () => {
    const spy = logger()
    const prepared = await preparePromptImages(promptOf([filePart(new Uint8Array([1]), "application/pdf")]), {
      inputModalities: ["text", "image"],
      modelId: MODEL_ID,
      fetch: okFetch,
      logger: spy,
    })
    expect(imagesOf(prepared)).toEqual([])
    expect(spy.warnLogs.some((log) => log.includes("非图片文件"))).toBe(true)
  })

  test("URL 下载失败（网络错误）→ 丢弃 + warn，主文本照发（非静默）", async () => {
    const spy = logger()
    const prompt = promptOf([
      { type: "text", text: "正文照发" },
      filePart(new URL("https://example.com/gone.png")),
    ])
    const prepared = await preparePromptImages(prompt, {
      inputModalities: ["text", "image"],
      modelId: MODEL_ID,
      fetch: async () => {
        throw new TypeError("fetch failed")
      },
      logger: spy,
    })
    expect(imagesOf(prepared)).toEqual([])
    expect(spy.warnLogs.some((log) => log.includes("下载失败"))).toBe(true)
    const { body } = buildEnvelope({ prompt: prepared } as LanguageModelV3CallOptions, context())
    const first = body.params.messages[0]
    if (first?.role === "user") {
      expect(first.content).toEqual([{ type: "text", text: "正文照发" }])
    }
  })

  test("URL 下载非 2xx → 丢弃 + warn", async () => {
    const spy = logger()
    const prepared = await preparePromptImages(promptOf([filePart("https://example.com/404.png")]), {
      inputModalities: ["text", "image"],
      modelId: MODEL_ID,
      fetch: async () => new Response("not found", { status: 404 }),
      logger: spy,
    })
    expect(imagesOf(prepared)).toEqual([])
    expect(spy.warnLogs.some((log) => log.includes("下载失败"))).toBe(true)
  })
})

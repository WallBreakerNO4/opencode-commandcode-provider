import { describe, expect, test } from "bun:test"
import { DEFAULT_MODELS_URLS, resolveModelsUrls } from "../../src/models/urls.ts"
import type { ModelsUrlsLogger } from "../../src/models/urls.ts"

/** 收集 warn/debug 的假 logger（断言逐项丢弃与回退告警用） */
function fakeLogger() {
  const warns: string[] = []
  const debugs: string[] = []
  return {
    warns,
    debugs,
    debug: (message: string) => debugs.push(message),
    warn: (message: string) => warns.push(message),
  } satisfies ModelsUrlsLogger & { warns: string[]; debugs: string[] }
}

describe("三通道与优先级（§1.3：config > env > 默认列表）", () => {
  test("config 数组命中 config 通道", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({ config: ["https://a.example/models.json"], env: undefined, logger })
    expect(result.source).toBe("config")
    expect(result.urls).toEqual(["https://a.example/models.json"])
  })

  test("config 逗号分隔字符串同样命中 config 通道（两通道共用同一解析器）", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({
      config: "https://a.example/models.json, https://b.example/models.json",
      env: undefined,
      logger,
    })
    expect(result.source).toBe("config")
    expect(result.urls).toEqual(["https://a.example/models.json", "https://b.example/models.json"])
  })

  test("config 缺席时 env 兜底（逗号分隔）", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({ config: undefined, env: "https://e.example/models.json", logger })
    expect(result.source).toBe("env")
    expect(result.urls).toEqual(["https://e.example/models.json"])
  })

  test("config 与 env 同时存在：config 胜（env 不参与解析、不产生 warn）", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({
      config: ["https://config.example/models.json"],
      env: "https://env.example/models.json",
      logger,
    })
    expect(result.source).toBe("config")
    expect(result.urls).toEqual(["https://config.example/models.json"])
    expect(logger.warns).toEqual([])
  })

  test("config 与 env 都缺席：内置默认列表（ADR 0001 四渠道序）", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({ config: undefined, env: undefined, logger })
    expect(result.source).toBe("default")
    expect(result.urls).toEqual(DEFAULT_MODELS_URLS)
    expect(DEFAULT_MODELS_URLS).toEqual([
      "https://github.com/WallBreakerNO4/opencode-commandcode-provider/releases/latest/download/models.json",
      "https://registry.npmmirror.com/@wallbreakerno4/opencode-commandcode-models/latest/files/models.json",
      "https://unpkg.com/@wallbreakerno4/opencode-commandcode-models@latest/models.json",
      "https://raw.githubusercontent.com/WallBreakerNO4/opencode-commandcode-provider/data/models.json",
    ])
  })

  test("config 整体非法 → 试 env → env 合法则 env 胜（逐级回退）", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({ config: 42, env: "https://env.example/models.json", logger })
    expect(result.source).toBe("env")
    expect(result.urls).toEqual(["https://env.example/models.json"])
    expect(logger.warns.some((message) => message.includes("回退内置默认列表"))).toBe(true)
  })

  test("解析结果与来源打 debug 日志", () => {
    const logger = fakeLogger()
    resolveModelsUrls({ config: ["https://a.example/models.json"], env: undefined, logger })
    expect(logger.debugs.some((message) => message.includes("来源=config") && message.includes("https://a.example/models.json"))).toBe(true)
  })
})

describe("整列表替换语义（§1.3：不拼接不插位）", () => {
  test("config 列表完整取代默认列表——结果里不掺任何默认渠道", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({ config: ["https://only.example/models.json"], env: undefined, logger })
    expect(result.urls).toEqual(["https://only.example/models.json"])
    expect(result.urls.some((url) => DEFAULT_MODELS_URLS.includes(url))).toBe(false)
  })

  test("单条 config 也整列表生效（不与默认拼接）", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({ config: "https://mirror.example/models.json", env: undefined, logger })
    expect(result.urls).toHaveLength(1)
  })
})

describe("非法值处理（§1.3：逐项丢弃 / 整体回退，不阻断启动）", () => {
  test("逐项校验：非法项丢弃 + 逐项 warn，合法项保留", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({
      config: ["https://good.example/models.json", "ftp://bad.example/x", "not a url"],
      env: undefined,
      logger,
    })
    expect(result.source).toBe("config")
    expect(result.urls).toEqual(["https://good.example/models.json"])
    expect(logger.warns.some((message) => message.includes("ftp://bad.example/x"))).toBe(true)
    expect(logger.warns.some((message) => message.includes("not a url"))).toBe(true)
    expect(logger.warns).toHaveLength(2)
  })

  test("非字符串数组元素同样逐项丢弃（42、null、对象）", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({
      config: [42, null, ["x"], "https://good.example/models.json"],
      env: undefined,
      logger,
    })
    expect(result.urls).toEqual(["https://good.example/models.json"])
    expect(logger.warns).toHaveLength(3)
  })

  test("http 之外的协议拒绝：file: 与 ws: 都不是 http(s) 绝对 URL", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({
      config: ["file:///etc/models.json", "ws://x.example/models.json"],
      env: undefined,
      logger,
    })
    expect(result.source).toBe("default")
    expect(logger.warns.filter((message) => message.includes("非法项已丢弃"))).toHaveLength(2)
    expect(logger.warns.filter((message) => message.includes("回退内置默认列表"))).toHaveLength(1)
  })

  test("非数组/非字符串整体非法 → 回退默认 + warn 注明原值", () => {
    for (const bad of [42, true, { 0: "https://a.example/x" }, null]) {
      const logger = fakeLogger()
      const result = resolveModelsUrls({ config: bad, env: undefined, logger })
      expect(result.source).toBe("default")
      expect(result.urls).toEqual(DEFAULT_MODELS_URLS)
      expect(logger.warns.some((message) => message.includes("整体非法") || message.includes("回退内置默认列表"))).toBe(true)
    }
  })

  test("数组全部非法（合法项为零）→ 整体回退 + warn", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({ config: ["nope", ""], env: undefined, logger })
    expect(result.source).toBe("default")
    expect(logger.warns.filter((message) => message.includes("非法")).length).toBeGreaterThanOrEqual(2)
  })

  test("config 非法 + env 未设置 → 默认列表；每级回退都有 warn", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({ config: [], env: undefined, logger })
    expect(result.source).toBe("default")
    expect(logger.warns.some((message) => message.includes("合法项为零"))).toBe(true)
  })

  test("env 设了但整体非法 → 回退默认 + warn", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({ config: undefined, env: "not-a-url", logger })
    expect(result.source).toBe("default")
    expect(logger.warns.some((message) => message.includes("合法项为零"))).toBe(true)
  })

  test("env 空串/纯空白视为未配置（静默走默认，无 warn）", () => {
    for (const env of ["", "   "]) {
      const logger = fakeLogger()
      const result = resolveModelsUrls({ config: undefined, env, logger })
      expect(result.source).toBe("default")
      expect(logger.warns).toEqual([])
    }
  })

  test("config undefined（键未写）静默走 env/默认，无 warn 噪音", () => {
    const logger = fakeLogger()
    resolveModelsUrls({ config: undefined, env: undefined, logger })
    expect(logger.warns).toEqual([])
  })

  test("逗号字符串里的空段与尾逗号是格式噪音：静默跳过不 warn", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({
      config: "https://a.example/models.json,,https://b.example/models.json,",
      env: undefined,
      logger,
    })
    expect(result.urls).toEqual(["https://a.example/models.json", "https://b.example/models.json"])
    expect(logger.warns).toEqual([])
  })

  test("URL 前后空白 trim 后仍合法", () => {
    const logger = fakeLogger()
    const result = resolveModelsUrls({
      config: "  https://padded.example/models.json  ",
      env: undefined,
      logger,
    })
    expect(result.urls).toEqual(["https://padded.example/models.json"])
    expect(logger.warns).toEqual([])
  })

  test("任何非法输入都不抛错（不阻断启动）", () => {
    const logger = fakeLogger()
    for (const bad of [Symbol("x"), () => {}, NaN, new Date(0)]) {
      expect(() => resolveModelsUrls({ config: bad, env: undefined, logger })).not.toThrow()
    }
    expect(resolveModelsUrls({ config: new Date(0), env: undefined, logger }).source).toBe("default")
  })
})

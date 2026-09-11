import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { MODELS_API_URL } from "../../src/models/pipeline.ts"

const ARTIFACT_URL = "https://fixture.commandcode.test/models.json"

const ARTIFACT = {
  schemaVersion: 1,
  generatedAt: "2026-09-11T00:00:00.000Z",
  sourceCliVersion: "1.53.0",
  models: [
    {
      id: "fixture/model",
      name: "Fixture",
      reasoning: false,
      inputModalities: ["text"],
      context: 64_000,
      maxOutput: 8_000,
    },
  ],
}

const MODELS = {
  object: "list",
  data: [
    {
      id: "fixture/model",
      object: "model",
      created: 1,
      owned_by: "fixture",
      context_length: 64_000,
      name: "Fixture",
    },
  ],
}

interface StartupResult {
  debugCalls: string[]
  warnCalls: string[]
  modelCount: number
}

function runIsolatedV1Startup(
  mode: "success" | "failure" | "factory-copy" | "factory-copy-unmarked",
  loadV1Plugin = true,
): StartupResult {
  const script = `
    ${loadV1Plugin ? 'import plugin from "./src/index.ts"' : ""}

    const mode = ${JSON.stringify(mode)}
    const modelsApiUrl = ${JSON.stringify(MODELS_API_URL)}
    const artifactUrl = ${JSON.stringify(ARTIFACT_URL)}
    const artifact = ${JSON.stringify(ARTIFACT)}
    const models = ${JSON.stringify(MODELS)}
    const originalLog = console.log
    const originalDebug = console.debug
    const originalWarn = console.warn
    const debugCalls = []
    const warnCalls = []

    globalThis.fetch = async (input) => {
      if (mode === "failure") throw new Error("offline")
      if (String(input) === modelsApiUrl) return Response.json(models)
      return Response.json(artifact)
    }
    console.debug = (message) => debugCalls.push(String(message))
    console.warn = (message) => warnCalls.push(String(message))

    try {
      const config = { provider: { "commandcode-go": { options: { modelsUrls: [artifactUrl] } } } }
      if (${String(loadV1Plugin)}) {
        const hooks = await plugin.server({}, {})
        await hooks.config(config)
      }
      if (mode === "factory-copy" || mode === "factory-copy-unmarked") {
        const { createCommandCode } = await import("./src/provider/model.ts?provider-copy")
        createCommandCode({
          name: "commandcode-go",
          fetch: globalThis.fetch,
          ...(mode === "factory-copy" ? config.provider["commandcode-go"].options : {}),
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      originalLog(JSON.stringify({
        debugCalls,
        warnCalls,
        modelCount: Object.keys(config.provider["commandcode-go"].models ?? {}).length,
      }))
    } finally {
      console.debug = originalDebug
      console.warn = originalWarn
    }
  `
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: resolve(import.meta.dir, "../.."),
    encoding: "utf8",
  })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  return JSON.parse(result.stdout.trim()) as StartupResult
}

test("v1 启动成功拉取静默，不污染 console", () => {
  const captured = runIsolatedV1Startup("success")
  expect(captured.warnCalls).toEqual([])
  expect(captured.debugCalls).toEqual([])
  expect(captured.modelCount).toBe(1)
})

test("v1 启动拉取失败保留 warn，不产生成功 debug", () => {
  const captured = runIsolatedV1Startup("failure")
  expect(captured.debugCalls).toEqual([])
  expect(captured.warnCalls.some((message) => message.includes("构建产物拉取失败"))).toBe(true)
  expect(captured.warnCalls.some((message) => message.includes("/provider/v1/models 拉取失败"))).toBe(true)
  expect(captured.modelCount).toBeGreaterThan(0)
})

test("v1 进入 TUI 后加载另一份 provider 工厂仍不产生成功 debug", () => {
  const captured = runIsolatedV1Startup("factory-copy")
  expect(captured.debugCalls).toEqual([])
  expect(captured.warnCalls).toEqual([])
  expect(captured.modelCount).toBe(1)
})

test("未带 v1 标记且未加载 v1 插件的独立工厂保留默认 logger 行为", () => {
  const captured = runIsolatedV1Startup("factory-copy-unmarked", false)
  expect(captured.debugCalls).toHaveLength(2)
  expect(captured.warnCalls).toEqual([])
})

test("v1 插件加载后，未透传 marker 的 provider 副本仍静默 debug", () => {
  const captured = runIsolatedV1Startup("factory-copy-unmarked")
  expect(captured.debugCalls).toEqual([])
})

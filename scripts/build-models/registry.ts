/**
 * 构建输入的网络获取：npm registry / view=client catalog / models.dev。
 * 全部经 deps.fetch 接缝注入（testing.md §2 的 mock 通道哲学同样适用于构建脚本）；
 * 生产默认 globalThis.fetch。只做 GET 与 JSON/字节解析，不含任何状态。
 */

import { parseClientCatalog, type ClientCatalog } from "./client-catalog.ts"

export interface FetchDeps {
  readonly fetch?: typeof globalThis.fetch
}

export const CLI_REGISTRY_URL = "https://registry.npmjs.org/command-code/latest"
export const CLIENT_CATALOG_URL = "https://api.commandcode.ai/provider/v1/models?view=client"
export const MODELS_DEV_URL = "https://models.dev/api.json"

export function tarballUrlFor(version: string): string {
  return `https://registry.npmjs.org/command-code/-/command-code-${version}.tgz`
}

async function getBytes(url: string, deps: FetchDeps): Promise<Uint8Array<ArrayBuffer>> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const response = await doFetch(url)
  if (!response.ok) {
    throw new Error(`GET ${url} 失败：HTTP ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

export interface CliRelease {
  readonly version: string
  readonly tarballUrl: string
}

export async function fetchLatestCliRelease(deps: FetchDeps = {}): Promise<CliRelease> {
  const bytes = await getBytes(CLI_REGISTRY_URL, deps)
  const meta = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown; dist?: { tarball?: unknown } }
  if (typeof meta.version !== "string" || typeof meta.dist?.tarball !== "string") {
    throw new Error(`registry 响应缺 version / dist.tarball 字段：${CLI_REGISTRY_URL}`)
  }
  return { version: meta.version, tarballUrl: meta.dist.tarball }
}

/** view=client catalog（发现权威）：官方 1.84.0 起 CLI 运行时同款端点 */
export async function fetchClientCatalog(deps: FetchDeps = {}): Promise<ClientCatalog> {
  const bytes = await getBytes(CLIENT_CATALOG_URL, deps)
  return parseClientCatalog(JSON.parse(new TextDecoder().decode(bytes)))
}

export async function downloadTarball(tarballUrl: string, deps: FetchDeps = {}): Promise<Uint8Array<ArrayBuffer>> {
  return getBytes(tarballUrl, deps)
}

/** 返回 api.json 原始字节（hash 用）与解析结果（limits 补全用），一次下载两用 */
export async function fetchModelsDev(deps: FetchDeps = {}): Promise<{ bytes: Uint8Array<ArrayBuffer>; api: unknown }> {
  const bytes = await getBytes(MODELS_DEV_URL, deps)
  return { bytes, api: JSON.parse(new TextDecoder().decode(bytes)) }
}

/**
 * v1 宿主接线（#37；实测定案 #11，原型证据在弃用分支 prototype/v1-host-loading）。
 *
 * 用户 config 只写一行 `plugin: ["@wallbreakerno4/opencode-commandcode"]`，其余全部
 * 自举（与 v2 glue #36 共用工厂与运行时，宿主形态互不干扰）：
 *
 * - **三合一入口**：`server(input, options)` 由 v1 加载器消费（default 带 id 时
 *   server 必须在场，否则整模块跳过，#11 实测），返回 `{config, auth}` hooks。
 *   v1.18.x 是双轨宿主——内嵌 v2 运行时也会以嵌入式 ctx 调 default.setup，但它
 *   懒加载且晚于 v1 config hook（1.18.25 真宿主探针实测），管线模式由先到的 v1
 *   config hook 协商为 v1，setup 的构造调用幂等落空。
 * - **config hook**：注入 `provider.commandcode-go = {npm, name, env, models}`。
 *   npm 指向本包安装 spec（推导方式见 selfNpmSpec——注入裸包名会装出第二个模块
 *   实例）；宿主经 arborist 缓存命中后 import 同一模块实例（目录存在即缓存命中，
 *   #11 实测），按「第一个 create* 导出」判得与 v2 共用的工厂。注入前先以用户
 *   已写的 `options.modelsUrls` 做 v1 启动协商（拉取一次，15s 总预算，失败用快照，
 *   此后无后台刷新——v1 无 reload 机制），模型清单 = 协商后的级联。
 * - **非破坏合并**：用户已写键一律优先（npm/name/env 整键、options 整块、models
 *   逐 id）——插件只补缺，绝不覆盖用户显式配置；`options` 全权归用户（modelsUrls
 *   通道所在），插件不注入任何默认值。
 * - **auth hook**：注册 `/connect` 登录项（label 固定「Command Code API Key」，
 *   CONTEXT.md）；loader 仅在 auth.json 有该 provider 凭证记录时被宿主调用（无凭证
 *   不触发，#11 实测），把凭证翻译成工厂 `apiKey`；优先级 auth > env 由宿主保证
 *   （与 v2 credential > env 一致）。
 * - **测试边界**（testing.md §4 定案）：hook 的宿主交互行为不入 bun test——mock
 *   宿主 = 重写宿主，验证 = 真宿主 v1（latest 1.18.x）验证，全程 XDG 隔离；
 *   hooks 静态形状与 selfNpmSpec 纯函数推导在 bun test 内（testing.md §1.4）。
 *
 * 零依赖纪律（入口既定）：不 import `@opencode-ai/plugin`，宿主对象以本模块的
 * 最小结构类型承接——字段名按 v1.18.25 真宿主探针收窄到 glue 触达的域，宿主漂移
 * 时真宿主验证即暴露，不为漂移预付兼容成本。
 */

import { ENTRY_URL } from "../index.js"
import { toV1ModelMap } from "../models/mapping.js"
import { PROVIDER_ID } from "../protocol/envelope.js"
import { ensureV1ProviderRuntime } from "../provider/model.js"
import { API_KEY_ENV_VAR, API_KEY_METHOD_LABEL, PROVIDER_DISPLAY_NAME } from "./constants.js"

/**
 * config hook 注入的 npm spec：从入口模块自身的加载路径推导（#37 真宿主验证定案）。
 * v1 宿主对 plugin 列表的裸包名会归一化为 `<name>@latest` 再定 arborist 缓存目录，
 * 而 provider 的 `npm` spec **原样**定目录——注入裸包名会装出第二个模块实例，
 * 伪装状态与模型管线全部翻倍（违背「v1 无后台刷新」与伪装 per-key 状态的进程内
 * 单例前提）。因此 spec 不能写死包名，按 v1 缓存目录布局
 * `…/opencode/packages/<spec>/node_modules/…` 从实际加载路径提取：
 * - 正常安装形态（plugin 裸包名 → @latest 归一化、版本钉死等）：提取出的 `<spec>`
 *   使 provider 解析命中同一缓存目录（目录存在即缓存命中，#11 实测）——同一模块
 *   实例。
 * - 其余形态（本地 file:// 直载开发、缓存布局漂移）：回退入口自身 URL，免安装
 *   直接 import（#11 实测 file:// 绝对路径形态可用；file: 相对路径残缺不可用，
 *   不产出）。
 * 推导在 server() 调用时进行（ENTRY_URL 此时必已初始化，规避环导 TDZ）。
 */
export function selfNpmSpec(entryUrl: string): string {
  const marker = "/opencode/packages/"
  const start = entryUrl.indexOf(marker)
  if (entryUrl.startsWith("file:") && start !== -1) {
    const from = start + marker.length
    const end = entryUrl.indexOf("/node_modules/", from)
    if (end !== -1) return entryUrl.slice(from, end)
  }
  return entryUrl
}

// ---------------------------------------------------------------------------
// 宿主对象最小结构类型（零依赖承接；形状出处：v1.18.25 真宿主探针）
// ---------------------------------------------------------------------------

/** v1 provider config 块：注入字段 + 用户可能已写的任意字段 */
export interface V1ProviderConfig {
  npm?: string
  name?: string
  env?: string[]
  /** options 块全权归用户（modelsUrls 通道所在）；插件不注入、不合并、原样保留 */
  options?: Record<string, unknown>
  models?: Record<string, unknown>
}

/** v1 config hook 收到的宿主 config 对象：只触达 provider 域，其余字段零知识 */
export interface V1ConfigObject {
  provider?: Record<string, V1ProviderConfig | undefined>
}

/** v1 auth hook 的登录方式：/connect 列表项（api 类型 + label） */
export interface V1AuthMethod {
  readonly type: "api"
  readonly label: string
}

/** v1 auth hook：provider 凭证通道注册（#11 实测消费行为；宿主以 (auth, provider) 调用） */
export interface V1AuthHook {
  readonly provider: string
  /** 仅在 auth.json 有该 provider 凭证记录时被调；auth 参数可能是懒加载函数 */
  readonly loader: (auth: unknown) => Promise<{ apiKey: string }>
  readonly methods: readonly V1AuthMethod[]
}

/** server() 返回的 v1 hooks（v1 加载器消费的全部面） */
export interface V1Hooks {
  config: (config: V1ConfigObject) => Promise<void>
  auth: V1AuthHook
}

// ---------------------------------------------------------------------------
// provider 块注入（非破坏合并）
// ---------------------------------------------------------------------------

/**
 * 注入 provider 块：插件自举字段垫底、用户已写键一律优先。models 逐 id 合并——
 * 用户手写的模型条目保留（覆盖同 id 的管线产物），其余由级联清单补齐。
 */
function mergeProviderBlock(
  npmSpec: string,
  existing: V1ProviderConfig | undefined,
  models: ReturnType<typeof toV1ModelMap>,
): V1ProviderConfig {
  const merged: V1ProviderConfig = {
    name: PROVIDER_DISPLAY_NAME,
    npm: npmSpec,
    env: [API_KEY_ENV_VAR],
    ...existing,
    models: { ...models, ...existing?.models },
  }
  return merged
}

// ---------------------------------------------------------------------------
// server()：v1 插件入口
// ---------------------------------------------------------------------------

/**
 * v1 插件入口（default.server）：返回 config / auth hooks。纯函数——宿主可能在
 * config 重载或 auth login 等场景重复调用，重放注入幂等（同级联 → 同块）。
 */
export async function serverV1(_input: unknown, _options: unknown): Promise<V1Hooks> {
  // 自举 npm spec 按实际加载路径推导（见 selfNpmSpec）；此时入口模块必已完成求值
  const npmSpec = selfNpmSpec(ENTRY_URL)
  return {
    config: async (config) => {
      const existing = config.provider?.[PROVIDER_ID]
      // 用户 modelsUrls 通道（model-pipeline.md §1.3）：仅用户已写时读取，作为
      // v1 启动拉取的 config 通道初值（config > env > 默认列表）
      const userModelsUrls = (existing?.options as { modelsUrls?: unknown } | undefined)?.modelsUrls
      // v1 启动协商：15s 总预算拉取一次（跨渠道共享），失败用快照；若运行时已被
      // 工厂先行 / 内嵌 v2 setup 先行构造，幂等守卫使本调用退化为读当前级联
      const cascade = await ensureV1ProviderRuntime({ modelsUrls: userModelsUrls })
      config.provider ??= {}
      config.provider[PROVIDER_ID] = mergeProviderBlock(npmSpec, existing, toV1ModelMap(cascade.models))
    },

    auth: {
      provider: PROVIDER_ID,
      loader: async (auth) => {
        // 宿主传懒加载函数或现值（#11 原型实测两种形态）；key 缺位 = 凭证记录损坏，
        // 空 apiKey 按 auth > env 优先级压过 env，请求以 401 浮现——warn 指路重新登录
        const resolved = (typeof auth === "function" ? await auth() : auth) as { key?: string } | null | undefined
        const key = resolved?.key
        if (!key) {
          console.warn("[commandcode-go] 凭证记录存在但 key 为空，请求将返回 401；请重新 /connect 登录")
        }
        return { apiKey: key ?? "" }
      },
      methods: [{ type: "api", label: API_KEY_METHOD_LABEL }],
    },
  }
}

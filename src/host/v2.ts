/**
 * v2 宿主接线（#36；实测定案 #12/#5；宿主 API 世代：2.0.4+ 的 provider/model 域）。
 *
 * 用户 config 无需 provider 空壳（正式版探针定案，docs/dev/research/v2-stable-probe.md），
 * 其余全部自举：
 *
 * - **provider.transform 自指注册**（#12 S1 定案）：`editor.add` 注册 provider source，
 *   `package` 设 `"aisdk:" + <入口模块 URL>`——宿主剥掉 `aisdk:` 前缀后原生 import
 *   该文件，命中同一模块实例（instance seq 全程 = 1，伪装模块进程内状态安全的前提）；
 *   锚点取入口模块的 `import.meta.url`（ENTRY_URL）而非 glue 子模块的——工厂判据
 *   「第一个 create* 导出」作用在入口模块上。`aisdk:<registry 包名>` 链路在
 *   beta-18684 已死（UnsupportedPackageError），不用。模型全量随 source 注册
 *   （add 的 models 清单；source 定义自包含，无宿主默认基线合并）：首播 = 包内快照
 *   （启动零阻塞），后台拉取签名变化触发 `provider.reload()` 重放本 transform，届时
 *   latestCascade 已是管线实时级联。
 * - **integration.transform 认证**（#12 S2 定案）：为全新 provider upsert
 *   integration（update 是 upsert，无需预存），注册 key 方法（/connect 粘贴）与
 *   env 方法；凭证由宿主解析后经工厂 `apiKey` 注入，优先级 credential > env。
 * - **modelsUrls v2 settings 通道**：用户写的 `settings.modelsUrls` 由宿主合并进
 *   工厂 options 顶层（beta-18684 实测：transform 草稿不带 config settings，插件
 *   侧构造时不可见），首次工厂调用经管线 rebindModelsUrls 接入（config > env >
 *   默认列表，原值不变零开销跳过）；settings 壳其余字段原样保留不 clobber。
 * - **宿主世代边界**：provider/model 域自 OpenCode 2.0.4 引入（catalog 域为
 *   2.0.0–2.0.3 专用，2.0.4 起移除）——v2 面最低支持 2.0.4。v1 宿主内嵌 runtime
 *   （catalog 世代）也会调 setup，但 v1 功能走 server() config hook 且先到协商
 *   （#37），本模块对缺 provider 域的 ctx 安静退出。
 * - **测试边界**（testing.md §4 定案）：glue 是全项目唯一无自动化测试的模块——
 *   mock 宿主 = 重写宿主；验证 = 真宿主（v2 正式版）验证 + 人工验收。
 *
 * 零依赖纪律（入口既定）：不 import 官方插件 SDK（`@opencode/plugin`），宿主 ctx
 * 以本模块的最小结构类型承接——字段名按 node_modules 的正式版 SDK 类型
 * （2.0.4+）收窄到 glue 触达的域，宿主漂移时真宿主验证即暴露，不为漂移预付兼容
 * 成本。
 */

import { ENTRY_URL } from "../index.js"
import { toV2ModelFields } from "../models/mapping.js"
import type { V2ModelFields } from "../models/mapping.js"
import { PROVIDER_ID } from "../protocol/envelope.js"
import { ensureProviderRuntime, latestCascade } from "../provider/model.js"
import { API_KEY_ENV_VAR, API_KEY_METHOD_LABEL, PROVIDER_DISPLAY_NAME } from "./constants.js"

// ---------------------------------------------------------------------------
// 宿主 ctx 最小结构类型（零依赖承接；形状出处：@opencode/plugin@2.0.4+ SDK 类型）
// 显示名 / 认证 label / env 变量三常量见 constants.ts（v1/v2 glue 单源）。
// ---------------------------------------------------------------------------

/** `Provider.Info` 中 glue 写入的场：settings 只读不写（config 通道原样保留） */
interface ProviderInfoDraft {
  id: string
  name: string
  package: string
  activation: "auto" | "enabled" | "disabled"
  integrationID?: string
}

/** `Model.Info` 中 glue 写入的场：source 定义自包含——cost 空数组 = 不写价格
 * （model-pipeline.md §3.2），time/status/enabled 取固定基线值 */
interface ModelInfoDraft {
  id: string
  modelID: string
  providerID: string
  name: string
  capabilities: { tools: boolean; input: string[]; output: string[] }
  limit: { context: number; output: number }
  variants: Array<{ id: string; settings?: Record<string, unknown> }>
  cost: unknown[]
  time: { released: number }
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
}

interface ProviderEditor {
  add(input: { info: ProviderInfoDraft; models: readonly ModelInfoDraft[] }): void
  update(providerID: string, update: (provider: ProviderInfoDraft) => void): void
  remove(providerID: string): void
}

interface ProviderDomain {
  readonly transform: (callback: (editor: ProviderEditor) => void) => Promise<unknown>
  readonly reload: () => Promise<void>
}

type IntegrationMethodRegistration = {
  readonly integrationID: string
  readonly method:
    | { readonly type: "key"; readonly label?: string }
    | { readonly type: "env"; readonly names: readonly string[] }
}

interface IntegrationDraft {
  readonly update: (id: string, update: (integration: { name: string }) => void) => void
  readonly method: {
    readonly update: (input: IntegrationMethodRegistration) => void
  }
}

interface IntegrationDomain {
  readonly transform: (callback: (draft: IntegrationDraft) => void) => Promise<unknown>
}

interface V2PluginContext {
  readonly provider?: ProviderDomain
  readonly integration: IntegrationDomain
}

// ---------------------------------------------------------------------------
// 级联模型 → add 的 models 输入
// ---------------------------------------------------------------------------

function toModelInfo(model: V2ModelFields): ModelInfoDraft {
  return {
    id: model.id,
    modelID: model.modelID,
    providerID: PROVIDER_ID,
    name: model.name,
    capabilities: {
      tools: model.capabilities.tools,
      input: [...model.capabilities.input],
      output: [...model.capabilities.output],
    },
    limit: { context: model.limit.context, output: model.limit.output },
    // 严格透传（model-pipeline.md §3.1）：产物无档位即空数组，不造变体
    variants: model.variants.map((variant) => ({
      id: variant.id,
      settings: { reasoningEffort: variant.settings.reasoningEffort },
    })),
    cost: [],
    time: { released: 0 },
    status: "active",
    enabled: true,
  }
}

// ---------------------------------------------------------------------------
// setup 接线
// ---------------------------------------------------------------------------

/**
 * v2 插件入口（default.setup）：自举 provider、模型与认证方法，并把共享运行时
 * 接上宿主目录。幂等——插件热重载重跑 setup 时 transform 重放为同一 source（重放
 * 自 fresh 值开始）、运行时幂等构造、reload 回调重设到活 ctx。
 */
export async function setupV2(context: unknown): Promise<void> {
  const ctx = context as V2PluginContext
  const provider = ctx.provider

  // 宿主世代守卫：provider 域 = v2 宿主（2.0.4+）标识；v1 内嵌 runtime（catalog
  // 世代）的 setup 调用不承载 v2 注册，安静退出（v1 功能由 server() 承担，#37）
  if (provider === undefined || typeof provider.transform !== "function") return

  await provider.transform((editor) => {
    editor.add({
      info: {
        id: PROVIDER_ID,
        name: PROVIDER_DISPLAY_NAME,
        // 自指（#12 S1 定案）：aisdk: 前缀强制（漏写即 UnsupportedPackageError）；
        // 锚点是入口模块 ENTRY_URL（create* 工厂判据所在），宿主再 import 同一路径
        // 命中同一模块实例
        package: `aisdk:${ENTRY_URL}`,
        activation: "auto",
        integrationID: PROVIDER_ID,
      },
      // 模型注册：目录键与上游 modelID 同为 wire id（可含 `/`）。首播 = 包内快照
      //（启动零阻塞）；后台拉取签名变化触发 provider.reload() 重放本回调，届时
      // latestCascade() 已是管线实时级联
      models: latestCascade().models.map(toV2ModelFields).map(toModelInfo),
    })
  })

  // 认证方法（#12 S2 定案）：integration.update 为全新 provider upsert；key 方法
  // 带 /connect 输入框 label，env 方法声明环境变量；integrationID 与 providerID
  // 同名——凭证解析终点是工厂 options.apiKey，优先级 credential > env 由宿主保证
  await ctx.integration.transform((draft) => {
    draft.update(PROVIDER_ID, (integration) => {
      integration.name = PROVIDER_DISPLAY_NAME
    })
    draft.method.update({
      integrationID: PROVIDER_ID,
      method: { type: "key", label: API_KEY_METHOD_LABEL },
    })
    draft.method.update({
      integrationID: PROVIDER_ID,
      method: { type: "env", names: [API_KEY_ENV_VAR] },
    })
  })

  // 共享运行时（模型管线 + 伪装状态单例）：注册全部完成后构造——变更回调只会晚于
  // 此刻触发，reload 不会空放。构造时管线按 env/默认列表启动并后台首轮拉取（启动
  // 零阻塞）；modelsUrls 的 config 通道（settings.modelsUrls）在 beta-18684 的
  // transform 草稿上不可见（宿主在目录构建后才合并，实测探针 settings=null），它
  // 由宿主合并进工厂 options、经首次工厂调用 rebindModelsUrls 接入管线
  ensureProviderRuntime({
    onModelDataChange: () => {
      provider.reload().catch((error: unknown) => {
        // reload 失败目录停在上一份级联：打 warn 留痕，不打断后台刷新节奏
        console.warn(`[commandcode-go] provider.reload 失败（${String(error)}），目录沿用上一份级联`)
      })
    },
  })
}

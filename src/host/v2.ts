/**
 * v2 宿主接线（#36；实测定案 #12/#5）。
 *
 * 用户 config 只写空壳 `{providers: {"commandcode-go": {}}}`，其余全部自举：
 *
 * - **catalog.transform 自指注册**（#12 S1 定案）：provider.update 设
 *   `package = "aisdk:" + <入口模块 URL>`——宿主剥掉 `aisdk:` 前缀后原生 import
 *   该文件，命中同一模块实例（instance seq 全程 = 1，伪装模块进程内状态安全
 *   的前提）；锚点取入口模块的 `import.meta.url`（ENTRY_URL）而非 glue 子模块的
 *   ——工厂判据「第一个 create* 导出」作用在入口模块上。`aisdk:<registry 包名>`
 *   链路在 beta-18684 已死（UnsupportedPackageError），不用。模型按级联清单
 *   update-or-create 注册：首播 = 包内快照（启动零阻塞），后台拉取签名变化触发
 *   `catalog.reload()` 重放本 transform，届时 latestCascade 已是管线实时级联。
 * - **integration.transform 认证**（#12 S2 定案）：为全新 provider upsert
 *   integration（update 是 upsert，无需预存），注册 key 方法（/connect 粘贴）与
 *   env 方法；凭证由宿主解析后经工厂 `apiKey` 注入，优先级 credential > env。
 * - **modelsUrls v2 settings 通道**：用户写的 `settings.modelsUrls` 由宿主合并进
 *   工厂 options 顶层（beta-18684 实测：transform 草稿不带 config settings，插件
 *   侧构造时不可见），首次工厂调用经管线 rebindModelsUrls 接入（config > env >
 *   默认列表，原值不变零开销跳过）；settings 壳其余字段原样保留不 clobber。
 * - **测试边界**（testing.md §4 定案）：glue 是全项目唯一无自动化测试的模块——
 *   mock 宿主 = 重写宿主；验证 = 真宿主（锁定 v2 beta 快照）验证 + #21 人工验收。
 *
 * 零依赖纪律（入口既定）：不 import `@opencode-ai/plugin`，宿主 ctx 以本模块的
 * 最小结构类型承接——字段名按 node_modules 实测的 beta d.ts 收窄到 glue 触达的
 * 域，宿主漂移时真宿主验证即暴露，不为漂移预付兼容成本。
 */

import { ENTRY_URL } from "../index.js"
import { toV2ModelFields } from "../models/mapping.js"
import { PROVIDER_ID } from "../protocol/envelope.js"
import { ensureProviderRuntime, latestCascade } from "../provider/model.js"
import { API_KEY_ENV_VAR, API_KEY_METHOD_LABEL, PROVIDER_DISPLAY_NAME } from "./constants.js"

// ---------------------------------------------------------------------------
// 宿主 ctx 最小结构类型（零依赖承接；形状出处：@opencode-ai/plugin beta d.ts）
// 显示名 / 认证 label / env 变量三常量见 constants.ts（v1/v2 glue 单源）。
// ---------------------------------------------------------------------------

/** Provider.Info 中 glue 写入的场：settings 只读不写（config 通道原样保留） */
interface ProviderDraft {
  name: string
  package: string
  activation: "auto" | "enabled" | "disabled"
  integrationID?: string
  settings?: Record<string, unknown>
}

/** Model.Info 中 glue 写入的场：字段归宿主默认基线的（cost/status/enabled/time）
 * 只在缺位时补，已有值不覆盖 */
interface ModelDraft {
  id: string
  modelID: string
  name: string
  capabilities: { tools: boolean; input: string[]; output: string[] }
  limit: { context: number; output: number }
  variants: Array<{ id: string; settings?: Record<string, unknown> }>
  status?: "alpha" | "beta" | "deprecated" | "active"
  enabled?: boolean
  time?: { released: number }
}

interface CatalogDraft {
  readonly provider: {
    readonly update: (providerID: string, update: (provider: ProviderDraft) => void) => void
  }
  readonly model: {
    readonly update: (
      providerID: string,
      modelID: string,
      update: (model: ModelDraft) => void,
    ) => void
  }
}

type IntegrationMethodRegistration = {
  readonly integrationID: string
  readonly method: { readonly type: "key"; readonly label?: string } | { readonly type: "env"; readonly names: readonly string[] }
}

interface IntegrationDraft {
  readonly update: (id: string, update: (integration: { name: string }) => void) => void
  readonly method: {
    readonly update: (input: IntegrationMethodRegistration) => void
  }
}

interface V2PluginContext {
  readonly catalog: {
    readonly transform: (callback: (draft: CatalogDraft) => void) => Promise<unknown>
    readonly reload: () => Promise<void>
  }
  readonly integration: {
    readonly transform: (callback: (draft: IntegrationDraft) => void) => Promise<unknown>
  }
}

// ---------------------------------------------------------------------------
// setup 接线
// ---------------------------------------------------------------------------

/**
 * v2 插件入口（default.setup）：自举 provider、模型与认证方法，并把共享运行时
 * 接上宿主目录。幂等——插件热重载重跑 setup 时 transform 重放为 upsert、运行时
 * 幂等构造、reload 回调重设到活 ctx。
 */
export async function setupV2(context: unknown): Promise<void> {
  const ctx = context as V2PluginContext

  await ctx.catalog.transform((draft) => {
    draft.provider.update(PROVIDER_ID, (provider) => {
      provider.name = PROVIDER_DISPLAY_NAME
      // 自指（#12 S1 定案）：aisdk: 前缀强制（漏写即 UnsupportedPackageError）；
      // 锚点是入口模块 ENTRY_URL（create* 工厂判据所在），宿主再 import 同一路径
      // 命中同一模块实例
      provider.package = `aisdk:${ENTRY_URL}`
      provider.integrationID = PROVIDER_ID
      provider.activation = "auto"
    })

    // 模型注册（update-or-create）：目录键与上游 modelID 同为 wire id（可含 `/`）。
    // 首播 = 包内快照（启动零阻塞）；后台拉取签名变化触发 catalog.reload() 重放本
    // 回调，届时 latestCascade() 已是管线实时级联
    for (const resolved of latestCascade().models.map(toV2ModelFields)) {
      draft.model.update(PROVIDER_ID, resolved.id, (model) => {
        model.id = resolved.id
        model.modelID = resolved.modelID
        model.name = resolved.name
        model.capabilities = {
          tools: true,
          input: [...resolved.capabilities.input],
          output: [...resolved.capabilities.output],
        }
        model.limit = { context: resolved.limit.context, output: resolved.limit.output }
        // 严格透传（model-pipeline.md §3.1）：产物无档位即空数组，不造变体
        model.variants = resolved.variants.map((variant) => ({
          id: variant.id,
          settings: { reasoningEffort: variant.settings.reasoningEffort },
        }))
        // 必填基线防御：字段归宿主 update-or-create 的 Model.Info 默认基线所有
        // （cost 省略 = 不写价格，model-pipeline.md §3.2；基线缺位才补），已有值
        // （含用户经 config 写入的 disabled）一律不覆盖
        model.status ??= "active"
        model.enabled ??= true
        model.time ??= { released: 0 }
      })
    }
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
      ctx.catalog.reload().catch((error: unknown) => {
        // reload 失败目录停在上一份级联：打 warn 留痕，不打断后台刷新节奏
        console.warn(`[commandcode-go] catalog.reload 失败（${String(error)}），目录沿用上一份级联`)
      })
    },
  })
}

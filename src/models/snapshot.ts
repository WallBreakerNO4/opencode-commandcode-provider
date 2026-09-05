/**
 * 包内快照（docs/spec/model-pipeline.md §5）：与构建产物同 schema 的「最后已知
 * 良好产物」，随插件发版从最新产物复制进来，是运行时永远可用的兜底层——不占
 * modelsUrls 列表位，产物/API 全部失败或从未成功时顶替产物角色（§5 降级表）。
 *
 * 发布流水线在插件打包前用最新构建产物整文件覆盖本常量；仓库内当前为占位空
 * 清单——正式产物由 models-pipeline（#28）按上游发版节奏产出。空 `models` 数组
 * 经 parseArtifact 合法（注册 0 个模型），运行时任何降级路径都不会因快照缺位
 * 而崩；版本头兜底链 ④ 取本快照的 `sourceCliVersion`（disguise.md §6）。
 */

/** 包内快照原文（与产物 schema v1 逐键一致，构建侧 emit.ts 为组装权威） */
export const PACKAGE_SNAPSHOT_JSON = {
  schemaVersion: 1,
  generatedAt: "1970-01-01T00:00:00Z",
  sourceCliVersion: "0.0.0",
  models: [],
} as const

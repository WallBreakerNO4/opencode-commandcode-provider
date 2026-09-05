/**
 * 包内快照（docs/spec/model-pipeline.md §5）：与构建产物同 schema 的「最后已知
 * 良好产物」，随插件发版从最新产物复制进来，是运行时永远可用的兜底层——不占
 * modelsUrls 列表位，产物/API 全部失败或从未成功时顶替产物角色（§5 降级表）。
 *
 * 产物原文在同目录 `snapshot.json`（逐字节来自构建产物，sha256 可与渠道产物对
 * 账）；刷新走 `pnpm embed-snapshot`（scripts/embed-snapshot.ts：运行时同款
 * parseArtifact schema 校验通过才写入，发布流程见 docs/release/release-process.md）。
 * build 脚本在 tsc 之后 `cp` 一份原文进 dist——tsc 自带的 JSON 复制会重排版，
 * 逐字节一致靠 cp 保住。空快照占位形态不存在——校验拒绝空清单入库；运行时任何
 * 降级路径都不会因快照缺位而崩（loadPackageSnapshot 的防御分支兜底）。
 * 快照 `sourceCliVersion` 同时是版本头兜底链 ④（disguise.md §6）。
 */

import snapshotJson from "./snapshot.json" with { type: "json" }

/** 包内快照原文（unknown：非可信数据，消费方一律经 parseArtifact 解析） */
export const PACKAGE_SNAPSHOT_JSON: unknown = snapshotJson

# 发布流程：两轮人工验收 → npm publish 主包

> 状态：就绪（issue #38 交付项）。验收清单：`docs/spec/acceptance.md`；分发渠道：`docs/adr/0001-artifact-distribution-channels.md`；npmmirror 登记：[npmmirror-whitelist-pr.md](./npmmirror-whitelist-pr.md)。
>
> **职责归属**：人工验收与发布命令由**维护者**执行；agent 只承担准备与文本工作。
> 验收发现的问题开新 issue 修订规格或实现，不就地偏离（acceptance.md 缺陷回路同款）。

## 0. 发布前置确认（维护者动作）

| 项 | 现状与核查方式 |
|---|---|
| `NPM_TOKEN` secret | 供 models-pipeline 渠道 2（npm 数据包）使用。核查方式：`npm view @wallbreakerno4/opencode-commandcode-models dist-tags` 有新版本持续出现（2026-09-05 核查：数据包已连发 12 版、latest `0.0.1788622352`，secret 有效）；或 `gh secret list`（维护者权限）确认在列。失效症状：Models pipeline 在「渠道 2 · npm 数据包」步 402/403 失败 → 整轮 run 失败、data 分支停更。补配：`gh secret set NPM_TOKEN`（automation token，需 publish 权限），补配后下一轮 cron 自动恢复。 |
| npmmirror files 白名单 | PR 文本草稿已就绪（npmmirror-whitelist-pr.md），fork / 提交 / 授权由维护者执行。**未合并不阻塞主包发布**：合并前渠道 2 稳定 403，客户端按默认 URL 列表落到 unpkg，无害。合并后需实测同步节奏满足 ≤30min SLA。 |
| LICENSE 与 `license` 字段 | 伪装层移植自 MIT 上游 `MAXeaglet/commandcode-proxy`（`docs/research/disguise-spec.md` §许可前提），发布前需保留其许可声明。当前仓库**尚无** LICENSE 文件与 package.json `license` 字段（npm publish 会告警）——license 选型与文件由维护者确认后补齐，属发布阻塞项。 |

## 1. 两轮人工验收（发布门槛）

v1 / v2 各跑一轮 `docs/spec/acceptance.md` 十项清单，**十项全部有结论**（pass / fail / 未触发，条件项如实标注）后方可发布：

- 环境：真实宿主 + 真实 Go plan key + 真实网络 + HTTPS MITM 抓包环境（mitmproxy 接管宿主进程出网，wire 级断言必需）。
- 宿主版本：v1 = 最新 stable；v2 = `opencode2 0.0.0-beta-18684`（acceptance.md §0 前置条件表）。
- v1 全程 `XDG_*` 重定向至临时目录隔离，不污染日常配置。
- 记录形式：acceptance.md §2——逐项结论 + 证据（截图 / 日志摘录 / 抓包摘录）+ 宿主版本号，留 issue 评论或文档。
- 缺陷回路：验收失败 → 开 issue → 修复 → 仅复验失败项；不就地偏离、不带着已知 fail 发布。

## 2. 发布主包（维护者执行）

1. **刷新包内快照**：`pnpm embed-snapshot`（缺省拉 GitHub Release 最新 asset；github.com 不可达时可传 data 分支 raw URL 或本地产物文件路径）→ `git diff src/models/snapshot.json` 复核 → `pnpm test` 全绿。快照必须来自构建产物（schema 校验由脚本强制），发版时刻的最后已知良好产物。
2. **提交并定版本号**：package.json `version` 由维护者定首发版本；快照变更与版本号一起提交（pnpm publish 默认拒绝脏工作树，顺序正是先提交后发布）。
3. **本地复核**：`pnpm pack` 抽查 tarball。零运行时依赖、files 清单最小、快照在包内、入口形状四项已由 `tests/package-publish.test.ts` 常驻 CI 兜底，人工抽查为最后一道。
4. **发布**：`pnpm publish --access public`（作用域包默认 restricted，免费账号必须显式 `--access public`，与数据包发布同款纪律）。
5. **打 tag**：`git tag v<version> && git push origin v<version>`，Release notes 首行注明对应包内快照的 sha256（`embed-snapshot` 输出值，可与渠道产物对账）。

## 3. 发布后

- 主包发版只影响包内快照（兜底层）数据；实时模型数据由 models-pipeline 三渠道（Release asset / npm 数据包 / data 分支）自动持续供给，**主包无需跟随上游 CLI 发版**。
- 数据包与主包独立发版（ADR-0001）：数据包随上游自动走，主包只在快照需要入库时发版。

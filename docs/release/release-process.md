# 发布流程：v1 轮验收 → npm publish → v2 轮验收

> 状态：修订（2026-09-06，issue #43/#44 执行期实测修订；原版为「两轮验收 → publish」，修订原因见下）。验收清单：`docs/spec/acceptance.md`；分发渠道：`docs/adr/0001-artifact-distribution-channels.md`；npmmirror 登记：[npmmirror-whitelist-pr.md](./npmmirror-whitelist-pr.md)。
>
> **职责归属**：人工验收与发布命令由**维护者**执行；agent 只承担准备与文本工作。
> 验收发现的问题开新 issue 修订规格或实现，不就地偏离（acceptance.md 缺陷回路同款）。
>
> **修订原因（结构性的，2026-09-06 实测）**：README 的 v2 安装路径 = `opencode2 plugin add <npm 包名>`，且实测 plugin add 只接受 npm registry / Git 来源、拒收本地路径与本地 tarball——**npm 包不存在时 v2 轮验收无从按 README 走查**。故 v2 轮移到发布后，用真·README 命令执行（这才是走查的本义）；发布门槛只卡 v1 轮。风险可控：首发包零用户，v1 轮已全链把关，v2 轮发现问题以补版本修复（npm 发新版本无限制，仅 unpublish 有 72h 窗口）。

## 0. 发布前置确认（维护者动作）

| 项 | 现状与核查方式 |
|---|---|
| `NPM_TOKEN` secret | 供 models-pipeline 渠道 2（npm 数据包）使用。核查方式：`npm view @wallbreakerno4/opencode-commandcode-models dist-tags` 有新版本持续出现（2026-09-05 核查：数据包已连发 12 版、latest `0.0.1788622352`，secret 有效）；或 `gh secret list`（维护者权限）确认在列。失效症状：Models pipeline 在「渠道 2 · npm 数据包」步 402/403 失败 → 整轮 run 失败、data 分支停更。补配：`gh secret set NPM_TOKEN`（automation token，需 publish 权限），补配后下一轮 cron 自动恢复。 |
| npmmirror files 白名单 | PR 文本草稿已就绪（npmmirror-whitelist-pr.md），fork / 提交 / 授权由维护者执行。**未合并不阻塞主包发布**：合并前渠道 2 稳定 403，客户端按默认 URL 列表落到 unpkg，无害。合并后需实测同步节奏满足 ≤30min SLA。 |
| LICENSE 与 `license` 字段 | 伪装层移植自 MIT 上游 `MAXeaglet/commandcode-proxy`（`docs/research/disguise-spec.md` §许可前提），发布前需保留其许可声明。当前仓库**尚无** LICENSE 文件与 package.json `license` 字段（npm publish 会告警）——license 选型与文件由维护者确认后补齐，属发布阻塞项。 |
| npm 本机登录（一次性） | `npm login` 浏览器授权。`@wallbreakerno4` scope 已属于维护者账号（数据包已用它发版），无需新建 org。 |

## 1. 第一阶段：v1 轮人工验收（发布门槛）

在最新 stable v1 宿主上跑完 `docs/spec/acceptance.md` 十项清单，**十项全部有结论**（pass / fail / 未触发，条件项如实标注）后方可发布。

**安装方式（2026-09-06 在维护者机器上全链实测通过：模型列表 42 个 + 真实 key 对话成功）**——主包未发布，npm 命令此刻不可用，v1 轮用本地路径安装：

```bash
cd <仓库目录>
pnpm install   # 仅首次；装开发工具
pnpm build     # 把 src/ 的 TypeScript 源码编译成宿主能加载的 dist/，每次代码变更后重跑
```

`~/.config/opencode/opencode.json`（不想污染日常配置则改在隔离目录建同路径文件并 export 三个 `XDG_*` 变量指向它）加入一行：

```json
{ "plugin": ["<仓库绝对路径>/dist/index.js"] }
```

登录二选一：TUI 里 `/connect` 选「Command Code (Go)」粘贴 key；或终端 `export COMMANDCODE_API_KEY=user_xxx`（真实 key）。快速验证：`opencode run --model commandcode-go/deepseek/deepseek-v4-pro "hi"`。装完即测：模型选择器出现 `commandcode-go/` 前缀模型即插件已生效。

其余环境：真实 Go plan key；HTTPS MITM 抓包环境（wire 级断言必需，工具在 `capture/`）；记录形式按 acceptance.md §2。

## 2. 发布主包（v1 轮全过后，维护者执行）

1. **刷新包内快照**：`pnpm embed-snapshot`（缺省拉 GitHub Release 最新 asset）→ `git diff src/models/snapshot.json` 复核 → `pnpm test` 全绿。快照必须来自构建产物（schema 校验由脚本强制），是发版时刻的最后已知良好产物。
2. **提交并定版本号**：package.json `version` 由维护者定首发版本；快照变更与版本号一起提交（pnpm publish 默认拒绝脏工作树，顺序正是先提交后发布）。
3. **本地复核**：`pnpm pack` 抽查 tarball。零运行时依赖、files 清单最小、快照在包内、入口形状四项已由 `tests/package-publish.test.ts` 常驻 CI 兜底，人工抽查为最后一道。
4. **发布**：`pnpm publish --access public`（作用域包默认 restricted，免费账号必须显式 `--access public`，与数据包发布同款纪律；开 2FA 会现场要一次性验证码）。
5. **打 tag**：`git tag v<version> && git push origin main --tags`，Release notes 首行注明对应包内快照的 sha256（`embed-snapshot` 输出值，可与渠道产物对账）。

## 3. 第二阶段：v2 轮人工验收（发布后）

npm 包就位后，在 v2 宿主（`opencode2 0.0.0-beta-18684`，acceptance.md §0）上**原样执行 README 双栏 v2 栏**——这是唯一能真正走查 README 承诺的方式：

```bash
opencode2 plugin add @wallbreakerno4/opencode-commandcode
```

再 `opencode.json` 合入 `"providers": {"commandcode-go": {}}` 空壳，`/connect` 或 env 登录，跑 acceptance.md 十项清单（v1 轮已验的纯插件逻辑项可引用 v1 轮记录，TUI 目视项与抓包 wire 级项在 v2 重做）。发现问题开 issue 修复 → 补版本重发（无需撤包）。

## 4. 发布后

- 主包发版只影响包内快照（兜底层）数据；实时模型数据由 models-pipeline 三渠道（Release asset / npm 数据包 / data 分支）自动持续供给，**主包无需跟随上游 CLI 发版**。
- 数据包与主包独立发版（ADR-0001）：数据包随上游自动走，主包只在快照需要入库时发版。


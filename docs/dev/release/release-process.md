# 发布流程：V2 本地 dist 预验收 → npm publish → 真 README 走查

> 状态：换轴修订（2026-09-12，issue #48/#49）：主路径改为 OpenCode 2 正式版，发布门槛从 v1 轮换到 V2 轮，V1 按 ADR-0004 只在 v1 专属面改动时复验。原版（2026-09-06，issue #43/#44）为「v1 轮验收 → publish → v2 轮验收」；其结构性原因（npm 包未就位时无从按 README 走查）仍成立，故保留两阶段——**发布前用本地 dist 预验收，发布后按真 README 走查**。
> 验收清单：`docs/dev/spec/acceptance.md`；分发渠道：`docs/dev/adr/0001-artifact-distribution-channels.md`；V1 政策：`docs/dev/adr/0004-v1-freeze-and-retention.md`；npmmirror 登记：`docs/dev/release/npmmirror-whitelist-pr.md`。
>
> **职责归属**：人工验收与发布命令由**维护者**执行；agent 只承担准备与文本工作。
> 验收发现的问题开新 issue 修订规格或实现，不就地偏离（acceptance.md 缺陷回路同款）。

## 0. 发布前置确认（维护者动作）

| 项 | 现状与核查方式 |
|---|---|
| npm Trusted Publishing（数据包） | models-pipeline 渠道 2（npm 数据包）的发布认证：GitHub Actions OIDC 短命凭证，无长期 token（issue #40，2026-09-11 迁移）。npm 侧在包 `@wallbreakerno4/opencode-commandcode-models` 的 Settings → Trusted Publisher 配置：Owner `WallBreakerNO4`、Repository `opencode-commandcode-provider`、Workflow filename `models-pipeline.yml`、Environment 留空，且 **Allowed actions 须勾选允许直接 `npm publish`**（2026-09-03 后新建的配置默认只允许 `npm stage publish`；npm UI 对此勾选显示 Not recommended，接受理由见 ADR-0001 修订「直发取舍」）。建议同时把 Publishing access 设为「Require two-factor authentication and disallow tokens」。等价 CLI（npm ≥ 11.15、账号开 2FA；带 bypass 2FA 的 GAT 不支持）：`npm trust github @wallbreakerno4/opencode-commandcode-models --file models-pipeline.yml --allow-publish`。迁移验证：手动 dispatch 一次完整构建 → 确认渠道 2 无 `NPM_TOKEN` 发布成功、npm 包页面出现 provenance、data 分支更新 → 删除仓库 secret `NPM_TOKEN`。核查方式：`npm view @wallbreakerno4/opencode-commandcode-models dist-tags` 有新版本持续出现；`gh secret list` 不再包含 `NPM_TOKEN`。失效症状：渠道 2 报 ENEEDAUTH 或 E404 Not Found（trusted publisher 配置不匹配时 npm 返 404）→ 整轮 run 失败、data 分支停更。补配：按上述字段在 npm 侧添加连接（已有连接字段不可改、需删除重建），无需任何 secret；下一轮 cron 自动恢复。 |
| npmmirror files 白名单 | PR 文本草稿已就绪（`docs/dev/release/npmmirror-whitelist-pr.md`），fork / 提交 / 授权由维护者执行。**未合并不阻塞主包发布**：合并前渠道 2 稳定 403，客户端按默认 URL 列表落到 unpkg，无害。合并后需实测同步节奏满足 ≤30min SLA。 |
| LICENSE 与 `license` 字段 | 伪装层移植自 MIT 上游 `MAXeaglet/commandcode-proxy`（`docs/dev/research/disguise-spec.md` §许可前提）。根目录 MIT `LICENSE` 与 package.json `license` 字段均已就位（保留上游版权声明）；发布前确认声明未丢失。 |
| npm 本机登录（一次性） | `npm login` 浏览器授权。`@wallbreakerno4` scope 已属于维护者账号（数据包已用它发版），无需新建 org。 |

## 1. 第一阶段：V2 本地 dist 预验收（发布门槛）

npm 包未发布（或目标版本尚未发布）时，用本地构建产物在**正式版 V2 真机**走完 `docs/dev/spec/acceptance.md` §1 十项清单，**十项全部有结论**（pass / fail / 未触发，条件项如实标注）后方可发布。方法沿用真机探针（`docs/dev/research/v2-stable-probe.md` §1）：

1. **构建**：`pnpm install`（仅首次）→ `pnpm build`；`dist/` 即插件入口目录。
2. **隔离环境**：建临时 `XDG_*` 目录并重定向（不污染日常配置），宿主用正式版 `opencode`（`opencode --version` → `opencode v2.x`）。
3. **本地路径写法**：全局配置 `plugins` 写**包含入口文件的目录**：

   ```json
   { "plugins": ["<仓库绝对路径>/dist"] }
   ```

   不要写 `dist/index.js`（文件路径被丢弃并 WARN），不要写仓库根目录（没有 `index.*`/`server.*`，静默不加载）。
4. **凭证与顺序**：`/connect` 选「Command Code (Go)」粘贴真实 key，或 `export COMMANDCODE_API_KEY=user_xxx`。未配置凭证前模型列表为空是预期；冷启动后第一次 `plugin list` / `models` 可能为空，重试一次再判。
5. **其余环境**：真实 Go plan key；HTTPS MITM 抓包环境（wire 级断言必需，工具在 `capture/`）；记录形式按 `docs/dev/spec/acceptance.md` §3。

## 2. 发布主包（预验收全过后，维护者执行）

1. **刷新包内快照**：`pnpm embed-snapshot`（缺省拉 GitHub Release 最新 asset）→ `git diff src/models/snapshot.json` 复核 → `pnpm test` 全绿。快照必须来自构建产物（schema 校验由脚本强制），是发版时刻的最后已知良好产物。
2. **提交并定版本号**：package.json `version` 由维护者定版本号；快照变更与版本号一起提交（pnpm publish 默认拒绝脏工作树，顺序正是先提交后发布）。
3. **本地复核**：`pnpm pack` 抽查 tarball。零运行时依赖、files 清单最小、快照在包内、入口形状四项已由 `tests/package-publish.test.ts` 常驻 CI 兜底，人工抽查为最后一道。
4. **发布**：`pnpm publish --access public`（作用域包默认 restricted，免费账号必须显式 `--access public`，与数据包发布同款纪律；开 2FA 会现场要一次性验证码）。
5. **打 tag**：`git tag v<version> && git push origin main --tags`，Release notes 首行注明对应包内快照的 sha256（`embed-snapshot` 输出值，可与渠道产物对账）。

## 3. 第二阶段：发布后按真 README 走查

npm 包就位后，在正式版 V2 宿主上**原样执行 README 手动安装节**——这是唯一能真正走查 README 承诺的方式：

```bash
opencode plugin add @wallbreakerno4/opencode-commandcode
```

重启 → `/connect`（或 env）→ `opencode models` / 发消息，跑 `docs/dev/spec/acceptance.md` §1 十项（第一阶段的纯插件逻辑项可引用记录，TUI 目视项与抓包 wire 级项重做）。发现问题开 issue 修复 → 补版本重发（无需撤包）。

## 4. V1 条件复验（非每轮）

仅当本次发布改动 v1 专属面（`src/host/v1.ts`、v1 专属测试或文档）时执行，范围与方法见 `docs/dev/spec/acceptance.md` §2；常规发布不跑 v1 轮（`docs/dev/adr/0004-v1-freeze-and-retention.md`）。

## 5. 契约巡检（OpenCode 大版本升级后）

OpenCode 大版本升级（如 2.x → 3.x）后，按 `docs/dev/research/v2-stable-probe.md` 的隔离探针方法跑一遍结构检查，确认插件依赖的宿主契约没有漂移：

1. **准备**：建隔离 `XDG_*` 目录与配置，`plugins` 指向本地 `dist/`；记录 `opencode --version`。
2. **结构探针**（dummy key，不做真实调用计费）：

   ```bash
   export COMMANDCODE_API_KEY=dummy
   opencode plugin list    # 应出现 commandcode-go（ID）/ 包名或入口文件路径（SOURCE）；冷启动第一次为空则重试
   opencode models         # 应列出 commandcode-go/* 模型
   opencode run --standalone --model commandcode-go/deepseek/deepseek-v4-pro "hi"
   # 期望：网关 401（链路已通），而不是 model/provider not found
   ```

3. **服务 API 核对**：`/api/provider` 的 `activation`（无空壳应为 `auto`）与 `package`（`aisdk:file://…/dist/index.js`）；`/api/integration` 的 key/env 方法与 label（「Command Code API Key」）。
4. **契约差异清单复核**（对照 `docs/dev/research/v2-stable-contract.md` 差异表）：插件 SDK 包名、`ctx.aisdk` 去留、工厂入参与调用节奏、transform 回放顺序与 settings 通道、`plugin list` / `models` 行为。
5. **处理**：差异记入 `docs/dev/research/`，按影响修订代码或文档；升级后的真机结论回写契约调研。

## 6. 发布后

- 主包发版只影响包内快照（兜底层）数据；实时模型数据由 models-pipeline 三渠道（Release asset / npm 数据包 / data 分支）自动持续供给，**主包无需跟随上游 CLI 发版**。
- 数据包与主包独立发版（ADR-0001）：数据包随上游自动走，主包只在快照需要入库时发版。

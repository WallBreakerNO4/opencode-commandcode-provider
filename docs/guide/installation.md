# For Humans 安装指南

把插件 [@wallbreakerno4/opencode-commandcode](https://github.com/WallBreakerNO4/opencode-commandcode-provider#readme)（Command Code Go plan 的 OpenCode provider）装进 OpenCode 2 正式版有两种方式：

- **推荐**：把 README 里的粘贴 prompt 丢进 OpenCode 会话，由其中的 agent 按本文档自主完成安装。人类只参与两步——粘贴 prompt，以及最后的重启与认证。
- 手动：按下面「手动安装」节自己敲命令。

> **V1 用户**：v1 支持面已冻结（只修致命问题），推荐升级到 OpenCode 2；继续使用 v1 的安装步骤见[冻结版安装指南](https://github.com/WallBreakerNO4/opencode-commandcode-provider/blob/v0.1.2/docs/guide/installation.md)。

## 手动安装（OpenCode 2）

1. 确认宿主为 V2：`opencode --version` 输出形如 `opencode v2.x`。
2. 安装插件：

   ```bash
   opencode plugin add @wallbreakerno4/opencode-commandcode
   ```

3. 重启 `opencode`。
4. 配置凭证（二选一）：
   - 在 OpenCode 中输入 `/connect`，选择 **Command Code (Go)**，粘贴 API key；
   - 或由用户自行设置环境变量 `COMMANDCODE_API_KEY`。
5. 验证：`opencode models` 应列出 `commandcode-go/` 前缀的模型，或直接发条消息（`opencode run --model commandcode-go/deepseek/deepseek-v4-pro "hi"`）。

未配置凭证前 provider 不可见、模型列表为空是预期；冷启动后第一次调用可能为空，重试一次再判失败。详见下文「验证」与「故障排查」。

---

## For LLM Agents

> 本节写给读取本文档的 coding agent。用 `curl` 获取本文档原文，不要用摘要式网页抓取（会丢失步骤细节）：
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/WallBreakerNO4/opencode-commandcode-provider/main/docs/guide/installation.md
> ```

你的任务：把 npm 包 `@wallbreakerno4/opencode-commandcode` 安装为用户的 OpenCode **全局**插件，完成结构性验证（Step 3 第 1–3 项，无需凭证），然后把重启、认证与模型验证交还给用户。

### 硬性规则

- **绝不索要或处理 API key**。不读取、不修改 `.env` 等任何凭证文件，不把 key 写进任何文件。认证由用户在 OpenCode 内经 `/connect` 亲手完成，或由用户自行设置环境变量。
- **只动全局配置**。仅修改 `~/.config/opencode/` 下的配置文件；不碰项目级 `opencode.json` 与 `.opencode/` 目录。
- **改前展示、留备份、失败回滚**。修改配置前先读原文件、向用户展示将要写入的变更，并在原文件同目录留一份带时间戳的备份；任何一步失败就恢复备份、撤销已做的变更，不留半套配置；验证全部通过后删除备份。
- **合并而非覆盖**。配置文件里可能有其他 provider、插件或用户自定义配置，按 JSON 合并语义只增改本插件相关键；改动后校验文件语法有效。若 `opencode.json` 与 `opencode.jsonc` 并存，改 `opencode.jsonc`。
- **宿主缺失即拒绝**。检测不到 OpenCode 安装时直接终止并向用户解释（见 Step 0），不做任何安装动作。
- **判别不了就停下**。`opencode --version` 输出无法识别时先询问用户，不猜测、不硬装。

### Step 0：宿主检测

按 **`opencode --version` 的输出**判别宿主版本：

| 输出 | 判定 | 动作 |
| --- | --- | --- |
| 形如 `opencode v2.x` | OpenCode 2 正式版 | 进入 Step 1 |
| 形如 `1.x`（纯版本号） | OpenCode V1 | 按下方 V1 分支处理 |
| 命令不存在 | 非 OpenCode 环境 | 拒绝安装 |

检测规则（按序执行）：

1. 执行 `opencode --version`。
2. **命令缺失**：终止。明确告诉用户：当前环境没有 OpenCode，本插件只服务于 OpenCode，请先参照 https://opencode.ai/docs 安装 OpenCode，再回到本项目重新执行粘贴 prompt。
3. **输出匹配 `v?2.x`**：目标宿主为 V2，直接进入 Step 1。
4. **输出匹配 `1.x`**：宿主是 V1。问用户一次是否升级到 OpenCode 2：
   - **愿意升级**：升级由用户自己执行官方安装，agent 只给命令与步骤，不代跑、不改用户环境。官方安装命令任选其一：
     - `npm install -g @opencode/cli`
     - `curl -fsSL https://opencode.ai/v2/install | bash`
     - 其余安装方式见 https://opencode.ai/v2/docs/

     用户装完后重新执行 `opencode --version`，确认输出已是 `opencode v2.x`，再进入 Step 1。
   - **不升级**：输出以下冻结指引并终止，不做安装动作：

     > v1 支持面已冻结（只修致命问题），推荐升级到 OpenCode 2；继续使用 v1 的安装步骤见[冻结版安装指南](https://github.com/WallBreakerNO4/opencode-commandcode-provider/blob/v0.1.2/docs/guide/installation.md)。

5. **输出无法识别**：停下，把原始输出展示给用户并询问如何处理；不猜测版本、不继续安装。

### Step 1：安装（V2）

1. 确认全局配置文件（`opencode.json` 或 `opencode.jsonc`；都不存在时由安装命令新建 `opencode.json`），按硬性规则留备份。
2. 执行官方安装命令：

   ```bash
   opencode plugin add @wallbreakerno4/opencode-commandcode
   ```

   该命令安装插件并把包名写入全局配置顶层的 `plugins` 数组。
3. **本地 / 开发路径安装**（仅当用户明确要求安装未发布的本地构建）：把**包含入口文件的目录**写进全局配置 `plugins` 数组，例如本仓库构建后的 `dist/` 目录：

   ```json
   { "plugins": ["<仓库绝对路径>/dist"] }
   ```

   不要写文件路径（`dist/index.js` 会被宿主丢弃并告警），也不要写仓库根目录（没有入口文件，会被静默忽略）。npm 包名安装不受此限。

#### 备份与回滚

- 备份命名：`<原文件名>.bak-<Unix 时间戳>`，放原文件同目录。
- **回滚动作**：先执行 `opencode plugin remove @wallbreakerno4/opencode-commandcode` 撤销插件安装（本地路径安装则跳过），再恢复备份内容（原文件不存在则删除新建文件）；然后向用户报告失败原因。
- Step 3 全部通过后删除备份。

### Step 2：配置凭证（先于验证）

把重启与认证交还用户，并明确告知：**未配置凭证前 provider 不可见、模型列表为空，这是预期**。

1. **重启宿主**：让用户退出当前会话并重新启动 `opencode`。
2. **认证，二选一**（agent 不参与、不接触 key）：
   - 在 OpenCode 中输入 `/connect`，在列表选择 **Command Code (Go)**，粘贴 API key。key 在 Command Code 官网 [Studio → API Keys](https://commandcode.ai/docs/studio) 生成（与官方 CLI 同一把），需要 Command Code Go plan 订阅。
   - 或由用户自行设置环境变量 `COMMANDCODE_API_KEY`。

### Step 3：验证

**凭证就绪是模型类检查的前置条件**：未配置 `/connect` 或 `COMMANDCODE_API_KEY` 前，`commandcode-go` 不可见、模型列表为空，属预期而非安装失败。第 1–3 项为结构性检查，不依赖凭证，可在把宿主交还用户之前执行；第 4–5 项需用户完成 Step 2 后执行。

逐项检查，全部通过才算成功：

1. **包已安装**：执行 `opencode plugin list`，ID 列应出现 `commandcode-go`，SOURCE 列应包含 `@wallbreakerno4/opencode-commandcode`（本地路径安装则显示解析后的入口文件路径，如 `…/dist/index.js`）。冷启动后的第一次调用可能输出空列表或 `No plugins found`——**重试一次**再判失败。
2. **配置正确**：全局配置 `plugins` 数组包含包名（本地路径安装则为目录路径）。
3. **宿主可用**：`opencode --version` 正常退出且输出 `v2.x`。
4. **模型可见（凭证就绪后）**：`opencode models` 应列出 `commandcode-go/` 前缀的模型；冷启动后的第一次调用可能为空，**重试一次**再判失败。
5. **端到端**：选一个 `commandcode-go/` 前缀的模型（例如 `commandcode-go/deepseek/deepseek-v4-pro`）发条消息，能正常回复即安装完成。

已知误区：`opencode models` 在凭证就绪后会列出 `commandcode-go` 模型；要防的是冷启动竞态——第一次为空时重试一次，两次都空再查故障排查。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `opencode plugin list` 为空 | 冷启动竞态：重试一次。仍为空则检查全局配置 `plugins` 是否含包名、插件安装后是否重启过宿主。 |
| `/connect` 列表里没有 Command Code (Go) | 插件没装进当前宿主或没重启：先跑 `opencode plugin list` 确认插件已加载，再确认重启的是同一个 `opencode`。 |
| `opencode models` 没有 commandcode-go 模型 | 未配置凭证时为空是预期：先完成 `/connect` 或 `COMMANDCODE_API_KEY`。已配置则冷启动后重试一次；仍为空检查 key 是否有效。 |
| 配置改动后 OpenCode 启动报配置错误 | 多为 JSON / JSONC 语法被破坏：检查合并处逗号与括号，对照备份修复。 |
| 认证或发消息报 403 / 无权限 | 检查订阅是否为 Go plan、key 是否有效；必要时在 [Studio → API Keys](https://commandcode.ai/docs/studio) 重新生成。 |
| 本地路径安装后插件不加载 | `plugins` 里的本地路径必须指向**包含入口文件的目录**（本项目 = `dist/`）；文件路径会被丢弃并告警，仓库根目录会被静默忽略。 |

与安装无关的已知问题（如模型额度消耗异常）见[已知问题](known-issues.md)。

## 卸载

从全局配置 `plugins` 数组中删除 `"@wallbreakerno4/opencode-commandcode"`，或执行：

```bash
opencode plugin remove @wallbreakerno4/opencode-commandcode
```

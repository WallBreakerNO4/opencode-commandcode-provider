# For Humans 安装指南

把插件 [@wallbreakerno4/opencode-commandcode](https://github.com/WallBreakerNO4/opencode-commandcode-provider#readme)（Command Code Go plan 的 OpenCode provider）装进 OpenCode 有两种方式：

- **推荐**：把 README 里的粘贴 prompt 丢进 OpenCode 会话，由其中的 agent 按本文档自主完成安装。人类只参与两步——粘贴 prompt，以及最后的重启与认证。
- 手动：按 README 的 v1 / v2 步骤自己敲命令。

---

## For LLM Agents

> 本节写给读取本文档的 coding agent。用 `curl` 获取本文档原文，不要用摘要式网页抓取（会丢失步骤细节）：
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/WallBreakerNO4/opencode-commandcode-provider/main/docs/guide/installation.md
> ```

你的任务：把 npm 包 `@wallbreakerno4/opencode-commandcode` 安装为用户的 OpenCode **全局**插件，完成结构性验证，然后把重启与认证交还给用户。

### 硬性规则

- **绝不索要或处理 API key**。不读取、不修改 `.env` 等任何凭证文件，不把 key 写进任何文件。认证由用户在 OpenCode 内经 `/connect` 亲手完成。
- **只动全局配置**。仅修改 `~/.config/opencode/` 下的配置文件；不碰项目级 `opencode.json` 与 `.opencode/` 目录。
- **改前展示、留备份、失败回滚**。修改配置前先读原文件、向用户展示将要写入的变更，并在原文件同目录留一份带时间戳的备份；任何一步失败就恢复备份、撤销已做的变更，不留半套配置；验证全部通过后删除备份。
- **合并而非覆盖**。配置文件里可能有其他 provider、插件或用户自定义配置，按 JSON 合并语义只增改本插件相关键；改动后校验文件语法有效。若 `opencode.json` 与 `opencode.jsonc` 并存，改 `opencode.jsonc`。
- **宿主缺失即拒绝**。检测不到任何 OpenCode 安装时直接终止并向用户解释（见 Step 0），不做任何安装动作。

### Step 0：宿主检测

本插件有两个宿主形态，插件系统互不兼容：

| 宿主 | 命令 | 版本形态 | 安装方式 |
| --- | --- | --- | --- |
| OpenCode v1 | `opencode` | stable，形如 `1.18.x` | 手动改配置 |
| OpenCode v2 | `opencode2` | beta，形如 `v0.0.0-beta-*` | CLI 安装 + 配置空壳 |

检测规则（按序执行）：

1. 分别执行 `command -v opencode` 与 `command -v opencode2`。
2. **两个都检测不到**：终止。明确告诉用户：当前环境没有 OpenCode，本插件只服务于 OpenCode，请先参照 https://opencode.ai/docs 安装 OpenCode，再回到本项目重新执行粘贴 prompt。
3. **只检测到其一**：目标宿主即为它，直接进入 Step 1，不提问。
4. **两个都检测到**：用提问工具让用户三选一，默认推荐「两个都安装」：
   - 两个都安装（推荐）
   - 只安装 v1（`opencode`）
   - 只安装 v2（`opencode2`）

### Step 1：安装

对选定的每个宿主执行对应分支；多宿主时逐个执行，互不依赖。两宿主的全局配置目录相同（`~/.config/opencode/`），先确认目标配置文件（`opencode.json` 或 `opencode.jsonc`，都不存在则创建 `opencode.json`），并做好备份。

#### v1（`opencode`）

1. 备份目标配置文件（若原本不存在，记住这点，回滚时改为删除新建文件）。
2. 在配置顶层 `plugin` 数组中加入 `"@wallbreakerno4/opencode-commandcode"`（已含同名项则跳过）：

```json
{
  "plugin": ["@wallbreakerno4/opencode-commandcode"]
}
```

v1 由插件自举 provider 配置与认证方式，不需要写任何 provider 条目。

#### v2（`opencode2`）

1. 执行：

```bash
opencode2 plugin add @wallbreakerno4/opencode-commandcode
```

该命令会把包名写进全局配置的 `plugins` 数组并安装包。若它执行失败，按「备份与回滚」处理。

2. 在全局配置顶层合并 provider 空壳（beta 限制，需手动添加；已存在同名键则跳过）：

```json
{
  "providers": {
    "commandcode-go": {}
  }
}
```

#### 备份与回滚

- 备份命名：`<原文件名>.bak-<Unix 时间戳>`，放原文件同目录。
- **回滚动作**：恢复备份内容（原文件不存在则删除新建文件）；v2 还需执行 `opencode2 plugin remove @wallbreakerno4/opencode-commandcode` 撤销插件安装；然后向用户报告失败原因。
- Step 2 全部通过后删除备份。

### Step 2：结构性验证

逐项检查，全部通过才算成功：

1. **包已安装**：v2 执行 `opencode2 plugin list`，SOURCE 列应包含 `@wallbreakerno4/opencode-commandcode`（ID 列显示为 `commandcode-go`）；v1 检查全局配置 `plugin` 数组包含包名。
2. **配置正确**：v1 `plugin` 数组含包名；v2 `plugins` 数组含包名、`providers` 含 `"commandcode-go"` 空对象。
3. **宿主可用**：对应命令 `--version` 正常退出（`opencode --version` / `opencode2 --version`）。

已知误区：`opencode2 models` 不加载插件，看不到 `commandcode-go`，**不能**用作安装成败的判据。端到端验证（发消息拿到回复）需要认证后的 key，属于用户完成 Step 3 之后的验收，agent 不做。

### Step 3：移交用户

安装成功后，按实际安装的宿主向用户输出说明：

1. **重启 OpenCode**：退出当前会话并重新启动 `opencode`（v1）/ `opencode2`（v2）；两个都装了就各自重启一遍。
2. **认证**：重启后在 OpenCode 中输入 `/connect`，在列表选择 **Command Code (Go)**，粘贴你的 API key。key 在 Command Code 官网 [Studio → API Keys](https://commandcode.ai/docs/studio) 生成（与官方 CLI 同一把），需要 Command Code Go plan 订阅。
3. **发条消息试试**：选一个 `commandcode-go/` 前缀的模型（例如 `commandcode-go/deepseek/deepseek-v4-pro`），能正常回复即安装完成。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `/connect` 列表里没有 Command Code (Go) | 插件没装进当前宿主或没重启：v1 检查全局配置 `plugin` 数组，v2 跑 `opencode2 plugin list`；确认重启的是装了插件的宿主。 |
| `opencode2 models` 看不到 commandcode-go | 正常现象——`models` 命令不加载插件，不构成故障；用认证后的会话验证。 |
| 配置改动后 OpenCode 启动报配置错误 | 多为 JSON / JSONC 语法被破坏：检查合并处逗号与括号，对照备份修复。 |
| 认证或发消息报 403 / 无权限 | 检查订阅是否为 Go plan、key 是否有效；必要时在 [Studio → API Keys](https://commandcode.ai/docs/studio) 重新生成。 |

与安装无关的已知问题（如模型额度消耗异常）见[已知问题](known-issues.md)。

## 卸载

- **v2**：从全局配置 `providers` 中删除 `"commandcode-go"` 空壳，然后执行 `opencode2 plugin remove @wallbreakerno4/opencode-commandcode`。
- **v1**：从全局配置 `plugin` 数组中删除 `"@wallbreakerno4/opencode-commandcode"`。

两个宿主都装了的，按各自方式分别卸载。

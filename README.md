# @wallbreakerno4/opencode-commandcode

OpenCode provider 插件：把 Command Code Go plan 专用的 `/alpha/generate` 网关桥接成 OpenCode 原生 provider，装好即可在 OpenCode 中使用 Command Code 的模型。

> ⚠️ **避坑**：GLM 系列模型的缓存命中率不稳定，额度消耗明显更快，建议优先选用 deepseek 系列模型。详见[已知问题](docs/guide/known-issues.md)。

## 安装

> 前置：Command Code Go plan 订阅，并在 [Studio → API Keys](https://commandcode.ai/docs/studio) 生成 API key（与 CLI 同一把）。

### For Humans（推荐）

把下面这段 prompt 粘贴进 OpenCode 2 会话（`opencode --version` 输出 `opencode v2.x`），agent 会按 [安装指南](docs/guide/installation.md) 自主完成安装；装完按它的提示重启宿主、输入 `/connect` 认证即可：

```
按照这份指南安装 @wallbreakerno4/opencode-commandcode 插件：
https://raw.githubusercontent.com/WallBreakerNO4/opencode-commandcode-provider/main/docs/guide/installation.md
```

### 手动安装（OpenCode 2）

1. 确认宿主为 V2：`opencode --version` 输出形如 `opencode v2.x`。
2. 安装插件：

   ```bash
   opencode plugin add @wallbreakerno4/opencode-commandcode
   ```

3. 重启 `opencode`。
4. 配置凭证（二选一）：输入 `/connect` 选择 **Command Code (Go)** 粘贴 key；或设置环境变量：

   ```bash
   export COMMANDCODE_API_KEY=user_xxx
   ```

5. 验证：

   ```bash
   opencode models            # 应出现 commandcode-go/ 前缀的模型
   opencode run --model commandcode-go/deepseek/deepseek-v4-pro "hi"
   ```

已知误区：`opencode models` 能列出插件模型（凭证就绪后），但冷启动后的第一次调用可能为空，**重试一次**再判失败；未配置凭证前 provider 不可见、模型列表为空是预期。

### OpenCode V1 用户

v1 支持面已冻结（只修致命问题），推荐升级到 OpenCode 2；继续使用 v1 的安装步骤见[冻结版安装指南](https://github.com/WallBreakerNO4/opencode-commandcode-provider/blob/v0.1.2/docs/guide/installation.md)。

## 免责声明

本项目为社区开发的第三方插件，与 Command Code 官方无关。插件桥接的 `/alpha/generate` 端点无公开文档，行为可能随官方更新而变动，使用产生的账号风险请自行评估。仅供学习交流。

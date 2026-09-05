# @wallbreakerno4/opencode-commandcode

OpenCode provider 插件：把 Command Code Go plan 专用的 `/alpha/generate` 网关桥接成 OpenCode 原生 provider。安装插件即完成全部配置——provider（`commandcode-go`）、模型清单与认证方式由插件自举，无需手写任何 provider 定义。

## 安装

> 前置：Command Code Go plan 订阅，并在 [Studio → API Keys](https://commandcode.ai/docs/studio) 生成 API key（与 CLI 同一把）。

### OpenCode v2（beta）

```bash
opencode2 plugin add @wallbreakerno4/opencode-commandcode
```

再在 `opencode.json` 合入一行 provider 空壳（beta 限制，需手动添加）：

```json
{
  "providers": {
    "commandcode-go": {}
  }
}
```

启动 `opencode2` 后输入 `/connect`，选择 Command Code (Go) 粘贴 key 登录；
或直接用环境变量（与 `/connect` 二选一）：

```bash
export COMMANDCODE_API_KEY=user_xxx
```

> v2 处于 beta，命令名以当前快照为准；正式版更名后以官方文档为准。

### OpenCode v1

`~/.config/opencode/opencode.json`（已有配置则合并）加一行：

```json
{
  "plugin": ["@wallbreakerno4/opencode-commandcode"]
}
```

启动 `opencode` 后输入 `/connect`，选择 Command Code (Go) 粘贴 key 登录；
或直接用环境变量 `COMMANDCODE_API_KEY`（同上）。

### 验证安装

```bash
opencode2 run --model commandcode-go/deepseek/deepseek-v4-pro "hi"   # v2
opencode run  --model commandcode-go/deepseek/deepseek-v4-pro "hi"   # v1
```

注意：`opencode2 models` 不加载插件，不能用来判断安装是否成功。

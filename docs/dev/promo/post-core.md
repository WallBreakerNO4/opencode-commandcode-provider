# 宣传帖核心长文（NodeSeek / linux.do / V2EX 共用骨架）

> 使用说明：三平台共用此正文，只按 `titles.md` 换标题；发布前把 `[配图 N：...]` 占位符替换成真实图片（拍摄清单见 `asset-checklist.md`）。

---

## 起因：一个划算到离谱的订阅，却被锁死在官方 CLI 里

前段时间刷到 Command Code 的 Go plan：**$1/月（算上手续费约 $1.4），给 $10 的模型额度**，部分模型还有 2×–5× 的优惠倍率（比如 MiMo V2.5 Pro 实际能用到约 $50）。对比 OpenCode Go（$10/月，多数模型 $60 额度），这个价格实在心动。

然后我点开文档，发现一个致命细节：**Go plan 没有 API**。调用标准 Provider API 直接返回 `403 upgrade_required`，官方在 Reddit 上的原话是 "the $1 plan is only meant for our coding agent"——这 $10 的额度只能用它家自己的官方 CLI 消耗。

不甘心，先试了社区里现成的反代方案（把上游转成 OpenAI 兼容接口再接进 OpenCode），结果完全用不了：Go plan 走的是一个 CLI 专用的非公开端点（`/alpha/generate`），协议是自定义信封 + NDJSON 事件流，跟标准 API 根本不是一回事，硬套必挂。

既然没轮子，那就自己造一个。

## 我做了什么

写了一个 OpenCode provider 插件：**`@wallbreakerno4/opencode-commandcode`**，把 Go plan 的专用网关桥接成 OpenCode 原生 provider：

- 装上插件后，OpenCode 里直接出现 `commandcode-go/` 前缀的 **40+ 模型**（含 DeepSeek V4 Pro 等），无需手写任何 provider 配置
- 同时支持 OpenCode **v1（stable）和 v2（beta）**
- 模型清单自动跟随上游更新，不用手动改配置
- 支持流式输出、工具调用、图片输入

项目已发布到 npm，代码 MIT 开源。

## 怎么装

前置：一个 Command Code Go plan 订阅，并在 Studio → API Keys 生成 API key（和 CLI 用的是同一把）。

**方式一（推荐）：把这段话直接粘进 OpenCode 会话，让 agent 自己装：**

```
按照这份指南安装 @wallbreakerno4/opencode-commandcode 插件：
https://raw.githubusercontent.com/WallBreakerNO4/opencode-commandcode-provider/main/docs/guide/installation.md
```

**方式二：OpenCode v2（beta）一行命令：**

```bash
opencode2 plugin add @wallbreakerno4/opencode-commandcode
```

（beta 限制：还需在 `opencode.json` 里合入 `"providers": { "commandcode-go": {} }` 一行空壳。）

**方式三：OpenCode v1，配置文件里加一行：**

```json
{ "plugin": ["@wallbreakerno4/opencode-commandcode"] }
```

装完重启宿主，输入 `/connect` 选 Command Code (Go) 粘贴 key 登录（或设环境变量 `COMMANDCODE_API_KEY`）。

验证：

```bash
opencode run --model commandcode-go/deepseek/deepseek-v4-pro "hi"
```

> [配图 1：终端验证截图]
>
> [配图 2：OpenCode TUI 对话截图]
>
> [配图 3：模型列表截图（`commandcode-go/` 前缀一排模型）]
>
> [配图 4：从安装到跑通的全流程 GIF]

## ⚠️ 提前说一个坑：GLM 系列额度消耗快

免得大家上来就踩：目前 Command Code 上游 API 的 **GLM 系列模型缓存命中率不稳定**——同一编码会话里上下文高度重复、理论上应持续命中缓存，实测一轮会话的综合命中率却只有约 54%（编码 agent 场景一般需要 90%+ 才合理），单次请求价格在 $0.02～$0.12 之间反复跳动，额度消耗明显偏快。

> [配图 5：GLM 缓存波动用量截图（可直接复用仓库 `docs/guide/assets/glm-cache-fluctuation.png`）]

这是上游 API 侧的问题，插件只做协议桥接，修不了，官方修复后会自然生效。**额度敏感的日常使用，建议直接选 deepseek 系列**（`deepseek/deepseek-v4-pro`、`deepseek/deepseek-v4-flash`），缓存命中稳定，消耗平缓。详细实测数据见项目的[已知问题文档](https://github.com/WallBreakerNO4/opencode-commandcode-provider/blob/main/docs/guide/known-issues.md)。

## 最后

坦白说：这个插件桥接的是官方未公开的 CLI 端点，协议没有文档、可能随官方更新而变动，请自行评估使用风险；项目也与 Command Code 官方没有任何关系。

如果你也是"订阅了 Go plan 但忍不了官方 CLI"的人，希望它能帮你省下重复造轮子的时间：

**GitHub：https://github.com/WallBreakerNO4/opencode-commandcode-provider**

有问题欢迎提 issue；觉得有用的话，顺手点个 star 就是最大的鼓励。

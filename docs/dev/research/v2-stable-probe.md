# OpenCode 2 正式版隔离真机探针：无空壳自举与空壳对照（v2.0.1）

> 状态：已完成。探针日期：2026-09-12。
> 环境：Linux 6.8.0-139-generic x86_64；`opencode --version` → `opencode v2.0.1`；二进制 `/home/wall/.opencode/bin/opencode`（官方 curl 安装线）。
> 关系：回答 `docs/dev/research/v2-stable-contract.md` §4 待真机验证清单第 1/2/9 条。本文只记录探针事实与证据，不改插件代码。
> 纪律：全程 XDG 隔离（隔离根 `/tmp/opencode/probe-20260912-164247`）；只用 dummy key（`COMMANDCODE_API_KEY=dummy`），未读 `.env` 或任何真实凭证；未执行 `plugin add/remove/update`；未触碰真实 `~/.config/opencode`、`~/.local/share/opencode`；未安装 npm 包；仓库内唯一新增文件即本文，未提交 Git。

## 0. 结论速览

| # | 探针 | 结果 | 一句话 |
|---|---|---|---|
| A | 无空壳自举（最高优先） | **pass** | 只写 `plugins` + env 凭证：provider（`activation:"auto"`）、integration、44 个模型全部可见；`run` 请求真实打到 Command Code 网关并返回 401（dummy key 预期内）；无 env 时本地以 `Model unavailable` 拒绝 |
| B | 空壳对照 | **按预期触发** | `providers: {"commandcode-go": {}}` 把 activation 覆写为 `enabled`：无凭证时模型照样列出（44 条）、`run` 照样发请求（401） |
| C | 工厂调用次数 | **未触发** | 宿主 aisdk/sdk-factory 路径无任何日志接缝、插件侧无计数器；不改仓库代码拿不到次数证据，留给维护者人工验收 |

**对「安装文档能否删空壳」的结论：可以删。** 凭证就绪后（env 或 `/connect`）无空壳路径与有空壳路径功能等价；空壳唯一的作用是把无凭证状态也标成 `enabled`（探针 B 已复现），代价是模型列表「虚可见」、请求带空凭证外发后 401。删掉空壳后的伴随语义：未配置凭证前 provider 不可见（`models` 不列出、`run` 本地报 `Model unavailable`）——安装文档需要把「配置凭证」放在验证步骤之前。

**附带纠正（本地路径写法）**：v2.0.1 的 `plugins` 数组里，指向**仓库根目录**（入口经 package.json `main`/`exports` 暴露、根目录无 `index.*`/`server.*`）会**静默不加载**；绝对**文件**路径与 `file://` 文件 URL 会被显式丢弃（WARN `configured plugin path must be a directory`）。本地开发路径应写**含 `index.js` 的目录**（本项目 = `<仓库>/dist`）。npm 包名安装（`plugin add`）走包名解析，不受路径形态限制（源码推断、未实测，见 §2/§8）。

另外，`docs/dev/research/v2-stable-contract.md` §4 第 9 条（`opencode models` 是否仍看不到插件注册模型）实测**行为已变**：稳定版 `opencode models` 能看到插件模型；但存在冷启动竞态，见 §5。

## 1. 隔离方式与准备

### 1.1 目录与配置

```bash
TS=20260912-164247
ROOT=/tmp/opencode/probe-$TS
mkdir -p $ROOT/A/{config/opencode,data,cache,state,workspace} $ROOT/B/{config/opencode,data,cache,state,workspace}
```

A 区（无空壳）`$ROOT/A/config/opencode/opencode.json`：

```json
{
  "update": "disable",
  "plugins": ["/home/wall/self-project/other/opencode-commandcode-provider/dist"]
}
```

B 区（有壳）`$ROOT/B/config/opencode/opencode.json`：

```json
{
  "update": "disable",
  "plugins": ["/home/wall/self-project/other/opencode-commandcode-provider/dist"],
  "providers": { "commandcode-go": {} }
}
```

- 防更新双保险：配置 `"update": "disable"`（源码 `packages/cli/src/services/updater.ts:76-84` 读取该键）+ 每条命令注入 `OPENCODE_DISABLE_AUTOUPDATE=1`（同文件 `:224-231`）。
- 两区各自预写 `service.json`（`{"port":48911}` / `{"port":48912}`），避开机器上真实后台服务的默认端口；服务注册文件只落在隔离 `state/`，探针不会连上真实服务。
- 仓库构建：`pnpm build`（探针前执行），`dist/index.js` 存在。

### 1.2 统一环境变量前缀（下文命令均带此前缀）

```bash
# A 区；B 区把每处 /A/ 换成 /B/
cd /tmp/opencode/probe-20260912-164247/A/workspace
export XDG_CONFIG_HOME=/tmp/opencode/probe-20260912-164247/A/config
export XDG_DATA_HOME=/tmp/opencode/probe-20260912-164247/A/data
export XDG_CACHE_HOME=/tmp/opencode/probe-20260912-164247/A/cache
export XDG_STATE_HOME=/tmp/opencode/probe-20260912-164247/A/state
export OPENCODE_DISABLE_AUTOUPDATE=1
```

下文直接查服务 API 时使用的密码取自隔离目录内的服务配置文件（探针过程中由宿主生成，仅存在于隔离环境）：

```bash
PW=$(python3 -c "import json;print(json.load(open('$XDG_CONFIG_HOME/opencode/service.json'))['password'])")
curl -s -u "opencode:$PW" "http://127.0.0.1:48911/api/…?location%5Bdirectory%5D=$PWD"
```

隔离生效的直接证据：

```console
$ opencode debug paths
home       /home/wall
data       /tmp/opencode/probe-20260912-164247/A/data/opencode
cache      /tmp/opencode/probe-20260912-164247/A/cache/opencode
config     /tmp/opencode/probe-20260912-164247/A/config/opencode
state      /tmp/opencode/probe-20260912-164247/A/state/opencode
tmp        /tmp/opencode
bin        /tmp/opencode/probe-20260912-164247/A/cache/opencode/bin
log        /tmp/opencode/probe-20260912-164247/A/data/opencode/log
repos      /tmp/opencode/probe-20260912-164247/A/data/opencode/repos
db         /tmp/opencode/probe-20260912-164247/A/data/opencode/opencode.db
```

## 2. 准备性发现：本地路径的正确写法（影响全部探针命令）

第一轮配置写的是仓库根目录，`plugin list` 输出 `No plugins found`，服务日志也无加载记录。排查后确认 v2.0.1 对 `plugins` 数组里的本地路径有两道筛选（`packages/core/src/config/plugin/source.ts:148-172`）：

- 绝对**文件**路径（含 `file://` 文件 URL，先经 `fileURLToPath` 归一）→ WARN 并丢弃：

```console
$ grep "must be a directory" $ROOT/A/data/opencode/log/opencode.log
level=WARN message="configured plugin path must be a directory" target=/home/wall/self-project/other/opencode-commandcode-provider/dist/index.js
```

- 绝对目录路径 → 交给 `Host.resolve({directory})`（`packages/plugin/src/host.ts:17-44`）：对路径目标只尝试 `<dir>/server`、`<dir>/index` 两个候选（`Bun.resolveSync` 做扩展名推断），**不读 package.json 的 `main`/`exports`**。仓库根目录没有 `index.*`/`server.*`，于是 `entrypoints.server` 为 `undefined`，被**静默丢弃**（无 WARN、无 `loading plugin` 日志）。
- `file://<目录>` 与绝对目录等价；`file://<文件>` 按文件丢弃。

对照验证（本机 bun）：

```console
$ repo=/home/wall/self-project/other/opencode-commandcode-provider
$ bun -e 'for (const t of [process.env.repo+"/index", process.env.repo+"/dist/index"]) { try { console.log(t, "=>", Bun.resolveSync(t, process.env.repo)) } catch(e) { console.log(t, "=> ERR", e.code) } }'
/home/wall/self-project/other/opencode-commandcode-provider/index => ERR ERR_MODULE_NOT_FOUND
/home/wall/self-project/other/opencode-commandcode-provider/dist/index => /home/wall/self-project/other/opencode-commandcode-provider/dist/index.js
```

| `plugins` 写法 | 结果 | 证据 |
|---|---|---|
| `/…/opencode-commandcode-provider/dist/index.js`（绝对文件） | 丢弃 + WARN | 上引日志 |
| `file:///…/opencode-commandcode-provider/dist/index.js` | 丢弃 + WARN（同一 target） | 日志 `target=…/dist/index.js` |
| `/…/opencode-commandcode-provider`（仓库根目录） | 静默丢弃 | `plugin list` 为空；日志无 `loading plugin` |
| `/…/opencode-commandcode-provider/dist`（含 `index.js` 的目录） | **加载成功** | 下节 `loading plugin` 日志与清单 |
| `<config>/plugins/zz-probe.js`（自动发现文件） | 加载成功（旁证） | `loading plugin` + 清单出现 `zz-probe-auto` |

自动发现旁证：在 `$ROOT/A/config/opencode/plugins/` 放一个最小插件 `zz-probe.js`（`export default { id: "zz-probe-auto", setup() {} }`），重启服务后 `/api/plugin` 出现 `{"id":"zz-probe-auto","source":{"type":"local","path":"…/plugins/zz-probe.js"}}`，随后已删除、未计入正式探针。

npm 包安装路径不受此限（源码）：`packages/core/src/plugin/module.ts:97` 对非本地目标用 `Npm.resolve` 的 `{directory, name}`（`packages/util/src/npm.ts:350-358`），`Host.resolve` 带 `name` 时按包名解析、走 package.json `exports`。

## 3. 探针 A：无空壳自举（pass）

### A1. 插件可见性（`opencode plugin list`）

```console
$ opencode plugin list
No plugins found            # 冷启动首次调用：激活未完成（见 §5），重试后正常

$ opencode plugin list      # 同一服务，第二次调用
ID              VERSION  SOURCE
commandcode-go  local    /home/wall/self-project/other/opencode-commandcode-provider/dist/index.js
```

服务日志与 `/api/plugin` 清单（服务端返回，`state.status = active`）：

```console
level=INFO run=3ecb150c msg="loading plugin" id=/home/wall/self-project/other/opencode-commandcode-provider/dist entrypoint=file:///home/wall/self-project/other/opencode-commandcode-provider/dist/index.js
```

```json
{
  "id": "commandcode-go",
  "source": { "type": "local", "path": "/home/wall/self-project/other/opencode-commandcode-provider/dist/index.js" },
  "features": { "server": true },
  "state": { "status": "active" }
}
```

### A2. 注入 dummy key 后的可见性与请求链路

```bash
COMMANDCODE_API_KEY=dummy opencode models
```

```console
$ grep -c "commandcode-go/" models-dummy-2.log
44
$ head -4 models-dummy-2.log
commandcode-go/deepseek/deepseek-v4-flash
commandcode-go/deepseek/deepseek-v4-flash-fast
commandcode-go/deepseek/deepseek-v4-flash-vision-exp
commandcode-go/deepseek/deepseek-v4-pro
# 全文 51 行 = 44 条 commandcode-go/* + 7 条内置 opencode/* 免费模型
```

直接查目录 API，`commandcode-go` 注册 44 个模型（节选）：

```console
$ curl -s -u "opencode:$PW" "http://127.0.0.1:48911/api/model?location%5Bdirectory%5D=…/A/workspace" | python3 -c "…"
total models: 51
commandcode-go models: 44
 - deepseek/deepseek-v4-pro | status: active | enabled: True
 - deepseek/deepseek-v4-flash | status: active | enabled: True
```

真实消息请求（dummy key）：

```bash
COMMANDCODE_API_KEY=dummy opencode run --standalone --model commandcode-go/deepseek/deepseek-v4-pro "hi"
```

```console
$ COMMANDCODE_API_KEY=dummy opencode run --standalone --model commandcode-go/deepseek/deepseek-v4-pro "hi"
# 退出码 1
> build · deepseek/deepseek-v4-pro
Error: [deepseek/deepseek-v4-pro] 认证失败（401）：key 无效或已过期，请重新运行 /connect 登录。上游：Invalid 'Authorization' header or token.
```

判据核对：错误是**上游 401**（含网关原文 `Invalid 'Authorization' header or token.`），不是 `model not found` / `provider not found` / 无凭证不可用——provider + 模型 + 认证链路全部注册成功，请求真实打到了 Command Code 网关。

同一 run 加 `--print-logs` 时插件加载行（节选）：

```console
level=INFO run=3ecb150c msg="loading plugin" id=…/dist entrypoint=file:///…/dist/index.js role=server
level=INFO run=3ecb150c message="watcher subscribe" path=/home/wall/self-project/other/opencode-commandcode-provider/dist/index.js type=file role=server
…（逐文件订阅 dist/ 下模块；加载与运行无任何 error/warn 级插件日志）
```

### A3. 不注入 env 的对照

```console
$ opencode models                 # 冷启动后两次调用结果一致
$ wc -l < models-noenv.log
0                                 # 一条模型也没有：provider activation=auto 且无凭证 → 不可见

$ opencode run --standalone --model commandcode-go/deepseek/deepseek-v4-pro "hi"
Error: Model unavailable: commandcode-go/deepseek/deepseek-v4-pro     # 本地拒绝，未发请求
```

provider API 的差异（dummy env vs 无 env）：

```json
// COMMANDCODE_API_KEY=dummy 时 /api/provider
{ "id": "commandcode-go", "integrationID": "commandcode-go", "name": "Command Code (Go)",
  "activation": "auto",
  "package": "aisdk:file:///home/wall/self-project/other/opencode-commandcode-provider/dist/index.js" }

// 无 env 时：provider 列表不含 commandcode-go
```

integration 注册（无空壳，`/api/integration`，A 区无 env 服务）：

```json
{ "id": "commandcode-go", "name": "Command Code (Go)",
  "methods": [
    { "type": "key", "label": "Command Code API Key" },
    { "type": "env", "names": ["COMMANDCODE_API_KEY"] }
  ],
  "connections": [] }
```

integration 注册与 env 凭证解析本身不受空壳影响；env 凭证可用时（dummy）activation `auto` 判定为「有连接」，provider 随之可见。

## 4. 探针 B：空壳对照（按预期触发）

B 区配置 = A + `providers: {"commandcode-go": {}}`（两区配置全文见 §1.1）。

```console
$ opencode models                # B 区，无 env
$ grep -c "commandcode-go/" models-noenv.log
44                               # 无凭证也可见：activation 被内置 config 插件覆写为 enabled

$ opencode run --standalone --model commandcode-go/deepseek/deepseek-v4-pro "hi"   # 无 env
> build · deepseek/deepseek-v4-pro
Error: [deepseek/deepseek-v4-pro] 认证失败（401）：key 无效或已过期，请重新运行 /connect 登录。上游：Invalid 'Authorization' header or token.
```

```bash
COMMANDCODE_API_KEY=dummy opencode run --standalone --model commandcode-go/deepseek/deepseek-v4-pro "hi"
```

```console
> build · deepseek/deepseek-v4-pro
Error: [deepseek/deepseek-v4-pro] 认证失败（401）：key 无效或已过期，请重新运行 /connect 登录。上游：Invalid 'Authorization' header or token.
# 与无 env 输出一致：空壳下无凭证也照发请求，错误形态与 A+dummy 相同
```

provider API（B 区，无 env）：

```json
{ "id": "commandcode-go", "integrationID": "commandcode-go", "name": "Command Code (Go)",
  "activation": "enabled",
  "package": "aisdk:file:///home/wall/self-project/other/opencode-commandcode-provider/dist/index.js" }
```

B 区 integration 注册与 A 区完全一致（`commandcode-go` / `Command Code (Go)` / key `Command Code API Key` / env `COMMANDCODE_API_KEY`）。

## 5. 跨探针观察：`plugin list` / `models` 的冷启动竞态

隔离环境下反复出现同一现象：服务冷启动后的**第一次**调用可能拿不到插件数据，紧接的第二次调用正常。

| 命令 | 冷启动第一次 | 第二次 |
|---|---|---|
| `opencode plugin list` | `No plugins found`（4 次复现） | 正常列出 commandcode-go |
| `opencode models`（dummy env） | 0 行 | 51 行（44 条 commandcode-go） |

源码依据：客户端 list 路径直接取服务端当前 inventory，不等待 `plugin.awaitActivation`（`packages/cli/src/commands/handlers/plugin/list.ts:19-21`；`packages/core/src/plugin.ts:43-45`；激活等待是独立端点 `plugin.awaitActivation`，`packages/server/src/handlers/plugin.ts:16`）。`opencode models` 同理不等待（`packages/cli/src/commands/handlers/models.ts:20-24`）。

对安装文档的含义：验证步骤用 `plugin list` / `models` 时，冷启动后应重试一次再判定失败；或者告知用户稍候。

## 6. 探针 C：工厂调用次数与 `settings.modelsUrls` 绑定（未触发）

- 可观测性检查：v2.0.1 宿主侧 `packages/core/src/aisdk.ts`、`packages/core/src/plugin/provider/sdk-factory.ts`、`dynamic.ts` 全文件**没有任何日志调用**；插件侧 `createCommandCode` 也没有计数/日志出口。`--print-logs --log-level all` 下也拿不到工厂调用次数。
- 不改仓库代码的前提下无法得到「同一次 run 中工厂被调用几次」的证据；探针纪律不允许改插件代码（探针 C 本身为可选项）。
- 留给维护者人工验收的建议：在 `createCommandCode` 入口临时加一行计数日志（或包装 `languageModel` 调用），跑一次 `run`（可观察主回复 + 标题/小任务请求的合计次数）；预期与 `docs/dev/research/v2-stable-contract.md` §2.2 的源码结论一致（sdk/language 按 key 缓存，同 key 只调一次工厂），实测数据同时可校准 `src/provider/model.ts` 头注的调用节奏假设。
- `settings.modelsUrls` 绑定次数同理由此路径观测；本探针未触达。

## 7. 结论表

| 探针 | 结果 | 关键证据 | 对安装文档的含义 |
|---|---|---|---|
| A 无空壳自举 | **pass** | `plugin list` 列出 `commandcode-go`（local, dist/index.js）；`/api/provider` 显示 `activation:"auto"` + `package:"aisdk:file://…/dist/index.js"`；dummy env 下 44 个模型可见、run 请求到网关得 401；无 env 时 `Model unavailable` | **空壳步骤可删**；验证前置条件是先配置凭证（env 或 `/connect`） |
| B 空壳对照 | **按预期触发** | 无 env 时 models 44 条、run 401；`/api/provider` 显示 `activation:"enabled"` | 保留空壳的唯一效果是「无凭证也可见/可尝试」；如无此需求，不应写空壳 |
| C 工厂次数 | **未触发** | 宿主无日志接缝，未改代码；详见 §6 | 不影响安装文档；留给维护者人工验收 |
| （附）本地路径写法 | 见 §2 | 文件 → 丢弃 + WARN；仓库根目录 → 静默丢弃；`dist` 目录 → 成功 | 本地路径写法若进文档，必须指到含 `index.*`/`server.*` 的目录；npm 包名安装不受限 |
| （附）`opencode models` | beta 结论已变 | dummy env 下 44 条 `commandcode-go/*`；无 env 0 条 | 安装验证可重新启用 `models`（注意冷启动重试，§5） |

## 8. 未能验证项

1. **真实 key 的端到端成功回包**：按探针纪律只用 dummy key，未做可用凭证请求；「链路注册成功」的证据是网关 401（含上游原文），不是成功流式回包。
2. **`/connect` TUI 交互**：headless 探针无法操作交互界面；integration 及 key/env 方法注册已由 `/api/integration` 直接验证，credential（`/connect` 存储凭证）通道未真机连接验证。
3. **credential > env 优先级**：需要真实凭证连接后才能对比，未测（契约调研 §2.3 已有源码结论）。
4. **npm 包名安装**（`opencode plugin add @wallbreakerno4/opencode-commandcode` 或配置写包名）：纪律禁装 npm 包且禁用 `plugin add`，未实测；「包名走 package.json 解析」为源码推断。
5. **探针 C 的工厂调用次数与 `settings.modelsUrls` 绑定**：不改代码无法观测。
6. **冷启动竞态的组件级定位**：现象稳定复现、源码可见 list 不等待激活，但未细分是插件激活、目录刷新还是两者叠加。

原始输出与日志保留在 `/tmp/opencode/probe-20260912-164247/{A,B}/`（`run-*.log`、`models-*.log`、`api-model-dummy.json`、`data/opencode/log/opencode.log` 等），不随仓库提交。

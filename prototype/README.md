# PROTOTYPE：v2 自举链路实测（一次性代码）

对应 issue：[v2 自举链路实测：package 指向自身与 integration 注册](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/12)（wayfinder 地图 #1）

**这些代码是弃子**：只为回答「beta-18684 上 `aisdk:` 包指向自身 + integration 注册认证」两个问题，结论沉淀进 issue #12 的解决记录后即可删除。禁止发布。

验证环境：opencode2 `0.0.0-beta-18684`（2026-08-31）。

## 结论速览

1. **`aisdk:<registry 包名>` 在 beta-18684 不可用**：无论包是否已发布、是否已作为插件安装，请求时一律 `UnsupportedPackageError`。npm.add 静默失败（无安装痕迹、不做已装检测、手工把包放进 `~/.cache/opencode/packages/<pkg>` 也无效）。#5 记录的「npm.add 后 import」链路在 18684 已死，等 v2 正式版再复查。
2. **自举正解：`p.package = "aisdk:" + import.meta.url`**（插件运行时自指自身文件）。`aisdk:file://` 走原生 import，命中同一模块实例（实测 instance seq 全程 = 1，无双实例——这对伪装模块的进程内状态至关重要）。
3. **config 必须有 provider 空壳**：纯 `catalog.transform` 新增的 provider 不进目录（`Model unavailable`）；`opencode.json` 里 `"providers": {"<id>": {}}` 一行空壳 + transform 填肉即可全链路闭环。这是 18684 相对 18414 的新约束（#5 时代纯 transform 可见），回填票 #6 的安装体验承诺：用户动作 = 装插件 + opencode.json 两行（plugins 数组 + providers 空壳）。
4. **`opencode2 models` 命令不加载插件**——不能用它判别 transform 注册的可见性；判据用 `opencode2 run --model <id>/<mid>`：报 `Model unavailable` = 未注册，报 `Unsupported package` = 已注册但包加载失败。
5. **integration.transform 注册认证方法可用**：`draft.update(id, …)` 是 upsert（全新 integration 可创建）；`draft.method.update({integrationID, method})` 注册 key/env 方法，`/api/integration` 列表可见（key 方法带自定义 label）。注意 serve 首次请求前插件 lazy 加载，第一次 GET 可能拿到 transform 之前的空列表。
6. **凭证流闭环**：`connect.key` 写入的 credential → 工厂 `options.apiKey`（`{name, apiKey, headers, body, fetch}`）；env 方法（`names: [...]`）→ 同名环境变量注入同一入参。优先级：**credential > env**（删除 credential 后 env 才生效）。

## 组成与跑法

- `pkg/` — 模拟插件包 `@wallbreakerno4/cc-self-proto`：default 导出 `{id, setup}`（插件入口）与 `create*` 工厂（aisdk 链消费）**同文件共存**，含双实例检测（`Symbol.for` 全局计数 + import.meta.url 留痕）、工厂入参留痕、LanguageModelV3 假流。
- `scratch/opencode.json` — config 空壳 provider（自举的前提）。

```bash
# 1. 以 git 包形式安装插件（模拟真实安装；发布后即 npm 包名）
cd /tmp && rm -rf cc-proto-repo && cp -r <repo>/prototype/pkg cc-proto-repo
cd cc-proto-repo && git init -q -b main && git add -A && git -c user.email=p@l -c user.name=p commit -qm x
opencode2 plugin add "git+file:///tmp/cc-proto-repo"

# 2. 准备运行目录（含空壳 config，providers.ccshell）
mkdir -p /tmp/cc-proto-run && cp <repo>/prototype/scratch/opencode.json /tmp/cc-proto-run/

# 3. 全链路 + 单实例验证
cd /tmp/cc-proto-run && opencode2 run "pong" --model ccshell/fake-1 --standalone
#   期望 stdout：CCSELF-ECHO[fake-1]: alive (instance 1)

# 4. integration / 凭证验证（serve + curl；密码见 serve 启动输出，Basic 认证）
opencode2 serve --port 4599 &
curl -u "opencode:<pw>" http://127.0.0.1:4599/api/integration          # 列表含 ccself（key/env methods）
curl -u "opencode:<pw>" -X POST -H "Content-Type: application/json" \
  -d '{"integrationID":"ccself","key":"self-key-123"}' \
  http://127.0.0.1:4599/api/integration/ccself/connect/key              # 204
cd /tmp/cc-proto-run && opencode2 run "pong" --model ccshell/fake-1 --standalone
#   工厂日志 apiKey = "self-key-123"
```

日志留痕：`/tmp/opencode/cc-self-proto/log.jsonl`（`CCSELF_LOG` 可改）。

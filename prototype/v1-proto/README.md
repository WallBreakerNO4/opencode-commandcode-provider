# PROTOTYPE：v1 宿主加载行为实测（wayfinder #11）

一次性原型，回答「opencode v1 宿主如何加载单包双入口」的三个问题。结论沉淀在票
[#11](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/11) 的 resolution comment，
方法照票 #5（源码/二进制取证 + 真机运行）。环境：本机 opencode v1 `1.18.21`、bun。

## 布局

- `pkg/` — 测试包（模拟未来 `@wallbreakerno4/opencode-commandcode` 的主入口）：
  - `index.js`：`default {id, setup, server}` 三合一双宿主 + `createCommandCode` 工厂（第一个 `create*` 导出）
  - `fake-model.js`：LanguageModelV3 假流（`finishReason: {unified, raw}` + 嵌套 usage）
  - `probe.js`：探针，留痕到 `CCPROTO_LOG`（JSON 行）+ stderr
  - `server.js`：旧版 `./server` 子路径方案（实验后被三合一形态取代，留作对照）
- `scenarios/` — 每个场景一个 `opencode.json.tpl`（占位符由 run.sh 替换）：
  - `s1-local-dual` — `.opencode/plugins/` 本地插件三变体（default 带 id / 不带 id / 纯命名导出）
  - `s2-server-entry` — `plugin: ["file://pkg"]`，config hook 自举注入 + auth loader
  - `s3-factory-file` — `provider.<id>.npm = "file://…/index.js"`，工厂裸加载
  - `s4-npm-tarball` — npm 包名 spec 的安装/缓存链路（需手动预置缓存目录，见下）
- `run.sh <scenario>` — 打包 tgz、生成配置、在场景目录跑 `opencode run`

## 跑法

```bash
./run.sh s3-factory-file                          # 工厂裸加载 + V3 验收
./run.sh s1-local-dual                            # 入口共存三变体
./run.sh s2-server-entry                          # 自举全链（CCPROTO_NPM_SPEC 指向包名 spec）

# s4（npm 包名 spec 的缓存命中链路）：
(cd pkg && npm pack --pack-destination ..)
CACHE=~/.cache/opencode/packages/@ccproto/v1-proto@0.0.1/node_modules/@ccproto/v1-proto
mkdir -p "$CACHE" && tar -xzf ccproto-v1-proto-0.0.1.tgz -C "$CACHE" --strip-components=1
CCPROTO_NPM_SPEC="@ccproto/v1-proto@0.0.1" ./run.sh s4-npm-tarball

# 认证双通道（在场景目录手动跑）：
# env 路径：CCPROTO_TEST_KEY=… opencode run …
# auth 路径：OPENCODE_AUTH_CONTENT='{"ccproto":{"type":"api","key":…}}' opencode run …
```

注意：`opencode run` 按 cwd 发现项目级 `opencode.json`，必须在场景目录里跑；
`file:` 相对路径 spec（npm 风格）不可用——`Npm.add` 会把 spec 字符串直接当缓存路径拼，
只有 `file://` 前缀（免安装直接 import）和 npm 包名 spec 是设计内形态。

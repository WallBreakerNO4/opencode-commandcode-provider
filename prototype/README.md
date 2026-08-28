# PROTOTYPE：v2 自定义 provider 包契约验证（一次性代码）

对应 issue：[v2 自定义 provider 包契约验证（aisdk: 包 or aisdk.hook）](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/5)

**这些代码是弃子**：只为回答「opencode2 beta-18414 怎么加载自定义模型」，结论沉淀进 `docs/research/v2-provider-contract.md` 后即可删除。禁止发布。

## 组成

- `commandcode-proto/index.js` — 最小 provider 包：导出 `createCommandCode(options)`，返回 `{ languageModel(modelID) }`，内含假流 LanguageModelV3。工厂调用与 doStream 全部留痕到 `CCPROTO_LOG`。
- `plugin/cc-proto-plugin.js` — v2 插件：`ctx.catalog.transform` 注册 provider `ccproto` 与两个测试模型：
  - `ccproto/fake-1`：只有 provider 级 `package`（单写）
  - `ccproto/fake-2`：模型级 `package` 双写（Breskott 坑位对照）
  - `CCPROTO_HOOK=1` 时额外走 `ctx.aisdk.hook("language")` 直注入路径

## 跑法

```bash
export PATH="$HOME/.opencode/bin:$PATH"
cd <scratch-run-dir>            # 含 opencode.json，见 issue 解决记录
export CCPROTO_FAKE_KEY=dummy
opencode2 run "hi" --model ccproto/fake-1 --print-logs --log-level debug --standalone
```

日志留痕：`cat "$CCPROTO_LOG"`（默认 `/tmp/opencode/cc-proto/cc-proto-factory.log`）。

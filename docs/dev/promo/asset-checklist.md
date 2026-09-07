# 宣传素材拍摄清单

技术社区版只需要真实截图 / 录屏转 GIF，拍摄后替换 `post-core.md` 中的对应占位符。所有截图建议用真实订阅跑，注意截图中不要露出完整 API key。

| 占位符 | 内容 | 怎么拍 | 备注 |
|--------|------|--------|------|
| 配图 1 | 终端一行验证截图 | 跑 `opencode run --model commandcode-go/deepseek/deepseek-v4-pro "hi"`，截下命令与真实回复 | 必备；最直观的"能跑"证据 |
| 配图 2 | OpenCode TUI 对话截图 | 在 TUI 里选 `commandcode-go/` 模型正常对话一两轮 | 必备；"留在习惯工具里"卖点的直接证据 |
| 配图 3 | 模型列表截图 | OpenCode 内打开模型选择器，截 `commandcode-go/` 前缀的一排模型 | 必备；40+ 模型的视觉冲击 |
| 配图 4 | 全流程 GIF | 录屏 `plugin add`（或粘贴 For Humans prompt）→ 重启 → `/connect` → 跑通，控制在 30 秒内转 GIF | 强烈建议；有它转化率高一截 |
| 配图 5 | GLM 缓存波动用量截图 | 无需新拍，直接复用仓库 `docs/guide/assets/glm-cache-fluctuation.png` | 已有素材 |

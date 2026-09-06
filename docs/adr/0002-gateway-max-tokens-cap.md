# max_tokens 缺省复刻官方 CLI 64e3，级联 maxOutput 降级为裁剪参考，叠加网关 200000 墙

#42 冒烟发现网关对 `params.max_tokens` 做 `<= 200000` 的 zod 硬校验，而级联 `maxOutput`（models.dev `limit.output` 补全）11/42 个模型超限，缺省请求必 400。排查官方 CLI 1.49.1 源码发现主对话路径实为 `max_tokens = maxOutputTokens ?? 64e3`——官方从不发模型理论值，抓包（deepseek-v4-flash 实发 64000）互证。据此反转 protocol.md 原否决「不发明固定默认值、不叠 200000 硬顶」：其前提「级联 maxOutput 是每模型真值」不成立（models.dev 第三方视角值），「64000 是 MAXeaglet 发明」也不成立（官方自身常量）。现行为：`max_tokens = min(调用方值 ?? 64000, 级联 maxOutput, 200000)`——缺省复刻官方（伪装口径），级联值只作裁剪参考，墙防调用方显式传大值撞 400。

## Considered Options

- 仅协议核心或仅构建侧钳 200000（级联值继续作缺省）：能修 400，但会发出官方永不发送的值（131072、200000 等），与伪装模块「官方怎么发我们怎么发」原则冲突。
- 构建侧 maxOutput 口径改 `min(模型上限, 200000)`：`limit.output` 展示值无论钳不钳都说不清单回合实际 64000，暂不动构建侧，另立跟进票。

## Consequences

- 单回合输出封顶 64000，与官方 CLI 用户同款待遇；级联 `maxOutput` 保留 `limit.output` 展示与「模型真实上限小于缺省」时的裁剪职责。
- 两个常量（64e3 / 200000）写死在协议核心，注释注明证据来源；网关或官方 CLI 变更时改常量发版，不做配置化。

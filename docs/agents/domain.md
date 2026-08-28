# 领域文档

工程类 skill 在探索本代码库时应如何消费本仓库的领域文档。

## 探索前先读这些

- **仓库根目录的 `CONTEXT.md`**，或
- **仓库根目录的 `CONTEXT-MAP.md`**（若存在）：它指向各上下文各自的 `CONTEXT.md`，阅读与主题相关的每一份。
- **`docs/adr/`**：阅读与你要处理的区域相关的 ADR。多上下文仓库中，还要查看 `src/<context>/docs/adr/` 里的上下文级决策。

如果这些文件不存在，**静默继续**。不要标记它们的缺失，也不要一开始就建议创建它们。`/domain-modeling` skill（通过 `/grill-with-docs` 和 `/improve-codebase-architecture` 到达）会在术语或决策真正敲定时惰性创建它们。

## 文件结构

单上下文仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文级决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用术语表的词汇

当你的输出提到某个领域概念（issue 标题、重构提案、假设、测试名等）时，使用 `CONTEXT.md` 中定义的术语。不要漂移到术语表明确避免的同义词。

如果你需要的概念还不在术语表里，这是一个信号：要么你在发明项目不用的语言（请重新斟酌），要么存在真实缺口（记录下来，交给 `/domain-modeling`）。

## 标记 ADR 冲突

如果你的输出与某个现有 ADR 矛盾，要显式指出，而不是静默覆盖：

> _与 ADR-0007（event-sourced orders）矛盾，但值得重新讨论，因为……_

# docs/ 布局二分：用户文档留顶层，开发文档迁入 docs/dev/

> 状态：accepted（2026-09-07）。

## 背景与问题

`docs/` 此前混放两类受众完全不同的文档：面向插件使用者的安装指南（`guide/installation.md`，README 的粘贴 prompt 会引导安装 agent 经 raw URL 拉取它）与面向开发者 / coding agent 的 ADR、agent 约定、发布流程、调研与规格。两类文档混放使 agent 无法从路径判断文档的承诺面——开发文档（spec / research）记载的是内部实现契约与取证事实，用户文档记载的是使用承诺；混淆两者会让安装类 agent 把内部规格误当作用户指引，也让维护者无法按受众放置新文档。

## 决策

- **用户文档**：留在 `docs/` 顶层，按分类子目录存放；现有 `docs/guide/` 即一例，需要新分类时新建子目录。
- **开发文档**：一律放 `docs/dev/`，保持原子目录结构（`adr/`、`agents/`、`release/`、`research/`、`spec/`）；规则无例外，`docs/adr/` 一并迁入 `docs/dev/adr/`。
- 仓库内全部指向开发文档的路径引用（根 `AGENTS.md`、`CONTEXT.md`、源码与测试注释、workflow 注释、`capture/README.md`、docs 互引）同步更新为 `docs/dev/...`。
- `docs/guide/installation.md` 原地不动：其内嵌的 raw.githubusercontent 自引 URL 已随 README 粘贴 prompt 对外发布，移动该文件将打断存量粘贴 prompt 的安装流程。

## Considered Options

- **`docs/adr/` 留在顶层作为例外**：可继续遵循 domain-modeling skill 的默认 ADR 位置，但「`docs/` 下即用户文档」的规则出现例外，agent 每次找文档都需逐文件判别受众，否决。
- **仅更新承重引用（AGENTS.md / CONTEXT.md），docs 互引任其腐烂**：本仓库 research → spec → 实现注释构成事实链（ground truth 追溯路径），断链等于切断追溯；且全量更新为机械替换、成本极低，否决。
- **用户文档一并迁移或改放 `docs/user/`**：installation.md 的 curl 自引 URL 已对外发布，移动属破坏性变更，与本次「用户文档位置不变」的目标相反，否决。

## Consequences

- 新建文档前先判别受众再选位置；该约定同时记录于根目录 `AGENTS.md`「文档布局」一节。
- 后续 `domain-modeling` skill 若按 skill 默认把新 ADR 落到 `docs/adr/`，需按本 ADR 纠正为 `docs/dev/adr/`。
- `docs/dev/agents/domain.md` 中的路径示例已按本布局修订为 `docs/dev/adr/`。
- `dist/` 内的旧路径注释为构建产物，随下次构建自然刷新，不手工修改。

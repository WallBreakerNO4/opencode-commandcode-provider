# AGENTS.md

## Agent skills

### Issue tracker

Issue 存放在本仓库的 GitHub Issues 中（用 `gh` CLI 操作；remote 已关联：`WallBreakerNO4/opencode-commandcode-provider`，`gh` 会自动从 `git remote -v` 推断仓库，动手前先查再说「没有」）。见 `docs/agents/issue-tracker.md`。

## 行为红线（任何会话、任何上下文都必须遵守）

- **Subagent 与后台任务**：未经用户当次明确下令，**绝对不准**启动 subagent / 后台任务。
- **Wayfinder 工单执行**：未经用户当次明确下令，**绝对不准**执行地图上的工单——认领（assign）、调研、评论、关闭、修改地图正文，一律算执行。用户不下令，票就躺在那里不许动。
- **先查证再断言**：说「没有 remote / 没有 X」之前，先用 `git remote -v` 等命令实际查证。

### Triage labels

五个 triage 角色使用中文标签：`待分类` / `待补充信息` / `可交给agent` / `需人工实现` / `不予处理`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）布局：根目录 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。

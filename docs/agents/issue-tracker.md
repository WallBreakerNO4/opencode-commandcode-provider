# Issue 跟踪器：GitHub

本仓库的 issue 和 spec 以 GitHub issue 的形式存放。所有操作使用 `gh` CLI。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行 body 使用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论，同时获取标签。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需附加 `--label` 和 `--state` 过滤。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **添加 / 移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

在克隆仓库内运行时，`gh` 会自动从 `git remote -v` 推断目标仓库。

> **注意**：本仓库当前还没有 git remote。首次使用前需先在 GitHub 上创建仓库，然后 `git remote add origin ...` 关联。

## Pull request 作为 triage 入口

**PR 作为请求入口：否。**（若本仓库将外部 PR 视作功能请求，改为 `yes`；`/triage` 会读取此标志。）

设为 `yes` 时，PR 与 issue 走相同的标签和状态流程，使用 `gh pr` 对应命令：

- **读取 PR**：`gh pr view <number> --comments`；diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的（剔除 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 和 PR 共用一个编号空间，因此裸 `#42` 可能是二者之一：先用 `gh pr view 42` 解析，失败再退回 `gh issue view 42`。

## 当 skill 说「发布到 issue 跟踪器」

创建一个 GitHub issue。

## 当 skill 说「获取相关工单」

运行 `gh issue view <number> --comments`。

## Wayfinder 操作

供 `/wayfinder` 使用。**地图**（map）是一个 issue，**子工单**（child）是各工单 issue。

- **地图**：一个打上 `wayfinder:map` 标签的 issue，承载 Notes / Decisions-so-far / Fog 正文。`gh issue create --label wayfinder:map`。
- **子工单**：通过 `gh api` 调用 sub-issues 端点，作为 GitHub 子 issue 关联到地图。若 sub-issue 功能未启用，则把子项加进地图正文的任务列表，并在子工单正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。被认领后，工单指派给主导开发者。
- **阻塞**：使用 GitHub **原生 issue 依赖**，这是规范且在 UI 可见的表达。用 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 添加一条边，其中 `<blocker-db-id>` 是阻塞者的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，_不是_ `#number` 或 `node_id`）。GitHub 通过 `issue_dependencies_summary.blocked_by`（仅统计开放阻塞者，实时闸门）上报。若依赖功能不可用，退回到在子工单正文顶部写 `Blocked by: #<n>, #<n>` 一行。当所有阻塞者都关闭时，工单解除阻塞。
- **前沿查询**：列出地图的开放子工单（`gh issue list --state open`，限定在地图的 sub-issue / 任务列表内），剔除有开放阻塞者（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中存在开放 issue）或已有指派人的；按地图顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，作为会话的第一次写入。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把上下文指针（摘要 + 链接）追加到地图正文的 Decisions-so-far。

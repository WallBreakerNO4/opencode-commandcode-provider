# AGENTS.md

## Agent skills

### Issue tracker

Issue 存放在本仓库的 GitHub Issues 中（用 `gh` CLI 操作；当前还没有 remote，首次使用前需先建好 GitHub 仓库并关联）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个 triage 角色使用中文标签：`待分类` / `待补充信息` / `可交给agent` / `需人工实现` / `不予处理`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）布局：根目录 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。

### 环境变量与 Command Code API key

- `.env.example` 是本仓库环境变量的清单（当前只有 `COMMANDCODE_API_KEY`），随仓库提交；新增环境变量时必须同步更新它。
- 仓库根目录已有一份配置好真实 key 的 `.env`（被 `.gitignore` 忽略，不准提交）。agent 不准读取或修改 `.env` 的内容——只需知道 key 已就位。
- 需要向 Command Code 端点发送真实请求、或运行/测试原型时，通过环境变量读取 key：代码里用 `process.env.COMMANDCODE_API_KEY`（配合 dotenv 等加载 `.env`），测试命令中也可直接注入该环境变量。禁止把 key 硬编码进代码、测试夹具或文档。

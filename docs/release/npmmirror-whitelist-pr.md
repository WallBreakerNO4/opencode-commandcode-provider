# npmmirror files 白名单登记 PR 文本草稿

> 状态：草稿就绪（issue #28 交付项）。**实际提交由维护者执行或授权，agent 只起草文本**（ADR-0001 修订 2026-09-01）。
>
> 目标仓库：`cnpm/unpkg-white-list`；目标文件：`data/allowPackages.json`。
> 合并后 npmmirror files 端点（`registry.npmmirror.com/<pkg>/latest/files/*`）最长约 5 分钟全网放行；
> 合并前渠道 2 稳定 403，客户端按默认 URL 列表顺序落到 unpkg，无害。
> 合并后需实测 npmmirror 对新版本的同步节奏满足 ≤30min SLA（分发流水线验收项）。

## 分支与改动

- 分支名：`feat/opencode-commandcode-models`
- 改动：在 `data/allowPackages.json` 中新增一条：

```json
"@wallbreakerno4/opencode-commandcode-models": { "version": "*" }
```

（`*` 覆盖全部未来版本，一次登记永久有效——该包每次构建发布取 `0.0.<Unix 秒 UTC>` 新版本号。）

## PR 标题（Conventional Commits）

```
feat: add @wallbreakerno4/opencode-commandcode-models to allowPackages
```

## PR 正文

```markdown
## 申请理由

为 `@wallbreakerno4/opencode-commandcode-models` 申请 npmmirror files 白名单登记（`version: "*"`）。

该包是开源项目 [WallBreakerNO4/opencode-commandcode-provider](https://github.com/WallBreakerNO4/opencode-commandcode-provider) 的**正常发布的 npm 数据包**：仓库的 GitHub Actions 流水线随上游 `command-code` CLI 发版自动构建，把解析出的模型目录数据（`models.json`，schema v1）以此包为载体发布到 npm，供 OpenCode 编辑器插件（`@wallbreakerno4/opencode-commandcode`）**在应用运行时匿名拉取消费**。包内仅一个 `models.json` 数据文件，无任何代码。

因部分用户的网络环境无法直连 `registry.npmjs.org` / `unpkg.com`，需要 npmmirror 的 files 端点作为镜像分发渠道；未登记前 files 端点 403，该渠道不可用。包版本号取 `0.0.<Unix 秒 UTC>`、由 workflow `concurrency` 串行保证严格单调，仅打 `latest` tag。

源码与构建流水线：https://github.com/WallBreakerNO4/opencode-commandcode-provider（`.github/workflows/models-pipeline.yml`）

## 登记内容

`data/allowPackages.json`：

```json
"@wallbreakerno4/opencode-commandcode-models": { "version": "*" }
```
```

## 维护者操作清单

1. fork `cnpm/unpkg-white-list`，按上述分支与改动登记；
2. 以草稿中的标题与正文开 PR；
3. 合并后实测：`curl -fsSL "https://registry.npmmirror.com/@wallbreakerno4/opencode-commandcode-models/latest/files/models.json"` 应 200 且内容与 Release asset 一致；
4. 记录同步延迟，确认满足 ≤30min SLA；若 PR 被拒，按 ADR-0001 另开决策票（备选：package.json 内嵌 manifest / 该渠道降位）。

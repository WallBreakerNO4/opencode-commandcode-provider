# 构建产物分发渠道：Release 为主源，npm 数据包作大陆兜底

> 状态：accepted（2026-08-30）。决策票：[WallBreakerNO4/opencode-commandcode-provider#10](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/10)。

构建产物需经匿名可拉取的渠道分发给插件运行时：客户端按内置的默认 URL 列表按序尝试、首个成功者胜，且模型管线的暴露规则（「API 有而产物无 → 隐藏」）使产物新鲜度成为**正确性要求**——SLA 定为发布到全网可见 ≤30 分钟。据此选定：**主源为 GitHub Release assets**（`releases/latest/download/models.json`，官方文档化的匿名 302、`no-cache` 每次重解析 latest、发布即生效、asset 带 ETag/Last-Modified、发布零额外凭据）；默认 URL 列表为 Release → npmmirror files → unpkg → raw `data` 分支。为获得 npmmirror（唯一大陆可达性良好的匿名渠道）的自动同步副本，构建侧同时发布独立数据包 `@wallbreakerno4/opencode-commandcode-models`（内容仅 models.json + package.json），并 force-push `data` 分支供 raw 灾备；包内快照独立于列表，始终是最后兜底层。

选型依赖几条代码里看不见的外部约束（2026-08-30 实测）：`raw.githubusercontent.com` 与 `gist.githubusercontent.com` 在大陆 100% 被阻断；`api.github.com` 匿名限额 60 次/时/IP，而 `releases/latest/download` 重定向不走该限额；jsDelivr 对分支内容有 CDN 12 小时缓存。

## Considered Options

- **gist raw**：大陆 100% blocked；且 Actions 的 GITHUB_TOKEN 无 gist 权限，需额外维护一把 PAT——两头都输，否决。
- **jsDelivr `@branch`**：CDN 12h 缓存（官方证实）直接违反 ≤30min SLA，新模型会静默隐身半天以上；主域名另有 DNS 污染问题，否决。
- **npm registry 直连 tarball**：tarball URL 仅认精确版本号，需「查元数据 + 下 tarball + 解 tar」三步，破坏客户端「纯 JSON URL」形状；unpkg 已覆盖同一数据，否决为独立渠道。
- **仅 npm 包内嵌（包内快照）**：新鲜度绑死插件发版节奏，作者本人成为更新瓶颈（老板明示排除），否决为唯一渠道。

## Consequences

- 仓库需新增 `NPM_TOKEN` secret；发布流水线一次运行同步发布三个渠道（Release asset / npm 数据包 / `data` 分支）。
- 命名三件套（asset 名 `models.json`、数据包名、`data` 分支名）烧进已发布插件的默认 URL 列表——改名等于强制插件发版，变更前需重新走决策。

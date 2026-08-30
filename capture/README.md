# Command Code 流量抓包

采集官方 `command-code` CLI 的真实 API 流量，为 `docs/research/disguise-spec.md` 与 `docs/spec/disguise.md` 的事实条款提供 ground truth（工单 [#9](https://github.com/WallBreakerNO4/opencode-commandcode-provider/issues/9)）。

## 文件组成

| 路径 | 作用 |
|---|---|
| `cc_capture_addon.py` | mitmdump addon：把 `*.commandcode.ai` 的请求/响应追加写入 `~/.cc-capture/requests.jsonl` |
| `sanitize.py` | 把 raw JSONL 脱敏成 `capture/samples/*.json`（形状保留、身份清除、结构保留），零依赖，`uv run` 直接跑 |
| `samples/` | 脱敏后的入库样本（见下方「样本存档规范」） |

原始数据（`~/.cc-capture/`）留在本机，永不进仓库。

## 本机网络注意（重要）

服务器常驻代理客户端（`localhost:7890`，小写 `http_proxy`/`https_proxy`/`all_proxy` 全局生效）。curl 与 Node 的优先级规则都是**小写压大写**：只设 `HTTPS_PROXY` 指向 mitmdump 的请求会被 7890 截胡，mitmdump 颗粒无收。

因此抓包遵循两条铁律：

1. **六个代理变量一起指向 8080**（大小写都设），并清空 `NO_PROXY`/`no_proxy`；
2. **mitmdump 以 upstream 模式串在 7890 之后**（8080 → 7890 → 外网），自身进程用 `env -u` 清掉代理变量，避免误读环境。

两条铁律封装成一行 export（终端 B 里粘贴执行即完成切换）：

```bash
export http_proxy=http://127.0.0.1:8080 https_proxy=http://127.0.0.1:8080 all_proxy=http://127.0.0.1:8080 HTTP_PROXY=http://127.0.0.1:8080 HTTPS_PROXY=http://127.0.0.1:8080 ALL_PROXY=http://127.0.0.1:8080 no_proxy= NO_PROXY= NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
```

还原为系统代理（Clash 7890）：

```bash
export http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890 all_proxy=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 ALL_PROXY=http://127.0.0.1:7890; unset no_proxy NO_PROXY NODE_USE_ENV_PROXY NODE_EXTRA_CA_CERTS
```

## 前置条件

- [uv](https://docs.astral.sh/uv/)，装 mitmproxy 用：

  ```bash
  uv tool install mitmproxy    # 隔离环境，mitmdump 落在 ~/.local/bin
  ```

  （备选 `sudo apt install mitmproxy`，Ubuntu 源内版本较旧但够用。）
- Node ≥ 24（`NODE_USE_ENV_PROXY=1` 需要；24.0+ 支持 fetch，24.5+ 支持 http/https 内建）。
- 官方 CLI `npm i -g command-code`。本仓库红线：CLI 只装在维护者自己的机器上做校准，与插件用户无关。

## 标准流程（Plan A：显式代理）

### 1. 启动采集（终端 A，保持运行）

mitmproxy 首次启动会生成 CA 到 `~/.mitmproxy/`：

```bash
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u NO_PROXY -u no_proxy \
mitmdump --mode upstream:http://127.0.0.1:7890 --listen-host 127.0.0.1 -p 8080 \
  -s capture/cc_capture_addon.py \
  -w ~/.cc-capture/flows.bin
```

只监听 `127.0.0.1`：CLI 与代理在同一台服务器上，流量不出本机，无需向网络暴露代理端口，也无需 SSH 端口转发。

### 2. 冒烟测试（终端 B）

先粘贴执行「本机网络注意」一节里的那行 export（代理切到 8080），然后：

```bash
node -e "fetch('https://api.commandcode.ai/provider/v1/models').then(r=>console.log('TLS OK',r.status)).catch(e=>console.error('FAIL',e))"
```

判定（`/provider/v1/models` 匿名可访问，是理想的探针）：

| 现象 | 结论 |
|---|---|
| B 打印 `TLS OK 200` 且 A 打出该 GET 的捕获行 | 代理路由与 CA 信任双通，可以开抓 |
| B 证书报错 | `NODE_EXTRA_CA_CERTS` 路径不对或 CA 未生成（先跑一次 mitmdump） |
| B 有 200 但 A 无捕获 | 流量被本机 7890 截胡：确认五个代理变量都已指向 8080（小写优先于大写） |
| B 连接失败 | mitmdump 未监听或端口不对 |

### 3. 登录 CLI（不挂代理）

用普通 shell（流量照常走 7890）完成 `command-code` 登录，再开正式抓包，避免登录凭据进入原始数据。

### 4. 正式抓包（终端 B，已执行 export 切换的同一会话）

```bash
command-code --help   # 确认一次性调用的 flag 名
command-code -p "Say OK"   # fresh 进程第 1 发：预期触发指纹 + lifecycle 预请求
sleep 5
command-code -p "Say OK"   # 第 2 发：观察预请求是否被冷却机制跳过
```

- 有交互 TUI 时，在 TUI 里发一条消息补一份对照（关注 `metadata.mode` 等字段的差异）。
- 可选：退出后 30 分钟用 fresh 进程再跑一发，补一个时间跨度的样本（lifecycle/指纹重发节奏）。

### 5. 结束与脱敏

终端 A `Ctrl-C`，然后：

```bash
export http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890 all_proxy=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 ALL_PROXY=http://127.0.0.1:7890; unset no_proxy NO_PROXY NODE_USE_ENV_PROXY NODE_EXTRA_CA_CERTS
uv run capture/sanitize.py
```

产出 `capture/samples/*.json`；人工过目 diff 后再入库。

## Plan B：透明代理（CLI 无视代理环境变量时）

> **本机不可用**：iptables 透明重定向会把 Clash 自身的出网流量也引进 mitmdump，形成回环。Clash 在跑时，Plan A 的 upstream 链就是正解，此节仅存档备用。

CLI 若是原生打包二进制（不读 `NODE_*` 变量），用 iptables 把本机 443 重定向给 mitmproxy。按官方配方用独立用户防止回环：

```bash
sudo useradd -r -m -d /var/lib/mitmproxy -s /usr/sbin/nologin mitm || true
sudo iptables  -t nat -A OUTPUT -p tcp --dport 443 -m owner ! --uid-owner mitm -j REDIRECT --to-ports 8080
sudo ip6tables -t nat -A OUTPUT -p tcp --dport 443 -m owner ! --uid-owner mitm -j REDIRECT --to-ports 8080
sudo -H -u mitm mitmdump --mode transparent --listen-host 127.0.0.1 -p 8080 \
  -s "$PWD/capture/cc_capture_addon.py" \
  -w /var/lib/mitmproxy/flows.bin
```

- mitm 用户运行时 CA 落在 `/var/lib/mitmproxy/.mitmproxy/`，冒烟测试的 `NODE_EXTRA_CA_CERTS` 指向它。
- 重定向规则影响全机 443（apt/npm 等），抓完立即删除同款 `-A` 换 `-D` 的两条规则。
- addon 的 JSONL 输出落在 `/var/lib/mitmproxy/.cc-capture/`，脱敏时 `--raw` 指过去即可。

## 脱敏清单（sanitize.py 的行为）

- 凭据：`Authorization`/`x-api-key`/`proxy-authorization`/`cookie`/`set-cookie`/JWT 全部替换为占位符（保留 scheme、key 前缀与长度）；
- 伪值替换（形状不变，内容不可回溯）：64 位 hex 哈希、UUID（保留版本/变体位）、`sess_*`、traceparent（保留 version/flags）、`x-project-slug`；
- 整段清除：prompt/系统提示词/工具 schema 等 >120 字符的字符串、文件路径、email、二进制 body；
- 原样保留：头名与出现顺序（含重复头）、user-agent、版本头、数值与布尔、短协议枚举、模型 id、URL 结构。

## 样本存档规范

`sanitize.py` 按端点分组输出到 `samples/`：

| 文件 | 端点 |
|---|---|
| `generate.json` | `POST /alpha/generate` 主请求 |
| `fingerprint-record.json` | `POST /alpha/fingerprint/record` 指纹预请求 |
| `lifecycle-events.json` | `POST /alpha/lifecycle-events` lifecycle 预请求 |
| `models.json` | `GET /provider/v1/models`（若 CLI 发起） |
| `other.json` | 命中主机的其余流量 |

每个文件为 `{"_meta": {...}, "requests": [...]}`；每条 request 含 `captured_at`/`method`/`url`/`http_version`、`request_headers`（`[名称, 值]` 有序数组，头序与重复情况本身是规格事实）、`request_body`（JSON 对象；流式响应体为 `{"_format": "ndjson", "lines": [...]}`）、`status_code`/`response_headers`/`response_body`/`error`。`_meta.redaction_summary` 记录各脱敏动作次数，`_meta.cli_version` 取自 `x-command-code-version`。

伪值替换保留形状（长度、字符集、UUID 版本/变体位、traceparent 的 version/flags），但内容不可回溯。据此做形状类断言（长度/格式/字段全集/头序）是可靠的；不要把伪值本身当作取值依据。

样本入库后在下方登记：

| 采集日期 | CLI 版本 | 文件 | 备注 |
|---|---|---|---|
| 2026-08-30 | 1.38.2 | `samples/generate.json` | 3 条（原始 20 条，保留 #0/#2/#19：两发一次性调用 + TUI 会话尾部）；含真实信封 `config/params` 结构 |
| 2026-08-30 | 1.38.2 | `samples/fingerprint-record.json` | 3 条（每进程一条，body 字节级相同）；响应 `{"success":true}` |
| 2026-08-30 | 1.38.2 | `samples/lifecycle-events.json` | 3 条（每进程一条）；响应 `{"tracked":true}` |
| 2026-08-30 | 1.38.2 | `samples/other.json` | 24 条：`/alpha/whoami` ×9、`/alpha/billing/subscriptions` ×6、`/alpha/billing/credits` ×9 |

采集环境：Ubuntu 24.04 x64（真实 Linux 机器）、Node 24、3 次 CLI 进程启动；原始流量 50 条存于本机 `~/.cc-capture/`（不入库）。脱敏器：`sanitize.py`（同形状伪值 + 占位符，身份字段/Stripe ID/凭据/路径/长文本已清除）。

## 红线

- 只抓自己的 Go plan 账号流量；`flows.bin`/`requests.jsonl` 不进仓库（`.gitignore` 已兜底 `capture/raw/`）；
- 不做故意的 A/B 语义对照实验：`x-co-flag`/`x-taste-learning` 只观察真实取值，不构造变体（工单 #9 已拍板：账号风控风险不值得）。

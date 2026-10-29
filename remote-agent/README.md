# 远程 Agent 操作 Windows：部署与使用

本功能让 macOS/Linux/Windows 上的 Codex、Claude Code 通过 `twssh` 操作 Windows 上持续运行的 PowerShell。浏览器固定只读查看终端，滚动不会影响远端执行。当前协议为 HTTP + Token，HTTPS 可选；无需在 Windows 上安装被控制的 Codex。

## 快速入口：安装 twssh skill（macOS / Linux / Windows 控制端）

推荐使用自包含的 [twssh skill](skills/twssh/SKILL.md)，内置客户端，不需要全局安装 CLI。控制端需要 Node.js 20+。以下命令在仓库根目录执行，Bash、zsh 和 PowerShell 均可使用：

```text
node remote-agent/skills/twssh/scripts/install.mjs codex
# Claude Code 用户改用：
node remote-agent/skills/twssh/scripts/install.mjs claude
```

也可把整个 `remote-agent/skills/twssh` 文件夹交给另一台电脑上的 AI，说：

> 请读取这个 twssh 文件夹的 SKILL.md，运行内置 install.mjs 安装到你对应的 skills 目录。检查 Node.js 20+，初始化连接配置；缺少地址或 Token 文件路径时再问我，不要读取或展示 Token。

重新加载技能或开启新对话后，在 Claude Code 使用 `/twssh`，在 Codex 使用 `$twssh` 或技能选择器。示例：

- `/twssh`：检查连接；第一次提示填写配置。
- `/twssh 把连接地址改为 http://192.168.1.20:8090，默认目录 C:\project`。
- `/twssh 在远程 Windows 的 C:\project 目录检查 Git 状态`。

连接配置放在**调用时的本地工作目录**下 `.twssh/connections.json`，不搜索父目录、不回退旧全局配置。在实际项目目录运行安装后的 `scripts/twssh.mjs init`，或让 AI 使用 `--project /本地项目目录` 指定项目。初始化不覆盖已有设置，并生成 `.twssh/.gitignore` 忽略连接配置和状态。

```json
{
  "version": 1,
  "connections": [
    {
      "name": "8845h",
      "description": "8845H 开发机",
      "url": "http://192.168.1.20:8090",
      "tokenFile": "~/.config/twssh/tokens/8845h",
      "cwd": "C:/twsshProjecTemp"
    },
    {
      "name": "14700",
      "description": "14700 测试机",
      "url": "http://192.168.1.30:8090",
      "tokenFile": "~/.config/twssh/tokens/14700",
      "cwd": "C:/twsshProjecTemp"
    }
  ]
}
```

只有一个连接时自动选中；多个连接必须说明名称，例如 `/twssh 使用 8845h 检查 Git 状态`。脚本使用 `--target 8845h`，目标缺失、名字不存在或重复时在联网前拒绝，不自动选第一个。Token 单独保存在控制端文件中；Windows 路径可写 `C:/Users/name/...`。可选 pin 用于 HTTPS 指纹。

新会话目录优先级：本次 `--cwd` > 连接配置 cwd > `C:/twsshProjecTemp`。默认目录不存在时，新版 Windows 服务会尝试自动创建；因此**自动建目录需要更新被控端代码并重启**。旧服务可先手动执行 `New-Item -ItemType Directory -Force -Path 'C:/twsshProjecTemp'`。指定其他目录时必须已存在，权限不足或路径无效会报错，不自动切换目录。更改默认目录不会改变已存在 Shell 的当前位置。

会话登记在 `.twssh/state/`，按当前项目、目标名称及服务地址隔离。`session local` 查看本地登记，`session list` 查看远端记录；明确选择远端已有会话后用 `session adopt --session ID` 登记。脚本拒绝直接操作未登记会话，改名或改服务地址需重新核对。连续任务复用会话，结束 detach；只有明确要求才 close。多个独立 Agent 不要并发写同一项目/目标的状态。

安装更新会备份旧 skill，不覆盖项目连接信息。旧版 `~/.config/twssh/connection.json` 不自动迁移；需要时将字段 host 改为 name、放进 connections 数组，并在目标项目中初始化。普通 CLI 的 TWSSH_HOME 行为不变，但新 skill 使用 --project 选择配置，忽略外部 TWSSH_HOME。

维护者修改 `remote-agent/client/{twssh,transport}.mjs` 时，须同步到 `skills/twssh/scripts/client/`；`node --test tests/twssh-skill.test.mjs` 检查内置副本一致性及独立安装、配置、请求路由。

## 1. 哪些机器需要更新

| 角色 | 需要的文件 / 操作 |
|---|---|
| 被操作的 Windows | 更新本仓库，安装依赖、构建网页，Agent API 默认开启，更新后重启服务 |
| 打开聚合网页的 Mac/Linux 主机 | 同步更新本仓库、重新构建网页并重启；只做网页入口时不必启用 Agent API |
| 发送命令的 Ubuntu/macOS Agent | 安装 `remote-agent/client` 客户端，让 Agent 阅读 `remote-agent/skills/terminal-web-remote/SKILL.md` |

**浏览器加载哪个地址，就使用哪台主机提供的前端。** 在 Mac 的聚合页面打开 Windows 会话时，只升级 Windows 不够。旧页面不支持新的只读快照协议，可能没有终端画面。更新提供网页的主机后，强制刷新浏览器。

功能分支：`winssh-f-fitshare-261028`。在已有仓库中更新：

```bash
git fetch origin
git switch winssh-f-fitshare-261028
git pull --ff-only
npm ci
npm run build
```

先保存本地未提交修改；不要用强制重置覆盖本机配置或工作。构建产物 `public/dist` 不提交 Git，所以每台提供网页的主机都必须自己构建。

## 2. Windows 服务端

需要 Node.js 20+、现有 psmux 和正常运行的 terminal-web。Windows 上 Agent API 默认开启，无需额外设置开关。项目根目录 `.env` 为本机配置，不提交 Git。不存在时先复制 `.env.example`，然后设置：

```dotenv
HOST=0.0.0.0
PORT=8090
# 仅在希望关闭远程 Agent 功能时取消下一行注释
# AGENT_ENABLED=0
TLS_CERT_FILE=
TLS_KEY_FILE=
```

未设置或留空 `AGENT_ENABLED` 时，Windows 默认开启，macOS/Linux 服务端默认关闭；显式 `1` 开启、`0` 关闭。**旧 `.env` 若已有 `AGENT_ENABLED=0`，仍会关闭功能，需要删除该项或改为 `1`。** Token 鉴权保持启用。

`HOST` 也可以设置为指定局域网 IP。停止原 Web 服务后，从项目根目录启动：

```powershell
pwsh -NoProfile -File scripts/start-windows.ps1
```

这个脚本读取 `.env`。直接 `npm start` 不自动读取 `.env`，使用它时必须另行设置进程环境。启动脚本不是 Windows 服务安装器，不自动配置开机启动。

Token 与管理员网页登录 Token 相同，默认在 `%USERPROFILE%\.config\terminal-web\auth-token`；配置了 `AUTH_TOKEN` 时以该值为准。客户端只需服务地址和 Token。Token 通过独立可信渠道交付，不放进仓库、Skill 或 ZIP。

HTTP 的 Token、输入和输出是明文，适用于可信内网或 VPN。持有 Token 的远端拥有服务用户的系统权限；它不会自动越过 UAC 或提升为管理员。

## 3. Mac/Linux 聚合页面

完成第 1 节的更新和构建后，按照这台机器原来的启动方式重启服务。若已用本项目服务脚本安装后台服务，可先查看 `bash scripts/service.sh status`，再按该脚本支持的命令管理服务；无需为观看 Windows 会话额外开启本机 Agent API。

浏览器强制刷新：Windows/Linux 使用 Ctrl+F5，Mac 使用 Cmd+Shift+R。也可以直接打开 `http://WINDOWS_IP:8090` 登录，绕过尚未更新的聚合页面。

## 4. 独立 CLI 安装（兼容旧用法）

下面是直接使用 CLI 的部署方式。使用上面的新 twssh skill 时，无需单独安装 CLI，也不使用本节的全局主机配置。

远端只需下面两部分及其文档：

```text
remote-agent/
  README.md                       部署和使用入口
  client/                         Node.js CLI，无第三方运行依赖
  skills/terminal-web-remote/      Agent 操作说明
  docs/design.md                  设计及协议说明
```

该目录直接以源码形式提交 Git，不提交 ZIP。可以从完整仓库复制整个 `remote-agent/`，或按第 7 节只检出此目录。在仓库根目录执行：

```bash
cd remote-agent/client
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"
```

把 PATH 设置加入远端实际启动 Agent 的环境。也可直接调用 `node /绝对路径/remote-agent/client/twssh.mjs`，避免全局安装。保留客户端目录，npm 的本地安装可能使用符号链接。

创建 Token 文件并配置主机（以下为 Bash）：

```bash
mkdir -p ~/.config/twssh
chmod 700 ~/.config/twssh
read -rsp 'Windows Token: ' TW_TOKEN
printf '\n'
(umask 077; printf '%s' "$TW_TOKEN" > ~/.config/twssh/token)
unset TW_TOKEN

twssh host add win-dev \
  --url http://WINDOWS_IP:8090 \
  --token-file ~/.config/twssh/token
twssh doctor win-dev
```

替换 `WINDOWS_IP`。返回 `version: 1` 和 `persistent-session` 能力表示接入成功。HTTP 不需要指纹。旧 HTTPS 别名改成 HTTP 时，再执行 `host add` 并省略 `--pin` 即可。

## 5. 独立 CLI 的旧版 Skill 指令

新安装推荐使用本文开头的 `twssh` skill；本节保留 `terminal-web-remote` 搭配独立 CLI 的方式。

将 Skill 文件夹安装到对应 Agent 支持的 skills 目录，或直接让 Agent 阅读该文件；无需把 Token 发进对话。例如：

> 阅读 `/opt/terminal-web/remote-agent/skills/terminal-web-remote/SKILL.md`。通过 `twssh` 操作已配置的 `win-dev`，任务目录为 `C:\project`。创建或复用一个专用会话，保存 sessionId，后续命令继续使用它。结束时 detach，保留环境。

客户端通过本地配置自动携带 Token。Codex 和 Claude Code 使用相同 CLI，不依赖专属 SDK、MCP 或模型协议。

```bash
twssh session create win-dev --name ubuntu-codex --cwd 'C:\project'
# 将返回的 sessionId 填入 SID
SID='返回的sessionId'
twssh exec win-dev --session "$SID" --command '$env:DEMO = "hello"'
twssh read win-dev --session "$SID" --wait 5
twssh exec win-dev --session "$SID" --command 'echo $env:DEMO'
twssh read win-dev --session "$SID" --wait 5
twssh detach win-dev --session "$SID"
```

`exec` 返回 `sent` 只表示输入已发送，不代表完成。当前版本不判断忙闲或退出码，必须先读取终端结果再决定下一步。前一个程序仍在运行时，新输入会进入那个程序。等待超时后继续 `read`；请求结果不明确时用 `result` 查询，不盲目重复执行。

更多命令、游标和限制见 [CLI 使用说明](client/README.md)。

## 6. 网页只读查看

- 创建会话后，会话列表出现 `🌐` 标签，顶部显示“远程 Agent 会话 · 只读”，不再提供接管或交还。
- 鼠标滚轮、触屏、PageUp/PageDown、Ctrl+Home/End 在浏览器本地翻页；支持文本选择和复制。滚动及浏览器窗口大小变化不向终端发送输入，不改变远端操作权。
- 浏览器读取 psmux 纯文本快照，约每秒更新一次，最多展示最近 2000 行（受 psmux 实际保留历史限制）。不保留 ANSI 颜色，不是完整归档，也不支持在页面内交互操作 TUI。
- 上翻或选择文本时冻结当前画面；远端继续执行后显示“有新输出”，点击“回到实时”查看最新画面。
- 页面禁止输入、粘贴、Ctrl+C、重启、分屏及关闭 Agent 终端；后端也拒绝浏览器接管和终止请求。普通终端保持原有行为。
- “操作记录”显示 Agent API 输入及请求状态，不是防篡改审计，也不保证还原所有应用操作。
- `detach` 或网络断开保留 Shell；需要结束时由远端运行 `twssh session close`。Windows 重启或 Shell 退出会丢失内存环境变量。

若没有只读画面，请同时更新 Windows 服务与提供当前网页的主机并重新构建、强制刷新；Mac 聚合页面也需要更新。远端 CLI 命令和 Token 配置不变。

## 7. 通过 Git 获取和更新

所有控制端文件统一维护在 `remote-agent/`，以可直接修改的源码提交。仓库不包含 ZIP、Token 或本机配置。

远端只需要控制端文件时，可以稀疏检出（以下命令在尚未创建目标目录时执行）：

```bash
git clone --filter=blob:none --sparse --branch winssh-f-fitshare-261028 \
  git@github.com:xutaocc/terminal-web.git terminal-web
cd terminal-web
git sparse-checkout set remote-agent
cd remote-agent/client
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"
```

以后在该仓库内执行 `git pull --ff-only` 更新源码；如果安装路径或客户端包配置变化，再执行同样的安装命令。只复制文件而不使用 Git 的机器，需要重新同步整个 `remote-agent/` 目录。

独立 CLI 的主机连接配置保存在 `~/.config/twssh/config.json`，与仓库分开，更新源码不会覆盖 Token 和会话记录。独立 CLI 的并发 Agent 使用独立 `TWSSH_HOME`；新 twssh skill 使用项目 `.twssh/`，同一项目/目标的操作须串行。Skill 若复制到了 Agent 的安装目录，也要同步更新该副本。

Windows 服务端和提供聚合网页的 Mac/Linux 主机需要完整仓库，不能只检出控制端目录；更新后分别构建并重启。

开发验证：

```powershell
npx tsc --noEmit
npm run build
node --import tsx --test tests/terminal-control.test.ts tests/shares.test.ts
$env:TW_AGENT_TEST_HTTP = '1'
$env:AGENT_BROWSER_TEST = '1'
node tests/agent-api.integration.mjs
```

集成测试使用 Windows psmux、OpenSSL；浏览器测试默认使用本机 Chrome，可用 `BROWSER_BIN` 指定路径。它验证真实会话恢复、CLI、鉴权、去重、只读快照、本地滚动、浏览历史时远端继续执行及浏览器越权请求拒绝。另有 HTTPS 路径，清除 `TW_AGENT_TEST_HTTP` 后运行。

已有 `tests/shares.integration.mjs` 仍使用旧 request/grant 转交协议，而基线服务端已切换分享规则，会在 handover request 处失败；本功能未恢复旧协议。尚未完成独立 Ubuntu 设备及 PowerShell 5.1 验收。

### 会话标签改名

`twssh session rename HOST --session UUID --name "电脑维护"` 仅修改展示名称。项目级 Skill 使用 `node scripts/twssh.mjs --project PROJECT --target TARGET session rename --session UUID --name "电脑维护"`，随后 `session identity --session UUID` 核对。

服务端提供 `PATCH /api/agent/v1/sessions/:id`，Bearer 认证，请求体 `{ "generation": "当前会话 generation", "label": "电脑维护" }`。名称 trim 后 1–64 字符，禁止控制字符；会话已关闭返回 410，generation 不匹配返回 409。接口不会启动 Shell 或获取终端控制权。重复设置相同名称是幂等的；并发改名按服务端接收顺序最后一次成功更新为准。

浏览器改名、备注编辑中的名称修改与 Agent API 共用持久化逻辑，保持内部 name、UUID、目录、终端进程和历史关联不变。新标签由现有会话列表同步机制更新；必要时刷新浏览器。旧版服务需升级后使用此命令。已有不一致名称不会自动猜测迁移，升级后显式改名一次即可统一。

### 查询会话、目录和历史

项目级命令（都带 `--project PROJECT --target 8845h`）：

```text
session list
session identity --session UUID
session history --session UUID --kind requests --after 0 --limit 50
session history --session UUID --kind output --after 0 --limit 50
```

`list` 返回服务端仍保留的全部 Agent 会话（包括已关闭），以及 total/open/closed 计数、完整 ID、名称、createdAt/lastActivityAt/closedAt、initialCwd、currentDirectory 和 requestCount。它不是浏览器所有普通终端的列表，也不是全部网络连接次数；删除的服务端历史不能找回。旧会话缺少时间戳时返回 null，不用查询时间伪造创建时间。

`history` 对应 `GET /api/agent/v1/sessions/:id/history?kind=requests|output&after=0&limit=50`，默认 requests，每页 1–100 条且请求记录页限制约 2 MiB。requests 游标是记录偏移，output 游标是独立持久化事件序号；按 nextCursor 翻页直到 hasMore=false。查询 metadata/history 不需要 adopt，不启动 Shell，不抢控制权；写入仍需项目登记和控制权校验。

输入记录包含 UTC ISO 时间戳、requestId、原始输入、发送状态和 directoryBeforeInput。目录来自发送输入前的 `pane_current_path` 观测，带 observedAt/source；失败时 cwd=null。它可能受 mux/前台程序行为影响，不保证等于 PowerShell 的逻辑位置，也不能代表同一段多行输入内部每条命令的目录。连续命令改变目录后，下次输入重新采样；不向忙碌终端注入 Get-Location。sent 只表示发送，不代表执行成功或完成。旧请求没有目录字段时应显示未知。

终端输出是原始 ANSI 流，不是模型聊天消息，也不能可靠逐条归属命令。每会话保存最近 512 KiB 或 2000 条（先达到者），truncated/gap 明确表示缺失。约 500ms 批量写盘，正常退出会 flush，异常断电可能损失最后一批；只覆盖采集器在线期间，旧输出不能追溯补齐。持久化文件位于 AGENT_SESSIONS_FILE 后缀 `.history/`。敏感输入存为 `[sensitive input]`，程序自身回显仍可能出现在输出中。请求去重记录独立保留，沿用既有每会话上限；超过上限拒绝新请求，不静默删除。

### Agent 会话类型标识

标签栏、侧边栏和移动端标题的 🌐 是前端根据内部 Agent 身份生成的独立标识，提示“远程 Agent 会话”，不会写回显示名称或随改名消失。旧名称开头已有的 🌐 仅在展示时去重；其他位置的 emoji 和普通会话名称保持原样。锁图标仍表示只读/分享状态，与 Agent 类型标识分开。

### Base64 操作记录预览

后端对完整的 PowerShell `-EncodedCommand`（UTF-16LE）、`node -e "eval(Buffer.from(...,'base64').toString())"`（UTF-8）及常用 UTF-8 ScriptBlock 包装自动生成 `decodedInput`、`decodedEncoding`、`decodedScope: "wrapper-body"`。原始 input 保留，发送内容和请求去重哈希不变；这些字段只是展示数据，不执行。外壳中明确的 FromBase64String 或 Buffer.from Base64 字面量会再解一层 UTF-8，保存为 decodedParts，最多 8 个片段、合计 16 KiB；不无限递归，也不推断文件路径。失败片段标注原因。旧记录读取时临时补充，不批量改写历史文件。网页默认展示代码片段，原始命令和完整外壳折叠；附加 format=json 参数可读取原始 JSON。

仅识别明确的完整包装，其他格式、非法 Base64/字符编码、二进制控制字符或超过 8192 字符的解码内容均跳过。没有预览字段不代表原命令不可执行。敏感输入继续只保存 `[sensitive input]`。可选预览不计入原有请求历史容量门槛，但会增加一定磁盘占用。不要为了得到预览而重复执行命令。

### 在浏览器关闭远程会话

管理员可在远程标签的 × 或菜单中选择「关闭远程会话」。确认框展示主机、显示名称和完整会话 ID；关闭终端可能中断任务。弹窗默认勾选「同时删除操作记录和终端输出历史」，用户可取消以保留记录；项目文件始终不删除。被其他控制端占用时普通关闭返回 SESSION_BUSY；只有再次明确确认才能强制关闭。关闭期间阻止新控制权和延迟输入，失败不主动移除标签。分享页无此管理权限。

浏览器统一使用「关闭远程会话」入口：终端仍在运行时结束终端并移除标签，终端已不存在时直接移除残留标签，两种情况均按弹窗的删除选项处理历史。未知的终端查询错误不视为已不存在。支持内部身份为 agent_ 加 32 位十六进制的遗留会话；未登记到 Agent API 的测试会话也可关闭，但不会补造缺失的历史。批量关闭跳过远程会话，需要逐个确认。

浏览器管理员接口：`POST /api/sessions/close-agent`，JSON `{name, force?: boolean, cleanup?: boolean, deleteHistory?: boolean}`。使用现有网页登录和同源校验，可经控制端远程代理访问。name 必须是完整内部身份，不能传显示名称或短 ID。原有 Agent CLI close 协议保持兼容。cleanup 参数仅为旧客户端保留，当前浏览器不再提供独立清理入口。

### 工具输出与 token

CLI exec/result/history 默认 `--detail compact`，返回状态、目录和最多 240 字符的 inputPreview，不重复输出原始输入和解码全文。预览可能截断，不用于执行或判断完成。`--detail readable` 返回完整可读外壳及解码片段（不重复 Base64 表达式）；`--detail raw` 返回原始输入；`--detail full` 返回兼容旧版的完整记录。选项仅控制 CLI 标准输出，不改变服务端保存内容或 API 协议；read 的终端事件不裁剪。网页浏览和本地解码不调用模型；显式读取详细内容仍会消耗相应 token。

### 关闭后删除记录与存储清理

网页关闭会话默认发送 deleteHistory=true；未传此字段的旧客户端及现有 CLI 保持保留历史的行为。只有底层终端成功关闭或确认不存在后，才清理该 Agent 会话的 requests（包括输入和解码字段）、输出 journal 及其临时文件、内存输出缓存。保留会话身份、关闭状态及 historyClearedAt 等少量元数据以阻止重建；不删除项目文件、业务数据、服务全局日志或外部备份。

关闭成功但清理失败返回 closed=true、historyDeleted=false、cleanupError=HISTORY_CLEANUP_FAILED，页面明确提示到主机清理入口重试。删除标记持久化后阻止延迟回调和 flush 定时器重新生成历史。旧历史链接显示删除时间，不再提供被清理内容。

侧栏每台电脑标题行的「⌫」按钮用于「清理已关闭会话记录」。先查询数量和估计空间、确认后按指定 ID 清理，每批最多 200 个；不会关闭正在运行的会话，不把采集器断线认定为已关闭。管理员接口 GET /api/sessions/closed-history 返回本批 sessions/count/bytes 与总数 total，POST 同路径提交 {ids:[完整会话ID]}，逐项返回 deleted/failed。批次预校验所有 ID 都已关闭，局部失败可重复重试。估计空间仅覆盖待删请求 JSON 和输出文件，不含保留元数据。

### HTTP file transfers

`file push/pull --spec spec.json` adds binary transfers without a terminal session.
The Agent API advertises `transfers-v1`. A single file streams directly; directories
and multiple files default to UTF-8 ZIP store (no compression), with explicit exclusions.
Deflate level 1 is available via explicit `compression: "fast"`. The client sends
`store` explicitly for pulls, including when talking to an older transfer-capable server.
Both directions validate size/SHA-256 before no-clobber hard-link publication.
The first release caps input/archive size at 1 GiB and ZIP entries at 60,000;
there is no extraction, overwrite, resume, or incremental synchronization.
See [transfer command examples and cleanup rules](skills/twssh/references/file-transfer.md).

Temporary workspaces use `.twssh-transfer-<UUID>-<random>/owner.json`.
Cleanup only uses live creation records, validates identities and modification
metadata, and unlinks named members before an empty-directory rmdir. It never
recursively removes a directory, sweeps a prefix, or reclaims orphan directories
after restart. Unknown or changed contents are retained and reported. Status
is process-local (200 recent records, cleaned records may be evicted), so a
missing result never authorizes automatic replay of an uncertain upload.


Windows TWSSH home is **`C:\twsshProjecTemp\`**, on either end of a transfer.
Create it when missing. Both packing and receiving workspaces live directly under
it as `.twssh-transfer-<UUID>-<random>/`; default final archive paths should be
`C:\twsshProjecTemp\<project>.zip`. The home itself, final archives and project
folders are NOT disposable caches. macOS/Linux retain platform-local paths.
Windows receive targets must share its volume/drive; reject unsupported targets
before sending payload, without silently moving staging to another location.

For a request combining archive transfer and automatic extraction, the agent must
present the complete host-specific source, packing, receiving, final archive,
extraction staging and final project paths, plus exact cleanup/retention scope,
and obtain explicit confirmation BEFORE transferring or extracting. A random-path
template is not an exact path plan. Changed paths or deletion scope need renewed
confirmation. Current push/pull do not implement extraction or extraction planning
and reject extract/extractTo parameters; do not bypass this via terminal commands.
See the skill reference for the required path checklist.

### Windows background command windows

Non-interactive tmux/psmux commands (session/directory polling, screen capture,
metadata, resize and control) use `src/background-process.ts`, which explicitly
sets `windowsHide: true` while preserving arguments, output, timeout and errors.
Do not import native execFile directly for these calls: a hidden parent process
does not guarantee that child console windows stay hidden. PTY/ConPTY attach
uses its existing path and must not be replaced by this background helper.

### escli 文件查询

TWSSH 统一使用 `C:\twsshProjecTemp\escli.exe` 查询 Everything 索引。程序缺失时，skill 自动使用官方固定 ES 1.1.0.38 x64 包准备客户端；已有文件不覆盖。Everything 主程序缺失或查询实例不可访问时只提醒，不自动安装、启动或修改服务。

安装流程、缓存保留规则及查询示例见 [escli 使用说明](skills/twssh/references/escli.md)。生成安装任务：`node remote-agent/skills/twssh/scripts/escli.mjs ensure /absolute/local/escli-task.json`，再通过 TWSSH task 执行。无需修改服务器或重启程序。

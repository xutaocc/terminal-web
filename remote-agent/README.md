# 远程 Agent 操作 Windows：部署与使用

本功能让 Ubuntu/macOS 上的 Codex、Claude Code 通过 `twssh` 操作 Windows 上持续运行的 PowerShell。浏览器固定只读查看终端，滚动不会影响远端执行。当前协议为 HTTP + Token，HTTPS 可选；无需在 Windows 上安装被控制的 Codex。

## 1. 哪些机器需要更新

| 角色 | 需要的文件 / 操作 |
|---|---|
| 被操作的 Windows | 更新本仓库，安装依赖、构建网页，配置 `AGENT_ENABLED=1` 并重启服务 |
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

需要 Node.js 20+、现有 psmux 和正常运行的 terminal-web。项目根目录 `.env` 为本机配置，不提交 Git。不存在时先复制 `.env.example`，然后设置：

```dotenv
HOST=0.0.0.0
PORT=8090
AGENT_ENABLED=1
TLS_CERT_FILE=
TLS_KEY_FILE=
```

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

## 4. 远端 Agent 安装客户端

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

## 5. 给 Codex / Claude Code 的指令

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

主机连接配置保存在 `~/.config/twssh/config.json`，与仓库分开，更新源码不会覆盖 Token 和会话记录。每个独立并发 Agent 使用独立 `TWSSH_HOME`，避免并发写同一个配置文件。Skill 若复制到了 Agent 的安装目录，也要同步更新该副本。

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

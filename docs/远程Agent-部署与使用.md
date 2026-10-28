# 远程 Agent 操作 Windows：部署与使用

本功能让 Ubuntu/macOS 上的 Codex、Claude Code 通过 `twssh` 操作 Windows 上持续运行的 PowerShell。浏览器能查看相同终端，并在需要时接管。当前协议为 HTTP + Token，HTTPS 可选；无需在 Windows 上安装被控制的 Codex。

## 1. 哪些机器需要更新

| 角色 | 需要的文件 / 操作 |
|---|---|
| 被操作的 Windows | 更新本仓库，安装依赖、构建网页，配置 `AGENT_ENABLED=1` 并重启服务 |
| 打开聚合网页的 Mac/Linux 主机 | 同步更新本仓库、重新构建网页并重启；只做网页入口时不必启用 Agent API |
| 发送命令的 Ubuntu/macOS Agent | 安装 `scripts/twssh` 客户端，让 Agent 阅读 `skills/terminal-web-remote/SKILL.md` |

**浏览器加载哪个地址，就使用哪台主机提供的前端。** 在 Mac 的聚合页面打开 Windows 会话时，只升级 Windows 不够。旧页面可能缺少“接管”按钮，也无法发送新版观看滚动请求。更新提供网页的主机后，强制刷新浏览器。

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
scripts/twssh/                  Node.js CLI，无第三方运行依赖
skills/terminal-web-remote/     Agent 操作说明
```

可以从完整仓库复制，也可使用第 7 节的 ZIP。解压后，在包根目录执行：

```bash
cd scripts/twssh
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"
```

把 PATH 设置加入远端实际启动 Agent 的环境。也可直接调用 `node /绝对路径/scripts/twssh/twssh.mjs`，避免全局安装。保留客户端目录，npm 的本地安装可能使用符号链接。

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

> 阅读 `/opt/terminal-web-remote/skills/terminal-web-remote/SKILL.md`。通过 `twssh` 操作已配置的 `win-dev`，任务目录为 `C:\project`。创建或复用一个专用会话，保存 sessionId，后续命令继续使用它。结束时 detach，保留环境。

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

更多命令、游标和限制见 [CLI 使用说明](../scripts/twssh/README.md)。

## 6. 网页观看、滚动与接管

- 创建会话后，Windows 会话列表出现 `🌐` 标签，显示客户端提供的名称。
- 网页默认观看，可复制和滚动历史；滚动不要求接管。PageUp/PageDown、Ctrl+Home/End 用于翻页。
- 编辑命令、粘贴和 Ctrl+C 需要点击“接管”；远端此时收到 `CONTROL_LOST`。点击“交还操作权”后远端可以继续。
- “操作记录”显示通过 Agent API 收到的输入及请求状态；它不是防篡改审计，也不保证还原终端内所有应用操作。
- 浏览的是共享 psmux 历史，滚动可能同步影响其他观看者。远端发送下一条键盘输入时自动退出历史模式并返回实时终端。
- `detach` 或网络断开保留 Shell；`session close`、网页“关闭并结束”会终止 Shell。Windows 重启或 Shell 退出会丢失内存中的环境变量。

没有“接管 / 操作记录”栏：优先确认提供当前网页的主机是否更新并重新构建，而不只是确认 Windows API 能访问。

## 7. 打包、更新与验证

在仓库根目录运行（需要 Python 3）：

```bash
python scripts/package-twssh.py --output /path/to/terminal-web-remote.zip
```

脚本只打包固定清单中的客户端、Skill、文档，不打包 `.env`、Token、日志和 node_modules。同时生成 `.sha256` 校验文件。ZIP 不包含 Windows 服务端；服务端和聚合主机应通过 Git 更新。下载端口与终端端口是两个不同服务。

更新客户端后重新安装同一目录；主机配置保存在 `~/.config/twssh/config.json`，不会因复制客户端而自动更新。每个独立并发 Agent 使用独立 `TWSSH_HOME`，避免并发写同一个配置文件。

开发验证：

```powershell
npx tsc --noEmit
npm run build
node --import tsx --test tests/terminal-control.test.ts tests/shares.test.ts
$env:TW_AGENT_TEST_HTTP = '1'
$env:AGENT_BROWSER_TEST = '1'
node tests/agent-api.integration.mjs
```

集成测试使用 Windows psmux、OpenSSL；浏览器测试默认使用本机 Chrome，可用 `BROWSER_BIN` 指定路径。它验证真实会话恢复、CLI、鉴权、去重、观看滚动、接管及滚动后继续执行。另有 HTTPS 路径，清除 `TW_AGENT_TEST_HTTP` 后运行。

已有 `tests/shares.integration.mjs` 仍使用旧 request/grant 转交协议，而基线服务端已切换分享规则，会在 handover request 处失败；本功能未恢复旧协议。尚未完成独立 Ubuntu 设备及 PowerShell 5.1 验收。

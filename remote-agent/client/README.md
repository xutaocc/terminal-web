# twssh 0.1 — 持久终端客户端

完整部署、Mac 聚合页面升级、远端 Agent 配置和 Git 更新步骤见 [部署与使用指南](../README.md)。

首版支持 HTTP + Token（可选 HTTPS）、原始终端输入、持续 Shell、输出游标、请求去重、网页独立只读查看。尚未实现受管命令完成通知、WSS 推送、独立侧栏分组及接入设置页。标签通过 `🌐` 前缀识别。操作记录可在网页终端顶部打开。

## Windows 服务端

直接使用现有 HTTP 服务地址和 Token，无需证书及指纹。Windows 默认启用 Agent 接口，更新后重启服务：

```powershell
# 如果旧配置显式关闭了功能，可覆盖为开启
$env:AGENT_ENABLED = '1'
# 以前配置过 TLS 时，清除这两个变量以恢复 HTTP
Remove-Item Env:TLS_CERT_FILE, Env:TLS_KEY_FILE -ErrorAction SilentlyContinue
npm start
```

Windows 未设置或留空 AGENT_ENABLED 时默认开启；显式 0 关闭、1 开启。macOS/Linux 服务端默认关闭。HTTP 会明文传输 Token、命令和输出，只在可信内网或 VPN 中使用；Token 校验不是加密。仍可按需配置 TLS_CERT_FILE / TLS_KEY_FILE 使用 HTTPS。

需要持久配置时，在 Windows 项目根目录的 `.env` 中设置 `AGENT_ENABLED=1`，然后使用 `pwsh -NoProfile -File scripts/start-windows.ps1` 启动。该脚本读取 `.env`；直接 `npm start` 不会读取此文件。`.env` 是本机配置，不提交 Git，也不需要提供给远端 Agent。

## Ubuntu 客户端

复制整个 `remote-agent/client` 文件夹到 Ubuntu；需要 Node.js 20+，无第三方运行依赖。

```bash
cd remote-agent/client
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"
# 也可以直接 node /path/to/twssh.mjs ...
chmod 600 /secure/token.txt
twssh host add win-dev --url http://192.168.1.20:8090 \
  --token-file /secure/token.txt
twssh doctor win-dev
twssh session create win-dev --name ubuntu-codex --cwd 'C:\devMyHome\terminal-web'
twssh exec win-dev --session 返回的ID --command '$env:DEMO = "hello"'
twssh read win-dev --session 返回的ID --wait 5
twssh exec win-dev --session 返回的ID --command 'echo $env:DEMO'
twssh read win-dev --session 返回的ID --wait 5
twssh detach win-dev --session 返回的ID
# 人工交互：Ctrl+] 断开，Ctrl+C 发送到远端
twssh attach win-dev --session 返回的ID
```

HTTP 不需要 `--pin`。可选 HTTPS 模式下，可信 CA 证书可以省略 `--pin`。自签指纹验证发生在发送 Token 前，不能通过未经验证的网络响应自动接受指纹。不提供跳过证书校验开关。

配置保存到 `~/.config/twssh/config.json`，目录 0700、文件 0600；含 Token，不能分享或提交 Git。`TWSSH_HOME` 可指定独立配置目录。首次创建会话时保存 ID 和客户端恢复标识；后续使用相同 ID。Token 更换后更新主机配置，服务端重启关闭旧连接。

## Agent 使用

将 `remote-agent/skills/terminal-web-remote` 目录复制到 Agent 支持的 skills 目录，让 Codex/Claude Code 加载其中的 `SKILL.md`。Skill 使用标准 CLI，不需要专属 SDK 或 MCP。

原始终端版本必须先读取输出再决定是否输入；服务端不判断前一个程序是否仍在运行。`exec` 返回 `sent`，不代表运行完成。长时间命令反复 `read`，不重复 `exec`。`result` 查询上次输入请求；`--request-id UUID` 可由调度器自行管理请求编号。数据发送到同一个 PowerShell，环境只在原 Shell 存活期间保留。

输入请求摘要和结果持久化到 `AGENT_SESSIONS_FILE`（默认 `~/.terminal-web/agent-sessions.json`），每会话最多 10000 项或约 8 MiB，满后明确拒绝新输入，避免悄悄失去去重记录。输出保留最多 8 MiB 内存；服务重启或缓冲过期返回 gap。输入记录默认包含命令文本；交互秘密用 `--sensitive`。同系统用户有读取/修改这些文件的权限，记录不具备防篡改保证。

首版每服务最多 8 个未关闭的 Agent 会话；会话登记与 psmux 存活分开。已有 Shell 丢失时恢复会失败，不自动重建。发生 collector_closed 时需要检查原会话并重启服务重新附着；不要直接重复执行最后的命令。

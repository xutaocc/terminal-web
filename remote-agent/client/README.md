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


## 低往返读取（兼容现有 Agent API）

`twssh exec HOST --session SID --command 'Get-Location' --wait 2` 在发送后自动读取；
`twssh read HOST --session SID --wait 5 --collect` 自动收集多页事件。
旧的 exec/read 默认行为不变。`--wait` 为 0–30 秒；聚合默认最多 8 次请求、256 KiB，
可通过 `--max-batches`（1–32）、`--max-bytes`（1024–4194304）调整。
字节阈值在完整响应页后检查，允许最多一页超出，防止确认游标后丢失内容。
总等待预算不替代单次网络请求超时。HTTP 在同次 CLI 内复用连接，HTTPS 仍逐次校验证书。

exec 返回发送回执和 observation。观察包含终端未读事件，不能当作该命令专属输出；
quiet/deadline 不代表执行结束，completion 仍为 unknown。读取失败不会自动重发已发送的命令；
observationError/readError 与 requestId 帮助继续读取或查询 result。只读分页出错保留已读内容与游标。

项目 skill 与客户端在同一 Node 进程内运行，取消重复 /info 探测；doctor 仍可显式检查连接。
Token 每次调用重新读取；控制权、请求去重、发送前持久化及目标隔离保持不变。
独立结构化任务（确定退出码）和文件补丁 API 尚未提供，仍使用持久终端工作流。

## 独立任务与文件操作（tasks-v1 / files-v1）

先用 doctor 检查 capabilities。任务适用于构建、测试和环境检查；需要交互或继承终端变量的操作继续使用 exec/input/read。任务不占用、也不修改已有终端。

```sh
twssh task create HOST --spec /local/build.json --request-id UUID
twssh task list HOST
twssh task wait HOST --task UUID --wait 5
twssh task status HOST --task UUID
twssh task logs HOST --task UUID --after 0 --limit 100
twssh task cancel HOST --task UUID
twssh task delete HOST --task UUID
```

spec 示例：`{"cwd":"C:/devMyHome/terminal-web","executable":"node","args":["--version"],"timeoutMs":60000}`。
不使用隐式 Shell，不支持交互 stdin；Windows 的 npm.cmd 等脚本应显式通过 pwsh/cmd 调用，或直接运行 Node 脚本。
任务继承服务账户的基础环境，不继承某个终端的临时变量；认证及 Agent 内部环境变量不会传入。
`timeoutMs:0` 不设执行时限；`task wait` 的等待到期不会停止任务。任务真实退出码由子进程 close 事件记录。
监督进程独立于 HTTP 服务，保存时间、cwd、退出码和 stdout/stderr。服务重启后可用 taskId（等于 requestId）查询。
15 秒无监督进程心跳会报告 unknown，不能自动重跑或按旧 PID 杀进程。
取消仅针对监督进程当前持有的子进程树；任务中不要启动脱离该树的后台服务。Windows 使用 taskkill /T，POSIX 使用独立进程组。
最多 4 个未确定结束的任务、200 份未清理记录；超限明确拒绝，不隐式排队。日志最多 4 MiB，超出后继续排空管道，标记 truncated；分页游标只确认完整记录。
删除只允许结束任务；unknown 可显式 `--forget-unknown` 删除记录，但这不代表进程被终止。保留至多 10000 个请求哈希墓碑，删除后重试不会重新执行。需要定期 task list/delete 清理，不默认定时删除审计记录。

```sh
twssh file read HOST --root C:/project --path src/app.py --start-line 1 --line-count 100
twssh file search HOST --root C:/project --query 'Hello'
twssh file write HOST --root C:/project --path hello.txt --file /local/hello.txt --expected-hash missing
twssh file patch HOST --root C:/project --path hello.txt --edits /local/edits.json --expected-hash SHA256
twssh file result HOST --request-id UUID
```

edits 是 `[{"oldText":"Hello","newText":"Hello world"}]`；每段旧文本必须唯一命中，所有编辑成功后才整体提交。
root 必须为绝对目录，path 为目录内相对路径；拒绝越界及目录内符号链接。只处理最多 1 MiB 的 UTF-8 文本（保留 BOM/换行），单次 HTTP 请求体仍限 96 KiB。
修改已有文件必须传读取所得 SHA256；新建用 missing。写入临时文件后复核哈希并替换；新建采用独占创建。此为乐观并发检查，无法锁住编辑器等外部写入者，需避免同时编辑同一文件。
写操作先保存 requestId 和意图哈希，结果不明查 file result 并重读文件，不盲目生成新 ID 重试。超过 10000 个写入回执明确拒绝，回执只保存哈希与结果，不保存文件正文。
搜索为字面量，跳过 .git/node_modules/符号链接/不可读取或非文本文件，最多遍历 2000 项、返回 200 个匹配；截断和跳过数量显式返回。

部署需要连续的维护通道时，可先单独启动 `node --import tsx scripts/agent-maintenance.ts`，显式设置 MAINTENANCE_HOST、MAINTENANCE_PORT、MAINTENANCE_STATE_DIR（绝对路径）。该临时进程沿用已有认证，只开放任务与文件 API，使用独立状态目录，不接管终端。默认 30 分钟自动退出（MAINTENANCE_SECONDS 可设 60–3600）。必须先验证通道的查询和执行，再重启主服务；验证主服务恢复后停止维护通道。它保障恢复操作仍可达，不保证主服务 WebSocket/HTTP 连接在重启瞬间不断开。

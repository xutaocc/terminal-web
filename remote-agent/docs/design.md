# Windows 远程 Agent 持久终端设计

状态：目标设计，已有 0.1 原始终端实现；具体可用能力以 `remote-agent/client/README.md` 为准。日期：2026-10-28。
工作分支：`winssh-f-fitshare-261028`。
基线：`fit-status-f-share-multi-platform-261027`，提交 `9f22aa7ea7d4b3a04f696b657b0bab47c8e98b57`。
文中未在使用说明列出的 API、客户端命令及配置仍为拟议接口。

## 0. 当前实现进度

最新调整：按用户要求默认支持 HTTP + Token，无需证书和指纹；HTTPS 为可选项。HTTP 不能防止网络监听及 Token 明文泄露，只用于可信内网或 VPN。其余持久会话和操作权语义保持。

已实现：HTTP 与可选 Node 直接 HTTPS、Bearer Token、HTTPS 模式发送凭据前校验证书/指纹、专属持久 psmux 会话、网页 🌐 标签及只读快照/操作记录、REST 输入和增量长轮询、请求去重及不确定状态、CLI 和远端 Skill。交互 `attach` 目前也使用长轮询，Ctrl+] 断开保留会话。

尚未实现：WSS 推送、受管命令完成/退出码、独立侧栏分组、网页接入设置、代理 TLS 模式、输出落盘轮转。原始模式不会判断 Shell 忙闲，Agent 必须先查看输出再提交下一条命令。持久输入历史达到 10000 项或约 8 MiB 时拒绝新增，不静默丢失去重信息。

Windows 集成测试覆盖真实 psmux 会话、环境变量保留、Node 重启后恢复、网页只读隔离、CLI、证书错误时不发送凭据及去重。尚未在另一台 Ubuntu 主机或 Windows PowerShell 5.1 上完成设备验收。原分享集成测试停在 handover request：基线 server.ts 已不接受该测试使用的 request/grant 消息，需后续按当前分享规则更新该测试。

## 1. 目标与选择

Ubuntu 等服务器上的 Codex、Claude Code，通过地址、端口和 Token 操作本机 Windows 的持久终端；网页自动出现专属标签，可实时查看命令、输出及连接状态。

采用 HTTP/HTTPS REST 控制接口 + 计划中的 WS/WSS 流式终端 + psmux 持久 Shell。沿用现有 Node 服务及端口，不实现 SSH 加密协议。远端安装一个小型 Node.js CLI，名称暂定 `twssh`；Skill 教 Agent 使用 CLI。首版不要求 MCP、不需要在 Windows 再启动一个 Codex。

使用体验参考 SSH 的主机别名、服务器身份校验、交互终端、心跳和连接复用。持久环境则类似 SSH + tmux：网络连接与 Shell 生命周期分离。标准 `ssh user@host` 不能直接连接本协议；若以后要求标准 SSH/SFTP 兼容，应接入 Windows OpenSSH，而不是自行实现 SSH。

信任模型：持有有效 Token 的远端是可信操作方，可以执行运行服务的 Windows 用户能够执行的任意命令。首版不提供多租户、目录沙箱、命令白名单、逐条审批或独立 Windows 身份。若服务未提升权限，Token 不会自动获得管理员/UAC 权限。不同会话是工作状态隔离，不是同一 Windows 用户之间的安全隔离。

## 2. 现有基础与必须调整的地方

| 现有实现 | 复用方式 / 改动 |
|---|---|
| `src/tmux.ts` 的 psmux 和 `new-session -A` | 创建专用会话；恢复时改为严格 attach，缺失时返回错误，禁止悄悄重建 |
| `src/session-store.ts` 的持久 identity | 增加来源和接入信息；授权及恢复绑定不可复用的 identity，不靠标签名 |
| `src/auth.ts` 管理员共享 Token、Cookie、Origin 校验 | Agent API 使用同一 Token 的 Bearer Header；浏览器继续使用 Cookie；只在新接口识别 Bearer |
| `src/server.ts` 的 PTY/WebSocket | 抽出会话连接管理，供浏览器和 Agent 共用 |
| `src/terminal-control.ts` 的 owner、epoch、fence | 新增 Agent 会话策略；现有 interact 会自动取得操作权，不能直接沿用 |
| `tmux/pwsh-integration.ps1` 的 prompt 包装 | 扩展可选命令完成通知；保留用户 prompt 和目录同步 |
| 现有分享及远程主机功能 | Agent 会话首版不进入分享选择器，防止与“分享后管理员只读”策略冲突；普通会话保持原逻辑 |
| 文件管理、会话侧栏、状态推送 | 管理员可从专用标签打开实际目录；Agent 首版无需额外文件 API |

现有分享目录导航提示不是 Shell 权限隔离；本方案也不将其用作权限边界。

## 3. 通信认证：Token，TLS 可选

仅携带 Token 不能阻止中间人窃取明文。默认 HTTP 适用于可信内网或 VPN；需要链路保密时选择 HTTPS，并在发送 Token 前验证证书。

- HTTP 和 HTTPS 都必须携带有效 Token；无需为 HTTP 配置指纹。服务端保持 Agent 接口显式启用开关。
- HTTPS 目标支持两种部署：Node 同端口直接加载证书；或 HTTPS 反向代理转发至仅监听回环地址的 Node 服务。后者不能把后端端口同时暴露给网络。
- 可选 HTTPS 模式：有域名时使用可信 CA 证书；只有 IP 时可使用自签证书，并从服务启动日志复制 SHA-256 指纹给远端客户端（网页设置页待实现）。
- 自签模式在发送任何认证 Header 前验证证书指纹；首次连接不能自动信任网络上返回的指纹。证书变化时停止连接，经本机确认后更新配置。
- Token 放 `Authorization: Bearer ...`，不得放 URL、命令行参数、日志、Skill 或网页标签。客户端用隐藏输入、标准输入或权限受限的 Token 文件配置。
- 默认复用管理员 Token，避免增加账号系统；页面明确“此凭据允许操作本机服务用户可访问的所有资源”。远端提供的名称仅用于显示和审计，不作为可靠身份认证。
- 拒绝自动跟随重定向，防止把 Token 带到别的地址。无 Token、错误 Token、过期连接认证均拒绝；复用认证失败限流，比较 Token 使用常量时间函数。
- Token 更换后关闭现存 Agent 连接并废止恢复凭据，保留 Shell；重启服务完成轮换也可以作为首版流程。
- 新接口拒绝跨站浏览器 Origin，不启用宽泛 CORS；不得仅凭客户端提供的 `X-Forwarded-Proto` 放行明文请求。代理模式需显式配置可信代理且限制入口。

Linux 客户端配置目录权限 0700、Token 文件 0600；Windows 服务端敏感文件需要 NTFS ACL，不能把 POSIX chmod 当作 Windows 权限保证。不默认记录认证 Header、环境变量全量或交互密码输入。

## 4. 会话及网页体验

远端创建时传入显示名称、Agent 类型和初始目录，服务器生成 sessionId、generation。Shell 首选 PowerShell 7，回退 Windows PowerShell 5.1；服务端返回实际版本、编码和功能能力。

侧栏增加“远程 Agent”分组，例如 `🌐 ubuntu-build · Codex`。标签展示连接中、执行中、空闲、已断开、已结束；连接状态与命令状态分别保存，断线时任务仍可能运行。

- 打开标签显示纯文本终端快照，支持本地复制与滚动。
- 网页固定只读，不加入 TerminalControl，不连接 PTY。服务端每秒合并采集一次 capture-pane，每个浏览器独立查看最多 2000 行历史。
- 浏览器不允许输入、接管、终止、重启、resize 或改变 copy-mode。上翻时冻结本地快照，回到实时才展示待更新内容；远端持续执行不受查看影响。
- 同一会话同一时刻只有一个写连接。短暂断线保留操作权 15 秒，恢复必须验证 Token 和恢复凭据；超时后允许显式重新获取。
- 多个 Agent 并行工作创建不同会话。同一标签名称不自动等于同一会话；客户端保存服务器返回的 ID。
- `detach` 断开不销毁；`close` 显式终止。Shell 已退出则返回 `SESSION_GONE`，由用户/Agent明确创建新会话，不伪装为环境仍然保留。

环境变量、当前目录、函数、虚拟环境保持在同一个 Shell 进程。Windows 重启或 Shell/psmux 退出后不能恢复内存状态；只保留标签、记录和初始化配置。Node 服务重启后尝试重新附着存活会话，实际 psmux 存活行为必须在目标 Windows 版本验收。

## 5. 协议 v1

所有接口挂在 `/api/agent/v1`，在管理员网页路由之前独立认证。服务端公布版本和 capabilities；不兼容版本直接报错。

| 接口 | 作用 |
|---|---|
| `GET /info` | 认证后返回 hostId、协议版本、系统、Shell 能力及限制 |
| `GET /sessions` | 列出 Agent 会话 |
| `POST /sessions` | 创建会话，含 requestId、label、agent、cwd |
| `GET /sessions/:id` | 查询 generation、连接、控制权和执行状态 |
| `POST /sessions/:id/commands` | 在原 Shell 提交完整命令，返回 commandId |
| `GET /sessions/:id/events?after=...&waitMs=...` | 增量读取，最长等待 25 秒，支持无常驻客户端 |
| `GET /sessions/:id/commands/:commandId` | 查询命令状态；超时后靠它查询，不能重新执行 |
| `POST /sessions/:id/input` | 输入文本/Enter/Ctrl+C 等，带 requestId 和控制权 epoch |
| `POST /sessions/:id/control` | acquire/release；仅远端客户端参与操作权竞争 |
| `DELETE /sessions/:id` | 明确关闭会话，带 generation 防止误关替代会话 |
| `WSS /api/agent/v1/stream` | Bearer 认证后订阅会话、流式输出、心跳与交互输入 |

控制消息使用 UTF-8 JSON。输出事件首版使用带序号的 JSON + base64 原始终端字节，保留 ANSI 和分片边界；CLI 提供原始显示和安全的文本视图。字段包含 `sessionId, generation, streamEpoch, seq, type, timestamp`。base64 的带宽开销换取首版协议简单；测量后再决定是否增加二进制帧。

提交示例：

```json
{"requestId":"UUID","generation":"UUID","controlEpoch":7,"text":"$env:DEMO = 'hello'","mode":"shell"}
```

响应示例：

```json
{"commandId":"UUID","state":"accepted","sessionId":"UUID","generation":"UUID"}
```

命令状态：accepted、running、completed、interrupted、unknown。完成信息区分 PowerShell 成功标志、原生程序退出码；不把陈旧 `$LASTEXITCODE` 当成所有命令的退出码。Shell 退出、取消或集成失效时允许 unknown/null，不能编造成功。

### 去重与断线

- 创建、命令、交互输入都带 requestId；服务端持久保存请求内容摘要和状态。同一 ID 同一内容返回原结果；同一 ID 不同内容返回冲突。
- 写入 psmux 与数据库不是事务。崩溃窗口可能出现“已登记但不知是否输入”，恢复后标记 unknown，禁止自动重新注入。这保证避免盲目重复，不能承诺任意命令严格 exactly-once。
- 客户端先查询原 requestId，再决定是否继续；已经确认的命令不得因网络超时重发成新 ID。
- 输出有序号和有限保留。游标超出范围返回 `OUTPUT_GAP` 及最早可读位置，不默默跳过。服务重启导致采集空档时产生新 streamEpoch 和 gap 事件。
- psmux 画面快照标记为 snapshot，不作为新命令输出或完整历史。断线期间收集由服务端常驻会话连接承担，而不是依赖浏览器在线。

## 6. 命令执行与终端兼容

提供两种能力，均操作同一个 Shell：

1. **原始终端模式**：交互程序、编辑器、提示输入、Ctrl+C；与现有终端最接近，不保证逐条命令退出码。
2. **受管命令模式**：Shell 空闲时提交完整命令，PowerShell 集成记录开始/完成事件；一次只接受一条，忙时返回 `SESSION_BUSY`，不把新命令误送入前一个程序的 stdin。

受管模式必须在原 PowerShell 的持久顶层作用域执行，不能每条启动一个 powershell 子进程，也不能因函数局部作用域使函数定义和变量消失。采用当前作用域执行脚本内容的集成方案，先验证全局变量、函数、cd、venv、多行和异常行为再定实现；失败时只公布 raw capability。

命令通过 UTF-8 文本文件或结构化输入传输，避免 Bash→JSON→PowerShell 多层插值。底层控制 psmux 使用 `execFile` 参数数组和生成的内部目标名称，不能拼接 Shell 命令。

完成事件可以经本机管道上报；prompt/屏幕标记只能作为状态提示，不能当作安全证明。后台子进程仍可能继续输出，完成只表示前台提交已返回。保留 PSReadLine、用户 prompt 和原有目录同步行为。

## 7. 远端安装与使用（拟议 CLI）

首版发布带依赖的 Node.js 客户端包，选定并测试受支持的 Node LTS 基线；提供可校验的版本包，不要求远端安装浏览器或项目全仓库。每次 CLI 都能短连接调用 REST；交互 attach 使用长连接，后续按性能需要增加类似 ControlMaster 的本地连接复用进程。

当前用 AGENT_ENABLED=1 启用服务，复制 HTTP 地址和 Token；HTTPS 可选，只有自签证书需要额外配置指纹。网页接入设置仍待实现。

```bash
# 首次配置：交互隐藏输入 Token；pin 仅自签部署需要
twssh host add win-dev --url http://192.168.1.20:8090 --token-file /secure/token.txt
twssh doctor win-dev

# 创建专用会话，JSON 返回 sessionId；后续保存并复用
twssh session create win-dev --name ubuntu-codex --agent codex \
  --cwd 'C:\devMyHome\terminal-web' --json

# SESSION_ID 替换为返回的 ID；每次 exec 在同一个 Shell 执行
twssh exec win-dev --session SESSION_ID --command '$env:DEMO = "hello"' --json
twssh exec win-dev --session SESSION_ID --command 'echo $env:DEMO' --json

# 文件方式适合复杂中文、多行和引号，文件在 Ubuntu 本地读取
twssh exec win-dev --session SESSION_ID --file task.ps1 --wait 20 --json
twssh read win-dev --session SESSION_ID --after CURSOR --wait 20 --json
twssh command status win-dev --session SESSION_ID --id COMMAND_ID --json

# 交互和人工使用
twssh input win-dev --session SESSION_ID --text yes --enter --json
twssh interrupt win-dev --session SESSION_ID --json
twssh attach win-dev --session SESSION_ID
twssh detach win-dev --session SESSION_ID

# 明确结束 Shell，环境随之消失
twssh session close win-dev --session SESSION_ID
```

所有 CLI 的机器输出统一 JSON，诊断写 stderr；区分工具/网络失败与远端命令失败。等待超时返回 running 和 commandId，不杀任务。客户端处理终端控制字符，JSON 模式不把远端输出直接当本地终端转义执行。

Skill 随客户端发布，内容包括：主机别名、持久 sessionId、Windows Shell 语法、忙时等待、超时查询、断线续读、操作权丢失处理、默认 detach 而非 close、禁止自动重放 unknown 命令。Skill 不含 Token。Codex 和 Claude Code 使用相同 CLI 契约，按各自安装方式提供 Skill；MCP 是后续可选封装。

## 8. 审计、性能与简单限制

网页“操作记录”保存服务端收到的完整命令、提交时间、客户端声明名称、requestId、完成状态、操作权和断线事件。原始键盘输入只能记录为交互事件，不能可靠还原所有 Shell 命令。密码类交互默认不落输入明文；终端输出仍可能包含应用自己打印的秘密，提供关闭输出落盘选项。

同一系统用户有修改本机记录的能力，因此这是可追踪的使用记录，不是防篡改审计。首版默认命令元数据保留 7 天；原始输出仅保留每会话 8 MiB 内存环形缓冲，磁盘输出日志显式启用后每会话 32 MiB 轮转。配额可调整，输出缺失必须显式报告。

拟定初始限制：每主机 8 个 Agent 会话（同时受现有 maxPtys 总限制）、单条命令 64 KiB、单帧 256 KiB、每客户端待发送队列 4 MiB。输出按 10–20ms 或 16 KiB 批次推送，心跳 5 秒；慢消费者断开并可续读，不拖住 Shell。默认不压缩小帧。

性能验收目标（非已测结论）：LAN 空闲连接输入至输出 p95 <100ms；重连到存活会话 <2s；持续大量输出下内存受限，网页仍可操作。记录 RTT、首输出延迟、吞吐及丢失范围，区分命令本身耗时。

## 9. 本地实施拆分

新增模块建议：

- `src/agent-api.ts`：版本路由、认证、schema 校验和请求大小限制。
- `src/agent-sessions.ts`：持久身份、psmux 生命周期、严格恢复。
- `src/agent-stream.ts`：常驻采集、缓冲、游标、背压和 WSS。
- `src/agent-commands.ts`：执行状态、请求去重、崩溃不确定性处理。
- `src/agent-audit.ts`：记录及轮转，认证数据过滤。
- `remote-agent/client/`：远端 CLI 和使用说明；后续增加实际 Skill。
- 网页增加接入设置、远程分组、状态徽标、操作记录及只读快照。

避免另一套锁：浏览器和 Agent 必须共用真实会话上的 TerminalControl，并新增显式控制策略。每次异步写入前重新核对 fence；切换控制权后清理旧队列。管理员网页的 restart/kill 同样经过统一策略。

阶段一：HTTP/Bearer（可选 TLS）、会话 create/attach/read/input、专属标签、断线保活、控制权。阶段二：受管 PowerShell 命令、去重、操作记录和 CLI/Skill。阶段三：Windows/Ubuntu 互通验收、限流背压与安装包。阶段二完成并通过验收后才对 Agent 宣称可靠命令完成状态。

## 10. 发布验收

- Ubuntu CLI 连 Windows PowerShell 7/5.1；中文、多行、空格路径、函数、环境变量、venv 连续保留。
- 断开客户端/关闭网页后命令继续；重连同一 Shell；Node 重启验证 psmux 存活与输出 gap；Windows 重启返回会话失效，不悄悄重建。
- 两种模式均拒绝错误/缺失 Token、跨源及重定向；HTTP 按约定明文传输。HTTPS 模式额外验证无效证书、错误 pin 被拒绝，抓包无明文 Token/命令，TLS 验证失败之前不能发 Token。
- 命令确认前后断网、同 requestId 重试、服务崩溃窗口均不盲目重复执行。
- 网页只读隔离、延迟输入、resize、Ctrl+C、两客户端争用、Token 轮换均符合控制策略。
- 会话关闭再同名新建不继承旧 ID；Agent 会话不绕过现有分享行为。
- 大量输出、慢客户端、游标过期、日志轮转和 PTY 上限有明确结果；命令非零退出和 PowerShell 异常不误报成功。
- 原有管理员、分享、远程主机、文件管理、会话状态相关测试回归通过。

## 11. 参考

- [OpenSSH ssh_config](https://man.openbsd.org/ssh_config)：主机别名、StrictHostKeyChecking、ServerAliveInterval 和 ControlMaster。借鉴交互及连接管理语义，TLS 证书校验对应服务器身份校验。
- [Windows OpenSSH 配置](https://learn.microsoft.com/en-us/windows-server/administration/OpenSSH/openssh-server-configuration)：标准 SSH 替代路线及 Windows 默认 Shell 配置。
- 本项目 `README.md`、`docs/部署与使用指南.md`、`src/auth.ts`、`src/tmux.ts`、`src/session-store.ts`、`src/terminal-control.ts`、`src/server.ts`、`tmux/pwsh-integration.ps1`。

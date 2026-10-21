# opencode 状态插件：钩子、状态更新与安装使用

最后更新：2026-10-21。适用于 **opencode 2.x**（实测 2.1.2）。opencode 1.x 没有本文用到的插件接口，安装器会跳过，状态继续由屏幕识别兜底。

terminal-web 里标签、侧栏和手机圆点的「执行中 / 等待确认 / 完成 / 空闲」来自 `src/agent-status.ts`。其他 agent 用命令钩子上报，opencode 2 没有命令钩子，改用本文说明的 **TUI 插件**。整体背景见 [部署与使用指南](部署与使用指南.md) 第 8 节。

## 1. 为什么是 TUI 插件

opencode 2 有两种进程：

- `opencode serve --service`：全局共享的后台服务，插件、会话、工具都在这里执行。
- TUI：每个打开的 `opencode` 界面一个进程（一个 pane 一个），运行在 tmux pane 里。

共享服务进程的 `TMUX_PANE` 只保留「最先启动它的那个 pane」。如果插件跑在服务里，多开几个 tab 后所有上报都会落到同一个 pane 上，状态就串了。TUI 进程一定在对应的 pane 里，所以状态必须由 **TUI 侧插件**上报。

另外两个实测结论：

- opencode 2 的 CLI 插件必须是一个**包目录**，且 `package.json` 里有 `exports["./tui"]`。在 `cli.json` 里直接写一个 `.js` / `.mjs` 文件会被静默忽略。
- 命令行 `opencode plugin list` 只列**服务端**插件，看不到这个 TUI 插件，不能用它判断是否装好。

插件包结构：

```text
scripts/opencode-status/        # 源码（安装器整体复制）
├── package.json                # "exports": { ".": "./index.js", "./tui": "./tui.js" }
├── index.js                    # 服务端入口；只 re-export，调用时 no-op
└── tui.js                      # 真正干活的 TUI 插件
```

安装后位于 `~/.terminal-web/opencode-status/`，并在 `~/.config/opencode/cli.json`（或 `$XDG_CONFIG_HOME/opencode/cli.json`）的 `plugins` 中登记：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "file:///Users/<你>/.terminal-web/opencode-status"
  ]
}
```

## 2. 状态是怎么算出来的

`tui.js` 不做事件名匹配（opencode 2 的 `session.next.*` / `session.execution.*` 事件族随版本变化），而是每 **400ms** 读取 TUI 当前显示会话的真实数据：

| 读取 | 含义 |
| --- | --- |
| `ctx.data.session.status(sessionID)` | `running` 表示这一轮还在跑 |
| `ctx.data.session.permission.list(sessionID)` | 有未处理的权限请求 |
| `ctx.data.session.form.list(sessionID)` | 有未回答的提问（question 工具等） |

判定顺序与上报事件：

| 判定 | 上报事件 | terminal-web 显示 |
| --- | --- | --- |
| 有权限请求或提问，且已持续 ≥ 500ms | `PermissionRequest` | 橙色闪烁「等待你确认」 |
| 会话为 `running` | `UserPromptSubmit` | 绿色转圈「执行中」 |
| 从执行中/等待中变为空闲 | `Stop` | 亮绿色「完成（未读）」，正在看则暗绿色 |

补充规则：

- **只在状态变化时上报**，一轮对话通常只有开始、等待、结束三次请求。
- 500ms 沉降是为了过滤「被保存的规则秒批」的权限请求，避免圆点闪一下橙色。
- 插件刚加载时如果会话空闲，**什么也不发**，避免把已有的「完成」状态清掉；如果加载时正在执行，则补发一次执行中。
- 只跟随 TUI **当前显示的会话**。在一个 pane 里切换 opencode 的会话时，圆点跟着切换后的会话走——terminal-web 的状态本来就是按 pane / tab 算的。
- 子会话通常不在主视图里，插件只上报 TUI 当前显示的那个会话；打开子会话时会跟着子会话走。
- 回到 opencode 首页（没有打开会话）时保持原状态不变。

## 3. 上报协议

插件直接向 terminal-web 的钩子接口发 HTTP 请求，和 `scripts/agent-hook.sh` 用的是同一个接口：

```http
POST /api/agent-hook
Content-Type: application/json
Cookie: tw_auth=<token>

{"agent":"opencode","pane":"%12","event":"UserPromptSubmit"}
```

字段：

| 字段 | 说明 |
| --- | --- |
| `pane` | 当前 tmux pane，取自 TUI 进程的 `TMUX_PANE` |
| `session` | 仅 psmux 使用（`PSMUX_SESSION`）。psmux 里每个会话的第一个 pane 都叫 `%1`，必须用会话名区分 |
| `event` | `UserPromptSubmit` / `PermissionRequest` / `Stop` |

地址与 Token 的解析顺序：

1. 环境变量 `TERMINAL_WEB_URL` / `TERMINAL_WEB_TOKEN_FILE`
2. `~/.terminal-web/agent-hook.env`（安装器写入，包含 `TERMINAL_WEB_URL` 和 `TERMINAL_WEB_TOKEN_FILE`）
3. 默认值 `http://127.0.0.1:8090` 和 `~/.config/terminal-web/auth-token`

请求失败（服务没启动、地址不通、Token 读不到）会被静默忽略，状态回落到屏幕识别，不影响 opencode 本身。`agent-hook.env` 变化后插件会在下一次上报时自动读到新地址，不用重启。

## 4. 安装

### 4.1 一键安装（推荐）

前提：服务已在运行、opencode 在本服务的 tmux 会话里运行、设置面板的「状态来源」为 **钩子**（默认值）。

```bash
cd /path/to/terminal-web
node scripts/install-agent-hooks.mjs --only=opencode
```

安装器会：

1. 把 `scripts/opencode-status/` 复制到 `~/.terminal-web/opencode-status/`。
2. 在 `~/.config/opencode/cli.json` 的 `plugins` 里追加 `file:///…/.terminal-web/opencode-status`；已有其他插件（例如 Orca）的条目原样保留。
3. 首次修改 `cli.json` 前备份为 `cli.json.bak-terminal-web`。
4. 刷新 `~/.terminal-web/agent-hook.sh`、`agent-hook.env`（和其他 agent 共用）。

opencode 1.x 会被检测并跳过；找不到 opencode 时输出 `opencode: not found, skipped`。

写完之后：

- 运行中的 TUI 通常会监视 `cli.json` 并**自动热加载**插件。
- 没有生效时重启该 opencode 会话。

### 4.2 手动安装

不想用安装器时：

```bash
mkdir -p ~/.terminal-web
rm -rf ~/.terminal-web/opencode-status
cp -R /path/to/terminal-web/scripts/opencode-status ~/.terminal-web/opencode-status
```

然后编辑 `~/.config/opencode/cli.json`，在 `plugins` 里加入（保留已有条目）：

```json
"file:///Users/<你>/.terminal-web/opencode-status"
```

最后重启 opencode。若服务不在 `127.0.0.1:8090`，在**启动 opencode 的 shell** 里二选一：

```bash
export TERMINAL_WEB_URL=http://192.168.1.10:8090
export TERMINAL_WEB_TOKEN_FILE=~/.config/terminal-web/auth-token
```

或写进 `~/.terminal-web/agent-hook.env`（格式见安装器生成的文件）。

## 5. 检查与验证

检查安装状态：

```bash
node scripts/install-agent-hooks.mjs --check --only=opencode
```

正常输出（只摘录相关行）：

```text
hook script     ok  /Users/xutao/.terminal-web/agent-hook.sh
token file      ok  /Users/xutao/.config/terminal-web/auth-token
server          ok (mode: hooks)  http://127.0.0.1:8090
opencode        1/1 plugin  /Users/xutao/.config/opencode/cli.json
```

关注两点：`opencode 1/1 plugin`，以及 `mode: hooks`（`screen` / `legacy` 模式下钩子上报会被忽略）。

功能验证：在 terminal-web 的某个 tab 里打开 opencode 并发一条消息。

1. 发出后圆点应立即转圈（执行中）。
2. 如果 agent 调用 question 工具或弹出权限确认，圆点变为橙色闪烁（等待确认）。
3. 回答后回到转圈。
4. 回答结束变成亮绿色（未读）；如果你正看着这个 tab，则直接暗绿色。

多开验证：在两个 tab 里各跑一个 opencode，分别发消息，两个圆点应各自变化，不串。

## 6. 更新与卸载

更新：升级 terminal-web 后重新执行一次安装器即可（会覆盖插件文件）：

```bash
node scripts/install-agent-hooks.mjs --only=opencode
```

卸载：

```bash
node scripts/install-agent-hooks.mjs --uninstall --only=opencode
```

会删除 `cli.json` 里的条目和 `~/.terminal-web/opencode-status/`，其他插件条目不受影响。`--uninstall` 不带 `--only` 时会连同所有 agent 的钩子一起移除。

## 7. 限制与已知行为

- **只支持 opencode 2.x 的 TUI**。`opencode run`、脚本化调用不会加载 CLI 插件，状态只能靠屏幕识别兜底。
- **只覆盖 tmux 里的会话**。不在 tmux 中运行时没有 `TMUX_PANE`，插件直接不工作。
- **跟随当前会话**：在 opencode 内切换会话，圆点跟随切换后的会话；这期间上一条会话的完成状态可能被下一条的空闲状态覆盖，属于按 pane 统计的预期行为。
- **首页不更新**：TUI 停在首页（没有打开会话）时插件不上报。
- **opencode 升级可能改接口**：插件对 `ctx.data.*` 的调用都做了存在性检查和 try/catch；接口缺失时静默退回屏幕识别，不会让 TUI 崩溃。升级大版本后建议按第 5 节重新验证一次。
- **opencode 1.x 不生效**：安装器会跳过，继续使用屏幕识别规则。
- **Windows / psmux**：插件是跨平台 JS；psmux 下额外读取 `PSMUX_SESSION` 以区分同名 pane。

## 8. 排查

| 现象 | 检查方向 |
| --- | --- |
| 圆点一直灰色 | `--check --only=opencode` 是否为 `1/1 plugin`；`mode` 是否为 `hooks`；是否在 tmux 里；是否被安装器跳过了（opencode 1.x） |
| 执行中不转圈 | 重启 opencode 让 `cli.json` 生效；确认 `cli.json` 里是 `file://…/opencode-status`（目录，不是单个 `.js` 文件） |
| 等待确认不亮橙色 | 确认 question / 权限确认框确实在 TUI 里；500ms 内被自动批准的请求不会上报 |
| 一直转圈不结束 | 插件漏掉了 `Stop`；切到屏幕识别或等待屏幕规则 6 秒后纠正；持续复现时记录当时 TUI 是否切过会话 |
| 多个 tab 状态串了 | 确认 `cli.json` 指向的是本插件的目录 `~/.terminal-web/opencode-status`，而不是单个文件；多个 pane 各跑一个 TUI 时应分别上报各自的 `%pane` |
| 改服务地址后不生效 | 插件每次上报都会重读 `agent-hook.env`；确认写的是 `TERMINAL_WEB_URL`，并确认 Token 文件可读 |
| 改完 `cli.json` 没反应 | 重启 opencode；`opencode plugin list` 看不到 TUI 插件属正常，不要用它判断 |
| 想确认插件是否被加载 | 重启 TUI 后在 terminal-web 里发一条消息看圆点；`~/.local/share/opencode/log/opencode.log` 主要记录服务端，CLI 插件加载不一定有日志 |

## 9. 维护说明

- 源码：`scripts/opencode-status/tui.js`。可调常量在文件顶部：
  - `TICK_MS = 400`：状态轮询间隔。
  - `SETTLE_MS = 500`：等待确认的沉降时间。
  - `POST_TIMEOUT_MS = 2000`：上报超时。
- 事件映射：`transitionEvent()`；状态判定：`computeState()`；两者都有单测。
- 测试：

  ```bash
  node --import tsx --test tests/opencode-status.test.ts
  ```

- 如果 opencode 新版本改了 `ctx.data.session.status` / `permission.list` / `form.list` 的形状，优先照着 TUI 的数据接口调整这三个读取函数；不要退回去猜事件名。
- 安装器改动在 `scripts/install-agent-hooks.mjs` 的 opencode 段落，检查行是 `opencode 1/1 plugin`。

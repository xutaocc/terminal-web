# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rule: one codebase for macOS, Linux and Windows (this branch)

On the `multi-platform` branch, every change must work on **all three** of macOS, Linux and native Windows, from the same code. This is a requirement, not a nice-to-have:

- No per-platform forks of a feature. Shared logic stays shared; where a platform truly differs, branch at the narrowest point (`IS_PSMUX` / `process.platform` server-side, the server's reported `platform` or the path itself client-side — never the browser's own OS) and keep the other platforms' behaviour unchanged.
- A server may be any of the three, and so may each remote it drives and each browser looking at it: a Windows page shows a Linux remote and the other way round. Paths, shell quoting, home shortening, file names, line endings and permissions must follow the system that owns them (`web/platform.ts`, `web/file-path.js`, `within()` in `src/file-api.ts`).
- Nothing may assume Unix-only tools or locations (`/etc/passwd`, `zip`, `/bin/sh`, `curl`, `ps`, `/proc`) or Windows-only ones without a working path on the other platforms. Scripts that must run everywhere are Node (`.mjs`), not bash or PowerShell alone.
- New tests must pass, or skip with a stated reason, on all three. Platform-only tests say so (`t.skip(...)`) instead of failing elsewhere.
- Before calling a change done, check it on Windows and on Linux or macOS. A real machine is best (an Ubuntu VM and Windows have been used together through the remote-hosts feature); at minimum run `npx tsc`, the unit tests and the integration tests on the platforms available.

This rule applies to the `multi-platform` branch only.

## Project

terminal-web: a browser terminal (xterm.js front end, Node + `ws` + `node-pty` back end) where every session is a **tmux** session, so disconnecting only detaches. Requires Node 20+ and tmux on the host (macOS / Linux / WSL2). On native Windows the same code drives **psmux** (a native Windows tmux clone that ships a `tmux.exe`) instead — see "Windows (psmux)" below. User-facing docs are in `README.md` and `docs/` (Chinese deployment guide and session-status design notes). Commit messages and recent docs are written in Chinese.

## Commands

```bash
npm install                 # postinstall fixes node-pty spawn-helper perms
npm run build               # esbuild: web/terminal.ts + web/file-browser.js -> public/dist/ (gitignored)
npm start                   # tsx src/server.ts (does NOT load .env)
npm run dev                 # scripts/dev.sh: loads .env, esbuild --watch + tsx watch
npx tsc                     # typecheck src/ + web/ (tsconfig has noEmit)

# Unit tests (node:test, TS via tsx)
node --import tsx --test tests/*.test.ts
node --import tsx --test tests/agent-status.test.ts      # single file

# Integration / UI tests: plain scripts, each spawns its own server on a free port
node tests/file-api.integration.mjs
node tests/file-browser.ui.mjs     # needs Chrome; BROWSER_BIN=... (skips if missing)
```

Deployment: `scripts/service.sh install|restart|status|logs` (launchd/systemd, runs straight from the checkout); `scripts/deploy.sh` builds and restarts (or rsyncs to a mirror install). Server code changes need a restart; front-end changes need `npm run build` because the server serves the prebuilt bundle.

## Architecture

- **Server (`src/`)** — `server.ts` is one large file holding the HTTP router (`/api/*` routes are inline `if` checks on method + pathname), static serving, uploads/downloads, prefs, and the `/ws` WebSocket handler. Each WebSocket gets its own pty running `tmux new-session -A -s NAME` (argv built in `tmux.ts`, using `tmux/web.tmux.conf`). WS protocol: binary frames = raw terminal bytes both ways; text frames = JSON control (`resize`, `ping`/`pong`, `restart`, `kill`, …; types in `types.ts`).
- **State lives server-side**: tab membership and labels are stored as tmux session options (`@twtab`); per-device-class prefs (`touch` / `desktop`) in `~/.terminal-web/prefs.json` via `/api/prefs`. Browser `localStorage` is only a cache (the page may run in a cross-origin iframe where storage is dropped).
- **Split view**: the second pane of a tab is a separate tmux session named `<name>__b`; the `__b` suffix is reserved and such sessions are folded into their parent tab.
- **Auth (`auth.ts`)**: every HTTP and WS request needs the shared token (cookie after login) plus an origin check; the token is persisted to `~/.config/terminal-web/auth-token` unless `AUTH_TOKEN` is set. Config/env defaults are in `config.ts` (see `.env.example`).
- **Remote hosts (`remotes.ts`, `web/hosts.ts`)**: this server can proxy other terminal-web servers. Everything under `/remote/<id>/…` (HTTP and WS) is forwarded with the remote's token swapped in, so the browser stays same-origin and never sees remote tokens. Client-side, session keys are `name` for local and `@<hostId>/name` for remote; use `makeKey`/`splitKey`/`hostUrl` rather than building paths by hand.
- **One long-lived connection per page**: browsers allow 6 connections per address, so a page must never open a stream per remote. The page's only stream is `/api/agent-status/events?health=1`, which carries this server's status (unnamed events), remote health (`health`), every remote's status (`remote`, gathered server-side by `RemoteStatusHub`) and a `ping` every 15 s. `tests/remote-hosts.ui.mjs` checks this with 5 remotes and 3 tabs.
- **Mixed-OS remotes**: a remote may run a different OS from this server and from the browser. Anything that depends on the OS goes by the server's reported `platform` (`/api/host-info`, kept in `hostPlatforms` client-side) or by the path itself — never the browser's own platform. Helpers: `web/platform.ts` (shell quoting, file names, `~` shortening) and `web/file-path.js` (file browser paths).
- **Agent status (`agent-status.ts`)**: tab indicators (working / waiting / done / unread) come from one of three modes — `hooks` (default; Claude Code/Codex/Kimi Code hooks installed by `scripts/install-agent-hooks.mjs` call `scripts/agent-hook.sh`, or `scripts/agent-hook.mjs` on Windows, which POSTs to `/api/agent-hook`), `screen` (server reads panes via tmux and matches on-screen cues), or `legacy` (browser-side heuristic). When changing screen-matching rules, add sample screens (including false-positive counterexamples) to `tests/agent-status.test.ts`.
- **File manager**: `src/file-api.ts` serves `/api/files/*`; UI is `public/file-browser.html` + `web/file-browser.js`, embedded same-origin. Long-running jobs (zip, etc.) run in the Node process and are kept only in memory.
- **Client (`web/`)**: `terminal.ts` is the monolithic app (tabs, key bar, sidebar, settings sheet, reconnect logic). Behavior worth unit testing is factored into small pure modules (`tab-order.ts`, `session-name.ts`, `touch-scroll.ts`, `keyboard-lock.ts`, …) that `tests/*.test.ts` import directly — follow that pattern for new testable logic. Many settings are kept separately for touch vs. desktop.
- Imports use `.js` extensions in TS source (NodeNext resolution).

## Windows (psmux)

`IS_PSMUX` (`src/tmux.ts`, true on win32) gates every Windows difference; Linux/macOS behaviour must stay unchanged. Every tmux call goes through the `TMUX` constant (never a literal `"tmux"`): `TMUX_BIN`, else `tmux.exe` found on PATH. The psmux binary is not in the repo — put it in `.psmux/` (gitignored) and prepend that to PATH:

```bash
PATH="$PWD/.psmux:$PATH" HOST=0.0.0.0 PORT=8099 npx tsx src/server.ts
```

Stopping the server: kill the whole process tree (`taskkill //PID <pid> //T //F`). Killing only the outer `npx`/shell leaves the Node server holding the port, and a restart then exits with "port … already in use" while the old code keeps serving.

psmux behaviours the code works around (each has a comment at its site):
- Config is `tmux/web.psmux.conf` (TERM `xterm-256color` — `tmux-256color` misplaces the cursor). `psmuxEnv()` also sets `PSMUX_CONFIG_FILE`, `PSMUX_NO_WARM=1` (a warm pre-spawned server never reads the config) and an empty `PSModulePath` (an inherited Windows PowerShell 5.1 path makes pwsh spawn a compat child, which is slow and breaks cwd tracking).
- New sessions run PowerShell 7 (`TERMINAL_WEB_SHELL` overrides), dot-sourcing `tmux/pwsh-integration.ps1`, which syncs the process cwd on each prompt so `#{pane_current_path}` follows `cd`.
- The pty uses node-pty's bundled OpenConsole (`useConptyDll`): the inbox conhost mis-renders wide (CJK) characters. OpenConsole's opening DA1 query is answered by the server, and `destroy()` is never called on Windows (closing the pseudoconsole twice crashes the server).
- One server per session: no `set-environment … ;` chain before `new-session`. `set-option` on a not-yet-ready session exits 0 with a "no active session" warning. `display-message` does not accept `-F`. `#{window_activity}` never advances (the screen poller compares screen contents instead).
- Pane ids restart at `%1` in every session, so never target a bare pane id — use `=<session>:`. Hooks send `PSMUX_SESSION`; a report without a verified session name is dropped.
- Paths are `C:\...`: use `path.isAbsolute` server-side and `isAbsolutePath()` (`web/hosts.ts`) client-side, never `startsWith('/')`. The file browser's path logic (breadcrumbs, parent, containment) lives in `web/file-path.js`, which reads the style from the path itself because a remote host may be the other OS; server-side containment is `within()` in `file-api.ts` (`path.relative`, so case-insensitive on Windows).
- File manager on Windows: zips are built by `scripts/zip-manifest.ps1` under pwsh (only its .NET flags UTF-8 names); chmod is refused (501); `/site/` URLs carry Windows paths as `/site/C:/…` (`sitePath()`).

Tests for the Windows paths: `node --import tsx --test tests/file-path.test.ts`, `node tests/file-api.windows.integration.mjs`, and `node tests/file-browser.windows.ui.mjs` (real Chrome + psmux from `.psmux/`). Remote hosts (any OS; several real servers on one machine): `node tests/remote-hosts.integration.mjs` and `node tests/remote-hosts.ui.mjs` (Chrome).

The server strips the tmux / psmux identity (`TMUX`, `TMUX_PANE`, `PSMUX_*`) from the environment it gives new sessions: a server started from inside a terminal tab would otherwise make every new client think it is nested, and psmux refuses those outright.

Not yet ported to Windows: the bash service/deploy scripts. `tests/terminal-env.test.ts` shells out to a real `tmux` and fails where none is installed; `tests/file-api.integration.mjs` and `tests/file-browser.ui.mjs` are Unix-only (they use `unzip`, chmod and symlinks).

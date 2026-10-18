#!/usr/bin/env node
// terminal-web agent hook — reports a Claude Code / Codex turn to terminal-web.
//
// The Node twin of agent-hook.sh, for hosts without a POSIX shell (Windows).
// Installed to ~/.terminal-web/agent-hook.mjs by scripts/install-agent-hooks.mjs
// and called by the agent's hook config as:  node agent-hook.mjs <claude|codex> <Event>
// The hook JSON arrives on stdin.
//
// It must never get in the agent's way: it always exits 0, and gives the post
// at most two seconds. For Claude it prints {} — a no-op answer that Claude's
// permission hooks need; for Codex it prints nothing. Outside tmux / psmux it
// does nothing — terminal-web finds the session from $TMUX_PANE (and, under
// psmux, where every session's first pane is %1, from $PSMUX_SESSION).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const word = (v, extra = '') => String(v ?? '').replace(new RegExp(`[^A-Za-z0-9_${extra}]`, 'g'), '');
const agent = String(process.argv[2] ?? '').replace(/[^a-z]/g, '');
if (agent === 'claude') process.stdout.write('{}\n');

async function main() {
  const pane = String(process.env.TMUX_PANE ?? '').replace(/[^%0-9]/g, '');
  if (!pane) return;
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let payload = {};
  try { payload = JSON.parse(input); } catch { /* not JSON: event from argv only */ }

  const conf = {};
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), '.terminal-web', 'agent-hook.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) conf[m[1]] = m[2].replace(/^'(.*)'$/, '$1');
    }
  } catch { /* defaults */ }
  const url = (process.env.TERMINAL_WEB_URL || conf.TERMINAL_WEB_URL || 'http://127.0.0.1:8090').replace(/\/+$/, '');
  const tokenFile = process.env.TERMINAL_WEB_TOKEN_FILE || conf.TERMINAL_WEB_TOKEN_FILE ||
    path.join(os.homedir(), '.config', 'terminal-web', 'auth-token');
  let token = '';
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return; }

  const event = word(process.argv[3] || payload.hook_event_name);
  if (!event) return;
  await fetch(`${url}/api/agent-hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `tw_auth=${token}` },
    body: JSON.stringify({
      agent, pane, event,
      session: word(process.env.PSMUX_SESSION, '-'),
      tool: word(payload.tool_name),
      kind: word(payload.notification_type),
    }),
    signal: AbortSignal.timeout(2000),
  });
}

main().catch(() => {}).finally(() => process.exit(0));

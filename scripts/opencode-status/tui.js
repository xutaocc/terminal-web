// terminal-web status reporter for opencode.
//
// opencode 1 had command hooks in its config; opencode 2 dropped them and only
// exposes plugins. This file is the TUI half of a CLI plugin: the TUI runs inside
// the tmux pane the user is looking at, so process.env.TMUX_PANE names the right
// pane. (The shared `opencode serve` process names only the pane that spawned it,
// so a server-side plugin would report the wrong session when several panes are
// in use; index.js is only there to satisfy opencode's package discovery and
// stays out of the way.)
//
// opencode only loads CLI plugins that are a package with a `./tui` export, so
// this directory has package.json + index.js + tui.js. scripts/
// install-agent-hooks.mjs copies it to ~/.terminal-web/opencode-status and
// registers that directory in ~/.config/opencode/cli.json.
//
// It reports the same hook events as the other agents' hooks (see
// src/agent-status.ts) to POST /api/agent-hook:
//   working -> UserPromptSubmit   waiting -> PermissionRequest   idle -> Stop
// Only changes are posted, so a long turn costs one request.
//
// Every function here is defensive on purpose: a plugin throw can take the
// TUI's plugin host down, which is far worse than a missing status dot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const ENV_FILE = path.join(HOME, '.terminal-web', 'agent-hook.env');
const DEFAULT_URL = 'http://127.0.0.1:8090';
const DEFAULT_TOKEN_FILE = path.join(HOME, '.config/terminal-web/auth-token');
const TICK_MS = 400;
// A permission request that is answered by a saved rule comes and goes within a
// few milliseconds. Waiting this long keeps those out of the orange dot.
const SETTLE_MS = 500;
const POST_TIMEOUT_MS = 2000;

/**
 * `KEY='value'` / `KEY="value"` / `KEY=value` lines, as written by
 * scripts/install-agent-hooks.mjs. Exported for the tests.
 */
export function parseEnvText(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && ((value[0] === "'" && value.at(-1) === "'") || (value[0] === '"' && value.at(-1) === '"'))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * The state to report, or null when there is nothing trustworthy to say yet.
 * A fresh permission request is not reported until it has settled.
 */
export function computeState({ running, blocked, blockedMs = 0, settleMs = SETTLE_MS }) {
  if (blocked) {
    if (blockedMs < settleMs) return running ? 'working' : null;
    return 'waiting';
  }
  return running ? 'working' : 'idle';
}

/**
 * The hook event that moves terminal-web from `prev` to `next`, or null when
 * nothing changed (or when an idle start should stay silent — the screen rules
 * already show idle, and reporting it would wipe a "done" left by a reload).
 */
export function transitionEvent(prev, next) {
  if (!next || prev === next) return null;
  if (next === 'working') return 'UserPromptSubmit';
  if (next === 'waiting') return 'PermissionRequest';
  if (next === 'idle') return prev ? 'Stop' : null;
  return null;
}

// Reading the endpoint on every post would mean a stat + read per tick; the
// installer rewrites the file rarely, so key a small cache on mtime + size.
let configCache = { key: '', value: null };

function readConfig() {
  const env = {};
  let key = 'none';
  try {
    const stat = fs.statSync(ENV_FILE);
    key = `${stat.mtimeMs}:${stat.size}`;
    if (configCache.key !== key) {
      Object.assign(env, parseEnvText(fs.readFileSync(ENV_FILE, 'utf8')));
      configCache = { key, value: env };
    } else {
      Object.assign(env, configCache.value ?? {});
    }
  } catch { /* no file: defaults */ }
  const url = (process.env.TERMINAL_WEB_URL || env.TERMINAL_WEB_URL || DEFAULT_URL).replace(/\/+$/, '');
  const tokenFile = process.env.TERMINAL_WEB_TOKEN_FILE || env.TERMINAL_WEB_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  return { url, tokenFile };
}

function readToken(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

/** Post one hook event. Never throws and never awaits the network on the tick. */
function post(event) {
  const pane = process.env.TMUX_PANE;
  if (!pane || !/^%\d{1,6}$/.test(pane)) return false; // not inside tmux: terminal-web cannot place it
  const { url, tokenFile } = readConfig();
  const token = readToken(tokenFile);
  if (!token) return false;
  // psmux numbers panes per session (every session's first is %1), so the pane
  // id alone is ambiguous there; the session name disambiguates it.
  const session = process.env.PSMUX_SESSION;
  const body = JSON.stringify({
    agent: 'opencode',
    pane,
    ...(session && /^[A-Za-z0-9_-]{1,64}$/.test(session) ? { session } : {}),
    event,
  });
  void (async () => {
    try {
      await fetch(`${url}/api/agent-hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: `tw_auth=${token}` },
        body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    } catch { /* server down or slow: status falls back to the screen rules */ }
  })();
  return true;
}

/** The session the TUI is showing, or undefined on the home screen. */
function currentSession(ctx) {
  try {
    const route = ctx.ui?.router?.current?.();
    return route?.type === 'session' && typeof route.sessionID === 'string' ? route.sessionID : undefined;
  } catch {
    return undefined;
  }
}

function sessionRunning(ctx, sessionID) {
  try {
    const value = ctx.data?.session?.status?.(sessionID);
    return value === 'running'
      || value?.type === 'busy' || value?.type === 'retry'
      || value?.status === 'running';
  } catch {
    return false;
  }
}

function sessionBlocked(ctx, sessionID) {
  try {
    if ((ctx.data?.session?.permission?.list?.(sessionID) ?? []).length) return true;
  } catch { /* older/newer shapes: try the next one */ }
  try {
    if ((ctx.data?.session?.form?.list?.(sessionID) ?? []).length) return true;
  } catch { /* no forms API: permissions only */ }
  return false;
}

/**
 * opencode 2 TUI plugin. opencode validates the default export as an object
 * with `id` and `setup`; `setup` is called with the TUI context (a server
 * context has no `ui.router`, in which case this plugin stays out of the way).
 */
export default {
  id: 'terminal-web-status',
  async setup(ctx) {
    const noop = () => {};
    if (/^1\./.test(String(ctx?.app?.version || ''))) return noop; // opencode 1 TUI API has no data.listen
    if (typeof ctx?.data?.listen !== 'function' || typeof ctx?.ui?.router?.current !== 'function') return noop;
    const pane = process.env.TMUX_PANE;
    if (!pane || !/^%\d{1,6}$/.test(pane)) return noop;

    let disposed = false;
    let last = null;
    let lastSession;
    let blockedSince = 0;
    // listen() fires for every streamed token; collapsing to one pending derive
    // keeps a fast reply from scheduling hundreds of ticks.
    let queued = false;

    const derive = () => {
      queued = false;
      if (disposed) return;
      try {
        const sessionID = currentSession(ctx);
        if (!sessionID) { blockedSince = 0; return; } // home screen: keep whatever the pane showed
        // A prompt already open in another session must not skip its settle.
        if (sessionID !== lastSession) { lastSession = sessionID; blockedSince = 0; }
        const running = sessionRunning(ctx, sessionID);
        const blocked = sessionBlocked(ctx, sessionID);
        const now = Date.now();
        if (blocked) { if (!blockedSince) blockedSince = now; } else blockedSince = 0;
        const state = computeState({ running, blocked, blockedMs: blockedSince ? now - blockedSince : 0 });
        if (!state || state === last) return;
        const event = transitionEvent(last, state);
        last = state;
        if (event) post(event);
      } catch { /* keep the TUI alive; the next tick tries again */ }
    };
    const schedule = () => {
      if (queued || disposed) return;
      queued = true;
      setTimeout(derive, 0);
    };

    const timer = setInterval(derive, TICK_MS);
    timer.unref?.();
    let unsubscribe;
    try { unsubscribe = ctx.data.listen(schedule); } catch { /* tick still works */ }
    derive();

    return () => {
      disposed = true;
      clearInterval(timer);
      try { if (typeof unsubscribe === 'function') unsubscribe(); } catch { /* already gone */ }
    };
  },
};

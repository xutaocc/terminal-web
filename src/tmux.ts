import { execFile, execFileSync } from "./background-process.js";
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmuxColorArgs } from './terminal-env.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/**
 * The tmux binary every call goes through. TMUX_BIN overrides it (e.g. psmux's
 * tmux.exe on Windows). node-pty on Windows does not search PATH for a bare
 * name the way execFile does, so there it is resolved to a full path up front:
 * the repo's own .psmux\ first (where the deployment guide puts psmux, so a
 * plain `npm start` finds it), then PATH.
 */
export const TMUX = resolveTmux();
/** psmux (Windows) speaks tmux's commands but differs in a few behaviours. */
export const IS_PSMUX = process.platform === 'win32';

function resolveTmux(): string {
  const configured = process.env.TMUX_BIN?.trim();
  if (configured) return configured;
  if (process.platform !== 'win32') return 'tmux';
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.psmux', 'tmux.exe');
  if (existsSync(bundled)) return bundled;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'tmux.exe');
    if (dir && existsSync(candidate)) return candidate;
  }
  return 'tmux';
}

/**
 * Invalid, missing or inaccessible startup directories fall back to the user's
 * home. "~" and "~/…" mean the home directory everywhere; on Windows "~\…" does
 * too, as its own paths are written that way.
 */
export async function resolveSessionDirectory(value: string): Promise<string> {
  const home = value === '~' || value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'));
  const directory = value === '~' ? os.homedir() : home ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(directory) || directory.length > 4096 || directory.includes('\0')) return os.homedir();
  try {
    if (!(await fs.stat(directory)).isDirectory()) return os.homedir();
    await fs.access(directory, constants.X_OK);
    return directory;
  } catch { return os.homedir(); }
}

/**
 * Sanitize a requested tmux session name.
 *
 * Per the protocol: keep only [A-Za-z0-9_-], length 1..64. Anything that does
 * not yield a valid name falls back to "web".
 */
export function sanitizeSession(name: string | null | undefined): string {
  if (typeof name !== "string") return "web";
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "");
  if (cleaned.length === 0) return "web";
  return cleaned.slice(0, 64);
}

/**
 * Build the argv passed to the `tmux` binary (node-pty spawns "tmux" + these).
 *
 * Uses `new-session -A` so it attaches to an existing session of the same name
 * or creates it if missing — the core of the resume behavior. The session is
 * assumed to already be sanitized by the caller.
 *
 * `-u` forces tmux to treat the client as UTF-8 capable regardless of the
 * locale it detects, so CJK/wide characters render correctly instead of being
 * replaced with "_" placeholders.
 */
export function tmuxArgs(session: string, confPath: string, startDir?: string): string[] {
  // -c only when the caller knows the session is being made: on an existing one
  // `-A` hands it to attach-session, which would reset the session's default
  // directory instead.
  const dir = startDir ? ["-c", startDir] : [];
  // psmux runs one server per session, so a new session takes its environment
  // from this spawn — and a `set-environment … ;` chain ahead of new-session
  // fails there when no server is running yet.
  const color = IS_PSMUX ? [] : tmuxColorArgs();
  // psmux: the pane's program goes after `--`; a session that already exists
  // ignores it, as tmux does.
  const shell = IS_PSMUX ? psmuxShell() : [];
  return ["-u", "-f", confPath, ...color, "new-session", "-A", "-s", session, ...dir, ...shell];
}

/**
 * The shell a new psmux session runs: TERMINAL_WEB_SHELL (a program plus any
 * arguments, e.g. `bash.exe --login -i`) or PowerShell 7 without its banner.
 * Windows PowerShell 5.1 when pwsh is not installed. PowerShell also loads
 * tmux/pwsh-integration.ps1 (after the profile), which keeps the directory
 * psmux reports in step with `cd`.
 */
function psmuxShell(): string[] {
  const configured = process.env.TERMINAL_WEB_SHELL?.trim();
  if (configured) return ["--", ...configured.match(/"[^"]*"|\S+/g)!.map(a => a.replace(/^"|"$/g, ""))];
  const pwsh = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  const integration = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tmux", "pwsh-integration.ps1");
  return ["--", existsSync(pwsh) ? pwsh : "powershell.exe", "-NoLogo", "-NoExit",
    "-Command", `. '${integration.replace(/'/g, "''")}'`];
}

/**
 * Environment for the psmux client the pty runs. The config is passed as an
 * env var as well as -f because psmux reads it in the server it starts; no warm
 * (pre-spawned) servers, since one of those is claimed with psmux's defaults
 * and never reads the config at all.
 *
 * PSModulePath is emptied so pwsh builds its own. Inherited from a Windows
 * PowerShell (or Git Bash started from one), it lists the 5.1 module folders
 * first: pwsh then loads 5.1's modules through a compatibility session — a
 * hidden powershell.exe child that slows every start, prints "正在创建隐式远程
 * 处理模块", and is the process psmux reads the pane's directory from, so `cd`
 * never showed up in the session list.
 */
export function psmuxEnv(confPath: string): Record<string, string> {
  return IS_PSMUX ? { PSMUX_CONFIG_FILE: confPath, PSMUX_NO_WARM: "1", PSModulePath: "" } : {};
}

/**
 * Start a new session in its base session's current pane directory. Used by
 * splits and new tabs. Existing sessions keep their own directory on attach.
 */
export function mateStartDir(mate: string, base: string, displayedDirectory?: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(TMUX, ["has-session", "-t", `=${mate}`], async (err) => {
      if (!err) {
        resolve(null); // already there: attaching must not move it
        return;
      }
      if (displayedDirectory !== undefined) {
        resolve(await resolveSessionDirectory(displayedDirectory));
        return;
      }
      execFile(
        TMUX,
        ["-u", "display-message", "-p", "-t", `=${base}:`, "#{pane_current_path}"],
        async (err2, stdout) => {
          const dir = err2 ? "" : stdout.replace(/\r?\n$/, '');
          resolve(await resolveSessionDirectory(dir));
        }
      );
    });
  });
}

/**
 * List the names of all currently-running tmux sessions.
 *
 * Returns the session names on success, or `null` when the list can't be
 * determined — `tmux list-sessions` exits non-zero both when tmux is missing
 * and when no server is running (zero sessions), and we can't tell those apart.
 * Callers treat `null` as "unknown" and keep their existing state rather than
 * wrongly concluding every session is gone. Never throws.
 */
export function listTmuxSessions(): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      TMUX,
      ["list-sessions", "-F", "#{session_name}"],
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const names = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        resolve(names);
      }
    );
  });
}

/**
 * Check whether the `tmux` binary is available on PATH.
 *
 * Returns true if `tmux -V` succeeds, false otherwise. Never throws.
 */
export function ensureTmuxAvailable(): boolean {
  try {
    execFileSync(TMUX, ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Like {@link ensureTmuxAvailable} but throws a clear, actionable error when
 * tmux is missing — useful for fail-fast startup.
 */
export function requireTmux(): void {
  if (!ensureTmuxAvailable()) {
    throw new Error(
      "tmux was not found on PATH. Install it (e.g. `brew install tmux` on macOS) and try again."
    );
  }
}

// ---------------------------------------------------------------------------
// Web-tab membership lives on the tmux session itself, via user options:
//   @twtab   = "1"     -> this session is a web tab (shown on every device)
//   @twlabel = "..."   -> the tab's display label
//
// These tags discover existing live tabs. The server also keeps a disk registry
// of names and working directories so tab identities survive a tmux/host restart.
// ---------------------------------------------------------------------------
const TAB_TAG = "@twtab";
const TAB_LABEL = "@twlabel";
const TAB_NOTE = '@twnote';

export interface SessionNote {
  tags?: string[];
  text: string;
  updatedAt: string | null;
}

/** Notes follow the session and survive Web server restarts. Encode multiline text. */
export async function getSessionNote(name: string): Promise<SessionNote | null> {
  const target = await runTmux(['display-message', '-p', '-t', `=${name}:`, '#{session_id}']);
  if (!target?.trim()) return null;
  const value = await runTmux(['show-options', '-qv', '-t', target.trim(), TAB_NOTE]);
  if (value === null) return null;
  if (!value.trim()) return { text: '', updatedAt: null };
  try {
    const note = JSON.parse(Buffer.from(value.trim(), 'base64').toString('utf8'));
    if (typeof note.text === 'string' && typeof note.updatedAt === 'string') return note;
  } catch { /* invalid metadata must not break the terminal */ }
  return { text: '', updatedAt: null };
}

export async function setSessionNote(name: string, note: SessionNote): Promise<boolean> {
  const target = await runTmux(['display-message', '-p', '-t', `=${name}:`, '#{session_id}']);
  if (!target?.trim()) return false;
  const encoded = Buffer.from(JSON.stringify(note), 'utf8').toString('base64');
  return await runTmux(['set-option', '-t', target.trim(), TAB_NOTE, encoded]) !== null;
}

export interface WebTab {
  /** tmux session name — the immutable id used to attach/kill the session. */
  name: string;
  /** Label shown on the tab; defaults to the session name. */
  displayName: string;
}

/**
 * Mark a session as a web tab so every device shows it. Best-effort, with a
 * few retries: the tag is written right after the pty spawns `tmux
 * new-session`, which may not have registered the session yet, so an immediate
 * set-option can fail with "can't find session" — retry briefly until it sticks.
 */
export function tagWebSession(name: string, attempt = 0): void {
  execFile(TMUX, ["set-option", "-t", name, TAB_TAG, "1"], (err, _out, stderr) => {
    if (setOptionFailed(err, stderr) && attempt < 10) {
      setTimeout(() => tagWebSession(name, attempt + 1), 150);
    }
  });
}

/** Persist a web tab's display label on its tmux session. Best-effort. */
export function setWebTabLabel(name: string, displayName: string, attempt = 0): void {
  // Strip control chars (newlines/tabs) so a label can never break the
  // space-delimited parsing in listWebTabs.
  const dn = displayName.replace(/[\x00-\x1f]/g, " ").trim().slice(0, 64) || name;
  execFile(TMUX, ["-u", "set-option", "-t", name, TAB_LABEL, dn], (err, _out, stderr) => {
    // The browser can send the display label before an inherited-cwd attach
    // has created the session. Retry just as we do for its web-tab tag.
    if (setOptionFailed(err, stderr) && attempt < 10) setTimeout(() => setWebTabLabel(name, dn, attempt + 1), 150);
  });
}

/**
 * tmux fails set-option on a session not there yet; psmux exits 0 and only
 * warns ("no active session"), dropping the value — so read the warning too.
 */
function setOptionFailed(err: Error | null, stderr: string | Buffer): boolean {
  return !!err || /no active session/.test(String(stderr));
}

/**
 * List the tmux sessions tagged as web tabs, in creation order, each with its
 * display label. Returns `null` when tmux can't be queried (no server / not
 * installed) — same "unknown, keep prior state" contract as
 * {@link listTmuxSessions} — versus `[]` for "queried fine, no tabs".
 */
export function listWebTabs(): Promise<WebTab[] | null> {
  // Space-separated, with the free-text label LAST. We deliberately avoid a TAB
  // (or any control char) separator: under a non-UTF-8 locale — e.g. the bare
  // environment launchd gives the service — tmux sanitizes control characters
  // in -F output to "_", which silently merged every field into one and made
  // this return nothing (so tabs vanished the moment their socket closed).
  // Session names are restricted to [A-Za-z0-9_-] (no spaces) and the tag and
  // created stamp are numeric, so splitting on spaces with the label as the
  // trailing remainder is unambiguous.
  const fmt = [`#{${TAB_TAG}}`, "#{session_created}", "#{session_name}", `#{${TAB_LABEL}}`].join(
    " "
  );
  return new Promise((resolve) => {
    execFile(TMUX, ["-u", "list-sessions", "-F", fmt], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const rows: { name: string; displayName: string; created: number }[] = [];
      for (const line of stdout.split("\n")) {
        if (!line) continue;
        const parts = line.split(" ");
        if (parts.length < 3) continue;
        const tag = parts[0];
        if (tag !== "1") continue; // only sessions tagged as web tabs
        const name = parts[2];
        if (!name) continue;
        const label = parts.slice(3).join(" ");
        rows.push({
          name,
          displayName: label.trim() ? label : name,
          created: Number(parts[1]) || 0,
        });
      }
      rows.sort((a, b) => a.created - b.created);
      resolve(rows.map(({ name, displayName }) => ({ name, displayName })));
    });
  });
}

/**
 * Every session's active-pane working directory, keyed by session name. Null
 * when tmux can't be queried. The path is the remainder after the first space:
 * names never contain one, paths may.
 */
export async function listSessionCwds(): Promise<Map<string, string> | null> {
  const out = await runTmux(["list-sessions", "-F", "#{session_name} #{pane_current_path}"]);
  if (out === null) return null;
  const cwds = new Map<string, string>();
  for (const line of out.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const cwd = line.slice(space + 1);
    if (path.isAbsolute(cwd)) cwds.set(line.slice(0, space), cwd);
  }
  return cwds;
}

/** Run tmux; resolve its stdout, or null if it failed. Never throws. */
function runTmux(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(TMUX, ['-u', ...args], (err, stdout) => resolve(err ? null : stdout));
  });
}

// ---------------------------------------------------------------------------
// Forcing a repaint.
//
// tmux only ever sends differences: it keeps a model of what each client's
// screen holds and skips anything it believes is already right. That makes a
// divergence permanent — once the browser's grid and tmux's model disagree,
// nothing corrects it. It shows up as a pane divider drawn a column or two off
// on a few rows, in whichever colour it had at the time (a border that is grey
// on some rows and green on others is the giveaway: tmux paints the whole
// border in one style per frame, so those rows are leftovers from different
// repaints). refresh-client throws that model away and redraws everything.
// ---------------------------------------------------------------------------

/**
 * The tty of the tmux client a pty is running, found by matching the pty's pid:
 * node-pty spawns the `tmux new-session -A` client itself, so the pid it
 * reports IS the client's. Null when tmux can't be asked, or the client is gone.
 */
export async function findClientTty(pid: number): Promise<string | null> {
  const out = await runTmux(["list-clients", "-F", "#{client_pid} #{client_tty}"]);
  if (out === null) return null;
  for (const line of out.split("\n")) {
    const [clientPid, tty] = line.trim().split(" ");
    if (tty && Number(clientPid) === pid) return tty;
  }
  return null;
}

/** Redraw a client's whole screen, absolutely, from tmux's own grid. */
export async function refreshClient(tty: string): Promise<void> {
  await runTmux(["refresh-client", "-t", tty]);
}

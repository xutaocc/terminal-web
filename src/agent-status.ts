import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IS_PSMUX, TMUX } from './tmux.js';

/**
 * Where tab status (working / waiting / done / unread) comes from. Chosen in
 * the settings sheet and saved for every device; this is the value until
 * someone chooses.
 *
 * - 'hooks'  (default) Claude Code / Codex report each turn through their hook
 *            systems (scripts/install-agent-hooks.mjs installs them). Sessions
 *            that have never reported fall back to the 'screen' rules below.
 * - 'screen' No hooks: the server reads every session's screen through tmux and
 *            recognises the agents' own on-screen cues ("esc to interrupt"
 *            while a turn runs, a numbered Yes/No menu while it asks).
 * - 'legacy' The original browser-side rule: any screen change after Enter
 *            spins for 60s. Only tabs opened in that page are tracked.
 */
export type AgentStatusMode = 'hooks' | 'screen' | 'legacy';
export const DEFAULT_AGENT_STATUS_MODE: AgentStatusMode = 'hooks';

export function isAgentStatusMode(value: unknown): value is AgentStatusMode {
  return value === 'hooks' || value === 'screen' || value === 'legacy';
}

export type AgentState = 'idle' | 'working' | 'waiting' | 'done';

export interface SessionAgentStatus {
  state: AgentState;
  /** Finished or asking while nobody was looking; cleared by a viewer. */
  unread: boolean;
  /** When the current state began (ms since epoch). */
  since: number;
}

export interface StatusSnapshot {
  mode: AgentStatusMode;
  sessions: Record<string, SessionAgentStatus>;
}

// ---------------------------------------------------------------------------
// Signals. Pure, so the tests can pin them down.
// ---------------------------------------------------------------------------

/** What one hook event says about the turn, or null when it says nothing. */
export function hookSignal(event: string, tool = '', kind = ''): AgentState | null {
  switch (event) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'SubagentStart':
      return 'working';
    case 'PreToolUse':
      // Claude's AskUserQuestion (Codex's request_user_input) stops to ask.
      return /^(AskUserQuestion|request_user_input)$/.test(tool) ? 'waiting' : 'working';
    case 'PermissionRequest':
      return 'waiting';
    case 'Notification':
      // Older Claude versions announce permission prompts only this way.
      return kind === 'permission_prompt' ? 'waiting' : null;
    case 'Stop':
    case 'StopFailure':
    case 'Interrupt':
      return 'done';
    case 'PostCompact':
      return 'done'; // a manual /compact ends without a Stop
    case 'SessionEnd':
      return 'idle';
    default:
      return null;
  }
}

/** Foreground commands that mean no agent is running in the pane. */
const SHELLS = /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|csh|nu|login|tmux|pwsh|powershell|cmd)(\.exe)?$/i;

export function isShell(command: string): boolean {
  return SHELLS.test(command);
}

/**
 * The agents whose screens are recognised, each by its own exact wording and
 * nothing looser: a screen that matches none of them proves nothing, and the
 * session keeps whatever state it had. Only the bottom of the screen is read,
 * so the same words in the conversation above never count. Sources:
 *
 * - Claude Code: status line "· esc to interrupt" while a turn runs (tool calls
 *   included); asks with a numbered menu, "❯ 1. Yes"; idle at its "❯" prompt.
 * - Codex: "(12s • esc to interrupt)"; "› 1. Yes, proceed"; "› Ask Codex …".
 * - qwen-code (a Gemini CLI fork): "(12s · esc to cancel)", or "Press Esc
 *   again to stop" once Esc is armed; asks "Do you want to proceed?" / "Apply
 *   this change?" / "Allow execution of: '…'?" over "› 1. Yes, allow once".
 * - Kimi Code: "Press Esc again to interrupt"; asks with "Approve once" /
 *   "Approve for this session"; idle in its boxed "│ >" prompt.
 * - opencode and MiMo Code (an opencode fork): "esc interrupt" at the bottom
 *   while busy; "△ Permission required" over "Allow once / Allow always /
 *   Reject"; idle shows "tab switch mode" or "/ commands" there.
 */
const WORKING_LINES: RegExp[] = [
  /[·•(]\s*esc to interrupt/i, // Claude Code, Codex
  /[·•(]\s*esc to cancel\)?\s*$/i, // qwen-code
  /Press Esc again to (stop|interrupt)/i, // qwen-code, Kimi Code
  /(^|\s)(esc|again to) interrupt\s*$/i, // opencode, MiMo Code: the hint ends their bottom row
];

const ASKING_LINES: RegExp[] = [
  /Do you want to|Would you like to|Allow (this|command)|Enter to (select|confirm)|Press enter to confirm/i, // Claude Code, Codex
  /Do you want to proceed\?|Apply this change\?|Allow execution of[: ]|Yes, allow (once|always)/, // qwen-code
  /Approve (once|for this session)/, // Kimi Code
  /△\s+Permission required/, // opencode, MiMo Code
];

/** A selectable first option: "❯ 1. Yes", "› 1. Yes, allow once". */
const MENU_LINE = /^\s*[│|]?\s*[❯›>]\s*1[.)]\s+\S/;
/** opencode / MiMo Code draw options as a row of buttons, with their key hints. */
const BUTTON_ROW = /Allow once\b.*\bReject\b.*enter confirm/;

const IDLE_LINES: RegExp[] = [
  /^\s*[│|]?\s*[❯›](\s|$)/, // Claude Code, Codex, qwen-code prompt
  /^\s*│\s*>(\s|$)/, // Kimi Code's boxed prompt
  /\btab switch mode\b|(^|\s)\/ commands\s*$/, // opencode, MiMo Code footer
];

export function screenSignal(screen: string): 'working' | 'waiting' | 'idle' | 'unknown' {
  const lines = screen.split('\n').map(line => line.trimEnd()).filter(Boolean);
  const bottom = lines.slice(-30);
  const menu = bottom.some(line => MENU_LINE.test(line) || BUTTON_ROW.test(line));
  const asking = bottom.some(line => ASKING_LINES.some(re => re.test(line)));
  if (menu && asking) return 'waiting';
  // A status item at the very bottom, not the words quoted in a reply.
  if (lines.slice(-6).some(line => WORKING_LINES.some(re => re.test(line)))) return 'working';
  // Idle only with the input prompt in sight. Anything else — a transcript
  // viewer, a menu, a full-screen tool — hides the status line and proves
  // nothing either way.
  if (lines.slice(-10).some(line => IDLE_LINES.some(re => re.test(line)))) return 'idle';
  return 'unknown';
}

/** Claude Code animates its title while it generates: braille or ◐◓◑◒. */
export function titleWorking(title: string): boolean {
  return /[⠀-⣿◐-◓]/.test(title);
}

// ---------------------------------------------------------------------------
// The monitor.
// ---------------------------------------------------------------------------

/** How long a hook keeps the screen rules out of a session's way. */
const HOOK_FRESH_MS = 30 * 60_000;
/** An idle screen must hold this long before a turn counts as done. */
const SCREEN_SETTLE_MS = 2_000;
/** In hooks mode, how long a working turn may look idle with no hook before it is called done (Esc in Claude fires no Stop). */
const HOOK_STALL_MS = 6_000;
const POLL_MS = 1_000;

interface Tracked extends SessionAgentStatus {
  hookAt: number;
  idleSince: number;
  activity: string;
  capturedAt: number;
  /** psmux: the last screen read, standing in for the activity stamp. */
  screen?: string;
}

interface Pane {
  id: string;
  session: string;
  active: boolean;
  activity: string;
  command: string;
  title: string;
}

function run(args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(TMUX, ['-u', ...args], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

export class AgentStatusMonitor {
  private mode: AgentStatusMode = DEFAULT_AGENT_STATUS_MODE;
  private readonly tracked = new Map<string, Tracked>();
  private readonly paneSessions = new Map<string, string>();
  private readonly listeners = new Set<(snapshot: StatusSnapshot) => void>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private emitQueued = false;

  /** `file` keeps the mode chosen in settings across restarts. */
  constructor(private readonly file: string) {}

  async start(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8')).mode;
      if (isAgentStatusMode(saved)) this.mode = saved;
    } catch { /* never chosen: the default */ }
    this.run();
  }

  async setMode(mode: AgentStatusMode): Promise<void> {
    if (mode === this.mode) return;
    this.mode = mode;
    // Whatever the old source concluded does not carry over to the new one.
    this.tracked.clear();
    this.run();
    this.emit();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ mode }), 'utf8');
    await fs.rename(temp, this.file);
  }

  /** Poll tmux unless the browsers are doing the work themselves ('legacy'). */
  private run(): void {
    if (this.mode === 'legacy') {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  subscribe(listener: (snapshot: StatusSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): StatusSnapshot {
    const sessions: Record<string, SessionAgentStatus> = {};
    for (const [name, t] of this.tracked) sessions[name] = { state: t.state, unread: t.unread, since: t.since };
    return { mode: this.mode, sessions };
  }

  /**
   * A hook fired in tmux pane `pane`. Returns false when the event was not used.
   * `named` is the session the hook said it ran in (psmux, where pane ids
   * repeat across sessions); without it the pane id is looked up. A name no
   * live session has is not believed: a psmux session taken from its warm pool
   * still says "__warm__" there. Under psmux the pane id is no fallback — it
   * names every session's first pane at once — so such a report is dropped.
   */
  async hook(pane: string, event: string, tool: string, kind: string, named?: string): Promise<boolean> {
    if (this.mode !== 'hooks') return false;
    const signal = hookSignal(event, tool, kind);
    if (!signal) return false;
    if (named && await run(['has-session', '-t', `=${named}`]) === null) named = undefined;
    if (IS_PSMUX && !named) return false;
    let session = named ?? this.paneSessions.get(pane);
    if (!session) {
      session = (await run(['display-message', '-p', '-t', pane, '#{session_name}']))?.trim() || undefined;
      if (!session) return false;
      this.paneSessions.set(pane, session);
    }
    const now = Date.now();
    const t = this.track(session, now);
    t.hookAt = now;
    this.set(t, signal, now);
    return true;
  }

  /** Someone is looking at these sessions: they are read. */
  read(names: string[]): void {
    let changed = false;
    for (const name of names) {
      const t = this.tracked.get(name);
      if (t?.unread) {
        t.unread = false;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private track(name: string, now: number): Tracked {
    let t = this.tracked.get(name);
    if (!t) {
      t = { state: 'idle', unread: false, since: now, hookAt: 0, idleSince: 0, activity: '', capturedAt: 0 };
      this.tracked.set(name, t);
    }
    return t;
  }

  private set(t: Tracked, state: AgentState, now: number): void {
    if (t.state === state) return;
    // Finishing and asking both want you; starting and stopping do not.
    if (state === 'done' || state === 'waiting') t.unread = true;
    t.state = state;
    t.since = now;
    t.idleSince = 0;
    this.emit();
  }

  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    setImmediate(() => {
      this.emitQueued = false;
      const snapshot = this.snapshot();
      for (const listener of this.listeners) listener(snapshot);
    });
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const panes = await this.listPanes();
      if (!panes || this.mode === 'legacy') return;
      const now = Date.now();
      this.paneSessions.clear();
      const live = new Set<string>();
      for (const pane of panes) {
        this.paneSessions.set(pane.id, pane.session);
        if (!pane.active) continue;
        live.add(pane.session);
        await this.observe(pane, now);
      }
      for (const name of this.tracked.keys()) {
        if (!live.has(name)) {
          this.tracked.delete(name);
          this.emit();
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async listPanes(): Promise<Pane[] | null> {
    // Space-separated with the free-text title last (see listWebTabs for why
    // not a tab); names, ids, flags, stamps and command names have no spaces.
    const out = await run(['list-panes', '-a', '-F',
      '#{pane_id} #{session_name} #{window_active}#{pane_active} #{window_activity} #{pane_current_command} #{pane_title}']);
    if (out === null) return null;
    const panes: Pane[] = [];
    for (const line of out.split('\n')) {
      const [id, session, flags, activity, command, ...title] = line.split(' ');
      if (!id || !session || !command) continue;
      panes.push({ id, session, active: flags === '11', activity, command, title: title.join(' ') });
    }
    return panes;
  }

  private async observe(pane: Pane, now: number): Promise<void> {
    const t = this.track(pane.session, now);
    // The agent is gone: whatever it was doing is over.
    if (isShell(pane.command)) {
      if (t.state === 'working' || t.state === 'waiting') this.set(t, 'idle', now);
      return;
    }
    const hooked = this.mode === 'hooks' && now - t.hookAt < HOOK_FRESH_MS;
    const busy = t.state === 'working' || t.state === 'waiting';
    // Read the screen only when something was drawn, or while a turn is open
    // (so its end is seen promptly). Idle sessions cost one list-panes line.
    // psmux never advances #{window_activity}, so there every agent pane is
    // read each poll and "something was drawn" is told by the screen itself.
    if (!IS_PSMUX && pane.activity === t.activity && !(busy && now - t.capturedAt >= POLL_MS)) return;
    t.activity = pane.activity;
    t.capturedAt = now;
    // psmux numbers panes per session (every session's first is %1), so a
    // bare pane id names some other session's pane there; the session does not.
    const target = IS_PSMUX ? `=${pane.session}:` : pane.id;
    const screen = await run(['capture-pane', '-p', '-t', target]);
    if (screen === null) return;
    if (IS_PSMUX) {
      if (screen === t.screen && !busy) return;
      t.screen = screen;
    }
    let seen = screenSignal(screen);
    if (seen !== 'working' && seen !== 'waiting' && titleWorking(pane.title)) seen = 'working';
    if (seen === 'unknown') return; // covered up: keep what we had, restart nothing

    if (seen !== 'idle') {
      t.idleSince = 0;
      // A hooked session already says when it works and asks.
      if (!hooked) this.set(t, seen, now);
      return;
    }
    if (!busy) return;
    if (!t.idleSince) t.idleSince = now;
    const settled = now - t.idleSince >= (hooked ? HOOK_STALL_MS : SCREEN_SETTLE_MS);
    if (settled && (!hooked || now - t.hookAt >= HOOK_STALL_MS)) this.set(t, 'done', now);
  }
}

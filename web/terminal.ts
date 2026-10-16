import '@xterm/xterm/css/xterm.css';
import './theme.css';
import { applyDocumentTheme, isTheme, TERMINAL_THEMES, type ThemeName } from './theme.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { TouchScrollMotion } from './touch-scroll.js';
import { mouseWheelReports } from './mouse-wheel.js';
import { bindIntentionalClick } from './intentional-click.js';
import { newSessionName, newSessionId } from './session-name.js';
import { NoteHover, NoteDismiss } from './note-hover.js';
import { moveTab, restoreTabOrder } from './tab-order.js';
import { TerminalKeyboardLock } from './keyboard-lock.js';
import { OutputActivityTracker, SessionReadState } from './output-activity.js';
import { showQuickCommands } from './quick-commands.js';
import { decodeOsc52, forceSelectKey, shouldHintDrag, takeHintTurn } from './terminal-copy.js';
import { type FolderInfo, groupByFolder, wouldEmpty } from './project-groups.js';
import { ICONS, ProjectSidebar } from './project-sidebar.js';
import { brandMark } from './brand-mark.js';
import { type AgentStatus, combineStatus, INDICATOR_LABEL, wantsAttention } from './agent-indicator.js';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------
let fileBrowserOpen = false;
let fileBrowserFrame: HTMLIFrameElement | null = null;
let fileBrowserSession = '';

const MIN_DELAY = 500;
const MAX_DELAY = 5000;
const MIN_FONT = 8;
const MAX_FONT = 28;
const KEYBAR_HEIGHT = 48; // px when shown

// Floor on the size we will ever report to the server. xterm's FitAddon happily
// proposes 2x1 whenever the pane momentarily has no layout box (a fullscreen
// switch, a phone's keyboard eating the viewport, a tab being restored), and
// that size goes straight through to tmux, which resizes the window for EVERY
// client attached to that session. A program on the alternate screen (Claude
// Code) has no scrollback, so whatever no longer fits is destroyed rather than
// scrolled off. A session found sitting at 11x6 on this machine is what that
// looks like afterwards. Below this floor we keep the last good size.
const MIN_COLS = 20;
const MIN_ROWS = 5;

// A tab can show two terminals: its own session, and a second one beside it.
// This is which you are looking at — the first alone, the second alone, or both
// at once. Neither is ever closed by switching; closing the tab closes both.
type LayoutMode = 'one' | 'two' | 'both';
// Below this pane width the two go one above the other rather than side by
// side. Half of 80 columns is not a terminal anyone can use.
const WIDE_PX = 760;

// The second terminal is a SESSION OF ITS OWN, named after the first.
//
// It used to be tmux's own split: one window, two panes, drawn into one xterm
// grid with the divider as a column of glyphs inside it. That divider was
// content, and tmux only ever sends differences — so once the browser's grid
// and tmux's model of it disagreed, the border stayed drawn a column or two off
// on a few rows for as long as the page was open. Everything downstream had to
// know where that column was: selections had to be clipped to one side of it,
// which took a block-selection mode reachable only through xterm's private
// selection service, and every resize had to force a full repaint.
//
// Two sessions side by side have no divider to get wrong. Each gets its own
// pty at its own size, its own selection, and its own clipboard, and the gap
// between them is a CSS gap. What tmux is asked for is an attach and nothing
// else.
//
// The pairing is in the NAME rather than a tmux option, because options are
// what a tmux-resurrect restore drops — the same way it drops @twtab — and a
// name survives it. `work` has `work__b`; nothing else needs storing.
const MATE_SUFFIX = '__b';

/** The name of the second session beside `name`. */
function mateNameOf(name: string): string {
  return name + MATE_SUFFIX;
}

/** Whether `name` is the second session of some pair. */
function isMateName(name: string): boolean {
  return name.endsWith(MATE_SUFFIX);
}

/** The first session of the pair `name` is the second of. */
function primaryNameOf(name: string): string {
  return name.slice(0, -MATE_SUFFIX.length);
}

// Touch "select" mode (toggled from the key bar). tmux runs with `mouse on`, so
// a finger drag is normally hijacked for scrolling and there is no way to make a
// text selection by touch (on desktop you hold Option to bypass tmux's mouse
// reporting; a tablet has no such key). While this is on, a one-finger drag
// selects text instead of scrolling, and lifting the finger copies it.
let touchSelectMode = false;
// Window to drop a duplicated IME emission. The CapsLock-switch double-send
// arrives ~100-120ms apart (keydown-finalize then compositionend-finalize), so
// 100ms was just too tight; 300ms covers it with margin while staying far below
// the interval of any legitimate re-typing of the same characters.
const IME_DEDUP_MS = 300;

// Cap on the bytes of discrete injections (uploaded file path, paste, key-bar
// press) buffered while the WebSocket is down, so a long outage can't grow the
// queue without bound. 64 KB is far more than any real path/paste.
const MAX_PENDING_SEQ = 64 * 1024;

// macOS uses ⌘ for copy/paste (never a terminal control key), so xterm passes
// it through to the browser. Everything else uses Ctrl, which collides with the
// terminal's ^C/^V — hence the OS-specific copy/paste key handling below.
const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

const params = new URLSearchParams(window.location.search);
const IME_DEBUG = (params.get('debug') ?? '').includes('ime');
// ?debug=vv logs visualViewport metrics (keyboard occlusion / Safari pan) to
// the server log via the same WS debug channel, for on-device layout diagnosis.
const VV_DEBUG = (params.get('debug') ?? '').includes('vv');
// ?debug=paste logs what each paste event actually carries (clipboard types,
// item kinds/types, file count) — for diagnosing why image paste-to-upload
// behaves differently across browsers/OSes (e.g. Windows Chrome).
const PASTE_DEBUG = (params.get('debug') ?? '').includes('paste');
// Touch browsers can accept a WebGL context but render a blank terminal.
// Use the standard renderer on those devices unless explicitly requested.
// ?webgl=0 (or ?nowebgl) always disables WebGL; ?webgl=1 opts in.
const WEBGL_ENABLED =
  !params.has('nowebgl') &&
  (params.get('webgl') === '1' ||
    (params.get('webgl') !== '0' && navigator.maxTouchPoints === 0));
// ?debug=sel traces touch selection — where a touch landed, whether the long
// press fired, what word it found, what ended up selected — to the server log.
// Selecting is several steps deep and every one of them is invisible when it
// goes wrong on a device you cannot open a console on.
const SEL_DEBUG = (params.get('debug') ?? '').includes('sel');

// Whether this device is touched rather than pointed at.
//
// maxTouchPoints rather than `(pointer: coarse)`: it is a count of digitizers,
// not a judgement about the primary input, so it does not move when a tablet
// decides to present itself as a desktop. (The iPad here answers coarse=1
// maxTouch=5 — see ?debug=sel — so the missing selection handles it was blamed
// for were really a stale stylesheet; the query is just the shakier question to
// be asking.)
const TOUCH_DEVICE = navigator.maxTouchPoints > 0;
const ANDROID_DEVICE = /Android/i.test(navigator.userAgent);
let keyboardLocked = (() => {
  try { return localStorage.getItem('tw.keyboardLocked') === '1'; }
  catch { return false; }
})();
let keyboardLockChanged = false;

const encoder = new TextEncoder();

/** Sanitize a session name to [A-Za-z0-9_-]{1,64}; null if nothing usable. */
function sanitizeName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned.length ? cleaned : null;
}

// Copy text to the clipboard. Uses the async Clipboard API on a secure context
// (HTTPS), else falls back to a hidden-textarea + execCommand("copy"), which
// works over plain HTTP within a user gesture.
async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Read the clipboard and send it to the active session. Reading requires a
// secure context (HTTPS); over HTTP we can't, so hint the user to use Cmd/Ctrl-V
// (the native paste event still works when the terminal is focused).
function pasteFromClipboard(): void {
  const clip = navigator.clipboard;
  if (clip && typeof clip.readText === 'function' && window.isSecureContext) {
    clip
      .readText()
      .then((t) => {
        if (t) activeSession?.pasteText(t);
        else openPasteBox();
      })
      .catch(() => openPasteBox());
  } else {
    // Plain HTTP can't read the clipboard via JS, so pop a box the user pastes
    // into (native paste into a real textarea works on HTTP and iPad).
    openPasteBox();
  }
}

// Rich paste for the Windows/Linux Ctrl+Shift+V chord (plain Ctrl+V uses the
// browser's own paste instead): unlike Chrome's built-in "paste as plain text"
// bound to that chord (which drops images) or readText() (text only), the
// async Clipboard API returns BOTH text and image blobs — so a pasted image
// uploads and text goes to the shell. Falls back to the text-only path when the
// Clipboard read API isn't available (non-secure context / older browsers).
async function pasteRich(): Promise<void> {
  const clip = navigator.clipboard;
  if (clip && typeof clip.read === 'function' && window.isSecureContext) {
    try {
      const items = await clip.read();
      let handled = false;
      for (const it of items) {
        const imgType = it.types.find((t) => t.startsWith('image/'));
        if (imgType) {
          const blob = await it.getType(imgType);
          const ext = (imgType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
          void uploadFile(blob, `pasted-image.${ext}`);
          handled = true;
        } else if (it.types.includes('text/plain')) {
          const text = await (await it.getType('text/plain')).text();
          if (text) activeSession?.pasteText(text);
          handled = true;
        }
      }
      if (handled) return;
    } catch {
      /* permission denied / not focused — fall back to the legacy paths */
    }
  }
  pasteFromClipboard();
}

function showCurrentPath(path: string, copied: boolean): void {
  if (document.querySelector('.cwd-dialog')) return;
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay cwd-dialog';
  const box = document.createElement('div');
  box.className = 'paste-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', '当前工作路径');
  const label = document.createElement('div');
  label.className = 'paste-label';
  label.setAttribute('aria-live', 'polite');
  label.textContent = copied ? '已复制当前路径' : '自动复制未成功，请点击复制或长按路径手动复制';
  const text = document.createElement('textarea');
  text.className = 'paste-ta';
  text.value = path;
  text.readOnly = true;
  text.rows = 4;
  text.spellcheck = false;
  text.setAttribute('aria-label', '完整工作路径');
  const row = document.createElement('div');
  row.className = 'paste-row';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tb-btn';
  close.textContent = '关闭';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'tb-btn';
  copy.textContent = copied ? '再次复制' : '复制路径';
  const dismiss = (): void => { overlay.remove(); };
  bindIntentionalClick(close, dismiss);
  bindIntentionalClick(copy, () => {
    void copyText(path).then(ok => {
      label.textContent = ok ? '已复制当前路径' : '复制失败，请长按路径手动复制';
      if (ok) copy.textContent = '再次复制';
    });
  });
  bindIntentionalClick(overlay, event => {
    if (event.target === overlay) dismiss();
  });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  });
  row.append(close, copy);
  box.append(label, text, row);
  overlay.append(box);
  document.body.append(overlay);
}

let copyingCurrentPath = false;
async function copyCurrentPath(): Promise<void> {
  const session = activeSession;
  if (!session) {
    flashStatus('没有选中的终端会话', 1600);
    return;
  }
  if (copyingCurrentPath || document.querySelector('.cwd-dialog')) return;
  copyingCurrentPath = true;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);
  const pathRequest = (async (): Promise<string> => {
    const response = await fetch(`/api/sessions/cwd?session=${encodeURIComponent(session.name)}`, {
      cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) throw new Error('working directory unavailable');
    const data = await response.json() as { path?: unknown };
    if (typeof data.path !== 'string' || !data.path.startsWith('/')) {
      throw new Error('invalid working directory');
    }
    return data.path;
  })();
  // Start the secure-context write inside the click, before awaiting the server.
  // WebKit accepts a ClipboardItem whose content arrives as a Promise.
  let clipboardWrite: Promise<boolean> | null = null;
  try {
    if (window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const content = pathRequest.then(path => new Blob([path], { type: 'text/plain' }));
      void content.catch(() => { /* fetch errors are reported below */ });
      clipboardWrite = navigator.clipboard.write([new ClipboardItem({
        'text/plain': content,
      })]).then(() => true, () => false);
    }
  } catch { /* use the existing clipboard fallback after the path arrives */ }
  try {
    const path = await pathRequest;
    const copied = clipboardWrite ? await clipboardWrite : await copyText(path);
    showCurrentPath(path, copied);
  } catch {
    flashStatus('无法获取当前路径，请检查会话连接', 2200);
  } finally {
    window.clearTimeout(timer);
    copyingCurrentPath = false;
  }
}

// A small overlay with a real <textarea> the user pastes into, then we forward
// the text to the active session. Works without the Clipboard API (HTTP/iPad).
function openPasteBox(): void {
  if (document.querySelector('.paste-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box';
  const label = document.createElement('div');
  label.className = 'paste-label';
  label.textContent = `在此粘贴（${isMac ? '⌘V' : 'Ctrl+V'}，或长按 → 粘贴），粘贴后自动发送`;
  const ta = document.createElement('textarea');
  ta.className = 'paste-ta';
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('autocomplete', 'off');
  ta.spellcheck = false;
  const row = document.createElement('div');
  row.className = 'paste-row';
  const cancel = document.createElement('button');
  cancel.className = 'tb-btn';
  cancel.type = 'button';
  cancel.textContent = '取消';
  const send = document.createElement('button');
  send.className = 'tb-btn';
  send.type = 'button';
  send.textContent = '发送';
  row.append(cancel, send);
  box.append(label, ta, row);
  overlay.append(box);
  document.body.append(overlay);
  window.setTimeout(() => ta.focus(), 0);

  const close = (): void => {
    overlay.remove();
    activeSession?.focus();
  };
  const submit = (): void => {
    const t = ta.value;
    if (t) activeSession?.pasteText(t);
    close();
  };
  send.addEventListener('click', submit);
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  // One-tap feel: auto-send right after a paste lands in the box.
  ta.addEventListener('paste', () => window.setTimeout(submit, 0));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

// Quick help overlay: how to copy / paste / attach files. Shown from the "?"
// button and once automatically on first visit.
function openHelp(): void {
  if (document.querySelector('.help-overlay')) return;
  const selKey = isMac ? '⌥ Option' : 'Shift';
  const pasteKey = isMac ? '⌘V' : 'Ctrl+V';
  const copyKey = isMac ? '⌘C' : 'Ctrl+Shift+C';
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay help-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box help-box';
  box.innerHTML =
    '<div class="help-title">使用帮助：复制 / 粘贴 / 文件</div>' +
    '<ul class="help-list">' +
    `<li><b>复制</b> — 直接用鼠标拖动选中即可复制到剪贴板；若没有复制成功，按住 <b>${selKey}</b> 再拖动，松开后自动复制。也可以选中后按 <b>${copyKey}</b>。</li>` +
    `<li><b>粘贴</b> — 点击终端后按 <b>${pasteKey}</b>${
      isMac ? '' : '（或 Ctrl+Shift+V）'
    }。手机 / 平板上点“粘贴”，在弹出的输入框里粘贴即可。</li>` +
    (isMac
      ? ''
      : '<li><b>输入字面 ^V</b>（vim 块选择、readline 原样插入）— Ctrl+V 已用于粘贴，请改按 <b>Ctrl+Q</b>，这两个程序都把它当作 ^V。</li>') +
    '<li><b>上传文件</b>（给 Claude Code 等使用）— 点上传按钮，或直接粘贴 / 拖入任意文件（图片、PDF、文本…），上传后会自动插入文件路径，再按回车发送。</li>' +
    '<li><b>下载文件</b> — 点 ⬇ 按钮（手机上为 <b>⋯ → 下载文件</b>），输入相对终端当前目录的文件名或路径（如 <code>report.zip</code>），或完整路径（<code>~/output/report.zip</code>），文件会下载到当前设备。</li>' +
    '<li><b>主题</b> — 右上角 ⋯ → 设置 → 浅色 / 深色；电脑与手机分别保存，切换时不重连终端。</li>' +
    '<li><b>滚动</b> — 鼠标滚轮或双指滑动查看历史输出。</li>' +
    '<li><b>标签</b> — <b>+</b> 新建会话，<b>×</b> 关闭标签并结束其会话，<b>⟳</b> 重启会话。右键或长按标签可重命名，双击（或双击触摸）也可以；只改显示名称，对应的 tmux 会话不变。</li>' +
    '</ul>' +
    '<div class="paste-row"><button class="tb-btn" type="button" data-help-close>知道了</button></div>';
  overlay.append(box);
  document.body.append(overlay);
  const close = (): void => {
    overlay.remove();
    activeSession?.focus();
  };
  box.querySelector('[data-help-close]')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

const mobileMQ = window.matchMedia('(max-width: 640px), (hover: none) and (pointer: coarse)');
const THEME_STORAGE_KEY = `tw.theme.${TOUCH_DEVICE ? 'touch' : 'desktop'}`;
let currentTheme: ThemeName = 'dark';
try {
  const cachedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  if (isTheme(cachedTheme)) currentTheme = cachedTheme;
} catch { /* server preferences can restore the theme */ }
let themeChanged = false;
applyDocumentTheme(currentTheme);

const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const root = document.documentElement;
const topbar = document.getElementById('topbar') as HTMLElement;
const termArea = document.getElementById('terminal') as HTMLElement;
const keybarEl = document.getElementById('keybar') as HTMLElement;
const statusEl = document.getElementById('status');

// Top bar layout: [ wrapping tabs ] [ + ] [ controls ]
const tabsEl = document.createElement('div');
tabsEl.id = 'tabs';
const addBtn = document.createElement('button');
addBtn.className = 'tab-add';
addBtn.type = 'button';
addBtn.textContent = '+';
addBtn.title = '新建会话';

const controlsEl = document.createElement('div');
controlsEl.id = 'controls';

const desktopTools = document.createElement('div');
desktopTools.id = 'desktop-tools';
// "+" lives at the end of the tab strip, right after the last tab: new tabs
// appear where you asked for one. Every tab is inserted before it.
desktopTools.append(controlsEl);
// Shown in the bar only while the sidebar is hidden, to bring it back.
const sidebarOpenBtn = document.createElement('button');
sidebarOpenBtn.type = 'button';
sidebarOpenBtn.id = 'sidebar-open';
sidebarOpenBtn.className = 'tb-btn tb-icon';
sidebarOpenBtn.title = '展开侧栏';
sidebarOpenBtn.innerHTML = ICONS.panel;
// A floated tool group reserves only its own rows, so later tab rows span the bar.
topbar.append(desktopTools, sidebarOpenBtn, tabsEl);
tabsEl.append(addBtn);

// Desktop left column: tabs in the folders the user put them in, grouped by
// directory inside each (hidden on phones by CSS). Folders and who is in them
// are shared by every device; see /api/folders.
let folders: FolderInfo[] = [];
/** session name -> folder id */
let folderMembers: Record<string, string> = {};
/** folder id ('' for none) -> cwd -> the name the user gave that directory card there. */
let dirNames: Record<string, Record<string, string>> = {};
/** folder id ('' for none) -> its directory cards' cwds, in the order the user dragged them into. */
let cardOrder: Record<string, string[]> = {};
let homeDir = '';
/** Directory -> the tab last shown from it, for clicks on its sidebar card. */
const lastUsedIn = new Map<string, string>();
const sidebar = new ProjectSidebar({
  activate: name => {
    const s = sessions.find(x => x.name === name);
    if (s) activateSession(s);
  },
  activateDirectory: names => {
    // Back to the session last used there, as Orca restores a worktree's tab.
    const inDir = sessions.filter(x => names.includes(x.name));
    const s = inDir.find(x => x.name === lastUsedIn.get(x.cwd ?? '')) ?? inDir[0];
    if (s) activateSession(s);
  },
  newSession: (folderId, directory) => void promptAddSession(activeSession, directory || undefined, folderId),
  newFolder: () => void promptNewFolder(),
  renameFolder: (id, name) => void editFolders({ action: 'rename', id, name }),
  moveSessions: (names, folderId, card) => moveSessions(names, folderId, card),
  renameDir: (folderId, cwd, name) => void editFolders({ action: 'renameDir', folder: folderId, cwd, name }),
  orderCards: (folderId, cwds) => {
    cardOrder = { ...cardOrder, [folderId]: cwds };
    void editFolders({ action: 'orderCards', folder: folderId, cwds });
  },
  openSettings: () => openSheet(),
  openHelp: () => openHelp(),
  resized: () => {
    refreshSidebar();
    fitActive();
  },
});
document.body.prepend(sidebar.el);
sidebarOpenBtn.addEventListener('click', () => sidebar.setHidden(false));

async function logoutBrowser(): Promise<void> {
  try {
    const response = await fetch('/auth/logout', { method: 'POST' });
    if (!response.ok && response.status !== 401) throw new Error('logout failed');
    // Only an event marker goes in localStorage, never the token.
    try { localStorage.setItem('tw.logout', String(Date.now())); } catch { /* unavailable */ }
    window.location.replace('/');
  } catch { flashStatus('退出失败，请重试', 2000); }
}
window.addEventListener('storage', event => {
  if (event.key === 'tw.logout') window.location.replace('/');
});
let keybarSettingsButton: HTMLButtonElement | null = null;

let currentFont = (() => {
  try {
    const n = parseInt(localStorage.getItem('tw.fontSize') ?? '', 10);
    if (!Number.isNaN(n)) return Math.min(MAX_FONT, Math.max(MIN_FONT, n));
  } catch {
    /* ignore */
  }
  return 14;
})();

// The size every pane has. All panes are inset:0 in #terminal and share one
// font, so a single measurement taken from the pane on screen is the correct
// size for all of them — including the hidden ones, which are display:none and
// cannot measure themselves. Written by setPaneDims(); 0 until the first fit.
let paneCols = 0;
let paneRows = 0;

function showStatus(text: string): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.add('visible');
}
function hideStatus(): void {
  statusEl?.classList.remove('visible');
}

// ---------------------------------------------------------------------------
// Session: one terminal + one WebSocket + reconnect, rendered in its own pane.
// ---------------------------------------------------------------------------
class Session {
  // Immutable tmux session id — used for the WebSocket ?session= param and the
  // kill command. Renaming a tab never touches this, so × still kills the
  // original session.
  readonly name: string;
  // Mutable label shown on the tab; defaults to the session name.
  displayName: string;
  readonly term: Terminal;
  readonly el: HTMLElement;
  tabEl: HTMLElement | null = null;
  tabLabel: HTMLElement | null = null;
  tabDot: HTMLElement | null = null;
  // Where the session is working, as last reported by the server (or where it
  // was asked to start). The sidebar files the tab under a project by this.
  cwd: string | null = null;
  connected = false;
  outputActive = false;
  readonly readState = new SessionReadState();
  private outputTracker: OutputActivityTracker | null = null;
  private outputActivityTimer: ReturnType<typeof setTimeout> | null = null;
  // True once this tab has been looked at and so has attached. Tabs are not
  // connected until then: a page with a dozen of them used to open a dozen
  // WebSockets, spawn a dozen ptys and attach a dozen tmux clients, all for
  // sessions nobody was looking at.
  started = false;

  // Sharing the screen with the other half of a split, rather than having it to
  // itself. Set by layOutTab; read where a full-width measurement is meant.
  half = false;

  private readonly fitAddon = new FitAddon();
  private ws: WebSocket | null = null;
  private reconnectDelay = MIN_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private keyboardLock: TerminalKeyboardLock | null = null;
  // Until when a connect may create this session if it is not there. The
  // server refuses to bring back a closed tab for a connect that does not ask
  // (see closedTabs in server.ts) — only a tab made on purpose asks, and only
  // for its first attach, so a page that sleeps for a day and wakes up cannot
  // pass for one.
  private createUntil = 0;
  private createFrom: string | null = null;
  private createDirectory: string | null = null;

  // IME double-input guard (order-independent, content-scoped).
  private lastData = '';
  private lastDataAt = 0;

  // The IME's current pre-edit (composing) string, straight from its own
  // compositionupdate events, with the time it was last seen. Nothing in here
  // has been committed, so none of it may reach the pty — only the text the IME
  // hands us at compositionend does, and we send that ourselves. Kept for a
  // moment after the composition ends because xterm's finalize is deferred.
  private composingText = '';
  private composingAt = 0;

  // True between compositionstart and compositionend — i.e. while the soft
  // keyboard is mid-composition (e.g. picking a 注音 candidate). A reconnect
  // that re-fits/re-focuses the terminal during this window cancels the iOS
  // composition (the candidate bar vanishes, input turns raw/direct), so we
  // defer that re-attach work until the composition commits.
  private composing = false;
  private reattachAfterCompose = false;

  // Discrete injections (file path, paste, key-bar seq) buffered while the WS is
  // not OPEN, flushed on the next reconnect (see connect's onopen). Raw typing
  // is never buffered — only these one-shot sends routed through sendSeq().
  private pendingSeq: string[] = [];

  // Which of this tab's two terminals is on screen. A per-device choice now
  // that the pair is two sessions rather than one tmux window: a phone and a
  // desktop looking at the same work want different answers to it.
  view: LayoutMode = 'one';
  // The session beside this one, built the first time it is asked for. Null on
  // a tab that has never been split, and always null on a mate itself.
  mate: Session | null = null;
  // True on the second session of a pair. It is an ordinary session in every
  // other way; this only keeps it out of the tab strip and its own recursion.
  readonly isMate: boolean;

  constructor(name: string, displayName?: string, isMate = false) {
    this.name = name;
    this.displayName = displayName?.trim() || name;
    this.isMate = isMate;
    this.term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: currentFont,
      scrollback: 100000,
      // Local scrollback speed; tmux mouse reports are accelerated separately.
      // One-finger touch scrolling uses TouchScrollMotion independently.
      scrollSensitivity: 2,
      allowProposedApi: true,
      // Hold Option (macOS) / Shift (others) and drag to select text even while
      // tmux mouse mode is on, so it can be copied.
      macOptionClickForcesSelection: true,
      theme: TERMINAL_THEMES[currentTheme],
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());

    this.el = document.createElement('div');
    this.el.className = 'term-pane hidden';
    termArea.append(this.el);
    this.term.open(this.el);
    if (this.term.textarea) {
      this.keyboardLock = new TerminalKeyboardLock(
        this.term.textarea, TOUCH_DEVICE, () => this.term.focus(),
      );
      this.keyboardLock.setLocked(keyboardLocked);
    }

    if (WEBGL_ENABLED) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        // The 0.18 glyph atlas can corrupt when it grows a page or merges pages
        // (lots of CJK + emoji on coloured diff backgrounds): glyphs render as
        // fragments of other glyphs until reload. Rebuild it from scratch
        // whenever it grows — at most once per cooldown, so a screen that
        // itself needs a new page cannot loop clear -> redraw -> grow.
        let atlasClearedAt = 0;
        webgl.onAddTextureAtlasCanvas(() => {
          const now = performance.now();
          if (now - atlasClearedAt < 2000) return;
          atlasClearedAt = now;
          requestAnimationFrame(() => this.term.clearTextureAtlas());
        });
        this.term.loadAddon(webgl);
      } catch {
        /* fall back to the DOM renderer */
      }
    }

    // Windows/Linux copy-paste. macOS gets this for free: ⌘ is never a terminal
    // key, so xterm ignores ⌘V and the browser's own paste runs — text, images
    // and files all take one path. Ctrl is different: xterm turns Ctrl+V into ^V
    // and Ctrl+C into ^C and cancels the keydown, which ALSO kills the browser's
    // copy/paste and the paste-to-upload event. So on non-Mac we take the keys
    // back:
    //   Ctrl+V        paste. Returning false WITHOUT preventDefault only stops
    //                 xterm making it ^V — the browser then pastes natively, so
    //                 this is the ⌘V path exactly: text, images, files, and it
    //                 still works over plain HTTP where the Clipboard API can't
    //                 read. The cost is ^V (readline quoted-insert, vim
    //                 visual-block), which both accept Ctrl+Q for instead.
    //                 Windows Terminal and VS Code make the same trade.
    //   Ctrl+Shift+V  the same, kept for muscle memory and the Linux-terminal
    //                 convention — but Chrome binds it to "paste as plain text"
    //                 (which drops images), so this chord reads the clipboard
    //                 itself rather than letting the browser do it.
    //   Ctrl+Shift+C  copy the selection (preventDefault so Chrome doesn't open
    //                 DevTools). Plain Ctrl+C stays ^C / SIGINT.
    // Auto-repeat is dropped on both paste chords: holding the key would paste
    // the same block again and again, which at a shell prompt is a duplicated
    // command rather than a typo.
    // This handler ALSO keeps xterm out of IME composition entirely, on every
    // platform — see the compositionend handler in wireInput, which commits the
    // text itself. xterm sends composed text from three places, and starving
    // one is not enough:
    //   1. compositionend        -> _finalizeComposition(true), deferred; reads
    //                               the textarea a tick later (starved there).
    //   2. a non-229 keydown mid-composition -> _finalizeComposition(false),
    //                               SYNCHRONOUS, so blanking the textarea
    //                               afterwards cannot stop it.
    //   3. a 229 keydown while not composing -> _handleAnyTextareaChanges().
    // 2 and 3 both run from _compositionHelper.keydown(), which _keyDown calls
    // only AFTER consulting this handler — so returning false for any keystroke
    // belonging to a composition shuts both off. e.isComposing is per-event, so
    // it cannot latch on if a compositionend is ever missed.
    this.term.attachCustomKeyEventHandler((e) => {
      if (!ANDROID_DEVICE && e.type === 'keydown' && (e.isComposing || e.keyCode === 229)) {
        return false; // composition keystroke — ours, not xterm's
      }
      if (isMac) return true; // ⌘ needs no remapping; the chords below are Ctrl
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) {
        return true; // not a copy/paste chord — let xterm handle it normally
      }
      // Match the physical key OR the layout's letter, so the chord works on
      // QWERTY and on layouts that move V/C (AZERTY, Dvorak…).
      const isKey = (code: string, ch: string): boolean =>
        e.code === code || (e.key || '').toLowerCase() === ch;
      if (isKey('KeyV', 'v')) {
        if (e.repeat) {
          e.preventDefault(); // a held key must not paste twice
          return false;
        }
        if (!e.shiftKey) return false; // hand it to the browser's native paste
        e.preventDefault(); // Chrome's own Ctrl+Shift+V would drop images
        void pasteRich();
        return false;
      }
      if (e.shiftKey && isKey('KeyC', 'c')) {
        const sel = this.term.getSelection();
        if (sel) void copyText(sel).then((ok) => flashStatus(ok ? 'copied' : 'copy failed', 1200));
        else flashStatus('nothing selected', 1200);
        e.preventDefault(); // block Chrome's Ctrl+Shift+C = open DevTools
        return false; // handled — don't let xterm process it
      }
      return true;
    });

    // Copy the selection to the clipboard when a drag/touch selection ends.
    const copySelection = (): void => {
      const sel = this.term.getSelection();
      if (sel) {
        void copyText(sel).then((ok) => {
          if (ok) flashStatus('copied', 1200);
        });
      }
    };
    // Desktop keeps select-to-copy: the selection is made with a precise
    // pointer and letting go is a deliberate end to it. Touch does not — see
    // the selection bar, which lets an imprecise drag be redone before it
    // decides anything.
    let dragFrom: { x: number; y: number; modifier: boolean } | null = null;
    this.el.addEventListener('mousedown', (e) => {
      this.lastInputWasTouch = false;
      dragFrom = e.button === 0 ? { x: e.clientX, y: e.clientY, modifier: e.shiftKey || e.altKey } : null;
    });
    this.el.addEventListener('mouseup', (e) => {
      copySelection();
      // A plain drag went to tmux (or the program), which copies into its own
      // buffer the browser cannot see. Say how to make it copyable, a few times.
      const from = dragFrom;
      dragFrom = null;
      if (from && shouldHintDrag({
        dx: e.clientX - from.x, dy: e.clientY - from.y, modifier: from.modifier,
        selected: this.term.hasSelection(), mouseTracking: this.term.modes.mouseTrackingMode !== 'none',
      }) && takeHintTurn(localStorage)) {
        flashStatus(`按住 ${forceSelectKey(isMac)} 再拖动即可选中复制`, 3500);
      }
    });
    // What tmux copies (a plain drag, copy-mode) arrives as OSC 52; put it on
    // the clipboard here too, so a drag without the modifier still copies.
    this.term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52(data);
      if (text) void copyText(text).then((ok) => { if (ok) flashStatus('copied', 1200); });
      return true;
    });

    // With two terminals on screen, something has to say which one the key bar,
    // a paste and an uploaded file are meant for. Touching one is that
    // something — the same gesture that focuses it for typing.
    this.el.addEventListener('pointerdown', () => focusPane(this), { capture: true });
    this.term.textarea?.addEventListener('focus', () => focusPane(this));

    this.wireInput();
    this.term.onCursorMove(() => {
      if (isActive(this)) updateKeyboardOffset();
    });
    this.wireTouchScroll();
    this.wireMouseWheel();
    this.wireHandles();
  }

  /**
   * A cell's size and where the grid starts, in CSS pixels. The pane is padded,
   * so its border box is a few pixels wider than the terminal inside it — worth
   * allowing for when the cells themselves are only about eight across.
   */
  private cellSize(): { w: number; h: number; left: number; top: number } {
    const rect = this.el.getBoundingClientRect();
    const style = getComputedStyle(this.el);
    const padX = parseFloat(style.paddingLeft) || 0;
    const padY = parseFloat(style.paddingTop) || 0;
    return {
      w: Math.max(1, rect.width - padX * 2) / Math.max(1, this.term.cols),
      h: Math.max(1, rect.height - padY * 2) / Math.max(1, this.term.rows),
      left: rect.left + padX,
      top: rect.top + padY,
    };
  }

  /** Cursor bottom in the terminal area's unpanned coordinate space. */
  cursorBottom(contextRows = 0): number {
    const buffer = this.term.buffer.active;
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    return this.el.offsetTop + 4 + (row + 1 + contextRows) * this.cellSize().h;
  }

  /**
   * The two drag handles that sit at the ends of a touch selection, the way
   * every native text selection has them. Only ever shown on touch: a pointer
   * can put the selection where it wants first time.
   */
  private wireHandles(): void {
    const make = (which: 'a' | 'b'): HTMLElement => {
      const h = document.createElement('div');
      h.className = `sel-handle sel-${which}`;
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        h.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent): void => {
          const cell = this.cellSize();
          const col = Math.max(0, Math.min(this.term.cols - 1, Math.floor((ev.clientX - cell.left) / cell.w)));
          const row = Math.max(0, Math.min(this.term.rows - 1, Math.floor((ev.clientY - cell.top) / cell.h)));
          const at: [number, number] = [col, this.term.buffer.active.viewportY + row];
          if (which === 'a') this.selA = at;
          else this.selB = at;
          this.applySelectionRange();
        };
        const up = (): void => {
          h.removeEventListener('pointermove', move);
          h.removeEventListener('pointerup', up);
          h.removeEventListener('pointercancel', up);
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
        h.addEventListener('pointercancel', up);
      });
      this.el.append(h);
      return h;
    };
    this.handleA = make('a');
    this.handleB = make('b');
  }

  /** Set the selection to the range between two cells and show its handles. */
  setSelectionRange(a: [number, number], b: [number, number]): void {
    this.selA = a;
    this.selB = b;
    this.applySelectionRange();
    if (SEL_DEBUG) {
      this.debugSend(
        'sel-range',
        `a=${a[0]},${a[1]} b=${b[0]},${b[1]} ` +
          `len=${this.term.getSelection().length} has=${this.term.hasSelection() ? 1 : 0}`,
      );
    }
  }

  /** Re-apply the stored range, ordered, and move the handles onto its ends. */
  private applySelectionRange(): void {
    if (!this.selA || !this.selB) return;
    let [sCol, sRow] = this.selA;
    let [eCol, eRow] = this.selB;
    if (eRow < sRow || (eRow === sRow && eCol < sCol)) {
      [sCol, sRow, eCol, eRow] = [eCol, eRow, sCol, sRow];
    }
    // One terminal, one selection that flows through it. The second session of
    // a split is a terminal of its own with a selection of its own, so nothing
    // here has to be kept on one side of a line drawn in the text.
    const length = (eRow - sRow) * this.term.cols + (eCol - sCol) + 1;
    try {
      this.term.select(sCol, sRow, length);
    } catch {
      /* out of range after a redraw — leave the selection as it was */
    }
    this.positionHandles(sCol, sRow, eCol, eRow);
    // Whatever made or changed this selection — a drag, a handle, a long press,
    // 全选 — if it was a finger then its actions belong on screen. Leaving that
    // to each caller is how a path ends up with a selection and no way to copy
    // it, which is exactly what happened.
    if (this.lastInputWasTouch && this.term.hasSelection()) showSelectionBar();
  }

  private positionHandles(sCol: number, sRow: number, eCol: number, eRow: number): void {
    if (!this.handleA || !this.handleB) return;
    // Only for a selection made by touch: a pointer puts one where it wants
    // first time, and two blue circles on a desktop terminal are in the way.
    // Judged by how this selection was made rather than by what the device
    // claims to be — a machine with both gets each kind right that way.
    if (!this.lastInputWasTouch) {
      if (SEL_DEBUG) this.debugSend('sel-handles', 'skipped: last input was not touch');
      return;
    }
    if (SEL_DEBUG) this.debugSend('sel-handles', `at ${sCol},${sRow}-${eCol},${eRow}`);
    const cell = this.cellSize();
    const viewTop = this.term.buffer.active.viewportY;
    const place = (h: HTMLElement, col: number, row: number, below: boolean): void => {
      h.style.left = `${col * cell.w}px`;
      h.style.top = `${(row - viewTop + (below ? 1 : 0)) * cell.h}px`;
      h.classList.add('visible');
    };
    place(this.handleA, sCol, sRow, false);
    place(this.handleB, eCol + 1, eRow, true);
  }

  /** Drop the selection and its handles. */
  clearSelectionRange(): void {
    this.selA = null;
    this.selB = null;
    this.handleA?.classList.remove('visible');
    this.handleB?.classList.remove('visible');
    this.term.clearSelection();
  }

  /** The run of word-ish characters around a cell, as a range. */
  wordRangeAt(col: number, row: number): [[number, number], [number, number]] | null {
    const line = this.term.buffer.active.getLine(row);
    if (!line) return null;
    const text = line.translateToString(false);
    const isWord = (ch: string): boolean => !!ch && !/\s/.test(ch);
    if (!isWord(text[col] ?? '')) return null;
    let a = col;
    let b = col;
    while (a > 0 && isWord(text[a - 1] ?? '')) a -= 1;
    while (b < text.length - 1 && isWord(text[b + 1] ?? '')) b += 1;
    return [
      [a, row],
      [b, row],
    ];
  }

  /**
   * Attach this terminal: open its socket, which spawns its pty and its tmux
   * client. Called the first time it is shown (see setShown), never before — a
   * tab you have not looked at, and a split you have not asked for, cost
   * nothing. Idempotent; a reconnect in flight counts as started.
   */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // Open at the size this pane is really going to be, so the pty spawns at it
    // and tmux never has to resize the window afterwards. One on screen has
    // just measured itself — setShown fits before it starts — and one that is
    // not takes the last full-pane measurement.
    if (this.el.classList.contains('hidden') && paneCols && paneRows) {
      this.applyDims(paneCols, paneRows);
    }
    updateTabDot(this);
    this.connect();
  }

  private debug(event: string, data?: string): void {
    if (!IME_DEBUG) return;
    this.debugSend(event, data);
  }

  /** Ungated debug sender — callers gate on their own flag (IME_DEBUG / VV_DEBUG). */
  debugSend(event: string, data?: string): void {
    // eslint-disable-next-line no-console
    console.log('[ime]', this.name, event, JSON.stringify(data ?? ''));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'debug',
          event,
          data: String(data ?? ''),
          at: Math.round(performance.now()),
        }),
      );
    }
  }

  private wireInput(): void {
    const ta = this.term.textarea;
    if (ta) {
      for (const event of ['keydown', 'input', 'compositionstart']) {
        ta.addEventListener(event, () => this.stopTouchScroll());
      }
    }
    if (IME_DEBUG && ta) {
      for (const ev of ['compositionstart', 'compositionupdate', 'compositionend']) {
        ta.addEventListener(ev, (e) => this.debug(ev, (e as CompositionEvent).data));
      }
      ta.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.isComposing || ke.keyCode === 229 || ke.keyCode === 20) {
          this.debug('keydown', `${ke.key}/${ke.keyCode}`);
        }
      });
    }

    // iOS CJK keyboards send punctuation, numbers and space as a keydown with
    // keyCode 229 and the character in .key, but with NO composition and NO
    // input event — so xterm.js drops them (in Chinese mode those keys did
    // nothing). A real composition key (Bopomofo / pinyin letter) is also
    // keyCode 229 but is followed by compositionstart within a few ms. So on
    // such a keydown we schedule the character, cancel it if a composition
    // starts, and otherwise forward it. English keys (real keyCode) and
    // committed CJK (compositionend → onData) are untouched, so nothing doubles.
    if (ta && !ANDROID_DEVICE) {
      // Keep xterm's hidden textarea empty after a paste. xterm reads the text
      // off the event's clipboardData and sends it, but never preventDefaults,
      // so the browser then inserts the same text into that textarea — where it
      // stays until the next Enter / ^C / blur. That matters because xterm
      // tracks IME input as offsets into this textarea: compositionstart takes
      // start = value.length, and the commit sends value.substring(start) — to
      // the END of the value. Compose on top of a stale paste and those offsets
      // are wrong, so part of the old block is committed again: type after
      // pasting and the pasted text reappears. xterm doesn't need the
      // insertion, so cancel it (only when clipboardData actually carried the
      // paste, i.e. xterm has already handled it). Scoped to the terminal's own
      // textarea — the mobile paste box needs its default insertion.
      ta.addEventListener('paste', (e) => {
        if (e.clipboardData) e.preventDefault();
      });

      // Keep it empty after a composition commits, too — this is what actually
      // stops Bopomofo snowballing.
      //
      // The browser inserts the committed text into the textarea AFTER the
      // compositionend dispatch, so clearing from inside that handler is undone
      // a moment later. Windows Bopomofo then pulls the text sitting there
      // straight back into its next composition (the log shows compositionstart
      // immediately followed by a compositionupdate already carrying everything
      // typed before), commits the lot again, and round it goes — each commit
      // longer than the last. compositionend is not cancelable, so the
      // insertion cannot be prevented; the input event that follows it is the
      // first moment the text is really there with no composition active, which
      // makes it the place to clear. Guarded on isComposing so the in-progress
      // composition is never touched.
      ta.addEventListener('input', (e) => {
        if (!(e as InputEvent).isComposing && ta.value !== '') ta.value = '';
      });

      const pendingKeys = new Map<number, string>();
      let lastSeq = -1;
      let seq = 0;
      // Any composition activity means the most-recent IME keydown was actually
      // composition input (Bopomofo / pinyin), so cancel its pending forward.
      // The truly-dropped keys (punctuation / number / space) produce no
      // composition event at all, so their forward survives and fires.
      const cancelLast = (): void => {
        if (lastSeq >= 0) {
          pendingKeys.delete(lastSeq);
          lastSeq = -1;
        }
      };
      ta.addEventListener('compositionstart', () => {
        this.composing = true;
        cancelLast();
        // Never let a composition begin on top of leftover text: that is what
        // the IME reconverts into its own buffer.
        if (ta.value !== '') ta.value = '';
      });
      ta.addEventListener('compositionupdate', (e) => {
        cancelLast();
        if (e.data) {
          this.composingText = e.data;
          this.composingAt = performance.now();
        }
      });
      ta.addEventListener('compositionend', (e) => {
        this.composing = false;
        cancelLast();
        // Commit the composed text ourselves, then empty the textarea.
        //
        // xterm clears this textarea only on Enter / ^C / blur, so while you
        // keep typing it accumulates everything composed so far — and xterm
        // sends a composition by slicing that buffer:
        //   value.substring(_compositionPosition.start + _dataAlreadySent.length)
        // which runs to the END of the value. _compositionPosition.start is
        // refreshed only on compositionstart, and a Windows IME fires that once
        // for a whole run of characters, so start freezes while the buffer
        // grows: every keystroke re-sends a sliding window of everything typed
        // since — type without pressing Enter and the same block floods in over
        // and over. compositionend.data is exactly the committed text, so send
        // that and blank the buffer; xterm's own deferred slice then reads an
        // empty value and sends nothing. Nothing here depends on the IME
        // firing compositionstart per character.
        const text = e.data;
        if (text) {
          // Synchronously, BEFORE the IME opens its next composition: the log
          // shows compositionend and the next compositionstart landing in the
          // same millisecond, so a deferred clear is far too late.
          ta.value = '';
          // If xterm's slice still manages to emit the same text, the onData
          // dedup below drops it.
          this.lastData = text;
          this.lastDataAt = performance.now();
          this.debug('composition-commit', text);
          this.send(text);
        } else {
          // Cancelled composition (Escape): nothing to send, but still reset
          // the buffer — after xterm's deferred slice has run, not racing it.
          window.setTimeout(() => {
            if (!this.composing) ta.value = '';
          }, 0);
        }
        // A reconnect arrived mid-composition and deferred its re-fit/re-focus
        // (see connect's onopen) so it wouldn't cancel the composition; now that
        // we've committed, it's safe to catch up.
        if (this.reattachAfterCompose) {
          this.reattachAfterCompose = false;
          this.resync();
          if (isActive(this)) this.focus();
        }
      });
      // The direct-insert half of the IME path. The custom key handler stops
      // xterm seeing 229 keydowns at all, so xterm's own
      // _handleAnyTextareaChanges — which used to deliver these keys — no
      // longer runs, and its _inputEvent fallback bails out whenever a keydown
      // was seen. So this rescue is what carries a key the IME commits with no
      // composition (full-width punctuation, digits, space), and the
      // compositionend handler above carries everything that does compose.
      // Nothing sends twice: a composition cancels the pending forward through
      // cancelLast().
      ta.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.keyCode !== 229) return; // only IME-routed keys
        const k = ke.key;
        if (!k || k.length !== 1) return; // a single printable char (not Enter/Backspace/…)
        const s = ++seq;
        pendingKeys.set(s, k);
        lastSeq = s;
        window.setTimeout(() => {
          if (!pendingKeys.has(s)) return; // a composition consumed it
          pendingKeys.delete(s);
          this.debug('forward-key', k);
          this.send(k);
        }, 90);
      });
    }

    this.term.onData((data: string) => {
      this.debug('onData', data);
      // xterm emits just one mouse report per wheel event, regardless of
      // scrollSensitivity. Repeat only the report produced by a desktop wheel.
      if (this.mouseWheelMultiplier > 1 && /^\x1b\[<\d+;\d+;\d+M$/.test(data)) {
        this.send(data.repeat(this.mouseWheelMultiplier));
        return;
      }
      const now = performance.now();
      // Never let the pre-edit string through. Windows Bopomofo keeps ONE
      // composition open while you type — the log shows compositionupdate
      // growing by a character at a time and only flushing a chunk now and
      // then — so at compositionend the textarea still holds uncommitted text.
      // xterm's finalize assumes the opposite (that what is left is exactly
      // what was committed) and fires a few ms later on a setTimeout, sending
      // the remaining pre-edit text: right after our own commit the log shows
      //   composition-commit "喔喔喔喔喔喔ㄟ"
      //   onData             "ㄟㄟㄟㄟㄟㄟ一一一一一一喔喔…"
      // Whatever it sends is a tail of the textarea, hence a tail of the string
      // the IME is composing, which makes this exact rather than a guess. The
      // committed text reaches the pty from the compositionend handler, which
      // calls send() directly and so never passes through here.
      if (
        data &&
        !/[\x00-\x1f]/.test(data) && // never touch control bytes or escapes
        this.composingText.endsWith(data) &&
        now - this.composingAt < 500
      ) {
        this.debug('onData-DROP-preedit', data);
        return;
      }
      // Only dedupe multibyte (IME) content; ASCII/control input is never touched.
      if (
        /[^\x00-\x7F]/.test(data) &&
        data === this.lastData &&
        now - this.lastDataAt < IME_DEDUP_MS
      ) {
        this.lastData = ''; // suppress exactly one duplicate
        this.debug('onData-DROP', data);
        return;
      }
      this.lastData = data;
      this.lastDataAt = now;
      this.send(data);
    });
  }

  private send(data: string): void {
    this.stopTouchScroll();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (this.readState.input(data)) this.outputTracker?.input();
      this.ws.send(encoder.encode(data));
    }
  }

  /**
   * Send a discrete injection (key-bar sequence, paste, uploaded file path).
   * Unlike raw keystrokes, these are buffered and replayed on reconnect when the
   * socket is down — a big upload can saturate the uplink, trip the 20s
   * heartbeat, and land the path insert mid-reconnect, which would otherwise be
   * silently dropped by send() and leave the path un-pasted.
   */
  sendSeq(seq: string): void {
    this.stopTouchScroll();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(seq);
      return;
    }
    const buffered = this.pendingSeq.reduce((n, s) => n + s.length, 0);
    if (buffered + seq.length <= MAX_PENDING_SEQ) this.pendingSeq.push(seq);
  }

  /**
   * Send clipboard text as a *paste* rather than as typing.
   *
   * A native paste (⌘V, and now Ctrl+V) goes through xterm, which turns
   * newlines into CR and wraps the text in bracketed-paste markers whenever the
   * running program asked for them. Text pushed straight down the socket has
   * neither, so a full-screen TUI (Claude Code, vim, tmux copy-mode) sees a
   * burst of keystrokes instead of one paste: it re-renders per character and
   * takes every LF as Enter, which reprints the line being edited — on screen
   * the block looks pasted twice. So every programmatic paste (the Paste
   * button, the mobile paste box, Ctrl+Shift+V) has to bracket it the same way.
   */
  pasteText(text: string): void {
    if (!text) return;
    const t = text.replace(/\r?\n/g, '\r');
    this.sendSeq(this.term.modes.bracketedPasteMode ? `\x1b[200~${t}\x1b[201~` : t);
  }

  private mouseWheelMultiplier = 1;

  private wireMouseWheel(): void {
    // Touch-capable Windows laptops can also have a mouse. Handle actual wheel
    // events on every device; finger scrolling never goes through this hook.
    this.term.attachCustomWheelEventHandler((event) => {
      this.mouseWheelMultiplier = this.term.modes.mouseTrackingMode === 'none' ? 1
        : mouseWheelReports(event.deltaY, event.deltaMode, this.term.rows);
      // Mouse reports are emitted synchronously inside xterm's wheel handler.
      // Reset before the next input so clicks, keys and paste are never sped up.
      queueMicrotask(() => { this.mouseWheelMultiplier = 1; });
      return true;
    });
  }

  // One-finger touch scrolling. tmux runs in the alternate screen (no
  // xterm-local scrollback) with `mouse on`, so history is browsed via
  // copy-mode, which is normally driven by the mouse wheel. A phone has no
  // wheel, so we translate a one-finger vertical drag into SGR mouse-wheel
  // events sent to tmux — dragging down scrolls back through history, dragging
  // up returns toward the live prompt, just like a real wheel.
  private wireTouchScroll(): void {
    const motion = new TouchScrollMotion();
    let animation: number | null = null;
    let lastFlush = 0;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let col = 1;
    let row = 1;
    let tracking = false;
    let scrolling = false;
    this.stopTouchScroll = () => {
      motion.cancel();
      if (animation !== null) cancelAnimationFrame(animation);
      animation = null;
    };
    const animate = (now: number): void => {
      animation = null;
      if (!isActive(this) || this.disposed || document.hidden ||
          !this.ws || this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 8192) {
        this.stopTouchScroll();
        return;
      }
      if (now - lastFlush >= 32) {
        lastFlush = now;
        const ticks = motion.frame(now);
        if (ticks) this.sendWheel(ticks, col, row);
      }
      if (motion.active) animation = requestAnimationFrame(animate);
    };
    const schedule = (): void => {
      if (animation === null) animation = requestAnimationFrame(animate);
    };

    // Touch-select state (only used while touchSelectMode is on). Anchor is the
    // 0-based cell where the drag started, in absolute buffer coords (so it
    // stays correct even when the view is scrolled into the scrollback).
    let selecting = false;
    let selMoved = false;
    // Long-press picks the word under your finger, so pulling one string out of
    // the screen does not mean arming a mode and then dragging over it exactly.
    let pressTimer: number | null = null;
    let pressFired = false;
    const cancelPress = (): void => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    let anchorCol = 0;
    let anchorRow = 0;
    let cellW = 1;
    let cellH = 1;
    let rectLeft = 0;
    let rectTop = 0;

    // Map a touch point to a 0-based [col, absoluteRow] cell.
    const cellAt = (clientX: number, clientY: number): [number, number] => {
      const c = Math.max(0, Math.min(this.term.cols - 1, Math.floor((clientX - rectLeft) / cellW)));
      const r = Math.max(0, Math.min(this.term.rows - 1, Math.floor((clientY - rectTop) / cellH)));
      return [c, this.term.buffer.active.viewportY + r];
    };

    this.el.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        this.stopTouchScroll();
        motion.start(performance.now());
        // A touch that lands on a selection handle is that handle's to deal
        // with; the terminal must not also start scrolling or a long-press.
        if ((e.target as HTMLElement | null)?.classList?.contains('sel-handle')) {
          tracking = false;
          selecting = false;
          cancelPress();
          return;
        }
        if (e.touches.length !== 1) {
          tracking = false;
          selecting = false;
          cancelPress();
          return;
        }
        cancelPress();
        this.lastInputWasTouch = true;
        const t = e.touches[0];
        startX = t.clientX;
        startY = lastY = t.clientY;
        const cell = this.cellSize();
        cellW = cell.w;
        cellH = cell.h;
        rectLeft = cell.left;
        rectTop = cell.top;
        if (touchSelectMode) {
          // Begin a selection drag; suspend scrolling for this gesture.
          tracking = false;
          selecting = true;
          selMoved = false;
          [anchorCol, anchorRow] = cellAt(t.clientX, t.clientY);
          this.clearSelectionRange();
          hideSelectionBar();
          return;
        }
        const pressAt = cellAt(t.clientX, t.clientY);
        if (SEL_DEBUG) {
          this.debugSend(
            'sel-touchstart',
            `cell=${pressAt[0]},${pressAt[1]} mode=${touchSelectMode ? 1 : 0} ` +
              `coarse=${window.matchMedia('(pointer: coarse)').matches ? 1 : 0} ` +
              `touchDevice=${TOUCH_DEVICE ? 1 : 0} maxTouch=${navigator.maxTouchPoints} ` +
              `cols=${this.term.cols} rows=${this.term.rows} target=${(e.target as HTMLElement).className}`,
          );
        }
        pressTimer = window.setTimeout(() => {
          pressTimer = null;
          const range = this.wordRangeAt(pressAt[0], pressAt[1]);
          if (SEL_DEBUG) {
            const line = this.term.buffer.active.getLine(pressAt[1]);
            this.debugSend(
              'sel-press',
              `fired at ${pressAt[0]},${pressAt[1]} range=${range ? JSON.stringify(range) : 'null'} ` +
                `line=${JSON.stringify((line?.translateToString(true) ?? '').slice(0, 60))}`,
            );
          }
          if (!range) return;
          tracking = false;
          pressFired = true;
          this.setSelectionRange(range[0], range[1]);
          showSelectionBar();
        }, 500);
        tracking = true;
        scrolling = false;
        // Cell under the finger, so tmux targets the right pane if it's split.
        col = Math.max(1, Math.min(this.term.cols, Math.floor((t.clientX - rectLeft) / cellW) + 1));
        row = Math.max(1, Math.min(this.term.rows, Math.floor((t.clientY - rectTop) / cellH) + 1));
      },
      { capture: true, passive: true },
    );

    this.el.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (selecting) {
          e.preventDefault();
          e.stopPropagation();
          if (!selMoved && Math.abs(t.clientX - startX) < 6 && Math.abs(t.clientY - startY) < 6) {
            return; // ignore jitter until it's clearly a drag
          }
          selMoved = true;
          if (SEL_DEBUG) this.debugSend('sel-drag', `to ${cellAt(t.clientX, t.clientY).join(',')}`);
          // Ordering, clipping to one window of a split tab, and placing the
          // handles all live in setSelectionRange — the drag just says where
          // the two ends are, exactly as dragging a handle afterwards does.
          this.setSelectionRange([anchorCol, anchorRow], cellAt(t.clientX, t.clientY));
          return;
        }
        if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) cancelPress();
        if (!tracking) return;
        if (!scrolling) {
          const dyTotal = t.clientY - startY;
          const dxTotal = t.clientX - startX;
          // Only hijack once the gesture is clearly a vertical drag, so taps
          // (focus / move cursor) and horizontal gestures still reach xterm.
          if (Math.abs(dyTotal) < 10 || Math.abs(dyTotal) <= Math.abs(dxTotal)) return;
          scrolling = true;
        }
        e.preventDefault();
        e.stopPropagation();
        motion.move(t.clientY - lastY, performance.now());
        lastY = t.clientY;
        schedule();
      },
      { capture: true, passive: false },
    );

    // Copy a finished touch selection. The bubble-phase `copySelection` handler
    // (wired in the constructor) copies term.getSelection() on touchend, so a
    // moved selection lands on the clipboard automatically; a tap with no drag
    // left the selection cleared, so nothing is copied. Select mode stays armed
    // until toggled off again.
    const end = (e: TouchEvent): void => {
      // A drag that actually selected something leaves the selection up along
      // with its actions, so it can be redone before anything is copied.
      if (selecting && selMoved && this.term.hasSelection()) showSelectionBar();
      cancelPress();
      if (scrolling && e.type === 'touchend') {
        motion.release(performance.now());
        schedule();
      } else {
        this.stopTouchScroll();
      }
      tracking = false;
      scrolling = false;
      selecting = false;
    };
    // A long-press has already done its job by the time the finger lifts; the
    // tap the browser would synthesise from it would go on to tmux as a click.
    this.el.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        if (!pressFired) return;
        pressFired = false;
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true, passive: false },
    );
    this.el.addEventListener('touchend', end, { capture: true, passive: true });
    this.el.addEventListener('touchcancel', end, { capture: true, passive: true });
  }

  // Emit |ticks| SGR mouse-wheel events (Cb 64 = up, 65 = down; press-only).
  private sendWheel(ticks: number, col: number, row: number): void {
    const seq = `\x1b[<${ticks > 0 ? 64 : 65};${col};${row}M`;
    // One binary frame per animation step, not one frame per wheel tick.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encoder.encode(seq.repeat(Math.abs(ticks))));
    }
  }

  stopTouchScroll: () => void = () => {};

  async scrollHistory(action: 'up' | 'down' | 'bottom'): Promise<void> {
    this.stopTouchScroll();
    try {
      const response = await fetch('/api/sessions/scroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.name, action }),
      });
      if (!response.ok) throw new Error('scroll failed');
    } catch {
      flashStatus('翻页失败，请检查连接', 1500);
    }
  }

  private sendResize(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }),
      );
    }
  }

  // Measure the pane and publish the result to every session (setPaneDims).
  // Only the pane on screen can be measured — a hidden one is display:none and
  // has no box — but they are all the same size, so the others take the number
  // from here instead of being left at whatever they started with.
  fit(): void {
    if (this.el.classList.contains('hidden')) return;
    let dims;
    try {
      dims = this.fitAddon.proposeDimensions();
    } catch {
      return; // not laid out yet
    }
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    // A degenerate box (see MIN_COLS) means the layout is mid-flight, not that
    // the terminal is really two columns wide. Keep the last good size.
    if (dims.cols < MIN_COLS || dims.rows < MIN_ROWS) return;
    try {
      this.fitAddon.fit(); // resizes to exactly those dims, clearing the renderer first
    } catch {
      return;
    }
    this.sendResize();
    // Only a full-width pane speaks for the tabs that cannot measure themselves.
    // Half of a split is not the size they will open at.
    if (!this.half) setPaneDims(this.term.cols, this.term.rows);
  }

  /** Adopt the measured pane size and pass it on to the server. */
  applyDims(cols: number, rows: number): void {
    if (this.term.cols === cols && this.term.rows === rows) return;
    try {
      this.term.resize(cols, rows);
    } catch {
      return;
    }
    this.sendResize();
  }

  // The selection as two cells in buffer coordinates, kept so either end can be
  // moved afterwards. A drag on a phone lands where it lands — the finger is
  // over the text it is choosing — so being able to nudge an edge afterwards is
  // most of what makes selecting on a touchscreen bearable.
  // Set by whichever kind of event last landed on this pane. Handles belong to
  // a selection made with a finger, and nothing about the device says that.
  private lastInputWasTouch = false;
  private selA: [number, number] | null = null;
  private selB: [number, number] | null = null;
  private handleA: HTMLElement | null = null;
  private handleB: HTMLElement | null = null;

  /**
   * Select everything on screen. This is the copy most often wanted on a phone,
   * where dragging out an exact range is the hard part — and with the split
   * being two terminals, "on screen" needs no qualification any more.
   */
  selectVisible(): boolean {
    const top = this.term.buffer.active.viewportY;
    const bottom = top + this.term.rows - 1;
    this.setSelectionRange([0, top], [this.term.cols - 1, bottom]);
    return this.term.hasSelection();
  }

  /**
   * The second session beside this one, built on first use.
   *
   * Nothing is asked of tmux to make it: the socket attaches with
   * `new-session -A`, which creates the session if it is not there and picks up
   * whatever was left in it if it is. So the pair survives a reload, a reboot
   * and a restore, and a tab that is never split never costs a second anything.
   */
  ensureMate(): Session | null {
    if (this.isMate) return null;
    if (!this.mate) {
      this.mate = new Session(mateNameOf(this.name), undefined, true);
      this.mate.intendCreate(); // made by pressing 2 or ⊞, or a split this device kept
    }
    return this.mate;
  }

  /** This session is being made on purpose: its first attach may create it. */
  intendCreate(baseSession?: string, directory?: string): void {
    this.createUntil = performance.now() + 60_000;
    this.createFrom = baseSession ?? null;
    this.createDirectory = directory ?? null;
  }

  /** Show one of this tab's terminals, or both. */
  setView(mode: LayoutMode): void {
    if (this.isMate) return;
    this.view = mode;
    if (mode !== 'one') this.ensureMate();
    layOutTab(this);
    saveTabs();
    refreshLayoutUI();
  }

  /** Re-state our size on a freshly opened socket, and re-measure if shown. */
  private resync(): void {
    if (this.el.classList.contains('hidden')) this.sendResize();
    else this.fit(); // re-measures and sends as a side effect
  }

  setFont(px: number): void {
    this.term.options.fontSize = px;
  }

  /**
   * Show or hide this one terminal. Where it goes on screen is the tab's
   * business — see layOutTab — because with a split that depends on what the
   * other one is doing.
   */
  setShown(shown: boolean): void {
    const entering = this.el.classList.contains('hidden') && shown;
    this.el.classList.toggle('hidden', !shown);
    if (!shown) {
      this.stopTouchScroll();
      this.clearSelectionRange(); // a selection belongs to what is on screen
      return;
    }
    if (!fileBrowserOpen && document.visibilityState === 'visible' && isActive(this)) {
      this.readState.enter();
      if (entering) this.outputTracker?.enter(performance.now());
      updateOutputActivity();
    }
    requestAnimationFrame(() => {
      if (this.disposed || this.el.classList.contains('hidden')) return;
      this.fit();
      // Attach now, not at page load: this is the first frame where this pane
      // is laid out, so fit() has the real size to hand the server.
      this.start();
    });
  }

  focus(): void {
    if (fileBrowserOpen || document.querySelector('.session-note-editor')) return;
    if (this.keyboardLock) this.keyboardLock.focus();
    else this.term.focus();
  }

  setKeyboardLocked(locked: boolean): void {
    this.keyboardLock?.setLocked(locked);
  }

  openKeyboard(): void {
    this.stopTouchScroll();
    if (this.keyboardLock) this.keyboardLock.open();
    else this.term.focus();
  }

  restart(): void {
    this.term.reset();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'restart' }));
    }
  }

  // Ask the server to kill this tmux session for good (used on tab close).
  // Over HTTP, not this tab's socket: a tab that was never opened has none.
  kill(): void {
    void fetch('/api/sessions/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.name }),
    }).catch(() => {
      /* ignore — the tab is already gone locally */
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  }
  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setConnected(state: boolean): void {
    this.connected = state;
    if (!state) this.clearOutputActivity();
    updateTabDot(this);
    if (isActive(this)) reflectActiveStatus();
  }

  private markOutputActivity(): void {
    // An output change is activity only after command submission. Keep unread
    // behind the spinner; when this timer expires the same icon becomes bright.
    if (this.disposed) return;
    if (!this.readState.output()) return;
    if (this.outputActivityTimer !== null) clearTimeout(this.outputActivityTimer);
    if (!this.outputActive) {
      this.outputActive = true;
    }
    updateOutputActivity();
    this.outputActivityTimer = setTimeout(() => this.clearOutputActivity(), 60_000);
  }

  private clearOutputActivity(): void {
    // Stop only the visual activity timer. Keep the submitted-command flag:
    // long tasks can resume output minutes later and must restart immediately.
    if (this.outputActivityTimer !== null) clearTimeout(this.outputActivityTimer);
    this.outputActivityTimer = null;
    if (this.outputActive) {
      this.outputActive = false;
      updateOutputActivity();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer !== null) return;
    if (isActive(this)) showStatus('reconnecting…');
    const base = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_DELAY);
    // Jitter ±50%: when several sessions drop together (e.g. a server restart)
    // this staggers their reconnects instead of firing them all as one burst.
    const delay = Math.round(base * (0.5 + Math.random()));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private connect(): void {
    if (this.disposed) return;
    // Hand the server our size up front so it spawns the pty with it and the
    // tmux client attaches at the size it is going to keep. Attaching at tmux's
    // 80x24 default first — what every connect and reconnect used to do —
    // resizes the window for every other client on that session, and a program
    // on the alternate screen loses everything that no longer fits.
    const url =
      `${wsProto}://${window.location.host}/ws?session=${encodeURIComponent(this.name)}` +
      `&cols=${this.term.cols}&rows=${this.term.rows}` +
      (performance.now() < this.createUntil ? '&create=1' +
        (this.createFrom ? `&from=${encodeURIComponent(this.createFrom)}` : '') +
        (this.createDirectory !== null ? `&dir=${encodeURIComponent(this.createDirectory)}` : '') : '');
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.ws = socket;
    let outputTracker: OutputActivityTracker | null = null;

    socket.onopen = () => {
      outputTracker = new OutputActivityTracker(performance.now());
      this.outputTracker = outputTracker;
      this.clearOutputActivity();
      this.reconnectDelay = MIN_DELAY;
      this.createUntil = 0; // it exists now; a later reconnect is only a reconnect
      this.createFrom = null;
      this.createDirectory = null;
      if (IME_DEBUG) {
        this.debugSend(
          'env',
          `mac=${isMac} coarse=${window.matchMedia('(pointer: coarse)').matches} ` +
            `touch=${TOUCH_DEVICE} maxTouch=${navigator.maxTouchPoints} ` +
            `imeOwned=1 ua=${navigator.userAgent.slice(0, 80)}`,
        );
      }
      this.setConnected(true);
      this.startPing();
      // Flush injections buffered while the socket was down (e.g. an uploaded
      // file path whose insert raced a big-upload reconnect). The socket is
      // OPEN here, so send() delivers them.
      if (this.pendingSeq.length) {
        const buffered = this.pendingSeq;
        this.pendingSeq = [];
        for (const s of buffered) this.send(s);
      }
      // Re-assert a custom label: the server stores it on the tmux session
      // (@twlabel), which is wiped when the session is killed+recreated by a
      // restart, so a renamed tab would otherwise revert to its raw name.
      if (this.displayName !== this.name) renameOnServer(this.name, this.displayName);
      // Re-fit + re-focus so typing resumes smoothly after a reconnect — UNLESS
      // an IME composition is in flight: on iOS these cancel the soft keyboard's
      // active composition, dropping the 注音 candidate bar and turning input
      // raw/direct. Mobile reconnects are frequent, so this otherwise interrupts
      // composing mid-word. Defer to compositionend instead.
      if (this.composing) {
        this.reattachAfterCompose = true;
      } else {
        this.resync();
        if (isActive(this)) this.focus();
      }
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        this.term.write(new Uint8Array(ev.data), () => {
          if (this.disposed || this.ws !== socket || !outputTracker) return;
          const buffer = this.term.buffer.active;
          const lines: string[] = [];
          for (let i = buffer.baseY; i < buffer.baseY + this.term.rows; i++) {
            lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
          }
          if (outputTracker.observe(lines.join('\n'), performance.now())) this.markOutputActivity();
        });
        return;
      }
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as { type?: string };
          // The session was closed (killed) here or on another device: drop the
          // tab and do NOT reconnect — reconnecting would recreate the session
          // via `new-session -A`, resurrecting what was just closed.
          if (msg && msg.type === 'closed') {
            // A mate closing takes the split down, not the tab: the tab is the
            // first session and is still perfectly alive.
            if (this.isMate) {
              const tab = sessions.find((s) => s.mate === this);
              if (tab) {
                tab.setView('one');
                tab.mate = null; // pressing 2 or ⊞ again makes a new one
                if (activeSession === this) activeSession = tab;
              }
              this.dispose(); // or its socket's close would reconnect it
              return;
            }
            recentlyClosed.set(this.name, performance.now());
            removeLocalSession(this);
          }
        } catch {
          /* ignore */
        }
      }
    };

    socket.onclose = (event: CloseEvent) => {
      if (event.code === 4001) { void logoutBrowser(); return; }
      this.stopTouchScroll();
      this.stopPing();
      if (this.ws === socket) this.ws = null;
      this.setConnected(false);
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };
  }

  dispose(): void {
    this.clearOutputActivity();
    this.stopTouchScroll();
    this.keyboardLock?.dispose();
    this.disposed = true;
    this.mate?.dispose(); // the pair goes together, or the second one is orphaned
    this.mate = null;
    this.stopPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    try {
      this.term.dispose();
    } catch {
      /* ignore */
    }
    this.el.remove();
  }
}

// ---------------------------------------------------------------------------
// Tab / session manager
// ---------------------------------------------------------------------------
// The tabs — first sessions only. A mate is reached through its tab's `mate`,
// never listed here, so everything that walks this list (the strip, the drawer,
// the cross-device sync, the size broadcast) goes on seeing one thing per tab.
const sessions: Session[] = [];
// The tab that is open, and the one of its (up to two) terminals that typing,
// pasting, copying and an uploaded file are meant for. On an unsplit tab they
// are the same session; a tab is never open without a focused terminal.
let activeTab: Session | null = null;
let activeSession: Session | null = null;

/** Whether this terminal is one of the ones currently on screen. */
function isActive(s: Session): boolean {
  return s === activeTab || (activeTab?.mate === s && activeTab.view !== 'one');
}

/** Point typing and the key bar at one of the open tab's terminals. */
function focusPane(s: Session): void {
  if (!isActive(s) || activeSession === s) return;
  activeSession = s;
  markFocusedPane();
  reflectActiveStatus();
}

/** Say which half has the keys, but only while there are two to tell apart. */
function markFocusedPane(): void {
  const split = activeTab?.view === 'both';
  for (const s of [activeTab, activeTab?.mate]) {
    s?.el.classList.toggle('focused', split && s === activeSession);
  }
}

function reflectActiveStatus(): void {
  if (!activeSession || activeSession.connected) hideStatus();
  // A terminal being opened for the first time is attaching, not reconnecting;
  // its socket opens on the next frame (see setShown).
  else if (!activeSession.started) hideStatus();
  else showStatus('reconnecting…');
}

function updateTabDot(s: Session): void {
  if (s.isMate) return; // no tab of its own to report on
  s.tabDot?.classList.toggle('connected', s.connected);
  // A tab nobody has opened yet is not "disconnected" — there is nothing wrong
  // with it, it just hasn't attached. Hollow dot rather than a grey one.
  s.tabDot?.classList.toggle('idle', !s.started);
  refreshMobileUI();
}

function hasRecentOutput(s: Session): boolean {
  return s.outputActive || !!s.mate?.outputActive;
}

// ---------------------------------------------------------------------------
// Agent status from the server (src/agent-status.ts): working / waiting / done
// and unread for every session, whether or not this page has opened it, the
// same on every device. The mode, picked in the settings sheet, says where it
// comes from; in 'legacy' mode — or against a server too old to say — the dots
// fall back to this page's own output heuristic (output-activity.ts).
// ---------------------------------------------------------------------------
let agentMode: 'hooks' | 'screen' | 'legacy' | null = null;
let agentStatuses = new Map<string, AgentStatus>();

function serverStatusActive(): boolean {
  return agentMode === 'hooks' || agentMode === 'screen';
}

function connectAgentStatus(): void {
  const source = new EventSource('/api/agent-status/events');
  source.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string) as { mode?: unknown; sessions?: Record<string, AgentStatus> };
      agentMode = data.mode === 'hooks' || data.mode === 'screen' || data.mode === 'legacy' ? data.mode : null;
      agentStatuses = new Map(Object.entries(data.sessions ?? {}));
      refreshStatusModeUI();
      refreshMobileUI();
    } catch {
      /* a malformed frame changes nothing */
    }
  };
  // EventSource reconnects by itself. A server without the endpoint answers
  // 404, which ends the stream for good: the page stays on the legacy dots.
}

/**
 * The sessions on screen right now are read — but only while someone can see
 * them: the page visible and focused, no file browser over the top.
 */
function reportViewed(): void {
  // Touch devices are exempt from the focus test: framed in the iOS launcher,
  // the page often has no focus until it is tapped, though it is plainly seen.
  if (!serverStatusActive() || fileBrowserOpen || document.visibilityState !== 'visible' ||
      (!TOUCH_DEVICE && !document.hasFocus())) return;
  const viewed = [activeTab, activeTab?.mate].filter((s): s is Session =>
    !!s && isActive(s) && !s.el.classList.contains('hidden') && !!agentStatuses.get(s.name)?.unread);
  if (!viewed.length) return;
  for (const s of viewed) agentStatuses.set(s.name, { ...agentStatuses.get(s.name)!, unread: false });
  void fetch('/api/agent-status/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions: viewed.map(s => s.name) }),
  }).catch(() => { /* the next view retries */ });
}

/** A tab's statuses: its own and its split half's. */
function statusesOf(s: Session): (AgentStatus | undefined)[] {
  return [agentStatuses.get(s.name), s.mate ? agentStatuses.get(s.mate.name) : undefined];
}

/** Sessions asking for you (waiting, or finished unread), for the page title. */
function attentionCount(): number {
  if (!serverStatusActive()) return 0;
  return sessions.filter(s => wantsAttention(combineStatus(statusesOf(s)))).length;
}

function updateOutputActivity(): void {
  reportViewed(); // before painting, so what is on screen never shows as unread
  if (serverStatusActive()) {
    const paintServer = (dot: Element | null | undefined, ...group: (Session | null | undefined)[]): void => {
      const indicator = combineStatus(group.flatMap(s => s ? statusesOf(s) : []));
      if (!dot) return;
      for (const cls of ['working', 'waiting', 'unread', 'done'] as const) dot.classList.toggle(cls, indicator === cls);
      dot.setAttribute('title', INDICATOR_LABEL[indicator]);
      dot.setAttribute('aria-label', INDICATOR_LABEL[indicator]);
    };
    for (const s of sessions) {
      paintServer(s.tabDot, s);
      s.tabEl?.classList.toggle('tab-attention', wantsAttention(combineStatus(statusesOf(s))));
    }
    paintServer(mTitleDot, activeTab);
    for (const row of drawerList.querySelectorAll<HTMLElement>('.drawer-row')) {
      paintServer(row.querySelector('.tab-dot'), sessions.find(session => session.name === row.dataset.session));
    }
    for (const dot of sidebar.dots()) {
      const names = (dot.dataset.sessions ?? '').split(' ');
      paintServer(dot, ...sessions.filter(session => names.includes(session.name)));
    }
    return;
  }

  // Legacy: all three surfaces share the same state. A split tab aggregates both panes;
  // entering a visible pane reads it, while hidden panes may remain unread.
  // A sidebar directory card speaks for all of its sessions at once.
  for (const s of sessions) s.tabEl?.classList.remove('tab-attention');
  const paint = (dot: Element | null | undefined, ...group: (Session | null | undefined)[]): void => {
    const working = group.some(s => !!s && hasRecentOutput(s));
    const unread = group.some(s => !!s && (s.readState.unread || !!s.mate?.readState.unread));
    dot?.classList.toggle('working', working);
    dot?.classList.toggle('unread', unread);
    if (dot) {
      const label = working ? '近期有输出' : unread ? '未读' : '已读';
      dot.setAttribute('title', label);
      dot.setAttribute('aria-label', label);
    }
  };
  for (const s of sessions) {
    paint(s.tabDot, s);
  }
  paint(mTitleDot, activeTab);
  for (const row of drawerList.querySelectorAll<HTMLElement>('.drawer-row')) {
    const s = sessions.find(session => session.name === row.dataset.session);
    paint(row.querySelector('.tab-dot'), s);
  }
  for (const dot of sidebar.dots()) {
    const names = (dot.dataset.sessions ?? '').split(' ');
    paint(dot, ...sessions.filter(session => names.includes(session.name)));
  }
}

/**
 * Put a tab's terminals on screen: one of them, the other, or both — side by
 * side when there is room for two usable ones, stacked when there is not.
 *
 * The two are placed by hand rather than by a flex container because they are
 * absolutely positioned siblings of every other tab's pane, all of them filling
 * #terminal. The gap between them is the whole of the divider: there is no
 * character anywhere in either grid that has to be kept straight.
 */
function layOutTab(tab: Session): void {
  const mate = tab.view === 'one' ? tab.mate : tab.ensureMate();
  const both = tab.view === 'both' && !!mate;
  const vertical = both && termArea.clientWidth < WIDE_PX;

  tab.half = both;
  if (mate) mate.half = both;

  if (both && mate) {
    // A 2px gap, showing the background between them.
    tab.el.style.inset = vertical ? '0 0 calc(50% + 1px) 0' : '0 calc(50% + 1px) 0 0';
    mate.el.style.inset = vertical ? 'calc(50% + 1px) 0 0 0' : '0 0 0 calc(50% + 1px)';
  } else {
    tab.el.style.inset = '';
    if (mate) mate.el.style.inset = '';
  }
  tab.el.classList.toggle('split', both);
  mate?.el.classList.toggle('split', both);

  const showFirst = tab.view !== 'two';
  const showSecond = tab.view !== 'one' && !!mate;
  tab.setShown(showFirst);
  mate?.setShown(showSecond);

  // Keys follow what is on screen: the terminal that had them if it is still
  // up, else whichever one is. Being on the open tab is not enough — going from
  // both halves to the second one alone leaves the first one's grid hidden, and
  // typing into a hidden terminal is typing into nothing you can see.
  const onScreen = [showFirst ? tab : null, showSecond ? mate : null].filter(
    (s): s is Session => !!s,
  );
  if (!activeSession || !onScreen.includes(activeSession)) {
    activeSession = onScreen[0] ?? tab;
  }
  markFocusedPane();
  reflectActiveStatus();
}

// How far a finger may move between landing and lifting and still count as a
// tap. Past it, it was a swipe — scrolling a list — and picks nothing.
const TAP_SLOP_PX = 10;

/**
 * Run `fn` on a tap, and never on a swipe that starts on `el`.
 *
 * Acting on pointerdown (what the session drawer used to do) picks whatever the
 * finger lands on, and its preventDefault stops the list from scrolling at all:
 * trying to scroll to a session selected the first one you touched. Waiting for
 * pointerup is not enough by itself either — a browser does not always turn a
 * short drag into a scroll (and fire pointercancel) before the finger lifts. So
 * a tap is a lift close to where it landed, with `scroller`, if given, not
 * having moved in between.
 */
function onTap(el: HTMLElement, fn: (e: PointerEvent) => void, scroller?: HTMLElement): void {
  let start: { id: number; x: number; y: number; left: number; top: number } | null = null;
  el.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) { start = null; return; }
    start = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: scroller?.scrollLeft ?? 0,
      top: scroller?.scrollTop ?? 0,
    };
  });
  el.addEventListener('pointercancel', () => {
    start = null;
  });
  el.addEventListener('pointerup', (e) => {
    const s0 = start;
    start = null;
    if (!s0 || s0.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - s0.x, e.clientY - s0.y) > TAP_SLOP_PX) return;
    if (scroller && (scroller.scrollLeft !== s0.left || scroller.scrollTop !== s0.top)) return;
    tapped = true;
    fn(e);
  });
  // A tap that closes the drawer uncovers the terminal, and the mouse events a
  // browser synthesizes after a touch would land on it — focusing it, which on
  // a phone raises the keyboard. touchend comes after pointerup and cancelling
  // it cancels those; it is too late to affect a scroll, which is over.
  let tapped = false;
  el.addEventListener(
    'touchend',
    (e) => {
      if (tapped && e.cancelable) e.preventDefault();
      tapped = false;
    },
    { passive: false },
  );
}

let draggedTab: Session | null = null;
let suppressTabTapUntil = 0;

function finishTabDrag(): void {
  for (const tab of sessions) tab.tabEl?.classList.remove('tab-dragging', 'tab-drop-before', 'tab-drop-after');
  draggedTab = null;
  suppressTabTapUntil = performance.now() + 250;
}

function applyTabOrder(ordered: Session[]): void {
  sessions.splice(0, sessions.length, ...ordered);
  for (const tab of sessions) if (tab.tabEl) tabsEl.insertBefore(tab.tabEl, addBtn);
  saveTabs();
  refreshMobileUI();
}

tabsEl.addEventListener('dragover', e => {
  if (!draggedTab) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
});
tabsEl.addEventListener('drop', e => {
  if (!draggedTab) return;
  e.preventDefault();
  const last = sessions[sessions.length - 1];
  if (last) applyTabOrder(moveTab(sessions, draggedTab, last, true));
  finishTabDrag();
});
addBtn.addEventListener('dragover', e => {
  if (!draggedTab) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
});
addBtn.addEventListener('drop', e => {
  if (!draggedTab) return;
  e.preventDefault();
  const last = sessions[sessions.length - 1];
  if (last) applyTabOrder(moveTab(sessions, draggedTab, last, true));
  finishTabDrag();
});

const pendingNoteSaves = new Map<string, Promise<void>>();

async function showSessionNote(s: Session, anchor?: HTMLElement, hover?: NoteHover): Promise<void> {
  if (document.querySelector('.session-note-editor')) return;
  const overlay = document.createElement('div');
  overlay.className = anchor ? 'session-note-popover session-note-editor' :
    'paste-overlay session-note-overlay session-note-editor';
  const box = document.createElement('div');
  box.className = 'paste-box session-note-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', anchor ? 'false' : 'true');
  box.setAttribute('aria-labelledby', 'session-note-title');
  const title = document.createElement('div');
  title.id = 'session-note-title';
  title.className = 'paste-label';
  title.textContent = '会话名称与工作详情';
  const hint = document.createElement('div');
  hint.className = 'session-note-hint';
  hint.textContent = anchor ? '直接编辑，鼠标移出后自动保存。也可点击保存。' : '修改会话名称和工作进度，保存后可跨设备查看。';
  const nameInput = document.createElement('input');
  nameInput.className = 'session-info-input';
  nameInput.value = s.displayName;
  nameInput.maxLength = 64;
  nameInput.disabled = true;
  const field = (text: string, control: HTMLElement): HTMLLabelElement => {
    const label = document.createElement('label');
    label.className = 'session-info-field';
    label.append(document.createTextNode(text), control);
    return label;
  };
  const input = document.createElement('textarea');
  input.className = 'session-note-input';
  input.setAttribute('aria-label', '工作详情');
  input.placeholder = '当前进度：\n待办事项：\n下一步：';
  input.maxLength = 4000;
  input.disabled = true;
  const counter = document.createElement('div');
  counter.className = 'session-note-hint';
  counter.textContent = '0 / 4000';
  input.addEventListener('input', () => { counter.textContent = `${input.value.length} / 4000`; });
  const status = document.createElement('div');
  status.className = 'session-note-status';
  status.setAttribute('role', 'status');
  status.textContent = '正在读取会话信息…';
  const row = document.createElement('div');
  row.className = 'paste-row';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'tb-btn';
  cancel.textContent = '关闭';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'tb-btn';
  save.textContent = '保存';
  save.disabled = true;
  row.append(cancel, save);
  const body = document.createElement('div');
  body.className = 'session-note-body';
  body.append(hint, field('会话名称', nameInput), field('工作详情', input), counter, status);
  box.append(title, body, row);
  overlay.append(box);
  document.body.append(overlay);
  const requests = new AbortController();
  if (!anchor) cancel.focus({ preventScroll: true });
  let loaded = false;
  let closed = false;
  let composing = false;
  let saving = false;
  const values = () => ({ displayName: nameInput.value, text: input.value });
  let baseline = values();
  const changed = (): boolean => loaded &&
    (nameInput.value !== baseline.displayName || input.value !== baseline.text);
  const close = (): void => {
    if (closed || saving || composing) return;
    closed = true;
    dismissal.dispose();
    requests.abort(); // Only cancels loading and listeners, never a save.
    overlay.remove();
    hover?.reset();
    if (!anchor && !TOUCH_DEVICE) activeSession?.focus();
  };
  const dismissal = new NoteDismiss(close);
  // Pin on interaction, before IME candidates can move focus or the pointer.
  overlay.addEventListener('pointerdown', () => dismissal.edit());
  overlay.addEventListener('focusin', () => dismissal.edit());
  overlay.addEventListener('input', () => dismissal.edit());
  overlay.addEventListener('compositionstart', () => { composing = true; dismissal.edit(); });
  overlay.addEventListener('compositionend', () => { composing = false; });
  if (anchor) {
    overlay.addEventListener('pointerenter', () => dismissal.enter());
    overlay.addEventListener('pointerleave', e => {
      if (e.pointerType === 'mouse') dismissal.leave();
    });
    document.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      const target = e.target as Node;
      const tabRect = anchor.getBoundingClientRect();
      const popupRect = overlay.getBoundingClientRect();
      // Treat the whole bridge between tab and popup as part of the hover area.
      const inBridge = e.clientX >= Math.min(tabRect.left, popupRect.left) - 8 &&
        e.clientX <= Math.max(tabRect.right, popupRect.right) + 8 &&
        e.clientY >= tabRect.top - 8 && e.clientY <= popupRect.top + 8;
      if (overlay.contains(target) || anchor.contains(target) || inBridge) dismissal.enter();
      else dismissal.leave();
    }, { signal: requests.signal });
    const position = (): void => {
      if (!anchor.isConnected) { close(); return; }
      const rect = anchor.getBoundingClientRect();
      const width = overlay.getBoundingClientRect().width;
      const top = Math.min(rect.bottom, window.innerHeight - 180);
      overlay.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      overlay.style.top = `${Math.max(8, top)}px`;
      box.style.maxHeight = `${Math.max(120, window.innerHeight - Math.max(8, top) - 8)}px`;
    };
    position();
    window.addEventListener('resize', position, { signal: requests.signal });
    tabsEl.addEventListener('scroll', position, { signal: requests.signal });
  }
  cancel.addEventListener('click', close);
  const commit = (): Promise<void> => {
    if (composing || saving || !changed()) return Promise.resolve();
    saving = true;
    save.disabled = cancel.disabled = nameInput.disabled = input.disabled = true;
    const snapshot = values();
    const previous = baseline;
    baseline = snapshot; // Prevent duplicate saves of the same pending edit.
    status.textContent = '正在保存…';
    const prior = pendingNoteSaves.get(s.name) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(async () => {
      const response = await fetch('/api/sessions/note', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: s.name, text: snapshot.text,
          displayName: snapshot.displayName.replace(/[\x00-\x1f\x7f]/g, '').trim() || s.name,
        }),
      });
      if (!response.ok) throw new Error('save failed');
      const saved = await response.json() as { displayName: string };
      setDisplayName(s, saved.displayName);
      saveTabs();
      if (!closed) status.textContent = `已保存：${new Date().toLocaleString()}`;
    }).catch(() => {
      if (baseline === snapshot) baseline = previous;
      if (!closed) status.textContent = '保存失败，可点击保存重试。';
      else flashStatus('会话信息保存失败', 2000);
    }).finally(() => {
      saving = false;
      if (!closed) save.disabled = cancel.disabled = nameInput.disabled = input.disabled = false;
      if (pendingNoteSaves.get(s.name) === task) pendingNoteSaves.delete(s.name);
    });
    pendingNoteSaves.set(s.name, task);
    return task;
  };
  save.addEventListener('click', () => { void commit(); });
  overlay.addEventListener('keydown', e => {
    e.stopPropagation();
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Tab' && !anchor) {
      const controls = [nameInput, input, cancel, save].filter(control => !control.disabled);
      if (controls.length) {
        const index = controls.indexOf(document.activeElement as typeof input | typeof cancel);
        controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
      e.preventDefault();
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void commit(); }
  });
  try {
    await pendingNoteSaves.get(s.name);
    if (closed) return;
    nameInput.value = s.displayName;
    const response = await fetch(`/api/sessions/note?session=${encodeURIComponent(s.name)}`, {
      cache: 'no-store', signal: requests.signal,
    });
    if (!response.ok) throw new Error('load failed');
    const note = await response.json() as { text: string; tags?: string[]; updatedAt: string | null };
    input.value = note.text;
    baseline = values();
    loaded = true;
    counter.textContent = `${note.text.length} / 4000`;
    status.textContent = note.updatedAt ? `上次保存：${new Date(note.updatedAt).toLocaleString()}` : '尚未保存会话信息';
    input.disabled = nameInput.disabled = save.disabled = false;
    if (!anchor) input.focus({ preventScroll: true });
  } catch {
    if (!requests.signal.aborted) status.textContent = '读取失败，请关闭后重试。';
  }
}

function buildTab(s: Session): void {
  const tab = document.createElement('div');
  tab.className = 'tab';
  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  const label = document.createElement('span');
  label.className = 'tab-label';
  label.textContent = s.displayName;
  const close = document.createElement('span');
  close.className = 'tab-close';
  close.textContent = '×';
  close.title = '关闭标签并结束会话';
  tab.append(dot, label, close);

  // Single tap activates. On a tap only (see
  // onTap), and WITHOUT preventDefault, so a sideways drag scrolls the strip
  // instead of picking the tab it started on. (The old pointerdown+preventDefault
  // cancelled the pan, making the strip unscrollable once your finger landed on
  // a tab.) touch-action:manipulation on .tab keeps the strip pannable and drops
  // the double-tap-to-zoom.
  tab.draggable = !TOUCH_DEVICE;
  tab.addEventListener('pointerdown', e => {
    tab.draggable = e.pointerType === 'mouse' && e.button === 0 && e.target !== close;
  });
  tab.addEventListener('dragstart', e => {
    if (!tab.draggable || !e.dataTransfer) { e.preventDefault(); return; }
    draggedTab = s;
    noteHover.leave();
    tab.classList.add('tab-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-terminal-tab', s.name);
  });
  tab.addEventListener('dragover', e => {
    if (!draggedTab) return;
    e.preventDefault();
    for (const other of sessions) other.tabEl?.classList.remove('tab-drop-before', 'tab-drop-after');
    if (draggedTab !== s) {
      const after = e.clientX >= tab.getBoundingClientRect().left + tab.offsetWidth / 2;
      tab.classList.add(after ? 'tab-drop-after' : 'tab-drop-before');
    }
  });
  tab.addEventListener('dragleave', () => tab.classList.remove('tab-drop-before', 'tab-drop-after'));
  tab.addEventListener('drop', e => {
    if (!draggedTab) return;
    e.preventDefault();
    e.stopPropagation();
    const after = e.clientX >= tab.getBoundingClientRect().left + tab.offsetWidth / 2;
    applyTabOrder(moveTab(sessions, draggedTab, s, after));
    finishTabDrag();
  });
  tab.addEventListener('dragend', finishTabDrag);
  const noteHover = new NoteHover(() => {
    if (draggedTab || !tab.isConnected || document.querySelector('.paste-overlay') ||
        document.querySelector('.session-note-editor')) return false;
    void showSessionNote(s, tab, noteHover);
    return true;
  });
  let inNoteHoverArea = false;
  const updateNoteHoverArea = (e: PointerEvent): void => {
    const rect = tab.getBoundingClientRect();
    const inside = e.pointerType === 'mouse' && e.buttons === 0 &&
      e.clientX >= rect.left && e.clientX < rect.left + rect.width / 3;
    if (inside === inNoteHoverArea) return;
    inNoteHoverArea = inside;
    if (inside) noteHover.enter();
    else noteHover.leave();
  };
  tab.addEventListener('pointerenter', updateNoteHoverArea);
  tab.addEventListener('pointermove', updateNoteHoverArea);
  tab.addEventListener('pointerleave', () => {
    inNoteHoverArea = false;
    noteHover.leave();
  });
  tab.addEventListener('pointerdown', () => {
    inNoteHoverArea = false;
    noteHover.leave();
  });
  onTap(tab, (e) => {
    if (draggedTab || performance.now() < suppressTabTapUntil) return;
    if (e.target === close) return; // the × has its own handler
    activateSession(s);
  }, tabsEl);
  onTap(close, (e) => {
    e.stopPropagation();
    if (draggedTab || performance.now() < suppressTabTapUntil) return;
    confirmCloseSession(s);
  }, tabsEl);

  s.tabEl = tab;
  s.tabLabel = label;
  s.tabDot = dot;
  tabsEl.insertBefore(tab, addBtn); // "+" stays last, right after the tabs
  updateTabDot(s);
  refreshMobileUI();
}

// Tabs built here moments ago. A tab attaches only when it is first looked at,
// so the server may not know about a brand-new one yet; without this the next
// sync would read its absence from the server's list as "closed on another
// device" and drop it.
const recentlyCreated = new Map<string, number>();
const CREATE_GUARD_MS = 6000;

function addSession(name: string, makeActive: boolean, displayName?: string): Session {
  let s = sessions.find((x) => x.name === name);
  if (!s) {
    s = new Session(name, displayName);
    sessions.push(s);
    buildTab(s);
    recentlyCreated.set(name, performance.now());
  } else if (displayName && displayName.trim() && displayName.trim() !== s.displayName) {
    setDisplayName(s, displayName.trim());
  }
  if (makeActive) activateSession(s);
  saveTabs();
  return s;
}

function activateSession(s: Session): void {
  if (activeTab && activeTab !== s) {
    activeTab.setShown(false);
    activeTab.mate?.setShown(false);
  }
  activeTab = s;
  lastUsedIn.set(s.cwd ?? '', s.name);
  // Whatever had the keys belonged to the tab we just left.
  activeSession = s;
  layOutTab(s);
  for (const x of sessions) x.tabEl?.classList.toggle('active', x === s);
  // With many tabs the active one can sit off-screen in the horizontal strip
  // (e.g. after picking it from the drawer); scroll it back into view. inline/
  // block: 'nearest' only scrolls #tabs horizontally, never the page/terminal.
  s.tabEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  hideSelectionBar(); // a selection belongs to the tab it was made in
  // On touch (phones / iOS PWA), don't auto-focus the terminal when a tab
  // becomes active: focusing xterm's hidden textarea pops up the soft keyboard,
  // so every tab switch forced it open and the user had to dismiss it each
  // time. Tapping the terminal still focuses it (and raises the keyboard) when
  // the user actually wants to type. Desktop keeps the immediate focus so you
  // can type right after switching.
  if (!TOUCH_DEVICE) requestAnimationFrame(() => activeSession?.focus());
  reflectActiveStatus();
  refreshMobileUI();
  refreshLayoutUI();
  saveTabs();
}

// Ask before killing a session: closing a tab terminates its tmux session and
// any programs running in it, so make the user confirm first.
function confirmCloseSession(s: Session): void {
  if (document.querySelector('.confirm-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay confirm-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box confirm-box';
  const label = document.createElement('div');
  label.className = 'paste-label';
  const strong = document.createElement('b');
  strong.textContent = s.displayName;
  const sessionNote = s.displayName === s.name ? '' : `（tmux 会话 "${s.name}"）`;
  label.append(
    '关闭 ',
    strong,
    `${sessionNote}？这会结束它的 tmux 会话，其中运行的程序也会一并结束。`,
  );
  // A folder lives as long as it holds a session; say so before taking its last.
  const lastOf = folders.find(f => f.id === folderOf(s) && wouldEmpty(f.id, [s.name], folderMembers));
  if (lastOf) {
    const warn = document.createElement('div');
    warn.className = 'confirm-warn';
    warn.textContent = `这是文件夹「${lastOf.name}」里最后一个会话，关闭后该文件夹也会删除。`;
    label.append(warn);
  }
  const row = document.createElement('div');
  row.className = 'paste-row';
  const cancel = document.createElement('button');
  cancel.className = 'tb-btn';
  cancel.type = 'button';
  cancel.textContent = '取消';
  const confirm = document.createElement('button');
  confirm.className = 'tb-btn danger';
  confirm.type = 'button';
  confirm.textContent = '关闭并结束';
  row.append(cancel, confirm);
  box.append(label, row);
  overlay.append(box);
  document.body.append(overlay);
  window.setTimeout(() => confirm.focus(), 0);

  const close = (): void => {
    overlay.remove();
    activeSession?.focus();
  };
  cancel.addEventListener('click', close);
  confirm.addEventListener('click', () => {
    close();
    closeSession(s);
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

/**
 * The tab that appears when the last one goes — made on purpose, so it may
 * create its session. Never under a name that was just closed, though: that is
 * how a page waking up with only a closed tab would bring it straight back.
 */
function addFallbackTab(): void {
  const name = recentlyClosed.has(defaultSessionName) ? nextSessionName() : defaultSessionName;
  addSession(name, true).intendCreate();
}

function closeSession(s: Session): void {
  const idx = sessions.indexOf(s);
  if (idx < 0) return;
  // The confirm box already said this takes the folder with it.
  const folder = folderOf(s);
  if (wouldEmpty(folder, [s.name], folderMembers)) expectedEmptied.add(folder);
  // Guard against a server sync that raced the kill re-adding this tab.
  recentlyClosed.set(s.name, performance.now());
  // Closing a tab kills its tmux session for good (its programs are terminated).
  s.kill();
  sessions.splice(idx, 1);
  s.tabEl?.remove();
  s.dispose();
  if (activeTab === s) {
    activeTab = null;
    activeSession = null;
    const next = nextTabAfter(s, idx);
    if (next) activateSession(next);
  }
  if (sessions.length === 0) addFallbackTab();
  refreshMobileUI();
  saveTabs();
}

/**
 * The tab to show once `gone` (which sat at `idx`) has left the list: its
 * neighbour, preferring one in the same folder and directory, then the same
 * folder, so the strip and sidebar do not jump somewhere else under you.
 */
function nextTabAfter(gone: Session, idx: number): Session | null {
  const folder = folderOf(gone);
  const near = (match: (x: Session) => boolean): Session | undefined =>
    sessions.slice(idx).find(match) ?? sessions.slice(0, idx).reverse().find(match);
  return near(x => folderOf(x) === folder && x.cwd === gone.cwd) ?? near(x => folderOf(x) === folder) ??
    sessions[idx] ?? sessions[idx - 1] ?? null;
}

function nextSessionName(): string {
  const used = new Set(sessions.map((s) => s.name));
  for (const c of ['web', 'work', 'dev', 'scratch']) if (!used.has(c)) return c;
  let i = 2;
  while (used.has(`s${i}`)) i += 1;
  return `s${i}`;
}

// PWA-safe replacement for window.prompt(). iOS standalone WebViews (display:
// standalone — see manifest) suppress or hang on the native prompt/alert/confirm
// dialogs, which froze the whole UI when "+ New session" / rename were tapped.
// Render our own overlay instead (same pattern as confirmCloseSession). Resolves
// to the entered text, or null if cancelled/dismissed.
function domPrompt(opts: {
  label: string;
  value?: string;
  okText?: string;
  directory?: (signal: AbortSignal) => Promise<string>;
  onDirectoryChange?: (directory: string) => void;
}): Promise<string | null> {
  return new Promise((resolve) => {
    if (document.querySelector('.prompt-overlay')) {
      resolve(null);
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'paste-overlay prompt-overlay';
    const box = document.createElement('div');
    box.className = 'paste-box prompt-box';
    const label = document.createElement('div');
    label.className = 'paste-label';
    label.textContent = opts.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-input';
    input.value = opts.value ?? '';
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const row = document.createElement('div');
    row.className = 'paste-row';
    const cancel = document.createElement('button');
    cancel.className = 'tb-btn';
    cancel.type = 'button';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'tb-btn primary';
    ok.type = 'button';
    ok.textContent = opts.okText ?? '确定';
    row.append(cancel, ok);
    const content = document.createElement('div');
    content.className = 'prompt-content';
    content.append(label, input);
    // The product badge heads every dialog of this kind, so they read as part
    // of the same app (new session, new folder, download …).
    const head = document.createElement('div');
    head.className = 'prompt-head';
    head.append(brandMark());
    box.append(head, content, row);
    overlay.append(box);
    document.body.append(overlay);
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);

    let done = false;
    let directoryRequest: AbortController | null = null;
    if (opts.directory) {
      overlay.classList.add('has-directory');
      const directoryLabel = document.createElement('div');
      directoryLabel.className = 'prompt-directory-label';
      directoryLabel.textContent = '启动目录（可修改，留空或无效时使用用户主目录）';
      const directory = document.createElement('textarea');
      directory.className = 'prompt-directory-path';
      directory.rows = 3;
      directory.setAttribute('aria-label', '新会话启动目录');
      directory.placeholder = '填写绝对路径；留空使用用户主目录';
      directory.spellcheck = false;
      directory.autocapitalize = 'off';
      let edited = false;
      directory.addEventListener('input', () => {
        edited = true;
        opts.onDirectoryChange?.(directory.value);
      });
      directory.addEventListener('keydown', e => {
        if (e.key === 'Enter') e.preventDefault();
      });
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'tb-btn'; retry.textContent = '重新读取目录';
      retry.hidden = true;
      content.append(directoryLabel, directory, retry);
      const loadDirectory = async (): Promise<void> => {
        directoryRequest?.abort();
        const request = new AbortController();
        directoryRequest = request;
        const timer = window.setTimeout(() => request.abort(), 5000);
        retry.hidden = true; directory.placeholder = '正在读取当前会话目录…';
        try {
          const path = await opts.directory!(request.signal);
          if (done || directoryRequest !== request) return;
          if (!edited) {
            directory.value = path;
            opts.onDirectoryChange?.(path);
          }
          directory.placeholder = '填写绝对路径；留空使用用户主目录';
        } catch {
          if (done || directoryRequest !== request) return;
          directory.placeholder = '读取失败，可手动填写；留空使用用户主目录'; retry.hidden = false;
        } finally { clearTimeout(timer); }
      };
      retry.addEventListener('click', () => { edited = false; void loadDirectory(); });
      void loadDirectory();
    }
    const finish = (result: string | null): void => {
      if (done) return;
      done = true;
      directoryRequest?.abort();
      overlay.remove();
      activeSession?.focus();
      resolve(result);
    };
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => finish(input.value));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!ok.disabled) finish(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
  });
}

async function promptAddSession(
  base: Session | null = activeSession, startDir?: string, folderId: string = base ? folderOf(base) : '',
  folderName?: string,
): Promise<void> {
  const suggestion = newSessionName(
    base?.displayName ?? defaultSessionName, sessions.map(s => s.displayName),
  );
  let directory = '';
  const folderLabel = folderName ?? folders.find(f => f.id === folderId)?.name;
  const raw = await domPrompt({
    label: folderName ? `文件夹「${folderName}」的第一个会话：` :
      folderLabel ? `在「${folderLabel}」新建会话：` : '新建会话名称：',
    value: suggestion,
    okText: '创建',
    directory: async signal => {
      if (startDir) return startDir;
      if (!base) return '';
      const response = await fetch(`/api/sessions/cwd?session=${encodeURIComponent(base.name)}`, {
        cache: 'no-store', signal,
      });
      if (!response.ok) throw new Error('directory unavailable');
      const data = await response.json() as { path?: unknown };
      if (typeof data.path !== 'string' || !data.path.startsWith('/')) throw new Error('invalid directory');
      return data.path;
    },
    onDirectoryChange: value => { directory = value; },
  });
  if (raw === null) return; // cancelled — and so is a folder waiting on this
  const displayName = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64) || suggestion;
  const name = await newSessionId(displayName, sessions.map(s => s.name));
  const session = addSession(name, false, displayName);
  session.cwd = directory || startDir || base?.cwd || null;
  session.intendCreate(base?.name, directory);
  // Filed before it is shown, so it lands in its folder rather than flickering
  // through "未分组" until the server answers.
  if (folderName) {
    folderMembers = { ...folderMembers, [name]: '' };
    void editFolders({ action: 'create', name: folderName, session: name });
  } else if (folderId) {
    folderMembers = { ...folderMembers, [name]: folderId };
    void editFolders({ action: 'move', sessions: [name], folder: folderId });
  }
  activateSession(session);
}

// ---------------------------------------------------------------------------
// Folders: the user puts tabs in named folders; inside one, tabs are grouped by
// directory. A folder never collects anything by itself, and it lives exactly
// as long as it holds a tab — there is no delete. The strip shows the tabs in
// the active tab's folder and directory, as long as the sidebar is there to
// reach the others. On phones, or with it hidden, every tab stays in the strip.
// ---------------------------------------------------------------------------
function folderOf(s: Session): string {
  return folderMembers[s.name] ?? '';
}

function refreshSidebar(): void {
  const groups = groupByFolder(sessions, s => s.name, folders, folderMembers);
  sidebar.render(groups, activeTab?.name ?? null, homeDir, dirNames, cardOrder);
  const filtering = !mobileMQ.matches && !sidebar.isHidden;
  const activeFolder = activeTab ? folderOf(activeTab) : '';
  const activeDir = activeTab?.cwd ?? '';
  for (const s of sessions) {
    if (s.tabEl) s.tabEl.hidden = filtering && (folderOf(s) !== activeFolder || (s.cwd ?? '') !== activeDir);
  }
}

interface FolderReply {
  folders?: unknown; members?: unknown; dirNames?: unknown; cardOrder?: unknown; emptied?: unknown; home?: unknown; error?: unknown;
}

/**
 * Take the server's folders. Folders that were here and are gone now went
 * because their last tab did — closed elsewhere, or its program exited — and
 * nobody was asked; say so, unless this device just removed them itself.
 */
let expectedEmptied = new Set<string>();
function setFolders(data: FolderReply): void {
  if (!Array.isArray(data.folders) || !data.members || typeof data.members !== 'object') return;
  const next = data.folders.filter((f): f is FolderInfo =>
    !!f && typeof f.id === 'string' && typeof f.name === 'string');
  const kept = new Set(next.map(f => f.id));
  const gone = folders.filter(f => !kept.has(f.id) && !expectedEmptied.has(f.id));
  expectedEmptied = new Set([...expectedEmptied].filter(id => kept.has(id)));
  folders = next;
  folderMembers = Object.fromEntries(Object.entries(data.members as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === 'string'));
  if (data.dirNames && typeof data.dirNames === 'object') dirNames = data.dirNames as typeof dirNames;
  cardOrder = data.cardOrder && typeof data.cardOrder === 'object' ? data.cardOrder as typeof cardOrder : {};
  if (typeof data.home === 'string') homeDir = data.home;
  if (gone.length) flashStatus(`文件夹「${gone.map(f => f.name).join('」「')}」已无会话，已删除`, 3500);
}

async function loadFolders(): Promise<void> {
  try {
    const res = await fetch('/api/folders', { cache: 'no-store' });
    if (res.ok) setFolders(await res.json());
  } catch {
    /* keep the folders we have */
  }
}

type FolderEdit =
  | { action: 'create'; name: string; session: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'move'; sessions: string[]; folder: string; card?: { cwd: string; name: string } }
  | { action: 'renameDir'; folder: string; cwd: string; name: string }
  | { action: 'orderCards'; folder: string; cwds: string[] };

async function editFolders(edit: FolderEdit): Promise<boolean> {
  try {
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edit),
    });
    const data = await res.json() as FolderReply;
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'failed');
    setFolders(data);
    return true;
  } catch {
    flashStatus('文件夹保存失败，请重试', 2500);
    await loadFolders(); // put back what the server really has
    return false;
  } finally {
    refreshMobileUI();
  }
}

/** A folder is made together with its first session; cancelling makes neither. */
async function promptNewFolder(): Promise<void> {
  const raw = await domPrompt({ label: '新建文件夹名称：', value: '', okText: '下一步' });
  const name = raw?.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  if (!name) return;
  await promptAddSession(activeSession, undefined, '', name);
}

/**
 * Move tabs into a folder ('' for none), asking first if that empties the
 * folder they leave. A whole card carries its name along, unless the target
 * folder already has a card for that directory: the two merge under the
 * target's name.
 */
function moveSessions(names: string[], folderId: string, card?: { cwd: string; name: string }): void {
  const from = folderMembers[names[0]] ?? '';
  // Merging into a card the target already has for this directory: its name wins.
  const moving = new Set(names);
  const cwd = card?.cwd;
  if (cwd && sessions.some(s => !moving.has(s.name) && folderOf(s) === folderId && s.cwd === cwd)) card = undefined;
  const leaving = folders.find(f => f.id === from && wouldEmpty(f.id, names, folderMembers));
  if (leaving) {
    const target = folders.find(f => f.id === folderId)?.name ?? '未分组';
    if (!window.confirm(`这是文件夹「${leaving.name}」里最后的会话，移到「${target}」后该文件夹会删除。继续吗？`)) return;
    expectedEmptied.add(leaving.id);
  }
  folderMembers = { ...folderMembers };
  for (const n of names) {
    if (folderId) folderMembers[n] = folderId;
    else delete folderMembers[n];
  }
  if (card && !dirNames[folderId]?.[card.cwd]) {
    dirNames = { ...dirNames, [folderId]: { ...(dirNames[folderId] ?? {}), [card.cwd]: card.name } };
  }
  refreshMobileUI();
  void editFolders({ action: 'move', sessions: names, folder: folderId, card });
}

// Update only the tab's display label; the tmux session name (s.name) is left
// untouched so closing the tab still kills the original session.
function setDisplayName(s: Session, displayName: string): void {
  s.displayName = displayName;
  if (s.tabLabel) {
    s.tabLabel.textContent = displayName;
    s.tabLabel.removeAttribute('title');
  }
  refreshMobileUI();
}

interface SavedTab {
  name: string;
  displayName: string;
  /** Working directory, when the server reported one (cached for the sidebar). */
  cwd?: string;
  /** Local only: which of the tab's terminals this device had on screen. */
  view?: LayoutMode;
}

function saveTabs(): void {
  try {
    localStorage.setItem(
      'tw.tabs',
      JSON.stringify(
        sessions.map((s) => ({ name: s.name, displayName: s.displayName, view: s.view, cwd: s.cwd ?? undefined })),
      ),
    );
    if (activeTab) localStorage.setItem('tw.activeTab', activeTab.name);
  } catch {
    /* ignore */
  }
  if (activeSession) savePrefs({ activeTab: activeSession.name });
}

function loadTabs(): { tabs: SavedTab[]; active: string | null } {
  try {
    const parsed = JSON.parse(localStorage.getItem('tw.tabs') ?? '[]');
    const active = localStorage.getItem('tw.activeTab');
    if (Array.isArray(parsed)) {
      const tabs: SavedTab[] = [];
      for (const item of parsed) {
        // Old format: a bare session-name string. New format: { name, displayName }.
        if (typeof item === 'string') {
          tabs.push({ name: item, displayName: item });
        } else if (item && typeof item === 'object' && typeof item.name === 'string') {
          const dn =
            typeof item.displayName === 'string' && item.displayName.trim().length
              ? item.displayName
              : item.name;
          const view: LayoutMode | undefined =
            item.view === 'one' || item.view === 'two' || item.view === 'both'
              ? item.view
              : undefined;
          const cwd = typeof item.cwd === 'string' && item.cwd.startsWith('/') ? item.cwd : undefined;
          tabs.push({ name: item.name, displayName: dn, view, cwd });
        }
      }
      return { tabs, active };
    }
  } catch {
    /* ignore */
  }
  return { tabs: [], active: null };
}

// ---------------------------------------------------------------------------
// Cross-device sync: the server holds the authoritative tab list (which
// sessions exist + their display names), so opening the page on any platform
// shows the same tabs. localStorage is now only a per-device cache (offline
// fallback + which tab this device last had focused).
// ---------------------------------------------------------------------------

// Sessions just closed on this device; suppress a racing server sync from
// re-adding them before the kill is reflected server-side. Expired in sync().
const recentlyClosed = new Map<string, number>();
const CLOSE_GUARD_MS = 6000;

// Fetch the server's tab list. Returns null (and we keep local state) if the
// server is unreachable or slow, so a flaky network never blanks the tabs.
async function fetchServerTabs(timeoutMs = 2500): Promise<SavedTab[] | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/sessions', { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { tabs?: unknown };
    if (!Array.isArray(data.tabs)) return null;
    const out: SavedTab[] = [];
    for (const item of data.tabs) {
      if (item && typeof item === 'object' && typeof (item as SavedTab).name === 'string') {
        const name = (item as SavedTab).name;
        const dnRaw = (item as SavedTab).displayName;
        const dn = typeof dnRaw === 'string' && dnRaw.trim() ? dnRaw : name;
        const cwdRaw = (item as SavedTab).cwd;
        const cwd = typeof cwdRaw === 'string' && cwdRaw.startsWith('/') ? cwdRaw : undefined;
        out.push({ name, displayName: dn, cwd });
      }
    }
    return out;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

// Best-effort: tell the server a tab was renamed so other devices pick it up.
// The local label is already updated; a failure just delays cross-device sync.
/**
 * Ask the server to re-adopt these sessions as web tabs. The tab list lives on
 * the tmux sessions (a @twtab option) and is written when a tab attaches —
 * which, now that a tab only attaches when you open it, would leave sessions
 * tmux-resurrect restored after a reboot untagged and about to be swept out of
 * the list by the next sync. The server only tags ones that really exist, so a
 * tab closed on another device is not resurrected by this device's cache.
 */
async function adoptOnServer(names: string[]): Promise<void> {
  try {
    await fetch('/api/sessions/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    });
  } catch {
    /* ignore — the next sync will simply show what the server does know */
  }
}

function postRename(name: string, displayName: string): Promise<unknown> {
  return fetch('/api/sessions/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, displayName }),
  }).catch(() => {
    /* ignore — local UI already reflects the change */
  });
}

function renameOnServer(name: string, displayName: string): void {
  void postRename(name, displayName);
}

/**
 * Hand back the tabs the server does not list, and put their labels back with
 * them.
 *
 * Both the tab tag and the label are tmux session options, written when a tab
 * attaches or is renamed, and a session can be alive without either: resurrect
 * restores them after a reboot bare, and a tmux server that restarts under a
 * page that is already open does the same. Nothing re-tags them any more —
 * that used to be a side effect of every tab holding a socket.
 *
 * The label needs saying again because the list the server hands back is what
 * the tab strip shows: a tab adopted without it comes back named after its
 * session and overwrites the name you gave it.
 */
async function readoptTabs(tabs: SavedTab[]): Promise<void> {
  await adoptOnServer(tabs.map((t) => t.name));
  await Promise.all(
    tabs
      .filter((t) => t.displayName && t.displayName !== t.name)
      .map((t) => postRename(t.name, t.displayName))
  );
}

// ---------------------------------------------------------------------------
// UI prefs (font size, key bar, which tab was open) live on the server too.
// localStorage is still written — it is instant and it is what the first paint
// uses — but it cannot be trusted to still be there: in the iOS launcher this
// page runs in a cross-origin iframe, and that storage goes away when the app
// is closed, so every relaunch looked like a first visit. The server copy is
// what actually restores things. Scoped by device class, so a phone's font
// size is not imposed on a desktop.
// ---------------------------------------------------------------------------

const PREF_SCOPE = TOUCH_DEVICE ? 'touch' : 'desktop';

interface UiPrefs {
  theme?: ThemeName;
  activeTab?: string;
  fontSize?: number;
  keybar?: boolean;
  keyboardLocked?: boolean;
}

async function fetchServerPrefs(timeoutMs = 2500): Promise<UiPrefs | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/prefs?scope=${PREF_SCOPE}`, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { prefs?: unknown };
    const prefs = data.prefs;
    if (!prefs || typeof prefs !== 'object') return null;
    return prefs as UiPrefs;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

// Nothing is sent until init has read the server's copy and applied it: the
// values in play before that are boot defaults, and writing those back would
// overwrite the very prefs we are about to restore.
let prefsReady = false;
let pendingPrefs: UiPrefs = {};
let prefsTimer = 0;

function prefsBody(): string {
  const body = JSON.stringify({ scope: PREF_SCOPE, ...pendingPrefs });
  pendingPrefs = {};
  return body;
}

function flushPrefs(): void {
  window.clearTimeout(prefsTimer);
  if (!Object.keys(pendingPrefs).length) return;
  void fetch('/api/prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: prefsBody(),
    keepalive: true,
  }).catch(() => {
    /* ignore — a lost pref is a cosmetic loss, and the next change retries */
  });
}

// Coalesced: holding A− down, or walking through tabs, is one write.
function savePrefs(patch: UiPrefs): void {
  if (!prefsReady) return;
  Object.assign(pendingPrefs, patch);
  window.clearTimeout(prefsTimer);
  prefsTimer = window.setTimeout(flushPrefs, 400);
}

// Closing the app is exactly when the debounce would still be pending, and on
// iOS pagehide is the last event we get. sendBeacon survives the teardown that
// a normal fetch would not.
window.addEventListener('pagehide', () => {
  if (!prefsReady || !Object.keys(pendingPrefs).length) return;
  const body = prefsBody();
  try {
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon('/api/prefs', blob)) return;
  } catch {
    /* fall through to fetch */
  }
  void fetch('/api/prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    /* ignore */
  });
});

// Tear down a tab whose session was closed on another device. Unlike
// closeSession this sends NO kill (the session is already gone server-side) —
// it just removes the tab and frees the terminal locally.
function removeLocalSession(s: Session): void {
  const idx = sessions.indexOf(s);
  if (idx < 0) return;
  sessions.splice(idx, 1);
  s.tabEl?.remove();
  s.dispose();
  if (activeTab === s) {
    activeTab = null;
    activeSession = null;
    const next = nextTabAfter(s, idx);
    if (next) activateSession(next);
  }
  refreshMobileUI();
}

let syncing = false;

// Reconcile our local tabs with the server's list: adopt sessions opened (or
// renamed) on other devices, drop sessions closed elsewhere. The active tab is
// per-device and never changed here unless its session disappeared.
async function syncFromServer(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const [serverTabs] = await Promise.all([fetchServerTabs(), loadFolders()]);
    if (!serverTabs) return; // unreachable — keep what we have
    const byName = new Map(serverTabs.map((t) => [t.name, t]));

    // Expire stale guards first so re-opening a name later still works.
    const now = performance.now();
    for (const [name, at] of recentlyClosed) {
      if (now - at > CLOSE_GUARD_MS) recentlyClosed.delete(name);
    }
    for (const [name, at] of recentlyCreated) {
      if (now - at > CREATE_GUARD_MS) recentlyCreated.delete(name);
    }

    // Add tabs opened elsewhere; adopt display-name changes from elsewhere.
    for (const t of serverTabs) {
      if (recentlyClosed.has(t.name)) continue; // don't resurrect a just-closed tab
      // The second session of a split belongs to its tab, not in the strip. The
      // server leaves it out of the list; this is the same rule again, for a
      // server that has not been updated yet. One whose first session is gone
      // is nobody's second half any more, and shows up as an ordinary tab.
      if (isMateName(t.name) && byName.has(primaryNameOf(t.name))) continue;
      const existing = sessions.find((s) => s.name === t.name);
      if (!existing) {
        addSession(t.name, false, t.displayName).cwd = t.cwd ?? null;
      } else {
        if (t.cwd) existing.cwd = t.cwd;
        if (t.displayName && t.displayName !== existing.displayName) setDisplayName(existing, t.displayName);
      }
    }

    // Remove tabs closed elsewhere. A tab we built moments ago is exempt: it
    // may not have attached yet, so the server would not list it either.
    let missing = sessions.filter(
      (s) => !byName.has(s.name) && !recentlyCreated.has(s.name) && !recentlyClosed.has(s.name)
    );
    // Absent from the list is not the same as gone. The list is built from a
    // tag the tmux session carries, and a session can lose it while this page
    // is open — a tmux server that dies and comes back through resurrect brings
    // every session back bare. While each tab held its own socket that fixed
    // itself, because attaching is what writes the tag; with tabs attaching
    // only when opened, the next sweep would take every unopened tab instead,
    // five seconds later, with nothing to undo it.
    //
    // So offer the names back before dropping any of them. Only sessions that
    // really exist get adopted, which leaves a tab closed on another device
    // missing from the re-read as well — and it still goes.
    if (missing.length) {
      await readoptTabs(missing.map((s) => ({ name: s.name, displayName: s.displayName })));
      const after = await fetchServerTabs();
      if (!after) return; // unreachable now — keep every tab we have
      const listed = new Set(after.map((t) => t.name));
      missing = missing.filter((s) => !listed.has(s.name));
    }
    for (const s of missing) {
      recentlyClosed.set(s.name, performance.now());
      removeLocalSession(s);
    }

    if (sessions.length === 0) addFallbackTab();
    refreshMobileUI(); // directories or folders may have changed
    saveTabs();
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------------------
// Layout: key bar height + iOS keyboard offset; fit the active session.
// ---------------------------------------------------------------------------
function fitActive(): void {
  if (fileBrowserOpen) return;
  // Both halves of a split, not just the one with the keys: the keyboard coming
  // up takes rows from each of them.
  activeTab?.fit();
  if (activeTab?.view !== 'one') activeTab?.mate?.fit();
}

// Resizing a tmux window makes it reflow its whole history, so the panes nobody
// is looking at wait for the drag to settle rather than following every frame.
const BG_RESIZE_DELAY = 250;
let bgResizeTimer: number | null = null;

// Publish the size measured from the pane on screen to every session. The
// hidden ones cannot measure themselves, and leaving them at the size they
// happened to start with is what left every tab you weren't looking at attached
// to tmux at 80x24 — one reconnect of such a client and tmux resized the window
// to 80x24 for everyone on it, taking the alternate screen's contents with it.
function setPaneDims(cols: number, rows: number): void {
  paneCols = cols;
  paneRows = rows;
  // The pane on screen has already resized itself (fit); the rest follow here.
  if (bgResizeTimer !== null) clearTimeout(bgResizeTimer);
  bgResizeTimer = window.setTimeout(() => {
    bgResizeTimer = null;
    for (const s of sessions) {
      if (!isActive(s)) s.applyDims(paneCols, paneRows);
    }
    // A window that got narrow enough (or wide enough) wants its two terminals
    // stacked rather than side by side, or the other way round.
    if (activeTab?.view === 'both') layOutTab(activeTab);
  }, BG_RESIZE_DELAY);
}

// Below this width the key bar wraps to several rows (see styles.css) instead
// of being one horizontally-scrollable row, so its height is no longer fixed.
// A phone stays in the touch layout when fullscreen landscape exceeds 640px.

// Publish the key bar's real height into --keybar-h so the terminal sits right
// above it: a fixed value on desktop (single row), the measured wrapped height
// on a phone.
function updateKeybarHeight(): void {
  if (keybarEl.classList.contains('hidden')) {
    root.style.setProperty('--keybar-h', '0px');
  } else {
    const h = mobileMQ.matches ? keybarEl.offsetHeight : KEYBAR_HEIGHT;
    root.style.setProperty('--keybar-h', `${h}px`);
  }
  // The terminal's height is measured from the key bar, and is set in JS now
  // rather than by CSS, so it has to be re-measured whenever the bar changes.
  updateKeyboardOffset();
}

function isKeybarVisible(): boolean {
  return !keybarEl.classList.contains('hidden');
}

function setKeybarVisible(visible: boolean): void {
  keybarEl.classList.toggle('hidden', !visible);
  keybarSettingsButton?.setAttribute('aria-checked', String(visible));
  const keybarLabel = keybarSettingsButton?.querySelector('span:last-child');
  if (keybarLabel) keybarLabel.textContent = visible ? '隐藏底部键盘栏' : '显示底部键盘栏';
  refreshMobileUI();
  try {
    localStorage.setItem('tw.keybar', visible ? '1' : '0');
  } catch {
    /* ignore */
  }
  savePrefs({ keybar: visible });
  requestAnimationFrame(() => {
    updateKeybarHeight();
    fitActive();
  });
}

// Where the bottom of what you can actually see sits, in the coordinate space
// our fixed elements live in (the layout viewport). Browsers split two ways
// over a soft keyboard: iOS Safari leaves the layout viewport alone and shrinks
// only the visual one, while Chrome on iPadOS shrinks the layout viewport
// itself. Measuring the visible bottom covers both without asking which is
// which — the first reports a smaller visual viewport, the second a smaller
// innerHeight, and this number drops either way.
function visibleBottom(): number {
  const vv = window.visualViewport;
  if (!vv) return window.innerHeight;
  return Math.min(window.innerHeight, vv.offsetTop + vv.height);
}

function cssPx(el: HTMLElement, prop: string): number {
  return parseFloat(getComputedStyle(el).getPropertyValue(prop)) || 0;
}

// The terminal's height with no keyboard up. Everything the keyboard does is
// measured against this, and the terminal keeps it while a keyboard is open so
// the pty is never resized by one — a resize would send tmux a SIGWINCH, and a
// program on the alternate screen has no scrollback to put the lost rows back.
let restingTermH: number | null = null;
// Below this, treat it as noise rather than a keyboard. Low enough to catch an
// iPad's shortcut bar (~45-55px) when a hardware keyboard is attached, which
// covers the prompt just as effectively as a full keyboard does.
const KEYBOARD_MIN_PX = 40;
// Never slide so far that there is nothing left to read.
const KEYBOARD_MIN_VISIBLE_PX = 72;

// How much of us the keyboard covers according to the page that frames us. A
// frame's own visualViewport does not track the top-level one, so when embedded
// (entry's launcher) none of the measurements above notice a keyboard at all —
// only the framing page can see it, and it says so by postMessage.
let framedCovered = 0;

function updateKeyboardOffset(): void {
  if (fileBrowserOpen) { sizeFileBrowser(); return; }
  const viewportTop = Math.max(0, window.visualViewport?.offsetTop ?? 0);
  root.style.setProperty('--visible-top', `${Math.round(viewportTop)}px`);
  root.style.setProperty('--visible-h', `${Math.max(0, Math.round(visibleBottom() - viewportTop))}px`);
  const top = cssPx(termArea, 'top');
  const keybarH = cssPx(root, '--keybar-h');
  // Everything hidden below what can be seen, however we came to know about it:
  // a shrunken visual viewport, a shrunken layout viewport, or a framing page
  // telling us. Only one of the three is ever non-zero.
  const hiddenBelow = Math.max(
    0,
    window.innerHeight - visibleBottom(),
    framedCovered,
  );
  const available = Math.max(0, window.innerHeight - hiddenBelow - keybarH - top);

  // A soft keyboard is only up while something is focused, so with nothing
  // focused this IS the resting height. While typing, take any increase: the
  // keyboard can only ever cost room, so more room means the resting value was
  // stale (rotated mid-type, say) rather than that the keyboard grew.
  const el = document.activeElement;
  const typing = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
  if (!typing || restingTermH === null || available > restingTermH) {
    restingTermH = available;
  }
  root.style.setProperty('--term-h', `${Math.round(restingTermH)}px`);

  // What the key bar has to clear to stay above the keyboard. Zero on a browser
  // that shrank the layout viewport for it — the bottom of that viewport is
  // already above the keyboard.
  root.style.setProperty('--kb-gap', `${Math.round(hiddenBelow)}px`);

  const covered = restingTermH - available;
  const room = Math.max(0, restingTermH - KEYBOARD_MIN_VISIBLE_PX);
  // Moving by the whole keyboard height hides prompts near the top behind
  // the toolbar. Keep three rows below the cursor visible too: terminal apps
  // put status and shortcut lines below their input field. Cap at the pane's
  // bottom so a cursor on the last row does not create an empty gap.
  const inputBottom = Math.min(restingTermH, activeSession?.cursorBottom(3) ?? restingTermH);
  const cursorCovered = Math.max(0, inputBottom - available);
  const offset = covered > KEYBOARD_MIN_PX
    ? Math.min(Math.ceil(cursorCovered), Math.round(covered), room)
    : 0;
  root.style.setProperty('--kb-offset', `${offset}px`);

  if (VV_DEBUG) {
    const vv = window.visualViewport;
    activeSession?.debugSend(
      'vv',
      `ih=${window.innerHeight} vvh=${Math.round(vv?.height ?? 0)} ` +
        `vvTop=${Math.round(vv?.offsetTop ?? 0)} hidden=${Math.round(hiddenBelow)} ` +
        `framed=${framedCovered} top=${Math.round(top)} keybar=${Math.round(keybarH)} ` +
        `avail=${Math.round(available)} resting=${Math.round(restingTermH)} ` +
        `covered=${Math.round(covered)} off=${offset} typing=${typing ? 1 : 0}`,
    );
  }
  // Deliberately no fit() here: the keyboard slides the terminal, it never
  // resizes it. A change to --term-h is a real size change and reaches fit()
  // through the ResizeObserver on #terminal.
}

// ---------------------------------------------------------------------------
// Top-bar controls + on-screen key bar
// ---------------------------------------------------------------------------
function makeButton(
  parent: HTMLElement,
  cls: string,
  label: string,
  title: string,
  onTap: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  // Both toolbar variants finish the click before opening an overlay.
  bindIntentionalClick(b, onTap);
  parent.append(b);
  return b;
}

function changeFont(delta: number): void {
  currentFont = Math.min(MAX_FONT, Math.max(MIN_FONT, currentFont + delta));
  try {
    localStorage.setItem('tw.fontSize', String(currentFont));
  } catch {
    /* ignore */
  }
  savePrefs({ fontSize: currentFont });
  for (const s of sessions) {
    s.setFont(currentFont);
    s.mate?.setFont(currentFont); // a second half is not in `sessions`
  }
  fitActive(); // the cell size changed: re-measure and push the new size to all panes
  activeSession?.focus();
}

let fullscreenBusy = false;

function isFullscreen(): boolean {
  return Boolean(document.fullscreenElement ||
    (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement);
}

async function toggleFullscreen(): Promise<void> {
  if (fullscreenBusy) return;
  const d = document as Document & {
    webkitFullscreenElement?: Element;
    webkitExitFullscreen?: () => void | Promise<void>;
  };
  const el = root as HTMLElement & { webkitRequestFullscreen?: () => void | Promise<void> };
  const exiting = isFullscreen();
  const operation = exiting
    ? (document.exitFullscreen ?? d.webkitExitFullscreen)
    : (el.requestFullscreen ?? el.webkitRequestFullscreen);
  if (!operation) {
    flashStatus('此浏览器不支持全屏切换', 1800);
    return;
  }
  fullscreenBusy = true;
  updateFullscreenButton();
  try {
    await operation.call(exiting ? document : el);
  } catch {
    flashStatus('全屏切换失败，请重试', 1800);
  } finally {
    fullscreenBusy = false;
    updateFullscreenButton();
    requestAnimationFrame(fitActive);
  }
}

bindIntentionalClick(addBtn, () => { void promptAddSession(); });

// A line icon in the bar's own colour, like the ⋯ beside it — the yellow 📁
// emoji stood out against the dark bar. (The phone bar keeps its own.)
const desktopFilesButton = makeButton(controlsEl, 'tb-btn tb-icon', '', '文件管理', () => openFileBrowser());
desktopFilesButton.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.38a1.5 1.5 0 0 1 1.06.44L11.5 8H19.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z"/></svg>';
// Upload, split view and quick commands live in the settings panel (⋯) on PC;
// only the file manager and ⋯ stay in the top bar. The upload button is still
// built, off-screen, because the panel row borrows its icon.
const desktopUploadButton = makeButton(document.createElement('div'), 'tb-btn tb-icon', '', '上传文件', () => fileInput.click());
desktopUploadButton.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5"/><path d="M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg>';
// Split view. A tab can show a second terminal beside its own: this picks
// whether you see the first, the second, or both at once. Both keep running
// whichever you are looking at — only closing the tab closes them. The second
// session is made the first time it is asked for.
const LAYOUT_BUTTONS: { mode: LayoutMode; label: string; title: string }[] = [
  { mode: 'one', label: '1', title: '只显示第一个终端（第二个继续运行）' },
  { mode: 'two', label: '2', title: '只显示第二个终端（第一个继续运行）' },
  { mode: 'both', label: '⊞', title: '同时显示两个终端' },
];
const layoutButtons = new Map<LayoutMode, HTMLElement>();
const sheetLayoutButtons = new Map<LayoutMode, HTMLElement>();

function refreshLayoutUI(): void {
  const mode = activeTab?.view ?? 'one';
  for (const [m, b] of layoutButtons) b.classList.toggle('active', m === mode);
  for (const [m, b] of sheetLayoutButtons) b.classList.toggle('active', m === mode);
}

const layoutSeg = document.createElement('div');
layoutSeg.className = 'tb-seg';
for (const def of LAYOUT_BUTTONS) {
  layoutButtons.set(
    def.mode,
    makeButton(layoutSeg, 'tb-btn', def.label, def.title, () => {
      activeTab?.setView(def.mode);
      activeSession?.focus();
    }),
  );
}
// Kept (not attached) so refreshLayoutUI can still mark the active mode on it.
void layoutSeg;

// Reliable file attach for every platform (incl. iPad) and over plain HTTP —
// no clipboard needed: pick any file(s), each uploads and its path is inserted.
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.style.display = 'none';
document.body.append(fileInput);
fileInput.addEventListener('change', () => {
  if (fileInput.files) {
    for (const f of Array.from(fileInput.files)) void uploadFile(f, f.name);
  }
  fileInput.value = '';
});
// The desktop toolbar, mobile bar and ⋯ sheet share this file picker.

function openQuickCommandPanel(): void {
  showQuickCommands(text => {
    const target = activeSession;
    if (!target?.connected) return false;
    target.pasteText(text);
    if (!TOUCH_DEVICE) target.focus();
    return true;
  });
}
// 快捷命令 moved into the settings panel (see sheet.append).
// Everything that isn't reached often — font size, attach, fullscreen, help —
// sits behind this, in the same actions sheet the phone bar opens. The bar
// keeps only what gets used mid-session.
makeButton(controlsEl, 'tb-btn tb-icon', '⋯', '设置', () => openSheet());

// --- selection actions (touch) ---------------------------------------------
// Copying used to happen the instant you lifted your finger, so one imprecise
// drag decided everything: overshoot and the whole thing started over, and
// there was never a moment where you could see what you were about to get. The
// selection stays up now and these appear above the key bar.
const selBar = document.createElement('div');
selBar.id = 'selbar';
selBar.className = 'hidden';

function showSelectionBar(): void {
  selBar.classList.remove('hidden');
  if (SEL_DEBUG) {
    const r = selBar.getBoundingClientRect();
    activeSession?.debugSend(
      'sel-bar',
      `show at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} ` +
        `inDom=${selBar.isConnected ? 1 : 0} kbGap=${cssPx(root, '--kb-gap')} keybar=${cssPx(root, '--keybar-h')}`,
    );
  }
}
function hideSelectionBar(): void {
  if (SEL_DEBUG && !selBar.classList.contains('hidden')) {
    activeSession?.debugSend('sel-bar', 'hide');
  }
  selBar.classList.add('hidden');
}

/** Turn touch-select mode on or off, keeping the key and the bar in step. */
function setTouchSelectMode(on: boolean): void {
  touchSelectMode = on;
  selectBtn?.classList.toggle('armed', on);
  if (!on) {
    activeSession?.clearSelectionRange();
    hideSelectionBar();
  }
}

/** Copy whatever is selected, then leave select mode. */
function copySelectionNow(): void {
  const sel = activeSession?.term.getSelection() ?? '';
  if (!sel) {
    flashStatus('未选择任何内容', 1400);
    return;
  }
  void copyText(sel).then((ok) => flashStatus(ok ? `已复制 ${sel.length} 个字符` : '复制失败', 1600));
  setTouchSelectMode(false);
}

function selBarButton(label: string, cls: string, onTap: () => void): void {
  const b = document.createElement('button');
  b.className = `sel-btn ${cls}`;
  b.type = 'button';
  b.textContent = label;
  // A real click, in the gesture: Safari only lets the clipboard be written
  // from one, and a preventDefaulted pointerdown is not it.
  b.addEventListener('click', onTap);
  selBar.append(b);
}

selBarButton('复制', 'primary', () => copySelectionNow());
selBarButton('全选', '', () => {
  if (!activeSession?.selectVisible()) flashStatus('无法全选', 1400);
});
selBarButton('取消', '', () => {
  activeSession?.clearSelectionRange();
  setTouchSelectMode(false);
});
document.body.append(selBar);

// --- on-screen key bar (sends to the active session) -----------------------
interface KeyDef {
  /** Override the visual position in the wrapped mobile key bar. */
  mobileOrder?: number;
  label?: string;
  seq?: string;
  mod?: 'ctrl' | 'shift';
  action?: 'copy' | 'paste' | 'select' | 'commands' | 'up' | 'down' | 'bottom' | 'keyboard';
  /** Force a line break here (mobile only): the keys after it wrap to a new row. */
  rowBreak?: boolean;
}
const KEYS: KeyDef[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t', mobileOrder: 8 },
  { label: 'Ctrl', mod: 'ctrl', mobileOrder: 1 },
  { label: 'Shift', mod: 'shift', mobileOrder: 10 },
  { label: '^C', seq: '\x03', mobileOrder: 9 },
  { label: 'Enter', seq: '\r' },
  { label: '命令', action: 'commands' },
  // On a phone the arrows get their own second row; everything else stays on the first.
  { rowBreak: true },
  // Ctrl+End: jump to the bottom in Claude Code's fullscreen view (CSI 1;5F).
  { label: '上页', action: 'up', mobileOrder: 2 },
  { label: '下页', action: 'down', mobileOrder: 3 },
  { label: '底部', action: 'bottom', mobileOrder: 4 },
  { label: '键盘', action: 'keyboard', mobileOrder: 11 },
  { label: '←', seq: '\x1b[D' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '→', seq: '\x1b[C' },
];

let ctrlArmed = false;
let shiftArmed = false;
const modButtons: Partial<Record<'ctrl' | 'shift', HTMLElement>> = {};
let selectBtn: HTMLElement | null = null;

function refreshModVisuals(): void {
  modButtons.ctrl?.classList.toggle('armed', ctrlArmed);
  modButtons.shift?.classList.toggle('armed', shiftArmed);
}

function applyMods(seq: string): string {
  if (!ctrlArmed && !shiftArmed) return seq;
  if (/^\x1b\[[ABCD]$/.test(seq)) {
    const mod = 1 + (shiftArmed ? 1 : 0) + (ctrlArmed ? 4 : 0);
    return `\x1b[1;${mod}${seq[seq.length - 1]}`;
  }
  if (shiftArmed && seq === '\t') {
    return ctrlArmed ? '\x1b[9;6u' : '\x1b[Z';
  }
  if (shiftArmed && seq === '\r') {
    // Encode Shift+Enter distinctly; its meaning is decided by the CLI.
    return `\x1b[13;${ctrlArmed ? 6 : 2}u`;
  }
  if (seq.length === 1) {
    let ch = shiftArmed ? seq.toUpperCase() : seq;
    if (ctrlArmed) {
      const code = ch.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) ch = String.fromCharCode(code & 0x1f);
    }
    return ch;
  }
  return seq;
}

for (const [index, def] of KEYS.entries()) {
  if (def.rowBreak) {
    const brk = document.createElement('div');
    brk.className = 'kb-break';
    brk.style.setProperty('--mobile-order', String(index));
    keybarEl.append(brk);
    continue;
  }
  const b = document.createElement('button');
  b.className = 'kb-key';
  b.style.setProperty('--mobile-order', String(def.mobileOrder ?? index));
  b.type = 'button';
  b.textContent = def.label ?? '';
  b.title = def.label ?? '';
  if (def.mod) modButtons[def.mod] = b;
  if (def.action === 'commands') {
    b.title = '快捷命令';
    b.setAttribute('aria-label', '快捷命令');
    bindIntentionalClick(b, openQuickCommandPanel, keybarEl);
    keybarEl.append(b);
    continue;
  }
  if (def.action === 'select') selectBtn = b;
  if (def.action === 'keyboard') {
    b.title = '弹出输入法';
    b.setAttribute('aria-label', '弹出输入法');
    bindIntentionalClick(b, () => activeSession?.openKeyboard(), keybarEl);
    keybarEl.append(b);
    continue;
  }
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    activeSession?.stopTouchScroll();
    if (def.action === 'up' || def.action === 'down' || def.action === 'bottom') {
      void activeSession?.scrollHistory(def.action);
      return;
    }
    // On touch, never refocus the terminal: focusing its textarea pops up the
    // soft keyboard. The keys send their bytes straight over the WebSocket, so
    // focus isn't needed — preventDefault already keeps whatever focus state
    // (and thus the keyboard) the user already had.
    const refocus = e.pointerType !== 'touch';
    if (def.action === 'select') {
      // Toggle touch-select mode. While on, dragging the terminal selects text
      // (and lifting copies it) instead of scrolling; tap again to go back to
      // scrolling. Never refocus — that would pop the soft keyboard.
      setTouchSelectMode(!touchSelectMode);
      flashStatus(touchSelectMode ? '选择模式：拖动选择文字，松手后点击复制' : '已关闭选择模式', 1800);
      return;
    }
    if (def.action === 'copy') {
      const sel = activeSession?.term.getSelection() ?? '';
      if (sel) {
        void copyText(sel).then((ok) => flashStatus(ok ? 'copied' : 'copy failed', 1200));
      } else {
        flashStatus('nothing selected', 1200);
      }
      if (refocus) activeSession?.focus();
      return;
    }
    if (def.action === 'paste') {
      pasteFromClipboard();
      if (refocus) activeSession?.focus();
      return;
    }
    if (def.mod) {
      if (def.mod === 'ctrl') ctrlArmed = !ctrlArmed;
      else shiftArmed = !shiftArmed;
      refreshModVisuals();
      return;
    }
    if (def.seq !== undefined) activeSession?.sendSeq(applyMods(def.seq));
    if (ctrlArmed || shiftArmed) {
      ctrlArmed = false;
      shiftArmed = false;
      refreshModVisuals();
    }
    if (refocus) activeSession?.focus();
  });
  keybarEl.append(b);
}

// ---------------------------------------------------------------------------
// Mobile UI: a compact top bar + a bottom "Sessions" drawer + an actions
// sheet. Built unconditionally; CSS (@media max-width:640px) hides it on
// desktop and hides the original #topbar on phones. Everything reuses the
// existing session functions, so the two layouts stay in sync.
// ---------------------------------------------------------------------------
const mobilebar = document.createElement('div');
mobilebar.id = 'mobilebar';

function mBtn(label: string, title: string, onTap: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'm-btn';
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  bindIntentionalClick(b, onTap);
  return b;
}

const mMenuBtn = mBtn('☰', '会话列表', () => openDrawer());
const mTitle = document.createElement('button');
mTitle.className = 'm-title';
mTitle.type = 'button';
const mTitleDot = document.createElement('span');
mTitleDot.className = 'tab-dot';
const mTitleLabel = document.createElement('span');
mTitleLabel.className = 'm-title-label';
const mCaret = document.createElement('span');
mCaret.className = 'm-caret';
mCaret.textContent = '▾';
mTitle.append(mTitleDot, mTitleLabel, mCaret);
bindIntentionalClick(mTitle, openDrawer);

// Built directly (not via mBtn) so it triggers on a real `click`: iOS refuses to
// open a file picker from a preventDefaulted pointerdown.
const mAttachBtn = document.createElement('button');
mAttachBtn.className = 'm-btn';
mAttachBtn.type = 'button';
mAttachBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5"/><path d="M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>';
mAttachBtn.title = '上传文件';
mAttachBtn.setAttribute('aria-label', '上传文件');
bindIntentionalClick(mAttachBtn, () => fileInput.click());
const mKeyboardLockBtn = mBtn('', '键盘锁定', () => {
  keyboardLockChanged = true;
  setKeyboardLocked(!keyboardLocked);
});
mKeyboardLockBtn.classList.add('m-keyboard-lock');
mKeyboardLockBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/><path d="M12 14v3"/></svg>';
const mMoreBtn = mBtn('⋯', '设置', () => openSheet());

const mFilesBtn = mBtn('📁', '文件管理', () => openFileBrowser());
mobilebar.append(mMenuBtn, mTitle, mFilesBtn, mAttachBtn, mKeyboardLockBtn, mMoreBtn);
document.body.append(mobilebar);

// --- Sessions drawer (bottom sheet) ----------------------------------------
const drawerOverlay = document.createElement('div');
drawerOverlay.className = 'sheet-overlay hidden';
const drawer = document.createElement('div');
drawer.className = 'sheet drawer';
const drawerGrip = document.createElement('div');
drawerGrip.className = 'sheet-grip';
/** A sheet header: the section name, and the brand mark on the right. */
function sheetHeader(title: string): HTMLElement {
  const head = document.createElement('div');
  head.className = 'sheet-title sheet-head';
  const label = document.createElement('span');
  label.className = 'sheet-head-label';
  label.textContent = title;
  head.append(label, brandMark());
  return head;
}

const drawerTitle = sheetHeader('会话');
const drawerHint = document.createElement('div');
drawerHint.className = 'drawer-hint';
drawerHint.textContent = '点击名称选中基准会话；点击“进入”切换终端。';
const drawerList = document.createElement('div');
drawerList.className = 'drawer-list';
const drawerNew = document.createElement('button');
drawerNew.className = 'drawer-new';
drawerNew.type = 'button';
drawerNew.textContent = '+  基于选中会话新建';
bindIntentionalClick(drawerNew, () => {
  const base = drawerSelected && sessions.includes(drawerSelected) ? drawerSelected : activeTab;
  closeDrawer();
  void promptAddSession(base);
}, drawer);
drawer.append(drawerGrip, drawerTitle, drawerHint, drawerList, drawerNew);
drawerOverlay.append(drawer);
document.body.append(drawerOverlay);
bindIntentionalClick(drawerOverlay, (e) => {
  if (e.target === drawerOverlay) closeDrawer();
}, drawer);

let drawerOpen = false;
let drawerSelected: Session | null = null;

function selectDrawerSession(session: Session): void {
  drawerSelected = session;
  for (const row of Array.from(drawerList.children)) {
    const selected = (row as HTMLElement).dataset.session === session.name;
    row.classList.toggle('active', selected);
    row.querySelector('.drawer-body')?.setAttribute('aria-pressed', String(selected));
  }
}

function renderDrawer(): void {
  if (!drawerSelected || !sessions.includes(drawerSelected)) drawerSelected = activeTab ?? sessions[0] ?? null;
  drawerList.textContent = '';
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'drawer-row' + (s === drawerSelected ? ' active' : '');
    row.dataset.session = s.name;

    const body = document.createElement('div');
    body.className = 'drawer-body';
    body.setAttribute('role', 'button');
    body.tabIndex = 0;
    body.setAttribute('aria-pressed', String(s === drawerSelected));
    body.setAttribute('aria-label', `选中会话：${s.displayName}`);
    const dot = document.createElement('span');
    dot.className = 'tab-dot' + (s.connected ? ' connected' : '') + (hasRecentOutput(s) ? ' working' : '');
    const name = document.createElement('span');
    name.className = 'drawer-name';
    name.textContent = s.displayName;
    body.append(dot, name);
    // Taps only: this list scrolls, and a swipe through it must not pick the
    // session it started on (it used to, on pointerdown).
    onTap(body, () => {
      selectDrawerSession(s);
    }, drawer);
    body.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDrawerSession(s); }
    });

    const enter = document.createElement('button');
    enter.className = 'drawer-act drawer-enter';
    enter.type = 'button';
    enter.title = '进入会话';
    enter.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h5v16h-5"/><path d="M3 12h11m-4-4 4 4-4 4"/></svg>';
    enter.setAttribute('aria-label', `进入会话：${s.displayName}`);
    onTap(enter, () => {
      selectDrawerSession(s);
      activateSession(s);
      closeDrawer();
    }, drawer);

    const rename = document.createElement('button');
    rename.className = 'drawer-act';
    rename.type = 'button';
    rename.textContent = '✎';
    rename.title = '编辑会话信息';
    rename.setAttribute('aria-label', `编辑会话信息：${s.displayName}`);
    onTap(rename, () => {
      closeDrawer();
      void showSessionNote(s);
    }, drawer);

    const close = document.createElement('button');
    close.className = 'drawer-act danger';
    close.type = 'button';
    close.textContent = '×';
    close.title = '关闭标签并结束会话';
    onTap(close, () => {
      closeDrawer();
      confirmCloseSession(s);
    }, drawer);

    row.append(body, enter, rename, close);
    drawerList.append(row);
  }
  updateOutputActivity();
}

function openDrawer(): void {
  drawerSelected = activeTab;
  renderDrawer();
  drawerOverlay.classList.remove('hidden');
  drawerOpen = true;
}
function closeDrawer(): void {
  drawerOverlay.classList.add('hidden');
  drawerOpen = false;
  // Don't focus the terminal on touch: this runs inside the tap gesture that
  // picked a session, and a synchronous focus() raises the soft keyboard — so
  // every session switch popped the keyboard. (This, not setActive()'s rAF
  // focus, was the real culprit: focus() outside a user gesture doesn't raise
  // the keyboard on iOS.) The drawer is mobile-only, so skip focus entirely on
  // a coarse pointer; tap the terminal when you actually want to type.
  if (!TOUCH_DEVICE) activeSession?.focus();
}

// --- Actions sheet (font / restart / paste / fullscreen / help) ------------
const sheetOverlay = document.createElement('div');
sheetOverlay.className = 'sheet-overlay hidden';
const sheet = document.createElement('div');
sheet.className = 'sheet actions-sheet';
const sheetGrip = document.createElement('div');
sheetGrip.className = 'sheet-grip';
const sheetTitle = sheetHeader('设置');

const fontRow = document.createElement('div');
fontRow.className = 'sheet-font';
const fontMinus = document.createElement('button');
fontMinus.className = 'sf-btn';
fontMinus.type = 'button';
fontMinus.textContent = 'A−';
fontMinus.title = '缩小字号';
const fontVal = document.createElement('div');
fontVal.className = 'sf-val';
const fontPlus = document.createElement('button');
fontPlus.className = 'sf-btn';
fontPlus.type = 'button';
fontPlus.textContent = 'A+';
fontPlus.title = '放大字号';
function updateFontVal(): void {
  fontVal.textContent = `字号 ${currentFont}px`;
}
bindIntentionalClick(fontMinus, () => {
  changeFont(-1);
  updateFontVal();
}, sheet);
bindIntentionalClick(fontPlus, () => {
  changeFont(1);
  updateFontVal();
}, sheet);
fontRow.append(fontMinus, fontVal, fontPlus);

const themeRow = document.createElement('div');
themeRow.className = 'sheet-seg theme-picker';
themeRow.setAttribute('role', 'group');
themeRow.setAttribute('aria-label', '界面主题');
const themeLabel = document.createElement('div');
themeLabel.className = 'ss-lbl';
themeLabel.textContent = '主题';
themeRow.append(themeLabel);
const themeButtons = new Map<ThemeName, HTMLButtonElement>();
for (const [name, label] of [['light', '☀ 浅色'], ['dark', '☾ 深色']] as const) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sf-btn';
  button.textContent = label;
  bindIntentionalClick(button, () => {
    themeChanged = true;
    setTheme(name);
    savePrefs({ theme: name });
  }, sheet);
  themeButtons.set(name, button);
  themeRow.append(button);
}
function setTheme(theme: ThemeName): void {
  currentTheme = theme;
  applyDocumentTheme(theme);
  for (const session of sessions) {
    session.term.options.theme = TERMINAL_THEMES[theme];
    if (session.mate) session.mate.term.options.theme = TERMINAL_THEMES[theme];
  }
  for (const [name, button] of themeButtons) {
    button.classList.toggle('active', name === theme);
    button.setAttribute('aria-pressed', String(name === theme));
  }
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* server copy remains */ }
  fileBrowserFrame?.contentWindow?.postMessage({ type: 'terminal-theme', theme }, location.origin);
}
setTheme(currentTheme);

const colorRow = document.createElement('div');
colorRow.className = 'sheet-seg theme-picker';
colorRow.setAttribute('role', 'group');
colorRow.setAttribute('aria-label', '终端颜色');
const colorLabel = document.createElement('div');
colorLabel.className = 'ss-lbl';
colorLabel.textContent = '终端颜色';
colorRow.append(colorLabel);
const colorHint = document.createElement('div');
colorHint.textContent = '所有设备共用；新建会话生效，已有会话不变。';
colorHint.className = 'sheet-hint';
colorHint.setAttribute('role', 'status');
const colorButtons = new Map<boolean, HTMLButtonElement>();
let colorRequest = false;
async function updateColorPolicy(enabled?: boolean): Promise<void> {
  if (colorRequest) return;
  colorRequest = true;
  for (const button of colorButtons.values()) button.disabled = true;
  try {
    const response = await fetch('/api/terminal-colors', enabled === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    if (!response.ok) throw new Error('request failed');
    const result = await response.json();
    if (typeof result.enabled !== 'boolean') throw new Error('invalid response');
    for (const [value, button] of colorButtons) {
      button.classList.toggle('active', value === result.enabled);
      button.setAttribute('aria-pressed', String(value === result.enabled));
    }
    colorHint.textContent = `${enabled === undefined ? '' : '已保存。'}所有设备共用；新建会话生效，已有会话不变。`;
  } catch {
    colorHint.textContent = enabled === undefined ? '读取颜色设置失败，请重新打开设置。' : '保存失败，请重试。';
  } finally {
    colorRequest = false;
    for (const button of colorButtons.values()) button.disabled = false;
  }
}
for (const [enabled, label] of [[true, '开启'], [false, '关闭']] as const) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sf-btn';
  button.textContent = label;
  button.setAttribute('aria-pressed', 'false');
  bindIntentionalClick(button, () => { void updateColorPolicy(enabled); }, sheet);
  colorButtons.set(enabled, button);
  colorRow.append(button);
}

// Where tab status comes from (src/agent-status.ts). Shared by every device;
// the current choice arrives with each status update, so a change made on one
// device shows on the others at once.
const STATUS_MODES = [
  { mode: 'hooks', label: '钩子', hint: '钩子：Claude Code / Codex 通过钩子上报，最准确；没上报过的会话自动按屏幕识别。需先安装钩子（见部署文档）。' },
  { mode: 'screen', label: '屏幕识别', hint: '屏幕识别：不需要钩子，服务端读取各会话屏幕判断执行中、等待确认和完成。' },
  { mode: 'legacy', label: '原始', hint: '原始：浏览器按回车后屏幕有变化就转圈 60 秒；只跟踪本页面打开过的标签，状态不跨设备。' },
] as const;
const statusModeRow = document.createElement('div');
statusModeRow.className = 'sheet-seg theme-picker';
statusModeRow.setAttribute('role', 'group');
statusModeRow.setAttribute('aria-label', '状态来源');
const statusModeLabel = document.createElement('div');
statusModeLabel.className = 'ss-lbl';
statusModeLabel.textContent = '状态来源';
statusModeRow.append(statusModeLabel);
const statusModeHint = document.createElement('div');
statusModeHint.className = 'sheet-hint';
statusModeHint.setAttribute('role', 'status');
const statusModeButtons = new Map<string, HTMLButtonElement>();
let statusModeError = '';
function refreshStatusModeUI(): void {
  for (const [mode, button] of statusModeButtons) {
    button.classList.toggle('active', mode === agentMode);
    button.setAttribute('aria-pressed', String(mode === agentMode));
  }
  const current = STATUS_MODES.find(m => m.mode === agentMode);
  statusModeHint.textContent = statusModeError ||
    (current ? `${current.hint} 所有设备共用。` : '服务端未提供状态来源（需重启服务以启用），当前按原始方式显示。');
}
async function setStatusMode(mode: string): Promise<void> {
  for (const button of statusModeButtons.values()) button.disabled = true;
  try {
    const response = await fetch('/api/agent-status/mode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
    });
    if (!response.ok) throw new Error('request failed');
    const data = await response.json() as { mode?: unknown; sessions?: Record<string, AgentStatus> };
    if (data.mode === 'hooks' || data.mode === 'screen' || data.mode === 'legacy') agentMode = data.mode;
    agentStatuses = new Map(Object.entries(data.sessions ?? {}));
    statusModeError = '';
  } catch {
    statusModeError = '保存失败，请重试。';
  } finally {
    for (const button of statusModeButtons.values()) button.disabled = false;
    refreshStatusModeUI();
    refreshMobileUI();
  }
}
for (const { mode, label } of STATUS_MODES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sf-btn';
  button.textContent = label;
  button.setAttribute('aria-pressed', 'false');
  bindIntentionalClick(button, () => { void setStatusMode(mode); }, sheet);
  statusModeButtons.set(mode, button);
  statusModeRow.append(button);
}
refreshStatusModeUI();

// The same split-view control, at touch size, for the phone's actions sheet
// (the desktop top bar is hidden at that width).
const splitRow = document.createElement('div');
splitRow.className = 'sheet-seg';
const splitLabel = document.createElement('div');
splitLabel.className = 'ss-lbl';
splitLabel.textContent = '分屏';
splitRow.append(splitLabel);
for (const def of LAYOUT_BUTTONS) {
  const b = document.createElement('button');
  b.className = 'sf-btn';
  b.type = 'button';
  b.textContent = def.label;
  b.title = def.title;
  bindIntentionalClick(b, () => {
    activeTab?.setView(def.mode);
  }, sheet);
  splitRow.append(b);
  sheetLayoutButtons.set(def.mode, b);
}

function sheetRow(
  ico: string,
  label: string,
  onTap: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sheet-row';
  b.type = 'button';
  const i = document.createElement('span');
  i.className = 'sheet-ico';
  i.textContent = ico;
  const t = document.createElement('span');
  t.textContent = label;
  b.append(i, t);
  bindIntentionalClick(b, onTap, sheet);
  return b;
}

const keyboardLockButton = sheetRow('☐', '键盘锁定', () => {
  keyboardLockChanged = true;
  setKeyboardLocked(!keyboardLocked);
});
keyboardLockButton.setAttribute('role', 'checkbox');
keyboardLockButton.classList.add('desktop-keyboard-lock-setting');
keyboardLockButton.title = '开启后，手机仅通过“键盘”按钮弹出终端输入法';

function setKeyboardLocked(locked: boolean): void {
  keyboardLocked = locked;
  mKeyboardLockBtn.classList.toggle('active', locked);
  mKeyboardLockBtn.setAttribute('aria-pressed', String(locked));
  mKeyboardLockBtn.title = locked ? '键盘锁定：已开启' : '键盘锁定：已关闭';
  keyboardLockButton.setAttribute('aria-checked', String(locked));
  const icon = keyboardLockButton.querySelector('.sheet-ico');
  if (icon) icon.textContent = locked ? '☑' : '☐';
  for (const session of sessions) {
    session.setKeyboardLocked(locked);
    session.mate?.setKeyboardLocked(locked);
  }
  try { localStorage.setItem('tw.keyboardLocked', locked ? '1' : '0'); }
  catch { /* server prefs still save the setting */ }
  savePrefs({ keyboardLocked: locked });
}
setKeyboardLocked(keyboardLocked);

const fullscreenButton = sheetRow('⤢', '进入全屏', () => {
  closeSheet();
  void toggleFullscreen();
});

function updateFullscreenButton(): void {
  const label = isFullscreen() ? '退出全屏' : '进入全屏';
  const text = fullscreenButton.querySelector('span:last-child');
  if (text) text.textContent = label;
  fullscreenButton.setAttribute('aria-label', label);
  fullscreenButton.disabled = fullscreenBusy;
}

for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(event, () => {
    updateFullscreenButton();
    requestAnimationFrame(fitActive);
  });
}
updateFullscreenButton();

keybarSettingsButton = sheetRow('⌨', isKeybarVisible() ? '隐藏底部键盘栏' : '显示底部键盘栏', () => {
  setKeybarVisible(!isKeybarVisible());
});
keybarSettingsButton.setAttribute('role', 'checkbox');
keybarSettingsButton.setAttribute('aria-checked', String(isKeybarVisible()));

selectBtn = sheetRow('↔', '拖动选择文字', () => {
  closeSheet();
  setTouchSelectMode(!touchSelectMode);
  flashStatus(touchSelectMode ? '选择模式：拖动选择文字，松手后点击复制' : '已关闭选择模式', 1800);
});
const uploadSheetButton = sheetRow('', '上传文件', () => {
  closeSheet();
  fileInput.click();
});
uploadSheetButton.querySelector('.sheet-ico')!.append(desktopUploadButton.firstElementChild!.cloneNode(true));
// Ordered by how often each is reached for: everyday actions first, then the
// view, then settings that are set once, then the account. Small headings mark
// the groups so the list scans quickly.
function sheetGroup(title: string): HTMLElement {
  const h = document.createElement('div');
  h.className = 'sheet-group-title';
  h.textContent = title;
  return h;
}
sheet.append(
  sheetGrip,
  sheetTitle,
  sheetGroup('常用'),
  sheetRow('▤', '文件管理', () => { closeSheet(); openFileBrowser(); }),
  uploadSheetButton,
  sheetRow('⬇', '下载文件', () => {
    closeSheet();
    promptDownload();
  }),
  sheetRow('⎘', '复制当前路径', () => {
    closeSheet();
    void copyCurrentPath();
  }),
  sheetRow(
    '▣',
    '复制当前屏幕',
    () => {
      closeSheet();
      if (activeSession?.selectVisible()) copySelectionNow();
      else flashStatus('无法全选', 1400);
    },
  ),
  sheetRow('⧉', '粘贴', () => {
    closeSheet();
    pasteFromClipboard();
  }),
  sheetRow('⌘', '快捷命令', () => {
    closeSheet();
    openQuickCommandPanel();
  }),
  sheetRow('⟳', '重启当前会话', () => {
    closeSheet();
    activeSession?.restart();
    activeSession?.focus();
  }),
  sheetGroup('显示'),
  fontRow,
  splitRow,
  themeRow,
  fullscreenButton,
  keybarSettingsButton,
  sheetGroup('设置'),
  statusModeRow,
  statusModeHint,
  colorRow,
  colorHint,
  keyboardLockButton,
  selectBtn,
  sheetGroup('其他'),
  sheetRow('?', '帮助：复制 / 粘贴 / 文件', () => {
    closeSheet();
    openHelp();
  }),
  sheetRow('↪', '退出登录', () => { closeSheet(); void logoutBrowser(); }),
);
sheetOverlay.append(sheet);
document.body.append(sheetOverlay);
bindIntentionalClick(sheetOverlay, (e) => {
  if (e.target === sheetOverlay) closeSheet();
}, sheet);

function openSheet(): void {
  void updateColorPolicy();
  for (const session of sessions) session.stopTouchScroll();
  if (drawerOpen) closeDrawer();
  updateKeyboardOffset();
  updateFontVal();
  updateFullscreenButton();
  sheetOverlay.classList.remove('hidden');
}
function closeSheet(): void {
  sheetOverlay.classList.add('hidden');
}

// Keep the browser title and mobile bar in sync with the active tab, and
// re-render the open drawer when the session list or connection state changes.
function refreshMobileUI(): void {
  const s = activeTab;
  const attention = attentionCount();
  document.title = (attention ? `(${attention}) ` : '') +
    (fileBrowserOpen ? `文件管理 · ${s?.displayName || ''}` : s?.displayName || 'WebTerminal xutaocc');
  mTitleLabel.textContent = s ? s.displayName : '—';
  mTitleDot.classList.toggle('connected', !!s?.connected);
  refreshSidebar();
  updateOutputActivity();
  if (drawerOpen) renderDrawer();
}
refreshMobileUI();

// ---------------------------------------------------------------------------
// Global resize handling
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  updateKeybarHeight(); // rows may re-wrap when the width changes
  fitActive();
});
// Re-measure when crossing the mobile breakpoint (e.g. rotating the phone),
// since the key bar switches between a fixed row and the wrapped layout.
mobileMQ.addEventListener('change', () => {
  updateKeybarHeight();
  refreshSidebar(); // the tab strip is only narrowed to a project on desktop
  fitActive();
});
let areaObserver: ResizeObserver | null = null;
if (typeof ResizeObserver !== 'undefined') {
  const topbarObserver = new ResizeObserver(() => {
    if (mobileMQ.matches) return;
    const safeTop = Math.max(0, parseFloat(getComputedStyle(topbar).paddingTop) - 4);
    const height = Math.ceil(topbar.getBoundingClientRect().height - safeTop);
    if (height <= 0 || cssPx(root, '--desktop-topbar-h') === height) return;
    root.style.setProperty('--desktop-topbar-h', `${height}px`);
    // Desktop textareas stay focused while tabs grow; reset the keyboard-height
    // baseline so the terminal shrinks to the space below the new rows.
    restingTermH = null;
    updateKeyboardOffset();
    fitActive();
  });
  topbarObserver.observe(topbar);
  areaObserver = new ResizeObserver(() => fitActive());
  areaObserver.observe(termArea);
}
// Embedded: the framing page is the only one that can see the keyboard, so it
// tells us. Nothing else here can, and a wrong guess is worse than none.
if (window.parent !== window) {
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { source?: unknown; type?: unknown; covered?: unknown } | null;
    if (!d || d.source !== 'entry' || d.type !== 'viewport') return;
    const n = typeof d.covered === 'number' && Number.isFinite(d.covered) ? d.covered : 0;
    const covered = Math.max(0, Math.min(2000, Math.round(n)));
    if (covered === framedCovered) return;
    framedCovered = covered;
    updateKeyboardOffset();
  });
  // We may have finished loading after the last one was sent.
  try {
    window.parent.postMessage({ source: 'terminal-web', type: 'viewport-please' }, '*');
  } catch {
    /* a frame we cannot talk back to — nothing to do */
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateKeyboardOffset);
  window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
  // Read the resting gap now, before anything is focused. Without this the
  // first reading would be taken as the keyboard opened, and a keyboard-sized
  // resting gap means the terminal never moves out from under it.
  updateKeyboardOffset();
  // Once more after layout settles (a PWA's safe areas, Safari's chrome).
  window.setTimeout(updateKeyboardOffset, 1200);
}
window.addEventListener('beforeunload', () => {
  for (const s of sessions) s.dispose();
});

// ---------------------------------------------------------------------------
// File paste / drag-drop / picker -> upload -> insert the saved path into the
// active session, so the program running there (e.g. Claude Code) can read it.
// Any file type works, not just images.
// ---------------------------------------------------------------------------
function flashStatus(text: string, ms: number): void {
  showStatus(text);
  window.setTimeout(() => {
    if (statusEl?.textContent === text) hideStatus();
  }, ms);
}

function fmtMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// Upload via XMLHttpRequest (not fetch): fetch exposes no upload-progress
// events, so a big file (e.g. 75 MB) just sat on "uploading…" with no feedback.
// xhr.upload.onprogress lets us show a live percentage, and parsing the server's
// JSON {error} surfaces *why* an upload failed (e.g. "file too large") instead
// of a generic message. Never rejects — always resolves so callers can `void` it.
function uploadFile(file: Blob, name?: string): Promise<void> {
  return new Promise((resolve) => {
    if (!file) {
      resolve();
      return;
    }
    // Bind the destination to the tab that's active NOW, at upload start — the
    // file belongs to the terminal you attached it from. onload can fire much
    // later (a big upload, or you switched tabs / backgrounded the app while it
    // ran); using the live activeSession there sent the path to whatever tab
    // happened to be active on completion — the wrong one, or none you were
    // looking at. sendSeq buffers it if that tab's socket is mid-reconnect.
    const target = activeSession;
    const label = name ?? 'file';
    showStatus(`uploading ${label}… 0%`);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload' + (name ? `?name=${encodeURIComponent(name)}` : ''));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = (e): void => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        showStatus(
          `uploading ${label}… ${pct}% (${fmtMB(e.loaded)}/${fmtMB(e.total)} MB)`,
        );
      } else {
        showStatus(`uploading ${label}… ${fmtMB(e.loaded)} MB`);
      }
    };
    // All bytes are sent; the server is now writing the file and replying.
    xhr.upload.onload = (): void => showStatus(`uploading ${label}… finishing…`);

    xhr.onload = (): void => {
      let data: { path?: string; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText) as typeof data;
      } catch {
        /* non-JSON response */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.path) {
        if (target) {
          // Quote the path if it contains whitespace; append a space so it reads
          // as a complete argument at the prompt. The path goes in as a bracketed
          // paste when the program asked for one: Claude Code only turns an image
          // path into an [Image #N] attachment when it arrives as a paste, and
          // typed keystrokes leave it as plain text. The space stays outside the
          // markers so the pasted text is the bare path.
          const p = /\s/.test(data.path)
            ? `'${data.path.replace(/'/g, `'\\''`)}'`
            : data.path;
          target.sendSeq(
            (target.term.modes.bracketedPasteMode ? `\x1b[200~${p}\x1b[201~` : p) + ' ',
          );
          if (isActive(target)) target.focus();
        }
        // If it landed on a tab you've since switched away from, name it so you
        // know where the path went instead of it seeming to vanish.
        const where = target && !isActive(target) ? ` → ${target.displayName}` : '';
        flashStatus(`file added${where}: ${data.path}`, 2500);
      } else {
        flashStatus(
          data.error ? `upload failed: ${data.error}` : 'file upload failed',
          3500,
        );
      }
      resolve();
    };
    xhr.onerror = (): void => {
      flashStatus('file upload failed', 2500);
      resolve();
    };
    xhr.send(file);
  });
}

// Pull a file off the host back to this device — the reverse of uploadFile. A
// HEAD pre-check turns a bad path into a toast instead of silently saving the
// server's 404 body as a file; the real GET then streams through a transient
// <a download> so large files never buffer in memory. Auth rides on the
// same-origin tw_auth cookie automatically.
async function downloadFromHost(rawPath: string): Promise<void> {
  const p = rawPath.trim();
  if (!p) return;
  // Pass the active session so the server can resolve a relative path against
  // that terminal's current working directory (no absolute path needed).
  const sess = activeSession?.name;
  const url =
    '/api/download?path=' + encodeURIComponent(p) + (sess ? '&session=' + encodeURIComponent(sess) : '');
  showStatus(`preparing ${p}…`);
  let head: Response;
  try {
    head = await fetch(url, { method: 'HEAD' });
  } catch {
    flashStatus('download failed (network)', 2500);
    return;
  }
  if (!head.ok) {
    const why =
      head.status === 404 ? 'not found' : head.status === 400 ? 'bad path' : `error ${head.status}`;
    flashStatus(`download failed: ${why}`, 3000);
    return;
  }
  const size = Number(head.headers.get('content-length') ?? '0');
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = p.split('/').pop() || 'download';
  document.body.append(a);
  a.click();
  a.remove();
  flashStatus(`downloading ${a.download}${size ? ` (${fmtMB(size)} MB)` : ''}…`, 2500);
}

// Ask for a path and download it. A bare filename / relative path resolves
// against the terminal's current directory (server-side), so no absolute path
// is needed — handy on mobile. Shared by the desktop ⬇ button and the mobile
// actions sheet.
function promptDownload(): void {
  void (async () => {
    const p = await domPrompt({
      label: "Download — a filename or relative path (from the terminal's folder), or a full path",
      value: '',
      okText: 'Download',
    });
    if (p) void downloadFromHost(p);
  })();
}

// Capture phase: xterm's own paste handler calls stopPropagation() on its
// textarea/element, so a bubble-phase listener would never see pastes made into
// the focused terminal. Capturing lets us intercept file pastes first. Any file
// kind is uploaded; plain-text pastes fall through to xterm untouched.
window.addEventListener(
  'paste',
  (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (PASTE_DEBUG) {
      const cd = e.clipboardData;
      let kinds = '(no items)';
      if (items) {
        const parts: string[] = [];
        for (let i = 0; i < items.length; i += 1) parts.push(`${items[i].kind}/${items[i].type}`);
        kinds = parts.length ? parts.join(',') : '(empty)';
      }
      const types = cd && cd.types ? Array.from(cd.types).join('|') : '(none)';
      activeSession?.debugSend(
        'paste',
        `types=[${types}] items=[${kinds}] files=${cd?.files?.length ?? 0}`,
      );
    }
    const dt = e.clipboardData;
    if (!dt) return;

    // (1) Real file items — macOS image paste, Win+Shift+S screenshots, any
    // copied file (any type is allowed). (2) Fall back to dt.files, which some
    // browsers populate even when the items list doesn't expose the file.
    const files: File[] = [];
    if (items) {
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].kind === 'file') {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (files.length === 0 && dt.files) {
      for (let i = 0; i < dt.files.length; i += 1) files.push(dt.files[i]);
    }
    if (files.length > 0) {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't let xterm also handle it
      for (const f of files) void uploadFile(f, f.name);
      return;
    }

    // (3) Windows-Chrome case: copying an image from a web page (or Office)
    // often delivers it ONLY as text/html (an <img src="data:...">) with NO
    // file item, so the checks above find nothing. Recover the embedded image
    // by parsing the HTML and fetching a data:/blob: src into a Blob. Remote
    // http(s)/file: srcs can't be fetched client-side (CORS/security), so those
    // fall through to xterm's normal text paste.
    const html = dt.getData ? dt.getData('text/html') : '';
    if (html) {
      const src =
        new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src') ??
        '';
      if (src.startsWith('data:image/') || src.startsWith('blob:')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void (async () => {
          try {
            const blob = await fetch(src).then((r) => r.blob());
            if (blob.type.startsWith('image/')) {
              const ext = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
              await uploadFile(blob, `pasted-image.${ext}`);
            }
          } catch {
            flashStatus('paste: could not read the image', 2500);
          }
        })();
        return;
      }
      if (PASTE_DEBUG && src) {
        activeSession?.debugSend('paste', `unfetchable img src=${src.slice(0, 48)}`);
      }
    }
    // Nothing uploadable: let xterm handle the (text) paste.
  },
  true,
);

function dragHasFile(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (let i = 0; i < dt.items.length; i += 1) {
    if (dt.items[i].kind === 'file') return true;
  }
  return false;
}

termArea.addEventListener('dragover', (e) => {
  if (!dragHasFile(e.dataTransfer)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  termArea.classList.add('dragging');
});
termArea.addEventListener('dragleave', () => termArea.classList.remove('dragging'));
termArea.addEventListener('drop', (e) => {
  termArea.classList.remove('dragging');
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  e.preventDefault();
  for (const f of Array.from(files)) void uploadFile(f, f.name);
});

// ---------------------------------------------------------------------------
// Init: restore tabs (or start one), restore prefs, activate.
// ---------------------------------------------------------------------------
const urlSession = sanitizeName(params.get('session'));
const cached = loadTabs(); // per-device cache: offline fallback + last focus
// A sensible value from the first tick (used by closeSession / syncFromServer
// before init resolves); init refines it once the tab list is known.
let defaultSessionName = urlSession ?? cached.tabs[0]?.name ?? 'web';

async function init(): Promise<void> {
  // Both server round-trips start together; the prefs one is awaited further
  // down, just before the tabs are built.
  const prefsPromise = fetchServerPrefs();
  const foldersPromise = loadFolders();
  // The server's list is authoritative; fall back to the local cache, then to
  // a single default session when both are empty.
  let server = await fetchServerTabs();
  // Any tab this device remembers that the server does not list: hand over the
  // names and let it re-adopt the ones whose sessions really exist. That is
  // what a tmux-resurrect restore leaves behind — resurrect brings the sessions
  // back but not their @twtab option, and with tabs only attaching when opened,
  // nothing else would ever re-tag them. It happens for a partial restore too,
  // where the server lists the sessions that survived and none of the rest, so
  // this is not conditional on the list being empty.
  const listed = new Set((server ?? []).map((t) => t.name));
  const unlisted = cached.tabs.filter((t) => !listed.has(t.name));
  if (unlisted.length) {
    await readoptTabs(unlisted);
    server = await fetchServerTabs();
  }
  let initialTabs: SavedTab[] =
    server && server.length
      ? server
      : cached.tabs.length
        ? cached.tabs.slice()
        : [{ name: defaultSessionName, displayName: defaultSessionName }];
  if (urlSession && !initialTabs.some((t) => t.name === urlSession)) {
    initialTabs = [{ name: urlSession, displayName: urlSession }, ...initialTabs];
  }
  if (!TOUCH_DEVICE) initialTabs = restoreTabOrder(initialTabs, cached.tabs.map(tab => tab.name));
  defaultSessionName = urlSession ?? initialTabs[0]?.name ?? 'web';

  // The stored prefs land before any tab is built, so a pane is created at the
  // font it will keep and nothing has to be re-fitted afterwards. A device that
  // still has its localStorage has already applied the same values; this only
  // differs on one that lost them (see fetchServerPrefs).
  const prefs = (await prefsPromise) ?? {};
  if (!themeChanged && isTheme(prefs.theme)) setTheme(prefs.theme);
  if (typeof prefs.fontSize === 'number' && Number.isFinite(prefs.fontSize)) {
    currentFont = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(prefs.fontSize)));
    updateFontVal();
    try {
      // Refill the cache, so a device that does keep its storage paints at the
      // right size before the server has answered.
      localStorage.setItem('tw.fontSize', String(currentFont));
    } catch {
      /* ignore */
    }
  }
  if (typeof prefs.keybar === 'boolean' && prefs.keybar !== isKeybarVisible()) {
    setKeybarVisible(prefs.keybar);
  }
  if (!keyboardLockChanged && typeof prefs.keyboardLocked === 'boolean') {
    setKeyboardLocked(prefs.keyboardLocked);
  }

  // Build every tab (creation order is tab order). None of them attaches here:
  // activating one is what opens its socket, on the frame after its pane has
  // been laid out and measured — so a tab attaches at the size it will really
  // have, and a tab nobody opens costs nothing at all.
  //
  // Whether a tab was split is this device's own memory of it — the server has
  // nothing to say about it, and the phone you also read this on wants its own
  // answer. Only the tab you open acts on it, so a split tab you never look at
  // still opens no second session.
  const cachedViews = new Map(cached.tabs.map((t) => [t.name, t.view]));
  const cachedCwds = new Map(cached.tabs.map((t) => [t.name, t.cwd]));
  await foldersPromise;
  for (const t of initialTabs) {
    const s = addSession(t.name, false, t.displayName);
    s.cwd = t.cwd ?? cachedCwds.get(t.name) ?? null;
    s.view = cachedViews.get(t.name) ?? 'one';
    // Asked for by name in the URL, or the default on a first visit: both are
    // tabs being made, not remembered, so they may create their session.
    if (t.name === urlSession || (!server?.length && !cached.tabs.length)) s.intendCreate();
  }

  // This device's own last focus first, then what the server remembers for its
  // kind of device — which is what is left after a storage wipe.
  const wanted = [urlSession, cached.active, prefs.activeTab].filter(
    (n): n is string => typeof n === 'string' && n.length > 0,
  );
  const active = wanted.map((n) => sessions.find((s) => s.name === n)).find(Boolean);
  activateSession(active ?? sessions[0]);

  // Everything restored: from here on, changes are the user's and get saved.
  prefsReady = true;
  if (themeChanged) savePrefs({ theme: currentTheme });
  if (keyboardLockChanged) savePrefs({ keyboardLocked });
}

void init();
connectAgentStatus();

// Keep the tab list in sync with the server: when the page regains focus /
// visibility, and on a light interval while visible.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const session of sessions) session.stopTouchScroll();
  }
  if (document.visibilityState === 'visible') void syncFromServer();
});
window.addEventListener('focus', () => {
  void syncFromServer();
  updateOutputActivity(); // coming back to the page reads what is on screen
});
setInterval(() => {
  if (document.visibilityState === 'visible') void syncFromServer();
}, 5000);

// Default: show the key bar on touch devices, hidden on desktop (unless saved).
const keybarDefault = (() => {
  try {
    const v = localStorage.getItem('tw.keybar');
    if (v !== null) return v === '1';
  } catch {
    /* ignore */
  }
  return TOUCH_DEVICE;
})();
setKeybarVisible(keybarDefault);


// Same-origin embedded file view isolates its CSS/keyboard handling while the
// terminal sockets and tmux processes remain attached behind it.
function openFileBrowser(): void {
  const session = activeSession;
  if (!session) return;
  closeSheet(); closeDrawer(); hideSelectionBar();
  for (const item of sessions) { item.stopTouchScroll(); item.mate?.stopTouchScroll(); }
  (document.activeElement as HTMLElement | null)?.blur();
  if (!fileBrowserFrame) {
    fileBrowserFrame = document.createElement('iframe');
    fileBrowserFrame.id = 'file-browser-frame';
    fileBrowserFrame.title = '服务器文件管理';
    fileBrowserFrame.addEventListener('load', () => {
      fileBrowserFrame?.contentWindow?.postMessage({ type: 'terminal-theme', theme: currentTheme }, location.origin);
    });
    document.body.append(fileBrowserFrame);
  }
  if (fileBrowserSession !== session.name) {
    fileBrowserSession = session.name;
    fileBrowserFrame.src = `/file-browser.html?${new URLSearchParams({ session: session.name, label: session.displayName, theme: currentTheme })}`;
  }
  fileBrowserOpen = true;
  document.body.classList.add('file-browser-open');
  fileBrowserFrame.hidden = false;
  sizeFileBrowser();
  document.title = `文件管理 · ${session.displayName}`;
}
function sizeFileBrowser(): void {
  if (!fileBrowserOpen || !fileBrowserFrame) return;
  const viewport = window.visualViewport;
  fileBrowserFrame.style.height = `${viewport?.height ?? window.innerHeight}px`;
  fileBrowserFrame.style.top = `${viewport?.offsetTop ?? 0}px`;
}
function closeFileBrowser(): void {
  fileBrowserOpen = false;
  document.body.classList.remove('file-browser-open');
  if (fileBrowserFrame) fileBrowserFrame.hidden = true;
  markVisibleSessionsRead();
  refreshMobileUI();
  requestAnimationFrame(() => { updateKeyboardOffset(); fitActive(); if (!TOUCH_DEVICE) activeSession?.focus(); });
}
function markVisibleSessionsRead(): void {
  if (fileBrowserOpen || document.visibilityState !== 'visible') return;
  for (const s of [activeTab, activeTab?.mate]) {
    if (s && isActive(s) && !s.el.classList.contains('hidden')) s.readState.enter();
  }
  updateOutputActivity();
}
document.addEventListener('visibilitychange', markVisibleSessionsRead);
// 同时校验来源域与 iframe 实例，只有当前文件视图可以触发终端会话切换。
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== fileBrowserFrame?.contentWindow) return;
  const data = event.data as { type?: string; name?: string; displayName?: string } | null;
  if (data?.type === 'files-close') closeFileBrowser();
  if (data?.type === 'files-auth-expired') location.reload();
  if (data?.type === 'files-open-terminal' && typeof data.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.name)) {
    closeFileBrowser();
    addSession(data.name, true, typeof data.displayName === 'string' ? data.displayName : data.name);
  }
});
window.addEventListener('resize', sizeFileBrowser);
window.visualViewport?.addEventListener('resize', sizeFileBrowser);
window.visualViewport?.addEventListener('scroll', sizeFileBrowser);

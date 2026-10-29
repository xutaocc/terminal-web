import { renderAgentLabel, agentSessionId } from './agent-identity.js';
import { mobileActions, mountMobileActions, type ActionContext } from './mobile-actions.js';
import { shareStorage as localStorage } from './share-context.js';
import { sortRecentEntries } from './recent-tabs.js';
import type { QuickSessionKind } from './quick-session-nav.js';
import { type FolderGroup, groupByDirectory, orderBy, orderCards, reorderCards, shortCwd } from './project-groups.js';
import { bindIntentionalClick } from './intentional-click.js';
import { brandMark } from './brand-mark.js';
import { hostOfKey, labelBadge, splitKey } from './hosts.js';

/** What a card needs to know about a session. */
export interface SidebarSession { name: string; displayName: string; cwd: string | null; pinned?: boolean }

/**
 * One server's sessions. With no remotes there is a single local section and
 * the list looks as it always has; with remotes, each server is a top-level
 * folder of its own, its folders nested inside.
 */
export interface SidebarSection {
  host: string;
  title: string;
  /** The address it is known by (LAN / Tailscale IP), shown beside the title. */
  ip: string;
  /** Its tag: the badge's name, colour and the note shown on hover. */
  tag: { name: string; color: string; note: string };
  remote: boolean;
  online: boolean;
  home: string;
  groups: FolderGroup<SidebarSession>[];
}

export interface RecentVisitEntry {
  name: string; title: string; detail: string; current: boolean; offline: boolean; status: string;
}

export interface SidebarHooks {
  readOnly?: boolean;
  recentEntries(): RecentVisitEntry[];
  recentLimit(): number;
  setRecentLimit(count: number): void;
  navigateRecent(name?: string): void;
  removeRecent(name: string): void;
  /** Apply persistent session marks before a new chip enters the document. */
  decorateChip(chip: HTMLElement, name: string): void;
  dismiss(): void;
  editSession(name: string): void;
  baseSession(name: string): void;
  activate(name: string): void;
  /** A directory card was clicked: show one of these sessions (they share its directory). */
  activateDirectory(names: string[]): void;
  /** New session in a folder ('' for none), starting in `directory` ('' for the active one's). */
  newSession(folderId: string, directory: string): void;
  /** New folder on a server; it starts with a new session, so it is never empty. */
  newFolder(host: string): void;
  renameFolder(id: string, name: string): void;
  /**
   * Move sessions into a folder ('' takes them out of any). `card` is set when
   * a whole directory card moves, so its name can go with it.
   */
  moveSessions(names: string[], folderId: string, card?: { cwd: string; name: string }): void;
  /** Name a directory card within its folder; '' restores the directory's own name. */
  renameDir(folderId: string, cwd: string, name: string): void;
  /** A folder's cards were dragged into a new order (their cwds, first to last). */
  orderCards(folderId: string, cwds: string[]): void;
  /** Pin a session to the top of its directory card, or unpin it. */
  pinSession(name: string, pinned: boolean): void;
  /** Close these sessions (their tmux sessions end); the page asks first. */
  cleanupHistory?(host: string): void;
  canClose?(name: string): boolean;
  isRemoteAgent?(name: string): boolean;
  closeSessions(names: string[]): void;
  /** Copy the clicked session's current absolute directory without activating it. */
  copySessionDirectory(names: string[]): void;
  /** A chip was dragged onto another in the same card: put `name` before or after `target`. */
  reorderSession(name: string, target: string, after: boolean): void;
  /** A server's block was dragged into a new place among the others (host keys, first to last). */
  orderHosts(hosts: string[]): void;
  /** A host's attention pill was clicked: show the session that wants you most. */
  attend(host: string): void;
  navigateStatus(kind: QuickSessionKind): void;
  openSettings(): void;
  openHelp(): void;
  /** The sidebar's width changed (shown, hidden or dragged). */
  resized(): void;
}

const MIN_WIDTH = 200;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 260;

const svg = (body: string, size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  panel: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>', 16),
  folder: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  folderPlus: svg('<path d="M12 10v6m-3-3h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  plus: svg('<path d="M5 12h14M12 5v14"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>', 12),
  chevron: svg('<path d="m6 9 6 6 6-6"/>', 12),
  pencil: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>', 12),
  terminal: svg('<path d="m4 17 6-6-6-6M12 19h8"/>', 13),
  gear: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>'),
  locate: svg('<circle cx="12" cy="12" r="10"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>'),
  pin: svg('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>', 11),
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore — layout memory is a convenience */
  }
}

function iconButton(icon: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ps-icon-btn';
  button.title = title;
  if (document.body.classList.contains('share-mode') && /新建|重命名/.test(title)) button.style.display = 'none';
  button.setAttribute('aria-label', title);
  button.innerHTML = icon;
  bindIntentionalClick(button, e => {
    e.stopPropagation();
    onClick(e);
  });
  return button;
}

/**
 * The desktop left column: sessions filed under project directories, one card
 * per session. It only draws; terminal.ts owns the sessions and calls render
 * whenever they, their directories or the project list change. Width, whether
 * it is shown and which groups are folded are this device's own memory.
 */
export class ProjectSidebar {
  private selectionCard: string | null = null;
  private selectedSessions = new Set<string>();
  readonly el = document.createElement('aside');
  private readonly list = document.createElement('div');
  private width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(readJson('tw.sidebar.width', DEFAULT_WIDTH)) || DEFAULT_WIDTH));
  private hidden = readJson<unknown>('tw.sidebar.hidden', false) === true;
  private readonly folded = new Set<string>(readJson<string[]>('tw.sidebar.folded', []));
  private signature = '';
  private lastRender: { sections: SidebarSection[]; groups: FolderGroup<SidebarSession>[]; active: string | null } | null = null;
  /**
   * Sessions being dragged, with the folder they came from, the card's carried
   * name (if it has one) and, for a whole card, its directory — which is what
   * lets it be dropped between other cards to reorder them.
   */
  private dragging: {
    names: string[]; from: string; card?: { cwd: string; name: string }; cardCwd?: string;
    /** A single chip: the card (folder + directory) it was in, for reordering inside it. */
    chipIn?: string;
    /** A server's whole block, dragged by its header to another place among the servers. */
    hostBlock?: string;
  } | null = null;
  private readonly shareCount = document.createElement('span');
  private readonly mobileShareCount = document.createElement('span');
  private sharedSessions = new Map<string, number>();
  private sharingSignature = '';
  private menu: HTMLElement | null = null;
  private dismissRecentPanel: (() => void) | null = null;
  private dismissMobileMenu: (() => void) | null = null;
  private readonly quickPills = new Map<QuickSessionKind, HTMLButtonElement>();

  private readonly recentButton = document.createElement('button');
  private readonly recentToggle = document.createElement('button');
  private readonly recentMenu = document.createElement('div');
  private readonly recentItems = document.createElement('div');
  private readonly recentLimitInput = document.createElement('input');
  private readonly recentPresets = new Map<number, HTMLButtonElement>();
  private readonly recentWrap = document.createElement('div');
  private recentSignature = '';

  constructor(private readonly hooks: SidebarHooks) {
    this.el.id = 'sidebar';

    const top = document.createElement('div');
    top.className = 'ps-top';
    top.append(brandMark('ps-brand'), iconButton(ICONS.panel, '收起侧栏', () => this.setHidden(true)));

    const header = document.createElement('div');
    header.className = 'ps-header';
    const title = document.createElement('span');
    title.className = 'ps-title';
    title.textContent = '会话';
    this.shareCount.className = 'ps-share-count';
    this.shareCount.hidden = true;
    title.append(this.shareCount);
    header.append(
      title,
      iconButton(ICONS.folderPlus, '新建文件夹', () => hooks.newFolder(hostOfKey(this.activeFolder()))),
      iconButton(ICONS.plus, '新建会话', () => hooks.newSession(this.activeFolder(), '')),
    );

    const quick = document.createElement('div');
    quick.className = 'ps-quick-status';
    quick.setAttribute('aria-label', '所有主机会话快捷定位');
    for (const kind of ['unread', 'working'] as const) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `ps-quick-pill ${kind}`;
      pill.dataset.kind = kind;
      const dot = document.createElement('span');
      dot.className = `tab-dot ${kind}`;
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = kind === 'unread' ? '待处理' : '执行中';
      const count = document.createElement('span');
      count.className = 'ps-quick-count';
      count.textContent = '0';
      pill.append(dot, label, count);
      pill.disabled = true;
      bindIntentionalClick(pill, () => hooks.navigateStatus(kind));
      this.quickPills.set(kind, pill);
      quick.append(pill);
    }
    this.recentWrap.className = 'ps-recent';
    this.recentButton.type = this.recentToggle.type = 'button';
    this.recentButton.className = 'ps-quick-pill ps-recent-main';
    this.recentButton.textContent = '◷ 最近访问 0';
    this.recentButton.disabled = true;
    this.recentToggle.className = 'ps-quick-pill ps-recent-toggle';
    this.recentToggle.textContent = '▾';
    this.recentToggle.disabled = false;
    this.recentToggle.setAttribute('aria-label', '展开最近访问会话');
    this.recentToggle.setAttribute('aria-expanded', 'false');
    this.recentToggle.setAttribute('aria-controls', 'ps-recent-menu');
    this.recentMenu.id = 'ps-recent-menu';
    this.recentMenu.className = 'ps-recent-menu';
    this.recentMenu.hidden = true;
    const settings = document.createElement('form'); settings.className = 'ps-recent-settings';
    const heading = document.createElement('div'); heading.textContent = '最近访问数量'; heading.className = 'ps-recent-settings-label';
    const presets = document.createElement('div'); presets.className = 'ps-recent-presets';
    for (const count of [2, 3, 5, 8, 10]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = String(count);
      button.title = `只在最近 ${count} 个会话间切换`;
      bindIntentionalClick(button, () => hooks.setRecentLimit(count));
      this.recentPresets.set(count, button); presets.append(button);
    }
    const custom = document.createElement('label'); custom.className = 'ps-recent-custom';
    const input = this.recentLimitInput; input.type = 'number'; input.min = '1'; input.max = '50'; input.step = '1'; input.required = true; input.inputMode = 'numeric'; input.setAttribute('aria-label', '自定义最近访问数量，1 到 50');
    const apply = document.createElement('button'); apply.type = 'submit'; apply.textContent = '设置';
    custom.append('自定义', input, apply);
    settings.addEventListener('submit', event => { event.preventDefault(); if (input.reportValidity()) hooks.setRecentLimit(Number(input.value)); });
    const hint = document.createElement('small'); hint.textContent = '点击主按钮循环切换，刷新后保留设置';
    settings.append(heading, presets, custom, hint);
    this.recentMenu.append(settings, this.recentItems);

    bindIntentionalClick(this.recentButton, () => { this.closeRecent(); hooks.navigateRecent(); });
    bindIntentionalClick(this.recentToggle, () => {
      this.updateRecent();
      this.recentMenu.hidden = !this.recentMenu.hidden;
      this.recentToggle.setAttribute('aria-expanded', String(!this.recentMenu.hidden));
    });
    this.recentWrap.append(this.recentButton, this.recentToggle, this.recentMenu);
    quick.append(this.recentWrap);
    this.mobileShareCount.className = 'ps-share-count ps-share-count-mobile';
    this.mobileShareCount.hidden = true;
    quick.append(this.mobileShareCount);
    this.updateQuickCounts({ unread: 0, working: 0 });
    this.list.className = 'ps-list';

    const footer = document.createElement('div');
    footer.className = 'ps-footer';
    const left = document.createElement('div');
    const right = document.createElement('div');
    left.append(
      iconButton(ICONS.gear, '设置', () => hooks.openSettings()),
      iconButton(ICONS.help, '帮助', () => hooks.openHelp()),
    );
    right.append(
      iconButton(ICONS.locate, '定位到当前会话', () => this.revealActive()),
      iconButton(ICONS.panel, '收起侧栏', () => this.setHidden(true)),
    );
    footer.append(left, right);

    const handle = document.createElement('div');
    handle.className = 'ps-resize';
    handle.title = '拖动调整宽度，双击恢复默认';
    this.bindResize(handle);

    this.el.append(top, header, quick, this.list, footer, handle);
    this.applyWidth();
    document.addEventListener('pointerdown', e => {
      if (!this.dismissMobileMenu && this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
      if (!this.dismissRecentPanel && !this.recentWrap.contains(e.target as Node)) this.closeRecent();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        this.closeMenu();
        if (!this.recentMenu.hidden) { this.closeRecent(); this.recentToggle.focus(); e.stopPropagation(); }
      }
    });
  }

  /** The folder holding the active session ('' for none). */
  private activeFolder(): string {
    const last = this.lastRender;
    return last?.groups.find(g => g.items.some(s => s.name === last.active))?.key ?? '';
  }

  get isHidden(): boolean { return this.hidden; }

  setHidden(hidden: boolean): void {
    if (hidden && this.el.closest('.drawer')) { this.closeMenu(); this.hooks.dismiss(); return; }
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    writeJson('tw.sidebar.hidden', hidden);
    this.applyWidth();
    this.hooks.resized();
  }

  /** Redraw, unless nothing the cards show has changed since last time. */
  /** folder id -> cwd -> the name the user gave that card. */
  private dirNames: Record<string, Record<string, string>> = {};
  /** folder id -> the cwds of its cards, in the order the user dragged them into. */
  private cardOrder: Record<string, string[]> = {};
  /** The servers' host keys, in the order the user dragged their blocks into ('' is this server). */
  private hostOrder: string[] = [];

  render(unordered: SidebarSection[], active: string | null,
         dirNames: Record<string, Record<string, string>> = this.dirNames,
         cardOrder: Record<string, string[]> = this.cardOrder,
         hostOrder: string[] = this.hostOrder): void {
    this.dirNames = dirNames;
    this.cardOrder = cardOrder;
    this.hostOrder = hostOrder;
    const sections = orderBy(unordered, sec => sec.host, hostOrder);
    const signature = JSON.stringify([[...this.folded], dirNames, cardOrder, hostOrder, sections.map(sec => [
      sec.host, sec.title, sec.ip, sec.tag, sec.online, sec.home, sec.groups.map(g => [
        g.key, g.folder?.name, g.items.map(s => [s.name, s.displayName, s.cwd, !!s.pinned]),
      ])])]);
    const previousActive = this.lastRender?.active;
    this.lastRender = { sections, groups: sections.flatMap(sec => sec.groups), active };
    if (signature === this.signature) {
      if (active === previousActive) return;
      // Selection is presentation state, not a reason to discard every chip.
      for (const dot of this.dots()) {
        const names = (dot.dataset.sessions ?? '').split(' ');
        const target = dot.closest('.ps-chip') ?? dot.closest('.ps-card');
        target?.classList.toggle('active', !!active && names.includes(active));
      }
      return;
    }
    this.signature = signature;

    const scrollTop = this.list.scrollTop;
    this.list.replaceChildren();
    for (const section of sections) {
      const { groups, home } = section;
      const target = this.buildHost(section);
      if (!target) continue;
      // With no folders there is nothing to tell the loose sessions apart from:
      // they are listed as they are, with no "未分组" heading over them.
      const flat = groups.length === 1 && !groups[0].folder;
      for (const group of groups) {
        target.append(flat ? this.buildCards(group, active, home, document.createElement('section')) : this.buildGroup(group, active, home));
      }
      if (!groups.length) {
        const empty = document.createElement('div');
        empty.className = 'ps-host-empty';
        empty.textContent = section.online ? '暂无会话' : '无法连接，稍后自动重试';
        target.append(empty);
      }
    }
    this.list.scrollTop = scrollTop;
  }

  /**
   * A server's top-level folder: badge, name, whether it answers, and its own
   * new-folder / new-session buttons. Returns where its groups go, or null
   * while it is folded.
   */
  private buildHost(section: SidebarSection): HTMLElement | null {
    const key = `host:${section.host}`;
    const el = document.createElement('section');
    el.className = 'ps-host';
    el.classList.toggle('remote', section.remote);
    el.classList.toggle('offline', !section.online);
    const folded = this.folded.has(key);
    el.classList.toggle('folded', folded);
    this.bindHostReorder(el, section.host);
    const head = document.createElement('div');
    head.className = 'ps-host-head';
    head.title = [section.remote ? `远程主机：${section.title}` : '本机上的会话', section.tag.note].filter(Boolean).join('\n');
    this.bindHostDrag(head, section.host);
    const chevron = document.createElement('span');
    chevron.className = 'ps-chevron';
    chevron.innerHTML = ICONS.chevron;
    const badge = labelBadge(section.tag.name, section.tag.color, section.tag.note);
    const name = document.createElement('span');
    name.className = 'ps-host-name';
    name.textContent = section.title;
    const ip = document.createElement('span');
    ip.className = `host-ip ${section.remote ? 'remote' : 'local'}`;
    ip.textContent = section.ip;
    ip.hidden = !section.ip;
    head.title = `${section.remote ? '远程主机' : '本机'}：${section.title}${section.ip ? `（${section.ip}）` : ''}`;
    // What on this server is waiting for you, painted by the page as statuses
    // change (see attention()); empty, and so hidden, when nothing is.
    const attention = document.createElement('button');
    attention.type = 'button';
    attention.className = 'ps-host-attention';
    attention.dataset.host = section.host;
    attention.hidden = true;
    attention.addEventListener('click', e => {
      e.stopPropagation();
      if (this.folded.delete(key)) { this.saveFolded(); this.rerender(); }
      this.hooks.attend(section.host);
    });
    const state = document.createElement('span');
    state.className = 'ps-host-state';
    state.title = section.online ? '已连接' : '无法连接';
    const count = document.createElement('span');
    count.className = 'ps-group-count';
    count.textContent = String(section.groups.reduce((n, g) => n + g.items.length, 0));
    const actions = document.createElement('span');
    actions.className = 'ps-group-actions';
    actions.append(
      iconButton('↑', '主机上移', () => this.shiftHost(section.host, -1)),
      iconButton('↓', '主机下移', () => this.shiftHost(section.host, 1)),
      iconButton(ICONS.folderPlus, `在「${section.title}」新建文件夹`, () => this.hooks.newFolder(section.host)),
      iconButton(ICONS.plus, `在「${section.title}」新建会话`, () =>
        this.hooks.newSession(section.groups.find(g => !g.folder)?.key ?? (section.host ? `@${section.host}/` : ''), '')),
    );
    if (!this.hooks.readOnly && this.hooks.cleanupHistory) actions.append(iconButton('⌫', `清理「${section.title}」已关闭会话记录`, () => this.hooks.cleanupHistory?.(section.host)));
    head.append(chevron, badge, attention, name, ip, state, count, actions);
    bindIntentionalClick(head, () => {
      if (this.folded.has(key)) this.folded.delete(key);
      else this.folded.add(key);
      this.saveFolded();
      this.rerender();
    }, this.list);
    el.append(head);
    this.list.append(el);
    if (folded) return null;
    const body = document.createElement('div');
    body.className = 'ps-host-body';
    el.append(body);
    return body;
  }

  /** Dragging a server's header takes its whole block along (see bindHostReorder). */
  private bindHostDrag(head: HTMLElement, host: string): void {
    head.draggable = !mobileActions();
    head.addEventListener('dragstart', e => {
      if (mobileActions()) { e.preventDefault(); return; }
      e.stopPropagation();
      this.dragging = { names: [], from: '', hostBlock: host };
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-terminal-host', host);
      }
    });
    head.addEventListener('dragend', () => {
      this.dragging = null;
      this.list.querySelectorAll('.ps-host').forEach(el => el.classList.remove('ps-drop-before', 'ps-drop-after'));
    });
  }

  /**
   * A server's block dropped onto another goes before or after it, by which
   * half of it the pointer is over; a line shows where. Its folders and cards
   * go with it. Sessions dropped here are left to the folders inside.
   */
  private bindHostReorder(el: HTMLElement, host: string): void {
    const side = (e: DragEvent): boolean => {
      const r = el.getBoundingClientRect();
      return e.clientY >= r.top + r.height / 2;
    };
    const mine = (): boolean => this.dragging?.hostBlock !== undefined && this.dragging.hostBlock !== host;
    el.addEventListener('dragover', e => {
      if (!mine()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const after = side(e);
      el.classList.toggle('ps-drop-after', after);
      el.classList.toggle('ps-drop-before', !after);
    });
    el.addEventListener('dragleave', e => {
      if (!el.contains(e.relatedTarget as Node)) el.classList.remove('ps-drop-before', 'ps-drop-after');
    });
    el.addEventListener('drop', e => {
      const drag = this.dragging;
      if (drag?.hostBlock === undefined || !mine()) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('ps-drop-before', 'ps-drop-after');
      const current = this.lastRender?.sections.map(sec => sec.host) ?? [];
      const next = reorderCards(current, drag.hostBlock, host, side(e));
      this.hostOrder = next;
      this.rerender();
      this.hooks.orderHosts(next);
    });
  }

  openRecentPanel(): void {
    this.closeRecent();
    this.updateRecent();
    this.recentMenu.hidden = false;
    this.recentMenu.classList.add('ps-menu');
    const heading = document.createElement('div');
    heading.className = 'ps-menu-title'; heading.textContent = '最近访问';
    this.recentMenu.prepend(heading);
    this.dismissRecentPanel = mountMobileActions(this.recentMenu, () => this.closeRecent());
    this.recentToggle.setAttribute('aria-expanded', 'true');
  }

  private closeRecent(): void {
    if (this.dismissRecentPanel) {
      this.recentWrap.append(this.recentMenu);
      this.dismissRecentPanel();
      this.dismissRecentPanel = null;
    }
    this.recentMenu.classList.remove('ps-menu');
    this.recentMenu.querySelector('.ps-menu-title')?.remove();
    this.recentMenu.hidden = true;
    this.recentToggle.setAttribute('aria-expanded', 'false');
  }

  updateRecent(): void {
    const entries = this.hooks.recentEntries();
    const limit = this.hooks.recentLimit();
    const signature = JSON.stringify([limit, entries]);
    if (signature === this.recentSignature) return;
    this.recentSignature = signature;
    this.recentButton.textContent = `◷ 最近访问 ${limit}`;
    this.recentButton.disabled = !entries.some(e => !e.offline);
    this.recentToggle.disabled = false;
    const at = entries.findIndex(e => e.current);
    const next = [...entries.slice(at + 1), ...entries.slice(0, at + 1)].find(e => !e.offline);
    this.recentButton.title = next ? `点击循环切换，下一个：${next.title}` : '暂无可访问会话';
    if (document.activeElement !== this.recentLimitInput) this.recentLimitInput.value = String(limit);
    for (const [count, button] of this.recentPresets) button.setAttribute('aria-pressed', String(count === limit));
    this.recentItems.replaceChildren();
    for (const entry of sortRecentEntries(entries)) {
      const item = document.createElement('div');
      item.className = 'ps-recent-item';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ps-recent-entry';
      row.disabled = entry.offline;
      row.setAttribute('aria-current', String(entry.current));
      const title = document.createElement('span');
      const dot = document.createElement('span');
      dot.className = `tab-dot ${entry.status}`;
      dot.setAttribute('aria-hidden', 'true');
      title.append(dot, document.createTextNode(`${entry.title}${entry.current ? ' · 当前' : ''}${entry.offline ? ' · 离线' : ''}`));
      const detail = document.createElement('small');
      detail.textContent = entry.detail;
      row.title = `${entry.title} · ${entry.detail}`;
      row.append(title, detail);
      bindIntentionalClick(row, () => { this.closeRecent(); this.hooks.navigateRecent(entry.name); });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ps-recent-remove';
      remove.textContent = '×';
      remove.title = '从最近访问移除（不关闭会话）';
      remove.setAttribute('aria-label', `从最近访问移除：${entry.title}`);
      bindIntentionalClick(remove, () => {
        const hadFocus = document.activeElement === remove;
        const at = [...this.recentItems.children].indexOf(item);
        this.hooks.removeRecent(entry.name);
        if (hadFocus) {
          const remaining = this.recentMenu.querySelectorAll<HTMLButtonElement>('.ps-recent-remove');
          const target = remaining[Math.min(at, remaining.length - 1)];
          (target ?? this.recentButton).focus();
        }
      });
      item.append(row, remove);
      this.recentItems.append(item);
    }
    if (!entries.length) { const empty = document.createElement('div'); empty.className = 'ps-recent-empty'; empty.textContent = '暂无最近访问会话'; this.recentItems.append(empty); }
  }

  updateQuickCounts(counts: Record<QuickSessionKind, number>): void {
    for (const [kind, pill] of this.quickPills) {
      const n = counts[kind];
      const label = kind === 'unread' ? '待处理' : '执行中';
      const text = n > 99 ? '99+' : String(n);
      const count = pill.querySelector('.ps-quick-count')!;
      if (count.textContent !== text) count.textContent = text;
      pill.disabled = n === 0;
      pill.title = n ? `所有主机共 ${n} 个${label}会话，点击循环进入` : `暂无${label}会话`;
      pill.setAttribute('aria-label', `${label} ${n}，${n ? '点击进入下一个会话' : '暂无会话'}`);
    }
  }

  /** The same order used for cards/chips, including content hidden by folding. */
  sessionOrder(): string[] {
    return (this.lastRender?.sections ?? []).flatMap(section => section.groups.flatMap(group =>
      orderCards(groupByDirectory(group.items, item => item.cwd), this.cardOrder[group.key])
        .flatMap(dir => dir.items.map(item => item.name))));
  }

  /** Each server's attention pill (data-host), for the caller to paint. */
  attention(): NodeListOf<HTMLElement> {
    return this.list.querySelectorAll<HTMLElement>('.ps-host-attention');
  }

  /** Scroll a session's chip into view and flash it. */
  reveal(name: string): void {
    const group = this.lastRender?.groups.find(g => g.items.some(s => s.name === name));
    const unfoldedGroup = !!group && this.folded.delete(group.key);
    const unfoldedHost = this.folded.delete(`host:${hostOfKey(name)}`);
    if (unfoldedGroup || unfoldedHost) {
      this.saveFolded();
      this.rerender();
    }
    const chip = Array.from(this.list.querySelectorAll<HTMLElement>('.ps-chip .tab-dot'))
      .find(dot => dot.dataset.sessions === name)?.closest<HTMLElement>('.ps-chip');
    const target = chip;
    if (!target) return;
    target.scrollIntoView({ block: 'nearest' });
    target.classList.remove('flash');
    void target.offsetWidth; // restart the animation
    target.classList.add('flash');
  }

  /** The status dots of every card, for the caller to paint. */
  dots(): NodeListOf<HTMLElement> {
    return this.list.querySelectorAll<HTMLElement>('.ps-card .tab-dot');
  }

  /** Scroll the active session's card into view, unfolding its group, and flash it. */
  revealActive(): void {
    const last = this.lastRender;
    const group = last?.groups.find(g => g.items.some(s => s.name === last.active));
    const unfoldedGroup = !!group && this.folded.delete(group.key);
    const unfoldedHost = this.folded.delete(`host:${hostOfKey(last?.active ?? '')}`);
    if (unfoldedGroup || unfoldedHost) {
      this.saveFolded();
      this.rerender();
    }
    const card = this.list.querySelector<HTMLElement>('.ps-card.active');
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    card.classList.remove('flash');
    void card.offsetWidth; // restart the animation
    card.classList.add('flash');
  }

  private rerender(): void {
    if (!this.lastRender) return;
    this.signature = '';
    const { sections, active } = this.lastRender;
    this.render(sections, active);
  }

  private saveFolded(): void {
    writeJson('tw.sidebar.folded', [...this.folded]);
  }

  private buildGroup(group: FolderGroup<SidebarSession>, active: string | null, home: string): HTMLElement {
    const el = document.createElement('section');
    el.className = 'ps-group';
    el.classList.toggle('loose', !group.folder);
    el.dataset.key = group.key;
    const folded = this.folded.has(group.key);
    el.classList.toggle('folded', folded);

    const head = document.createElement('div');
    head.className = 'ps-group-head';
    head.title = group.folder ? '' : '不在任何文件夹里的会话';
    const chevron = document.createElement('span');
    chevron.className = 'ps-chevron';
    chevron.innerHTML = ICONS.chevron;
    const name = document.createElement('span');
    name.className = 'ps-group-name';
    name.textContent = group.folder?.name ?? '未分组';
    const count = document.createElement('span');
    count.className = 'ps-group-count';
    count.textContent = String(group.items.length);
    const actions = document.createElement('span');
    actions.className = 'ps-group-actions';
    if (group.folder) {
      const folder = group.folder;
      const icon = document.createElement('span');
      icon.className = 'ps-group-icon';
      icon.innerHTML = ICONS.folder;
      head.append(chevron, icon, name, count, actions);
      // No delete: a folder goes when its last session does.
      actions.append(
        iconButton(ICONS.pencil, '重命名文件夹', () => this.startRename(name, folder)),
        iconButton(ICONS.plus, `在「${folder.name}」新建会话`, () => this.hooks.newSession(folder.id, '')),
      );
      name.addEventListener('dblclick', e => {
        e.stopPropagation();
        this.startRename(name, folder);
      });
    } else {
      head.append(chevron, name, count, actions);
    }
    bindIntentionalClick(head, () => {
      if (head.querySelector('.ps-rename')) return;
      if (this.folded.has(group.key)) this.folded.delete(group.key);
      else this.folded.add(group.key);
      this.saveFolded();
      this.rerender();
    }, this.list);
    this.bindDrop(head, group.key);
    el.append(head);
    if (folded) return el;
    return this.buildCards(group, active, home, el);
  }

  /** The folder's directory cards, each holding its sessions as chips. */
  private buildCards(group: FolderGroup<SidebarSession>, active: string | null, home: string, el: HTMLElement): HTMLElement {
    this.bindDrop(el, group.key);
    const dirs = orderCards(groupByDirectory(group.items, item => item.cwd), this.cardOrder[group.key]);
    for (const dir of dirs) {
      const names = dir.items.map(item => item.name);
      const selectionKey = JSON.stringify([group.key, dir.cwd]);
      const selecting = this.selectionCard === selectionKey;
      const closableNames = names.filter(name => this.hooks.canClose?.(name) !== false);
      if (selecting) this.selectedSessions = new Set(closableNames.filter(name => this.selectedSessions.has(name)));
      const card = document.createElement('div');
      card.className = 'ps-card';
      card.classList.toggle('active', !!active && names.includes(active));
      card.classList.toggle('ps-selecting', selecting);
      card.title = dir.cwd || '目录未知';
      const row = document.createElement('div');
      row.className = 'ps-card-row';
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      dot.dataset.sessions = names.join(' ');
      const glyph = document.createElement('span');
      glyph.className = 'ps-card-icon';
      glyph.innerHTML = ICONS.folder;
      const label = document.createElement('span');
      label.className = 'ps-card-name';
      const ownName = dir.cwd ? dir.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '/' : '目录未知';
      const given = dir.cwd ? this.dirNames[group.key]?.[dir.cwd] : undefined;
      label.textContent = given ?? ownName;
      row.append(dot, glyph, label);
      if (dir.cwd) {
        const cwd = dir.cwd;
        const edit = iconButton(ICONS.pencil, '重命名（只改显示名，不改目录）', () =>
          this.startRename(label, { id: '', name: label.textContent ?? '' }, value =>
            this.hooks.renameDir(group.key, cwd, value === ownName ? '' : value)));
        edit.classList.add('ps-card-add');
        row.append(edit);
        label.addEventListener('dblclick', e => {
          e.stopPropagation();
          edit.click();
        });
      }
      if (dir.cwd) {
        const cwd = dir.cwd;
        const add = iconButton(ICONS.plus, '在此目录新建会话', () => this.hooks.newSession(group.key, cwd));
        add.classList.add('ps-card-add');
        row.append(add);
      }
      row.append(iconButton('⋯', '目录操作', () => this.openMenuAt(row, names, group.key,
        label.textContent ?? '', dir.cwd ? { cwd: dir.cwd, name: given ?? '' } : undefined)));
      if (!this.hooks.readOnly && closableNames.length) {
        row.append(iconButton('☑', selecting ? '取消多选' : '多选会话', () => {
          this.selectionCard = selecting ? null : selectionKey;
          this.selectedSessions.clear();
          this.rerender();
        }));
      }
      const sub = document.createElement('div');
      sub.className = 'ps-card-sub';
      sub.textContent = shortCwd(dir.cwd, home);
      const chips = document.createElement('div');
      chips.className = 'ps-chips';
      for (const session of dir.items) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ps-chip';
        chip.classList.toggle('active', session.name === active);
        chip.classList.toggle('pinned', !!session.pinned);
        if (selecting) {
          chip.classList.toggle('ps-selected', this.selectedSessions.has(session.name));
          chip.setAttribute('aria-pressed', String(this.selectedSessions.has(session.name)));
          chip.disabled = this.hooks.canClose?.(session.name) === false;
          const check = document.createElement('span');
          check.className = 'ps-selection-check';
          check.textContent = this.selectedSessions.has(session.name) ? '☑' : '☐';
          chip.append(check);
        }
        chip.title = `${session.displayName}${session.pinned ? '（已置顶）' : ''}${mobileActions() ? '（点击进入，更多操作请点右侧 ⋯）' : '（拖到同一目录的其他会话旁可调整顺序，拖到文件夹可移动；右键置顶或移动）'}`;
        const chipDot = document.createElement('span');
        chipDot.className = 'tab-dot';
        chipDot.dataset.sessions = session.name;
        const chipName = document.createElement('span');
        chipName.className = 'ps-chip-name';
        renderAgentLabel(chipName, splitKey(session.name).raw, session.displayName);
        const agentId = agentSessionId(splitKey(session.name).raw);
        if (agentId) chip.title += ` · sessionId: ${agentId}`;
        chip.append(chipDot);
        const sharedCount = this.sharedSessions.get(session.name) ?? 0;
        if (sharedCount) {
          const lock = document.createElement('span'); lock.className = 'ps-share-lock';
          lock.title = `分享中：${sharedCount} 个有效 Token 已授权此会话`;
          lock.setAttribute('role', 'img'); lock.setAttribute('aria-label', lock.title);
          lock.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="7" width="10" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 7V4a3 3 0 0 1 6 0v3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="11" r="1" fill="currentColor"/></svg>';
          chip.append(lock);
        }
        chip.append(chipName);
        if (session.pinned) {
          const pin = document.createElement('span');
          pin.className = 'pin-mark';
          pin.innerHTML = ICONS.pin;
          chip.append(pin);
        }
        this.hooks.decorateChip(chip, session.name);
        bindIntentionalClick(chip, e => {
          e.stopPropagation();
          if (selecting) {
            if (this.hooks.canClose?.(session.name) === false) return;
            if (!this.selectedSessions.delete(session.name)) this.selectedSessions.add(session.name);
            this.rerender();
            return;
          }
          this.hooks.activate(session.name);
        }, this.list);
        const chipIn = `${group.key}\n${dir.cwd}`;
        if (!selecting) {
          this.bindDrag(chip, [session.name], group.key, undefined, undefined, chipIn);
          this.bindChipReorder(chip, session.name, chipIn);
        }
        chip.addEventListener('contextmenu', e => {
          e.preventDefault();
          if (mobileActions()) { e.stopPropagation(); return; }
          e.stopPropagation();
          this.openMenu(e, [session.name], group.key, session.displayName, undefined, !!session.pinned);
        });
        const wrap = document.createElement('span');
        wrap.className = 'ps-chip-wrap';
        wrap.append(chip);
        if (!this.hooks.readOnly && this.hooks.canClose?.(session.name) !== false) {
          const close = document.createElement('button');
          close.type = 'button'; close.className = 'ps-icon-btn ps-chip-close';
          close.textContent = '×';
          close.title = `关闭会话：${session.displayName}`;
          close.setAttribute('aria-label', close.title);
          bindIntentionalClick(close, e => {
            e.stopPropagation();
            if (!mobileActions() && this.hooks.canClose?.(session.name) !== false) this.hooks.closeSessions([session.name]);
          }, this.list);
          wrap.append(close);
        }
        wrap.append(iconButton('⋯', `管理会话：${session.displayName}`, () =>
          this.openMenuAt(chip, [session.name], group.key, session.displayName, undefined, !!session.pinned)));
        chips.append(wrap);
      }
      card.append(row);
      if (sub.textContent) card.append(sub);
      if (selecting) {
        const tools = document.createElement('div');
        tools.className = 'ps-selection-tools';
        const action = (text: string, run: () => void, disabled = false): void => {
          const button = document.createElement('button');
          button.type = 'button'; button.textContent = text; button.disabled = disabled;
          bindIntentionalClick(button, e => { e.stopPropagation(); run(); }, this.list);
          tools.append(button);
        };
        action('全选', () => { this.selectedSessions = new Set(closableNames); this.rerender(); });
        action('清空', () => { this.selectedSessions.clear(); this.rerender(); });
        action(`关闭已选（${this.selectedSessions.size}）`, () => {
          const selected = closableNames.filter(name => this.selectedSessions.has(name));
          this.hooks.closeSessions(selected);
        }, !this.selectedSessions.size);
        action('完成', () => { this.selectionCard = null; this.selectedSessions.clear(); this.rerender(); });
        card.append(tools);
      }
      card.append(chips);
      bindIntentionalClick(card, () => {
        if (!selecting && !card.querySelector('.ps-rename')) this.hooks.activateDirectory(names);
      }, this.list);
      // Only a name the user gave travels; a directory's own name is its own anywhere.
      const carry = dir.cwd && given ? { cwd: dir.cwd, name: given } : undefined;
      if (!selecting) {
        this.bindDrag(card, names, group.key, carry, dir.cwd || undefined);
        if (dir.cwd) this.bindReorder(card, group.key, dir.cwd, dirs.map(d => d.cwd).filter(Boolean));
      }
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (mobileActions()) { e.stopPropagation(); return; }
        this.openMenu(e, names, group.key, `${label.textContent}（${names.length} 个会话）`, carry);
      });
      el.append(card);
    }
    return el;
  }

  // -------------------------------------------------------------------------
  // Moving sessions: drag a chip or a whole card onto a folder, or right-click.
  // -------------------------------------------------------------------------
  private bindDrag(el: HTMLElement, names: string[], from: string, card?: { cwd: string; name: string }, cardCwd?: string,
                   chipIn?: string): void {
    el.draggable = !mobileActions();
    el.addEventListener('dragstart', e => {
      if (mobileActions()) { e.preventDefault(); return; }
      e.stopPropagation();
      this.dragging = { names, from, card, cardCwd, chipIn };
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-terminal-sessions', names.join(' '));
      }
      this.el.classList.add('ps-dragging');
    });
    el.addEventListener('dragend', () => {
      this.dragging = null;
      this.el.classList.remove('ps-dragging');
      for (const t of this.list.querySelectorAll('.ps-drop')) t.classList.remove('ps-drop');
      for (const t of this.list.querySelectorAll('.ps-drop-before, .ps-drop-after')) {
        t.classList.remove('ps-drop-before', 'ps-drop-after');
      }
    });
  }

  /**
   * A chip dropped onto another chip of the same card goes before or after it,
   * by which half of it the pointer is over; a line on that side shows where.
   * Dropped anywhere else it is a move to a folder, as before.
   */
  private bindChipReorder(chip: HTMLElement, name: string, chipIn: string): void {
    const side = (e: DragEvent): boolean => {
      const r = chip.getBoundingClientRect();
      return e.clientX >= r.left + r.width / 2;
    };
    const mine = (): boolean => {
      const d = this.dragging;
      return !!d && d.chipIn === chipIn && d.names.length === 1 && d.names[0] !== name;
    };
    chip.addEventListener('dragover', e => {
      if (!mine()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const after = side(e);
      chip.classList.toggle('ps-drop-after', after);
      chip.classList.toggle('ps-drop-before', !after);
    });
    chip.addEventListener('dragleave', e => {
      if (!chip.contains(e.relatedTarget as Node)) chip.classList.remove('ps-drop-before', 'ps-drop-after');
    });
    chip.addEventListener('drop', e => {
      const drag = this.dragging;
      if (!mine() || !drag) return;
      e.preventDefault();
      e.stopPropagation();
      chip.classList.remove('ps-drop-before', 'ps-drop-after');
      this.hooks.reorderSession(drag.names[0], name, side(e));
    });
  }

  /**
   * A whole card dropped onto another card in the same folder goes before or
   * after it, by which half of it the pointer is over; a line shows where.
   * From another folder, the drop falls through to the folder (a move).
   */
  private bindReorder(card: HTMLElement, folderId: string, cwd: string, order: string[]): void {
    const side = (e: DragEvent): boolean => {
      const r = card.getBoundingClientRect();
      return e.clientY >= r.top + r.height / 2;
    };
    const mine = (): boolean => {
      const d = this.dragging;
      return !!d?.cardCwd && d.from === folderId && d.cardCwd !== cwd;
    };
    card.addEventListener('dragover', e => {
      if (!mine()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const after = side(e);
      card.classList.toggle('ps-drop-after', after);
      card.classList.toggle('ps-drop-before', !after);
    });
    card.addEventListener('dragleave', e => {
      if (!card.contains(e.relatedTarget as Node)) card.classList.remove('ps-drop-before', 'ps-drop-after');
    });
    card.addEventListener('drop', e => {
      const drag = this.dragging;
      if (!mine() || !drag?.cardCwd) return;
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('ps-drop-before', 'ps-drop-after');
      const next = reorderCards(order, drag.cardCwd, cwd, side(e));
      this.cardOrder = { ...this.cardOrder, [folderId]: next };
      this.rerender();
      this.hooks.orderCards(folderId, next);
    });
  }

  private bindDrop(el: HTMLElement, folderId: string): void {
    const movable = (): boolean => !!this.dragging && this.dragging.names.length > 0 && this.dragging.from !== folderId &&
      hostOfKey(this.dragging.names[0]) === hostOfKey(folderId);
    el.addEventListener('dragover', e => {
      if (!movable()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      el.closest('.ps-group, section')?.classList.add('ps-drop');
    });
    el.addEventListener('dragleave', e => {
      if (!el.contains(e.relatedTarget as Node)) el.closest('.ps-group, section')?.classList.remove('ps-drop');
    });
    el.addEventListener('drop', e => {
      const drag = this.dragging;
      if (!drag || !movable()) return;
      e.preventDefault();
      e.stopPropagation();
      el.closest('.ps-group, section')?.classList.remove('ps-drop');
      this.hooks.moveSessions(drag.names, folderId, drag.card);
    });
  }

  private shiftHost(host: string, delta: number): void {
    const order = this.lastRender?.sections.map(s => s.host) ?? [];
    const at = order.indexOf(host), to = at + delta;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    this.hooks.orderHosts(order);
    this.render(this.lastRender!.sections, this.lastRender!.active, this.dirNames, this.cardOrder, order);
  }

  private openMenuAt(anchor: HTMLElement, names: string[], from: string, label: string,
                     card?: { cwd: string; name: string }, pinned?: boolean): void {
    const rect = anchor.getBoundingClientRect();
    this.openMenu({ clientX: rect.left, clientY: rect.bottom } as MouseEvent, names, from, label, card, pinned);
  }

  updateSharing(count: number, shared: Map<string, number>): void {
    const signature = JSON.stringify([count, [...shared].sort()]);
    if (signature === this.sharingSignature) return;
    this.sharingSignature = signature;
    this.sharedSessions = shared;
    for (const badge of [this.shareCount, this.mobileShareCount]) {
      badge.hidden = count === 0;
      badge.textContent = `分享中 ${count}`;
      badge.title = `${count} 个有效分享 Token（不是会话数或在线设备数）`;
    }
    this.rerender();
  }

  actionContext(name: string, count = 1, directoryOnly = false): ActionContext | undefined {
    const section = this.lastRender?.sections.find(s => s.host === hostOfKey(name));
    const group = section?.groups.find(g => g.items.some(s => s.name === name));
    const session = group?.items.find(s => s.name === name);
    if (!section || !group || !session) return undefined;
    const path = session.cwd || '';
    const directory = this.dirNames[group.key]?.[path] || path.split(/[\\/]/).filter(Boolean).pop() || (path ? '/' : '目录未知');
    return { tag: section.tag, remote: section.remote, hostTitle: section.title,
      directory, path, folder: group.folder?.name,
      session: directoryOnly ? undefined : session.displayName, count };
  }

  private openMenu(e: MouseEvent, names: string[], from: string, label: string, card?: { cwd: string; name: string },
                   pinned?: boolean): void {
    this.closeMenu();
    // A session can only move between folders of the server it runs on.
    const host = hostOfKey(names[0] ?? '');
    const folders = (this.lastRender?.groups ?? []).flatMap(g => g.folder && hostOfKey(g.key) === host ? [g.folder] : []);
    const menu = document.createElement('div');
    menu.className = 'ps-menu';
    const title = document.createElement('div');
    title.className = 'ps-menu-title';
    title.textContent = label;
    menu.append(title);
    const item = (text: string, onPick: () => void, disabled = false, danger = false): void => {
      if (this.hooks.readOnly && text !== '复制目录绝对路径') return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-menu-item' + (danger ? ' danger' : '');
      b.textContent = text;
      b.disabled = disabled;
      bindIntentionalClick(b, () => {
        this.closeMenu();
        onPick();
      }, menu);
      menu.append(b);
    };
    if (pinned !== undefined) {
      item('编辑名称和备注', () => this.hooks.editSession(names[0]));
      item('基于此会话新建', () => this.hooks.baseSession(names[0]));
      const group = this.lastRender?.groups.find(g => g.key === from);
      const session = group?.items.find(s => s.name === names[0]);
      const peers = group?.items.filter(s => s.cwd === session?.cwd && !!s.pinned === pinned) ?? [];
      const at = peers.findIndex(s => s.name === names[0]);
      item('向前移动', () => this.hooks.reorderSession(names[0], peers[at - 1].name, false), at <= 0);
      item('向后移动', () => this.hooks.reorderSession(names[0], peers[at + 1].name, true), at < 0 || at >= peers.length - 1);
      item('移到最前', () => this.hooks.reorderSession(names[0], peers[0].name, false), at <= 0);
    }
    if (card) {
      const group = this.lastRender?.groups.find(g => g.key === from);
      const dirs = orderCards(groupByDirectory(group?.items ?? [], s => s.cwd), this.cardOrder[from]).map(d => d.cwd).filter(Boolean);
      const at = dirs.indexOf(card.cwd);
      for (const [title, delta] of [['目录上移', -1], ['目录下移', 1]] as const) {
        const to = at + delta;
        item(title, () => {
          const next = [...dirs];
          [next[at], next[to]] = [next[to], next[at]];
          this.hooks.orderCards(from, next);
        }, at < 0 || to < 0 || to >= dirs.length);
      }
    }
    // A single session can be pinned to the top of its directory card.
    if (pinned !== undefined) {
      item(pinned ? '取消置顶' : '置顶到目录最前', () => this.hooks.pinSession(names[0], !pinned));
      const sep = document.createElement('div');
      sep.className = 'ps-menu-sep';
      menu.append(sep);
    }
    for (const f of folders) item(`移到「${f.name}」`, () => this.hooks.moveSessions(names, f.id, card), f.id === from);
    if (hostOfKey(from) === host && from !== (host ? `@${host}/` : '')) {
      item('移出文件夹', () => this.hooks.moveSessions(names, host ? `@${host}/` : '', card));
    }
    if (!folders.length) item('还没有文件夹，先点上方按钮新建', () => {}, true);
    item('复制目录绝对路径', () => this.hooks.copySessionDirectory(names));
    const sep2 = document.createElement('div');
    sep2.className = 'ps-menu-sep';
    menu.append(sep2);
    const closable = names.filter(name => this.hooks.canClose?.(name) !== false);
    if (names.length === 1 && this.hooks.isRemoteAgent?.(names[0])) {
      item('关闭远程会话', () => this.hooks.closeSessions(names), false, true);
    } else if (closable.length) item(pinned === undefined ? '关闭目录中可操作的会话' : '关闭会话', () => this.hooks.closeSessions(closable), false, true);
    this.menu = menu;
    this.dismissMobileMenu = mountMobileActions(menu, () => this.closeMenu(), this.actionContext(names[0], names.length, pinned === undefined));
    if (this.dismissMobileMenu) return;
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - rect.height - 8))}px`;
    this.menu = menu;
  }

  closeMenu(): void {
    this.dismissMobileMenu?.();
    this.dismissMobileMenu = null;
    this.menu?.remove();
    this.menu = null;
  }

  /** Edit a name in place; Enter or blur saves, Escape cancels. */
  private startRename(nameEl: HTMLElement, folder: { id: string; name: string },
                      save: (name: string) => void = name => this.hooks.renameFolder(folder.id, name)): void {
    if (this.hooks.readOnly) return;
    const input = document.createElement('input');
    input.className = 'ps-rename';
    input.value = folder.name;
    input.maxLength = 64;
    let done = false;
    const finish = (keep: boolean): void => {
      if (done) return;
      done = true;
      const value = input.value.replace(/[\x00-\x1f\x7f]/g, '').trim();
      input.replaceWith(nameEl);
      if (keep && value && value !== folder.name) {
        nameEl.textContent = value;
        save(value);
      }
    };
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    nameEl.replaceWith(input);
    input.focus();
    input.select();
  }

  private applyWidth(): void {
    this.el.classList.toggle('collapsed', this.hidden);
    this.el.style.width = `${this.width}px`;
    document.documentElement.style.setProperty('--sidebar-w', this.hidden ? '0px' : `${this.width}px`);
    document.documentElement.classList.toggle('sidebar-hidden', this.hidden);
  }

  private bindResize(handle: HTMLElement): void {
    let startX = 0;
    let startWidth = 0;
    let frame = 0;
    const move = (e: PointerEvent): void => {
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + e.clientX - startX));
      if (width === this.width) return;
      this.width = width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        this.applyWidth();
        this.hooks.resized();
      });
    };
    const up = (e: PointerEvent): void => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('sidebar-resizing');
      writeJson('tw.sidebar.width', this.width);
    };
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      startX = e.clientX;
      startWidth = this.width;
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      document.documentElement.classList.add('sidebar-resizing');
    });
    handle.addEventListener('dblclick', () => {
      this.width = DEFAULT_WIDTH;
      writeJson('tw.sidebar.width', this.width);
      this.applyWidth();
      this.hooks.resized();
    });
  }
}

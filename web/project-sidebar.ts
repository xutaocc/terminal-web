import { type FolderGroup, groupByDirectory, orderCards, reorderCards, shortCwd } from './project-groups.js';
import { brandMark } from './brand-mark.js';
import { hostOfKey } from './hosts.js';

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
  remote: boolean;
  online: boolean;
  home: string;
  groups: FolderGroup<SidebarSession>[];
}

export interface SidebarHooks {
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
  /** A host's attention pill was clicked: show the session that wants you most. */
  attend(host: string): void;
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
  button.setAttribute('aria-label', title);
  button.innerHTML = icon;
  button.addEventListener('click', e => {
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
  private dragging: { names: string[]; from: string; card?: { cwd: string; name: string }; cardCwd?: string } | null = null;
  private menu: HTMLElement | null = null;

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
    header.append(
      title,
      iconButton(ICONS.folderPlus, '新建文件夹', () => hooks.newFolder(hostOfKey(this.activeFolder()))),
      iconButton(ICONS.plus, '新建会话', () => hooks.newSession(this.activeFolder(), '')),
    );

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

    this.el.append(top, header, this.list, footer, handle);
    this.applyWidth();
    document.addEventListener('pointerdown', e => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.closeMenu();
    });
  }

  /** The folder holding the active session ('' for none). */
  private activeFolder(): string {
    const last = this.lastRender;
    return last?.groups.find(g => g.items.some(s => s.name === last.active))?.key ?? '';
  }

  get isHidden(): boolean { return this.hidden; }

  setHidden(hidden: boolean): void {
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

  render(sections: SidebarSection[], active: string | null,
         dirNames: Record<string, Record<string, string>> = this.dirNames,
         cardOrder: Record<string, string[]> = this.cardOrder): void {
    this.dirNames = dirNames;
    this.cardOrder = cardOrder;
    const signature = JSON.stringify([active, [...this.folded], dirNames, cardOrder, sections.map(sec => [
      sec.host, sec.title, sec.ip, sec.online, sec.home, sec.groups.map(g => [
        g.key, g.folder?.name, g.items.map(s => [s.name, s.displayName, s.cwd, !!s.pinned]),
      ])])]);
    this.lastRender = { sections, groups: sections.flatMap(sec => sec.groups), active };
    if (signature === this.signature) return;
    this.signature = signature;

    const scrollTop = this.list.scrollTop;
    this.list.replaceChildren();
    const nested = sections.length > 1 || sections.some(sec => sec.remote);
    for (const section of sections) {
      const { groups, home } = section;
      const target = nested ? this.buildHost(section) : this.list;
      if (!target) continue;
      // With no folders there is nothing to tell the loose sessions apart from:
      // they are listed as they are, with no "未分组" heading over them.
      const flat = groups.length === 1 && !groups[0].folder;
      for (const group of groups) {
        target.append(flat ? this.buildCards(group, active, home, document.createElement('section')) : this.buildGroup(group, active, home));
      }
      if (nested && !groups.length) {
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
    const head = document.createElement('div');
    head.className = 'ps-host-head';
    head.title = section.remote ? `远程主机：${section.title}` : '本机上的会话';
    const chevron = document.createElement('span');
    chevron.className = 'ps-chevron';
    chevron.innerHTML = ICONS.chevron;
    const badge = document.createElement('span');
    badge.className = `host-badge ${section.remote ? 'remote' : 'local'}`;
    badge.textContent = section.remote ? '远程' : '本地';
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
      iconButton(ICONS.folderPlus, `在「${section.title}」新建文件夹`, () => this.hooks.newFolder(section.host)),
      iconButton(ICONS.plus, `在「${section.title}」新建会话`, () =>
        this.hooks.newSession(section.groups.find(g => !g.folder)?.key ?? (section.host ? `@${section.host}/` : ''), '')),
    );
    head.append(chevron, badge, name, ip, attention, state, count, actions);
    head.addEventListener('click', () => {
      if (this.folded.has(key)) this.folded.delete(key);
      else this.folded.add(key);
      this.saveFolded();
      this.rerender();
    });
    el.append(head);
    this.list.append(el);
    if (folded) return null;
    const body = document.createElement('div');
    body.className = 'ps-host-body';
    el.append(body);
    return body;
  }

  /** Each server's attention pill (data-host), for the caller to paint. */
  attention(): NodeListOf<HTMLElement> {
    return this.list.querySelectorAll<HTMLElement>('.ps-host-attention');
  }

  /** Scroll a session's chip into view and flash it. */
  reveal(name: string): void {
    const chip = Array.from(this.list.querySelectorAll<HTMLElement>('.ps-chip .tab-dot'))
      .find(dot => dot.dataset.sessions === name)?.closest<HTMLElement>('.ps-chip');
    const target = chip?.closest<HTMLElement>('.ps-card') ?? chip;
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
    head.addEventListener('click', () => {
      if (head.querySelector('.ps-rename')) return;
      if (this.folded.has(group.key)) this.folded.delete(group.key);
      else this.folded.add(group.key);
      this.saveFolded();
      this.rerender();
    });
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
      const card = document.createElement('div');
      card.className = 'ps-card';
      card.classList.toggle('active', !!active && names.includes(active));
      card.title = dir.cwd || '目录未知';
      const row = document.createElement('div');
      row.className = 'ps-card-row';
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      dot.dataset.sessions = names.join(' ');
      const glyph = document.createElement('span');
      glyph.className = 'ps-card-icon';
      glyph.innerHTML = ICONS.terminal;
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
        chip.title = `${session.displayName}${session.pinned ? '（已置顶）' : ''}（右键置顶或移动，可拖到文件夹）`;
        const chipDot = document.createElement('span');
        chipDot.className = 'tab-dot';
        chipDot.dataset.sessions = session.name;
        const chipName = document.createElement('span');
        chipName.className = 'ps-chip-name';
        chipName.textContent = session.displayName;
        chip.append(chipDot, chipName);
        if (session.pinned) {
          const pin = document.createElement('span');
          pin.className = 'pin-mark';
          pin.innerHTML = ICONS.pin;
          chip.append(pin);
        }
        chip.addEventListener('click', e => {
          e.stopPropagation();
          this.hooks.activate(session.name);
        });
        this.bindDrag(chip, [session.name], group.key);
        chip.addEventListener('contextmenu', e => {
          e.preventDefault();
          e.stopPropagation();
          this.openMenu(e, [session.name], group.key, session.displayName, undefined, !!session.pinned);
        });
        chips.append(chip);
      }
      card.append(row);
      if (sub.textContent) card.append(sub);
      card.append(chips);
      card.addEventListener('click', () => {
        if (!card.querySelector('.ps-rename')) this.hooks.activateDirectory(names);
      });
      // Only a name the user gave travels; a directory's own name is its own anywhere.
      const carry = dir.cwd && given ? { cwd: dir.cwd, name: given } : undefined;
      this.bindDrag(card, names, group.key, carry, dir.cwd || undefined);
      if (dir.cwd) this.bindReorder(card, group.key, dir.cwd, dirs.map(d => d.cwd).filter(Boolean));
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        this.openMenu(e, names, group.key, `${label.textContent}（${names.length} 个会话）`, carry);
      });
      el.append(card);
    }
    return el;
  }

  // -------------------------------------------------------------------------
  // Moving sessions: drag a chip or a whole card onto a folder, or right-click.
  // -------------------------------------------------------------------------
  private bindDrag(el: HTMLElement, names: string[], from: string, card?: { cwd: string; name: string }, cardCwd?: string): void {
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      e.stopPropagation();
      this.dragging = { names, from, card, cardCwd };
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
    const movable = (): boolean => !!this.dragging && this.dragging.from !== folderId &&
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
    const item = (text: string, onPick: () => void, disabled = false): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-menu-item';
      b.textContent = text;
      b.disabled = disabled;
      b.addEventListener('click', () => {
        this.closeMenu();
        onPick();
      });
      menu.append(b);
    };
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
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(e.clientX, innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - rect.height - 8)}px`;
    this.menu = menu;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  /** Edit a name in place; Enter or blur saves, Escape cancels. */
  private startRename(nameEl: HTMLElement, folder: { id: string; name: string },
                      save: (name: string) => void = name => this.hooks.renameFolder(folder.id, name)): void {
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

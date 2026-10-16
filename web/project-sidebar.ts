import { groupByDirectory, type ProjectGroup, shortCwd } from './project-groups.js';

/** What a card needs to know about a session. */
export interface SidebarSession { name: string; displayName: string; cwd: string | null }

export interface SidebarHooks {
  activate(name: string): void;
  /** A directory card was clicked: show one of these sessions (they share its directory). */
  activateDirectory(names: string[]): void;
  /** New session in this directory; '' means wherever the active one is. */
  newSession(directory: string): void;
  addProject(): void;
  removeProject(path: string, name: string): void;
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
  terminal: svg('<path d="m4 17 6-6-6-6M12 19h8"/>', 13),
  gear: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>'),
  locate: svg('<circle cx="12" cy="12" r="10"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>'),
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
  private lastRender: { groups: ProjectGroup<SidebarSession>[]; active: string | null; home: string } | null = null;

  constructor(private readonly hooks: SidebarHooks) {
    this.el.id = 'sidebar';

    const top = document.createElement('div');
    top.className = 'ps-top';
    const brand = document.createElement('span');
    brand.className = 'ps-brand';
    brand.textContent = 'terminal-web';
    top.append(brand, iconButton(ICONS.panel, '收起侧栏', () => this.setHidden(true)));

    const header = document.createElement('div');
    header.className = 'ps-header';
    const title = document.createElement('span');
    title.className = 'ps-title';
    title.textContent = '项目';
    header.append(
      title,
      iconButton(ICONS.folderPlus, '添加项目', () => hooks.addProject()),
      iconButton(ICONS.plus, '在当前项目新建会话', () => hooks.newSession('')),
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
  render(groups: ProjectGroup<SidebarSession>[], active: string | null, home: string): void {
    const signature = JSON.stringify([active, home, [...this.folded], groups.map(g => [
      g.key, g.project?.name, g.items.map(s => [s.name, s.displayName, s.cwd]),
    ])]);
    this.lastRender = { groups, active, home };
    if (signature === this.signature) return;
    this.signature = signature;

    const scrollTop = this.list.scrollTop;
    this.list.replaceChildren();
    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'ps-empty';
      empty.textContent = '还没有项目。点击上方 ';
      empty.append(iconButton(ICONS.folderPlus, '添加项目', () => this.hooks.addProject()), ' 添加项目目录，会话会按工作目录自动归组。');
      this.list.append(empty);
    }
    for (const group of groups) this.list.append(this.buildGroup(group, active, home));
    this.list.scrollTop = scrollTop;
  }

  /** The status dots of every card, for the caller to paint. */
  dots(): NodeListOf<HTMLElement> {
    return this.list.querySelectorAll<HTMLElement>('.ps-card .tab-dot');
  }

  /** Scroll the active session's card into view, unfolding its group, and flash it. */
  revealActive(): void {
    const last = this.lastRender;
    const group = last?.groups.find(g => g.items.some(s => s.name === last.active));
    if (group && this.folded.delete(group.key)) {
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
    const { groups, active, home } = this.lastRender;
    this.render(groups, active, home);
  }

  private saveFolded(): void {
    writeJson('tw.sidebar.folded', [...this.folded]);
  }

  private buildGroup(group: ProjectGroup<SidebarSession>, active: string | null, home: string): HTMLElement {
    const el = document.createElement('section');
    el.className = 'ps-group';
    el.dataset.key = group.key;
    const folded = this.folded.has(group.key);
    el.classList.toggle('folded', folded);

    const head = document.createElement('div');
    head.className = 'ps-group-head';
    head.title = group.project?.path ?? '不在任何项目目录下的会话';
    const chevron = document.createElement('span');
    chevron.className = 'ps-chevron';
    chevron.innerHTML = ICONS.chevron;
    const icon = document.createElement('span');
    icon.className = 'ps-group-icon';
    icon.innerHTML = ICONS.folder;
    const name = document.createElement('span');
    name.className = 'ps-group-name';
    name.textContent = group.project?.name ?? '其他';
    const count = document.createElement('span');
    count.className = 'ps-group-count';
    count.textContent = String(group.items.length);
    const actions = document.createElement('span');
    actions.className = 'ps-group-actions';
    if (group.project) {
      const project = group.project;
      actions.append(
        iconButton(ICONS.plus, `在 ${project.name} 新建会话`, () => this.hooks.newSession(project.path)),
        iconButton(ICONS.close, '移除项目（不影响会话）', () => this.hooks.removeProject(project.path, project.name)),
      );
    }
    head.append(chevron, icon, name, count, actions);
    head.addEventListener('click', () => {
      if (this.folded.has(group.key)) this.folded.delete(group.key);
      else this.folded.add(group.key);
      this.saveFolded();
      this.rerender();
    });
    el.append(head);
    if (folded) return el;

    if (!group.items.length) {
      const hint = document.createElement('div');
      hint.className = 'ps-group-empty';
      hint.textContent = '暂无会话';
      el.append(hint);
    }
    // Second level, as in Orca: one card per working directory, its sessions
    // as chips inside it.
    for (const dir of groupByDirectory(group.items, item => item.cwd)) {
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
      label.textContent = dir.cwd ? dir.cwd.split('/').filter(Boolean).pop() ?? '/' : '目录未知';
      row.append(dot, glyph, label);
      if (dir.cwd) {
        const cwd = dir.cwd;
        const add = iconButton(ICONS.plus, '在此目录新建会话', () => this.hooks.newSession(cwd));
        add.classList.add('ps-card-add');
        row.append(add);
      }
      const sub = document.createElement('div');
      sub.className = 'ps-card-sub';
      sub.textContent = shortCwd(dir.cwd, '', home);
      const chips = document.createElement('div');
      chips.className = 'ps-chips';
      for (const session of dir.items) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ps-chip';
        chip.classList.toggle('active', session.name === active);
        chip.title = session.displayName;
        const chipDot = document.createElement('span');
        chipDot.className = 'tab-dot';
        chipDot.dataset.sessions = session.name;
        const chipName = document.createElement('span');
        chipName.className = 'ps-chip-name';
        chipName.textContent = session.displayName;
        chip.append(chipDot, chipName);
        chip.addEventListener('click', e => {
          e.stopPropagation();
          this.hooks.activate(session.name);
        });
        chips.append(chip);
      }
      card.append(row);
      if (sub.textContent) card.append(sub);
      card.append(chips);
      card.addEventListener('click', () => this.hooks.activateDirectory(names));
      el.append(card);
    }
    return el;
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

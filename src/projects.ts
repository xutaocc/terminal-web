import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * A sidebar folder: a named group the user puts sessions in. It has no path —
 * what is in it is whatever the user put there, never what happens to sit in
 * some directory — and it lives exactly as long as it holds a session.
 */
export interface Folder { id: string; name: string }

export interface FolderData {
  folders: Folder[];
  /** session name -> folder id */
  members: Record<string, string>;
  /**
   * Names the user gave directory cards: folder id ('' for no folder) -> cwd ->
   * name. Keyed by folder, so the same directory can be called something else
   * in each, and a card dragged into a folder that already has that directory
   * takes the name it has there.
   */
  dirNames: Record<string, Record<string, string>>;
  /**
   * The order the user dragged directory cards into: folder id ('' for no
   * folder) -> cwds, first to last. Cards not listed follow in their natural
   * order. Optional: files written before cards could be reordered lack it.
   */
  cardOrder?: Record<string, string[]>;
  /**
   * Pinned sessions, most recently pinned first. A pinned session goes to the
   * top of its directory card (and of the tab strip, which shows one card).
   * Optional: files written before pinning lack it.
   */
  pinned?: string[];
}

const MAX_FOLDERS = 100;
const MAX_DIR_NAMES = 500;
const MAX_PINNED = 500;

export function validFolderName(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
}

const validSession = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name);

function valid(data: unknown): data is FolderData {
  const d = data as FolderData;
  return !!d && Array.isArray(d.folders) && d.folders.length <= MAX_FOLDERS &&
    d.folders.every(f => f && typeof f.id === 'string' && validFolderName(f.name)) &&
    !!d.members && typeof d.members === 'object' &&
    Object.entries(d.members).every(([s, f]) => validSession(s) && typeof f === 'string') &&
    !!d.dirNames && typeof d.dirNames === 'object' &&
    Object.values(d.dirNames).every(names => !!names && typeof names === 'object' &&
      Object.entries(names).every(([cwd, name]) => cwd.startsWith('/') && validFolderName(name))) &&
    Object.values(d.dirNames).reduce((n, names) => n + Object.keys(names).length, 0) <= MAX_DIR_NAMES &&
    (d.cardOrder === undefined || (typeof d.cardOrder === 'object' && !!d.cardOrder &&
      Object.values(d.cardOrder).every(list => Array.isArray(list) && list.length <= MAX_DIR_NAMES &&
        list.every(cwd => typeof cwd === 'string' && cwd.startsWith('/') && cwd.length <= 4096)))) &&
    (d.pinned === undefined || (Array.isArray(d.pinned) && d.pinned.length <= MAX_PINNED && d.pinned.every(validSession)));
}

/** Drop memberships of unknown folders, then folders nobody is in, then their card names. */
function settle(data: FolderData): FolderData {
  const ids = new Set(data.folders.map(f => f.id));
  const members = Object.fromEntries(Object.entries(data.members).filter(([, f]) => ids.has(f)));
  const used = new Set(Object.values(members));
  const folders = data.folders.filter(f => used.has(f.id));
  const kept = new Set(['', ...folders.map(f => f.id)]);
  const dirNames = Object.fromEntries(Object.entries(data.dirNames ?? {})
    .filter(([id, names]) => kept.has(id) && Object.keys(names).length));
  const cardOrder = Object.fromEntries(Object.entries(data.cardOrder ?? {})
    .filter(([id, list]) => kept.has(id) && list.length));
  return { folders, members, dirNames, cardOrder, pinned: [...new Set(data.pinned ?? [])] };
}

/**
 * Before the folders, the sidebar had path-based projects in a list of
 * { path, name }. Each becomes a folder holding the sessions working in it
 * now, so nothing the user set up disappears.
 */
function migrate(raw: unknown, cwds: Map<string, string>): FolderData {
  const data: FolderData = { folders: [], members: {}, dirNames: {} };
  // Folders saved before cards could be named.
  const saved = raw as Partial<FolderData>;
  if (Array.isArray(saved?.folders) && saved.members && !saved.dirNames) return settle({ ...saved, dirNames: {} } as FolderData);
  const projects = (raw as { projects?: unknown })?.projects;
  if (!Array.isArray(projects)) return data;
  const inside = (dir: string, root: string): boolean => dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);
  for (const p of projects) {
    if (!p || typeof p.path !== 'string' || !validFolderName(p.name)) continue;
    const folder = { id: randomUUID(), name: p.name };
    data.folders.push(folder);
    for (const [session, cwd] of cwds) {
      if (!data.members[session] && inside(cwd, p.path)) data.members[session] = folder.id;
    }
  }
  return settle(data);
}

/** Folder edits are applied one at a time, so two devices never overwrite each other. */
export class FolderStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly sessionCwds: () => Promise<Map<string, string> | null>) {}

  private async read(): Promise<FolderData> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { folders: [], members: {}, dirNames: {} };
      throw error;
    }
    if (valid(raw)) return raw;
    // Written straight back: folder ids are random, and a migration redone on
    // every read would hand out new ones each time.
    const data = migrate(raw, (await this.sessionCwds()) ?? new Map());
    await this.write(data);
    return data;
  }

  private async write(data: FolderData): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.file);
  }

  async get(): Promise<FolderData> {
    await this.queue;
    return this.read();
  }

  /** Apply one edit; empty folders go with it. Returns what was removed along the way. */
  update(edit: (data: FolderData) => FolderData): Promise<{ data: FolderData; emptied: Folder[] }> {
    const task = this.queue.then(async () => {
      const before = await this.read();
      const data = settle(edit(structuredClone(before)));
      if (!valid(data)) throw new Error('Invalid folders');
      const kept = new Set(data.folders.map(f => f.id));
      const emptied = before.folders.filter(f => !kept.has(f.id));
      await this.write(data);
      return { data, emptied };
    });
    this.queue = task.catch(() => {});
    return task;
  }

  /** Sessions that no longer exist leave their folders; folders left empty go too. */
  prune(live: Set<string>): Promise<{ data: FolderData; emptied: Folder[] }> {
    return this.update(data => ({
      ...data,
      members: Object.fromEntries(Object.entries(data.members).filter(([s]) => live.has(s))),
      pinned: (data.pinned ?? []).filter(s => live.has(s)),
    }));
  }

  /** Pin sessions (to the front of the list) or unpin them. */
  pin(sessions: string[], pinned: boolean): Promise<{ data: FolderData; emptied: Folder[] }> {
    return this.update(data => {
      const rest = (data.pinned ?? []).filter(s => !sessions.includes(s));
      return { ...data, pinned: pinned ? [...sessions, ...rest].slice(0, MAX_PINNED) : rest };
    });
  }

  create(name: string, session: string): Promise<{ data: FolderData; emptied: Folder[]; folder: Folder }> {
    const folder = { id: randomUUID(), name: name.trim() };
    return this.update(data => {
      if (data.folders.length >= MAX_FOLDERS) throw new Error('too many folders');
      return { ...data, folders: [...data.folders, folder], members: { ...data.members, [session]: folder.id } };
    }).then(result => ({ ...result, folder }));
  }

  rename(id: string, name: string): Promise<{ data: FolderData; emptied: Folder[] }> {
    return this.update(data => ({
      ...data, folders: data.folders.map(f => f.id === id ? { ...f, name: name.trim() } : f),
    }));
  }

  /**
   * Put sessions in a folder, or take them out of any ('' as the folder). A
   * whole card moved along with its name (`card`) keeps that name — unless the
   * folder already has a card for the same directory: the two merge, and the
   * name it has there wins.
   */
  move(sessions: string[], id: string, card?: { cwd: string; name: string }): Promise<{ data: FolderData; emptied: Folder[] }> {
    return this.update(data => {
      if (id && !data.folders.some(f => f.id === id)) throw new Error('unknown folder');
      const members = { ...data.members };
      for (const s of sessions) {
        if (id) members[s] = id;
        else delete members[s];
      }
      const dirNames = { ...data.dirNames, [id]: { ...(data.dirNames[id] ?? {}) } };
      if (card && !dirNames[id][card.cwd]) dirNames[id][card.cwd] = card.name.trim();
      return { ...data, members, dirNames };
    });
  }

  /** Set the order of a folder's directory cards ('' for no folder): its cwds, first to last. */
  orderCards(id: string, cwds: string[]): Promise<{ data: FolderData; emptied: Folder[] }> {
    return this.update(data => {
      const cardOrder = { ...(data.cardOrder ?? {}) };
      if (cwds.length) cardOrder[id] = [...new Set(cwds)];
      else delete cardOrder[id];
      return { ...data, cardOrder };
    });
  }

  /** Name a directory card within one folder ('' for no folder); an empty name restores the default. */
  renameDir(id: string, cwd: string, name: string): Promise<{ data: FolderData; emptied: Folder[] }> {
    return this.update(data => {
      const names = { ...(data.dirNames[id] ?? {}) };
      if (name.trim()) names[cwd] = name.trim();
      else delete names[cwd];
      return { ...data, dirNames: { ...data.dirNames, [id]: names } };
    });
  }
}

export { validSession };

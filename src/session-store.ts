import fs from 'node:fs';
import path from 'node:path';

export interface SavedSession {
  name: string;
  displayName: string;
  cwd?: string;
}

/** Durable tab identities, independent of the lifetime of a tmux server. */
export class SessionStore {
  private tabs = new Map<string, SavedSession>();
  constructor(private file: string) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(data)) throw new Error('Expected a session array');
      for (const tab of data) {
        if (tab && typeof tab.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tab.name) &&
            !tab.name.endsWith('__b') && typeof tab.displayName === 'string') {
          this.tabs.set(tab.name, { name: tab.name, displayName: tab.displayName,
            cwd: typeof tab.cwd === 'string' && path.isAbsolute(tab.cwd) ? tab.cwd : undefined });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  list(): SavedSession[] { return [...this.tabs.values()].map(tab => ({ ...tab })); }
  get(name: string): SavedSession | undefined {
    const tab = this.tabs.get(name);
    return tab && { ...tab };
  }
  update(tab: SavedSession): void {
    if (tab.name.endsWith('__b')) return;
    const previous = this.tabs.get(tab.name);
    const next = { ...previous, ...tab, cwd: tab.cwd ?? previous?.cwd };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.tabs.set(tab.name, next);
    this.save();
  }
  remove(name: string): void {
    if (this.tabs.delete(name)) this.save();
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.list(), null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface QuickCommand { id: string; label: string; text: string }
export interface QuickCommandData { revision: string; commands: QuickCommand[] }

export function validQuickCommands(value: unknown): value is QuickCommand[] {
  if (!Array.isArray(value) || value.length > 50) return false;
  const ids = new Set<string>();
  return value.every(item => {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) ||
        ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim() ||
        item.label.length > 64 || /[\x00-\x1f\x7f]/.test(item.label) ||
        typeof item.text !== 'string' || !item.text.trim() || item.text.length > 4000) return false;
    ids.add(item.id);
    return true;
  });
}

/** Atomic saves and optimistic revisions prevent devices from overwriting newer edits. */
export class QuickCommandStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  private async read(): Promise<QuickCommandData> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (typeof data.revision !== 'string' || !validQuickCommands(data.commands)) throw new Error('Invalid saved commands');
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: '', commands: [] };
      throw error;
    }
  }
  async get(): Promise<QuickCommandData> { await this.queue; return this.read(); }
  save(revision: string, commands: QuickCommand[]): Promise<QuickCommandData | null> {
    const task = this.queue.then(async () => {
      if (!validQuickCommands(commands)) throw new Error('Invalid commands');
      const current = await this.read();
      if (current.revision !== revision) return null;
      const data = { revision: randomUUID(), commands };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await fs.rename(temp, this.file);
      return data;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

import fs from 'node:fs';
import path from 'node:path';
export interface JournalEvent { seq: number; time: string; type: string; data: string }
interface Journal { next: number; truncated: boolean; events: JournalEvent[] }
/** Bounded raw terminal history, separate from durable command deduplication records. */
export class AgentJournal {
  private loaded = new Map<string, Journal>();
  private suppressed = new Set<string>();
  private dirty = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private directory: string) {}
  private get(id: string): Journal {
    let journal = this.loaded.get(id);
    if (!journal) {
      const file = path.join(this.directory, id + '.json');
      journal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Journal : { next: 1, truncated: false, events: [] };
      this.loaded.set(id, journal);
    }
    return journal;
  }
  suppress(id: string): void {
    this.suppressed.add(id); this.dirty.delete(id); this.loaded.delete(id);
  }
  bytes(id: string): number {
    let bytes = 0;
    for (const suffix of ['.json', '.json.tmp']) {
      try { bytes += fs.statSync(path.join(this.directory, id + suffix)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return bytes;
  }
  remove(id: string): void {
    this.suppress(id);
    for (const suffix of ['.json', '.json.tmp']) fs.rmSync(path.join(this.directory, id + suffix), {force: true});
  }
  append(id: string, type: string, data: string): void {
    if (this.suppressed.has(id)) return;
    const journal = this.get(id);
    journal.events.push({ seq: journal.next++, time: new Date().toISOString(), type, data });
    while (journal.events.length > 2000 || Buffer.byteLength(JSON.stringify(journal.events)) > 512 * 1024) {
      journal.events.shift(); journal.truncated = true;
    }
    this.dirty.add(id);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; try { this.flush(); } catch { /* retain dirty records for retry */ } }, 500);
      this.timer.unref();
    }
  }
  read(id: string, after: number, limit: number) {
    this.flush();
    const journal = this.suppressed.has(id) ? {next: 1, truncated: false, events: []} : this.get(id);
    const events = journal.events.filter(e => e.seq > after).slice(0, limit);
    return { events, nextCursor: events.at(-1)?.seq ?? after, hasMore: journal.events.some(e => e.seq > (events.at(-1)?.seq ?? after)),
      truncated: journal.truncated, gap: after > journal.next - 1 || after < (journal.events[0]?.seq ?? 1) - 1,
      coverage: 'collector-only; raw output may contain ANSI and sensitive program echoes' };
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    for (const id of this.dirty) {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, id + '.json');
      fs.writeFileSync(file + '.tmp', JSON.stringify(this.get(id)), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file); this.dirty.delete(id);
    }
  }
}

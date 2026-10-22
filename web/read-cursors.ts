/** Independent read cursors. The storage passed by the app is namespaced per share. */
export interface SequencedStatus {
  instance?: string; version?: number; eventSeq?: number; unread: boolean;
}
export class ReadCursors {
  private memory = new Map<string, number>();
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>) {}
  private key(session: string, status: SequencedStatus): string { return `tw.read.${session}:${status.instance ?? 'legacy'}`; }
  unread(session: string, status: SequencedStatus): boolean {
    if (typeof status.eventSeq !== 'number') return status.unread;
    let seen = this.memory.get(this.key(session,status)) ?? 0; try { seen = Math.max(seen, Number(this.storage.getItem(this.key(session, status))) || 0); } catch { /* private browsing */ }
    return status.eventSeq > seen;
  }
  read(session: string, status: SequencedStatus): void {
    if (!status.eventSeq) return;
    const key = this.key(session, status);
    this.memory.set(key, Math.max(this.memory.get(key) ?? 0, status.eventSeq));
    try { this.storage.setItem(key, String(Math.max(Number(this.storage.getItem(key)) || 0, status.eventSeq))); } catch { /* private browsing */ }
  }
}
export function newerStatus(previous: SequencedStatus | undefined, incoming: SequencedStatus): boolean {
  return previous?.version === undefined || incoming.version === undefined || incoming.version >= previous.version;
}

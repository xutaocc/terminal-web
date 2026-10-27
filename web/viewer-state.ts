import type { SequencedStatus } from './read-cursors.js';
export interface ViewerState { revision: number; reads: Record<string, number>; recent: string[]; limit: number }
type Operation = {type: 'read'; session: string; instance: string; seq: number} | {type: 'visit' | 'remove'; session: string} | {type: 'limit'; limit: number};
/** Server owns durable state. Pending operations provide immediate feedback and retry after reconnect. */
export class ViewerStateSync {
  private state: ViewerState = {revision: -1, reads: {}, recent: [], limit: 8};
  private queue: Operation[] = [];
  private flushing = false;
  private refreshing = false;
  private refreshAgain = false;
  constructor(private changed: (state: ViewerState) => void, private request: typeof fetch = fetch) {}
  get ready(): boolean { return this.state.revision >= 0; }
  private effective(): ViewerState {
    const state = structuredClone(this.state);
    for (const op of this.queue) {
      if (op.type === 'read') { const key = JSON.stringify([op.session, op.instance]); state.reads[key] = Math.max(state.reads[key] ?? 0, op.seq); }
      if (op.type === 'limit') { state.limit = op.limit; state.recent = state.recent.slice(0, state.limit); }
      if (op.type === 'visit' || op.type === 'remove') { state.recent = state.recent.filter(n => n !== op.session); if (op.type === 'visit') state.recent.unshift(op.session); state.recent = state.recent.slice(0, state.limit); }
    }
    return state;
  }
  unread(session: string, status: SequencedStatus): boolean {
    if (!this.ready) return false;
    return (status.eventSeq ?? 0) > (this.effective().reads[JSON.stringify([session, status.instance ?? 'legacy'])] ?? 0);
  }
  read(session: string, status: SequencedStatus): void {
    if (this.unread(session, status)) this.send({type: 'read', session, instance: status.instance ?? 'legacy', seq: status.eventSeq!});
  }
  send(operation: Operation): void { this.queue.push(operation); void this.flush(); }
  private accept(state: ViewerState): void { if (state.revision >= this.state.revision) this.state = state; this.changed(this.effective()); }
  async refresh(): Promise<void> {
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    try { const response = await this.request('/api/viewer-state', {cache: 'no-store', signal: AbortSignal.timeout(10000)}); if (response.ok) this.accept(await response.json()); }
    catch { /* reconnect/poll retries */ }
    finally {
      this.refreshing = false;
      if (this.refreshAgain) { this.refreshAgain = false; void this.refresh(); }
    }
    void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.flushing || !this.ready) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const response = await this.request('/api/viewer-state', {method: 'POST', signal: AbortSignal.timeout(10000), headers: {'Content-Type': 'application/json'}, body: JSON.stringify(this.queue[0])});
        if (!response.ok) { if (response.status === 400) this.queue.shift(); break; }
        const state = await response.json(); this.queue.shift(); this.accept(state);
      }
    } catch { /* retain pending operations until reconnected */ }
    finally { this.flushing = false; }
  }
}

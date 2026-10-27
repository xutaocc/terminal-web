import fs from 'node:fs/promises';
import path from 'node:path';
import type http from 'node:http';
export interface ViewerState { revision: number; reads: Record<string, number>; recent: string[]; limit: number; initialized?: Record<string, boolean> }
class ViewerInputError extends Error {}
export const cursorKey = (session: string, instance: string) => JSON.stringify([session, instance]);
/** Per credential state; never accepts a credential/scope supplied by the browser. */
export class ViewerStateStore {
  private data: Record<string, ViewerState> = Object.create(null);
  private ready: Promise<void>;
  private writes = Promise.resolve();
  private listeners = new Set<(scope: string) => void>();
  constructor(private file: string) {
    this.ready = fs.readFile(file, 'utf8').then(raw => { this.data = JSON.parse(raw); }).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  subscribe(listener: (scope: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async snapshot(scope: string): Promise<ViewerState> { await this.ready; return structuredClone(this.data[scope] ?? {revision: 0, reads: {}, recent: [], limit: 8}); }
  /** Called only by the authorization layer, never by a browser operation. */
  async initialize(scope: string, entries: {session: string; identity: string; instance: string; seq: number}[]): Promise<void> {
    const run = this.writes.then(async () => {
      const state = await this.snapshot(scope);
      state.initialized ??= {};
      let changed = false;
      for (const entry of entries) {
        const identity = cursorKey(entry.session, entry.identity);
        if (state.initialized[identity]) continue;
        // Existing users keep their read/unread history during migration.
        const hasRead = Object.keys(state.reads).some(key => JSON.parse(key)[0] === entry.session);
        if (!hasRead) state.reads[cursorKey(entry.session, entry.instance)] = entry.seq;
        state.initialized[identity] = true;
        changed = true;
      }
      if (changed) await this.persist(scope, state);
    });
    this.writes = run.then(() => {}, () => {});
    return run;
  }
  private async persist(scope: string, state: ViewerState): Promise<void> {
    state.revision++;
    const next = {...this.data, [scope]: state};
    await fs.mkdir(path.dirname(this.file), {recursive: true});
    await fs.writeFile(this.file + '.tmp', JSON.stringify(next), {mode: 0o600});
    await fs.rename(this.file + '.tmp', this.file);
    this.data = next;
    for (const listener of this.listeners) listener(scope);
  }
  async update(scope: string, operation: any, allowed: (session: string) => boolean): Promise<ViewerState> {
    const run = this.writes.then(async () => {
      const state = await this.snapshot(scope);
      const session = operation?.session;
      if (operation?.type === 'read') {
        if (typeof session !== 'string' || !allowed(session) || typeof operation.instance !== 'string' || operation.instance.length > 128 || !Number.isSafeInteger(operation.seq) || operation.seq < 0) throw new ViewerInputError('invalid read');
        const key = cursorKey(session, operation.instance);
        state.reads[key] = Math.max(state.reads[key] ?? 0, operation.seq);
      } else if (operation?.type === 'visit' || operation?.type === 'remove') {
        if (typeof session !== 'string' || session.length > 256 || !allowed(session)) throw new ViewerInputError('invalid session');
        state.recent = state.recent.filter(name => name !== session);
        if (operation.type === 'visit') state.recent.unshift(session);
        state.recent = state.recent.slice(0, state.limit);
      } else if (operation?.type === 'limit') {
        if (!Number.isInteger(operation.limit) || operation.limit < 1 || operation.limit > 50) throw new ViewerInputError('invalid limit');
        state.limit = operation.limit; state.recent = state.recent.slice(0, state.limit);
      } else throw new ViewerInputError('invalid operation');
      await this.persist(scope, state);
      return structuredClone(state);
    });
    this.writes = run.then(() => {}, () => {});
    return run;
  }
  visible(state: ViewerState, allowed: (session: string) => boolean): ViewerState {
    const result = structuredClone(state);
    delete result.initialized;
    result.recent = result.recent.filter(allowed);
    result.reads = Object.fromEntries(Object.entries(result.reads).filter(([key]) => allowed(JSON.parse(key)[0])));
    return result;
  }
  async http(req: http.IncomingMessage, res: http.ServerResponse, scope: string, allowed: (session: string) => boolean): Promise<void> {
    let state: ViewerState;
    try {
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new ViewerInputError('body too large'); }
        let operation: unknown;
        try { operation = JSON.parse(raw); } catch { throw new ViewerInputError('invalid JSON'); }
        state = await this.update(scope, operation, allowed);
      } else if (req.method === 'GET') state = await this.snapshot(scope);
      else { res.writeHead(405).end(); return; }
    } catch (error) {
      res.writeHead(error instanceof ViewerInputError ? 400 : 500).end('Viewer state request failed'); return;
    }
    state = this.visible(state, allowed);
    res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(state));
  }
}

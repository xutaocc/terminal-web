import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type http from 'node:http';
import type { IPty } from 'node-pty';
import { isKeyboardInput } from './history-input.js';
import { TerminalControl, type ControlClient } from './terminal-control.js';

const PREFIX = '/api/agent/v1';
/** Windows enables remote control by default; an explicit setting overrides the default. */
export function isAgentApiEnabled(value = process.env.AGENT_ENABLED, platform: NodeJS.Platform = process.platform): boolean {
  const setting = value?.trim();
  return setting ? setting === '1' : platform === 'win32';
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
interface Event { seq: number; type: string; time: string; data: string }
interface RecordEntry { hash: string; result: unknown }
interface Session {
  id: string; name: string; label: string; cwd: string; generation: string;
  ended?: boolean; requests: Record<string, RecordEntry>;
}
interface Runtime {
  proc: IPty; events: Event[]; bytes: number; seq: number; epoch: string;
  clients: Map<string, { client: ControlClient; seen: number }>;
  listeners: Set<() => void>; alive: boolean;
}
export interface AgentBackend {
  token: string; file: string; enabled: boolean; control: TerminalControl;
  spawn(name: string, cwd: string, create: boolean): Promise<IPty>;
  prepareInput(name: string, authorized: () => boolean): Promise<void>;
  output?(name: string): void;
  register(name: string, label: string, cwd: string): void;
  remove(name: string): Promise<void>;
}

/** Raw persistent terminal API. No completion claims are inferred from a quiet screen. */
export class AgentApi {
  private sessions = new Map<string, Session>();
  private runtimes = new Map<string, Runtime>();
  private opening = new Map<string, Promise<Runtime>>();
  private creates: Record<string, RecordEntry> = {};
  private failures = new Map<string, { count: number; until: number }>();
  private active = 0;
  private creation: Promise<unknown> = Promise.resolve();
  constructor(private backend: AgentBackend) {
    if (fs.existsSync(backend.file)) {
      const saved = JSON.parse(fs.readFileSync(backend.file, 'utf8'));
      for (const s of saved.sessions) { this.sessions.set(s.id, s); backend.control.setExplicit(s.name); }
      this.creates = saved.creates ?? {};
    }
    const timer = setInterval(() => {
      for (const [id, r] of this.runtimes) for (const [key, c] of r.clients) {
        if (Date.now() - c.seen > 15000) {
          backend.control.leave(this.sessions.get(id)!.name, c.client, true); r.clients.delete(key);
        }
      }
    }, 5000); timer.unref();
  }
  isAgent(name: string): boolean { return [...this.sessions.values()].some(s => s.name === name); }
  history(name: string): unknown {
    const s = [...this.sessions.values()].find(s => s.name === name);
    return s ? { label: s.label, records: Object.values(s.requests).map(r => r.result) } : null;
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.backend.file), { recursive: true });
    const temp = this.backend.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ sessions: [...this.sessions.values()], creates: this.creates })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.backend.file);
  }
  private auth(req: http.IncomingMessage): void {
    if (!this.backend.enabled) throw new ApiError(404, 'AGENT_DISABLED');
    // This machine interface accepts no browser credentials or cross-origin calls.
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'ORIGIN_DENIED');
    const ip = req.socket.remoteAddress ?? '';
    const failure = this.failures.get(ip);
    if (failure && failure.until > Date.now()) throw new ApiError(429, 'AUTH_RATE_LIMIT');
    const got = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${this.backend.token}`);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      const count = (failure?.count ?? 0) + 1;
      if (this.failures.size > 1024) this.failures.clear();
      this.failures.set(ip, { count, until: count >= 6 ? Date.now() + 60000 : 0 });
      throw new ApiError(401, 'UNAUTHORIZED');
    }
    this.failures.delete(ip);
  }
  private async body(req: http.IncomingMessage): Promise<any> {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length; if (size > 96 * 1024) throw new ApiError(413, 'BODY_TOO_LARGE'); chunks.push(chunk);
    }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value;
    } catch { throw new ApiError(400, 'INVALID_JSON'); }
  }
  private event(r: Runtime, type: string, data: string): void {
    // Bound even a single giant pty chunk; sequence is a terminal stream, not a command log.
    for (let offset = 0; offset < data.length || offset === 0; offset += 8192) {
      const part = data.slice(offset, offset + 8192);
      const e = { seq: ++r.seq, type, time: new Date().toISOString(), data: part };
      r.events.push(e); r.bytes += Buffer.byteLength(part) + 128;
      while (r.bytes > 8 * 1024 * 1024 && r.events.length) {
        const removed = r.events.shift()!; r.bytes -= Buffer.byteLength(removed.data) + 128;
      }
    }
    for (const wake of r.listeners) wake();
  }
  private runtime(s: Session, create = false): Promise<Runtime> {
    if (s.ended) return Promise.reject(new ApiError(410, 'SESSION_GONE'));
    const current = this.runtimes.get(s.id);
    if (current) { if (!current.alive) return Promise.reject(new ApiError(410, 'SESSION_GONE')); return Promise.resolve(current); }
    const pending = this.opening.get(s.id); if (pending) return pending;
    const opening = (async () => {
      if (s.ended) throw new ApiError(410, 'SESSION_GONE');
      let proc: IPty;
      try { proc = await this.backend.spawn(s.name, s.cwd, create); }
      catch (error) {
        if ((error as Error).message === 'SESSION_GONE') throw new ApiError(410, 'SESSION_GONE');
        if ((error as Error).message === 'PTY_LIMIT') throw new ApiError(429, 'PTY_LIMIT');
        throw error;
      }
      const r: Runtime = { proc, events: [], bytes: 0, seq: 0, epoch: crypto.randomUUID(), clients: new Map(), listeners: new Set(), alive: true };
      this.runtimes.set(s.id, r);
      this.event(r, create ? 'created' : 'output_gap', 'Terminal attached; output contains screen redraws.');
      proc.onData(data => { this.event(r, 'output', data); this.backend.output?.(s.name); });
      proc.onExit(() => {
        r.alive = false;
        // Collector loss is not proof the underlying shell died. A later service restart may attach.
        this.event(r, 'collector_closed', 'Reconnect collector explicitly; shell state is unknown.');
        for (const c of r.clients.values()) this.backend.control.leave(s.name, c.client, true);
      });
      this.backend.register(s.name, s.label, s.cwd);
      return r;
    })().finally(() => this.opening.delete(s.id));
    this.opening.set(s.id, opening); return opening;
  }
  private client(req: http.IncomingMessage, s: Session, r: Runtime): ControlClient {
    const key = req.headers['x-terminal-client'];
    if (typeof key !== 'string' || !/^[a-f0-9]{48}$/.test(key)) throw new ApiError(400, 'CLIENT_ID_REQUIRED');
    let entry = r.clients.get(key);
    if (!entry) {
      if (r.clients.size >= 16) throw new ApiError(429, 'CLIENT_LIMIT');
      const client = this.backend.control.join(s.name, {
        resume: key, principal: 'agent', label: s.label, admin: false,
        valid: () => r.alive, send: () => {},
      }, { cols: 120, rows: 35 }, false);
      entry = { client, seen: Date.now() }; r.clients.set(key, entry);
    }
    entry.seen = Date.now(); this.backend.control.action(s.name, entry.client, 'heartbeat');
    return entry.client;
  }
  private request(store: Record<string, RecordEntry>, body: any, action: () => unknown): unknown {
    if (!uuid(body.requestId)) throw new ApiError(400, 'REQUEST_ID_REQUIRED');
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const old = store[body.requestId];
    if (old) { if (old.hash !== hash) throw new ApiError(409, 'REQUEST_CONFLICT'); return old.result; }
    if (Object.keys(store).length >= 10000) throw new ApiError(429, 'REQUEST_HISTORY_FULL');
    // Durable uncertainty BEFORE writing any terminal bytes. Never replay an ambiguous request.
    if (Buffer.byteLength(JSON.stringify(store)) > 8 * 1024 * 1024) throw new ApiError(429, 'REQUEST_HISTORY_FULL');
    store[body.requestId] = { hash, result: { state: 'unknown', requestId: body.requestId, time: new Date().toISOString(),
      ...(typeof body.text === 'string' ? { input: body.sensitive ? '[sensitive input]' : body.text } : {}) } }; this.save();
    const result = action(); store[body.requestId].result = result; this.save(); return result;
  }
  async http(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith(PREFIX + '/') && url.pathname !== PREFIX) return false;
    const reply = (status: number, value: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
    let counted = false;
    try {
      this.auth(req);
      if (this.active >= 64) throw new ApiError(429, 'CONNECTION_LIMIT');
      this.active++; counted = true;
      const route = url.pathname.slice(PREFIX.length), method = req.method;
      if (route === '/info' && method === 'GET') { reply(200, { version: 1, platform: process.platform, capabilities: ['raw', 'persistent-session', 'cursor', 'dedupe'], completion: false }); return true; }
      if (route === '/sessions' && method === 'GET') { reply(200, { sessions: [...this.sessions.values()].map(({requests, ...s}) => ({ ...s, connected: this.runtimes.get(s.id)?.alive ?? false })) }); return true; }
      if (route === '/sessions' && method === 'POST') {
        const body = await this.body(req);
        const run = async () => {
          if (!uuid(body.requestId) || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80 || /[\x00-\x1f\x7f]/.test(body.label)) throw new ApiError(400, 'INVALID_CREATE');
          if (!this.creates[body.requestId] && [...this.sessions.values()].filter(s => !s.ended).length >= 8) throw new ApiError(429, 'SESSION_LIMIT');
          let directoryValid = false;
          try {
            // Only the documented Windows scratch directory is automatically provisioned.
            // Explicit project paths still have to exist; typos must not create directories.
            if (process.platform === 'win32' && typeof body.cwd === 'string' &&
                path.win32.normalize(body.cwd).replace(/[\\/]+$/, '').toLowerCase() === 'c:\\twsshprojectemp') {
              fs.mkdirSync(body.cwd, { recursive: true });
            }
            directoryValid = typeof body.cwd === 'string' && path.isAbsolute(body.cwd) && fs.statSync(body.cwd).isDirectory();
          } catch { /* invalid or inaccessible directory */ }
          if (!directoryValid) throw new ApiError(400, 'INVALID_DIRECTORY');
          const result = this.request(this.creates, body, () => {
            const id = crypto.randomUUID();
            const s: Session = { id, generation: crypto.randomUUID(), name: 'agent_' + id.replaceAll('-', ''), label: '🌐 ' + body.label, cwd: body.cwd, requests: {} };
            this.sessions.set(id, s); this.backend.control.setExplicit(s.name); return { sessionId: id, generation: s.generation, name: s.name };
          }) as {sessionId?: string};
          if (result.sessionId) {
            const s = this.sessions.get(result.sessionId)!;
            // New record can create; retries after a crash must never silently recreate a shell.
            const fresh = !this.runtimes.has(s.id) && !s.ended;
            const allowCreate = fresh && !this.recovered.has(s.id);
            this.recovered.add(s.id);
            await this.runtime(s, allowCreate);
          }
          return result;
        };
        const pending = this.creation.then(run); this.creation = pending.catch(() => {});
        reply(200, await pending); return true;
      }
      const match = /^\/sessions\/([a-f0-9-]{36})(?:\/(events|input|control|requests))?$/.exec(route);
      const s = match && this.sessions.get(match[1]); if (!s) throw new ApiError(404, 'SESSION_NOT_FOUND');
      const action = match![2];
      if (!action && method === 'GET') { const {requests, ...info} = s; reply(200, info); return true; }
      if (action === 'requests' && method === 'GET') { const id = url.searchParams.get('id') ?? ''; reply(200, s.requests[id]?.result ?? { state: 'not_found' }); return true; }
      // A dead collector must not make an orphan session impossible to close.
      if (!action && method === 'DELETE') {
        const body = await this.body(req);
        if (body.generation !== s.generation) throw new ApiError(409, 'GENERATION_MISMATCH');
        const current = this.runtimes.get(s.id);
        if (current?.alive) {
          const client = this.client(req, s, current);
          if (!this.backend.control.owns(s.name, client)) throw new ApiError(409, 'CONTROL_LOST');
        }
        await this.backend.remove(s.name); s.ended = true; this.save(); reply(200, { state: 'closed' }); return true;
      }
      const r = await this.runtime(s); const client = this.client(req, s, r);
      if (action === 'events' && method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new ApiError(400, 'INVALID_CURSOR');
        const epoch = url.searchParams.get('epoch');
        const gap = () => (epoch !== null && epoch !== r.epoch) || after > r.seq || after < (r.events[0]?.seq ?? 1) - 1;
        const wait = Math.min(5000, Math.max(0, Number(url.searchParams.get('waitMs')) || 0));
        if (!gap() && after === r.seq && wait) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); r.listeners.delete(done); res.off('close', done); resolve(); };
          const timer = setTimeout(done, wait); r.listeners.add(done); res.once('close', done);
        });
        const events = r.events.filter(e => e.seq > (gap() ? 0 : after)).slice(0, 128);
        reply(200, { epoch: r.epoch, gap: gap(), events, cursor: events.at(-1)?.seq ?? r.seq, alive: r.alive, mine: this.backend.control.owns(s.name, client) }); return true;
      }
      const body = await this.body(req);
      if (body.generation !== s.generation) throw new ApiError(409, 'GENERATION_MISMATCH');
      if (action === 'control' && method === 'POST') {
        if (!['acquire', 'release'].includes(body.action)) throw new ApiError(400, 'INVALID_ACTION');
        this.backend.control.action(s.name, client, body.action);
        reply(200, { mine: this.backend.control.owns(s.name, client), epoch: this.backend.control.fence(s.name, client) }); return true;
      }
      if (action === 'input' && method === 'POST') {
        if (typeof body.text !== 'string' || Buffer.byteLength(body.text) > 65536) throw new ApiError(400, 'INVALID_INPUT');
        if (typeof body.controlEpoch !== 'number' || !this.backend.control.accepts(s.name, client, body.controlEpoch)) throw new ApiError(409, 'CONTROL_LOST');
        const authorized = () => r.alive && !s.ended && this.backend.control.accepts(s.name, client, body.controlEpoch);
        // Viewing scrollback puts the shared pane in copy-mode. Leave it before
        // keyboard input, just like browser input, so the next command reaches PowerShell.
        if (!s.requests[body.requestId] && isKeyboardInput(body.text)) await this.backend.prepareInput(s.name, authorized);
        if (!authorized()) throw new ApiError(409, 'CONTROL_LOST');
        const result = this.request(s.requests, body, () => {
          this.event(r, 'input', body.sensitive ? '[sensitive input]' : body.text);
          r.proc.write(body.text);
          return { requestId: body.requestId, state: 'sent', completion: 'unknown', time: new Date().toISOString(), input: body.sensitive ? '[sensitive input]' : body.text };
        }); reply(200, result); return true;
      }
      throw new ApiError(404, 'NOT_FOUND');
    } catch (e) { reply(e instanceof ApiError ? e.status : 500, { error: e instanceof ApiError ? e.message : 'INTERNAL_ERROR' }); }
    finally { if (counted) this.active--; }
    return true;
  }
  private recovered = new Set<string>();
  /** Must be called immediately after loading disk state. */
  markRecovered(): void { for (const s of this.sessions.values()) this.recovered.add(s.id); }
}

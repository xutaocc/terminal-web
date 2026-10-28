import { decodeCommandPreview, withCommandPreview } from './command-preview.js';
import { AgentJournal } from './agent-journal.js';
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
  createdAt?: string; closedAt?: string; lastActivityAt?: string;
  ended?: boolean; requests: Record<string, RecordEntry>;
}
interface Runtime {
  sessionId: string; proc: IPty; events: Event[]; bytes: number; seq: number; epoch: string;
  clients: Map<string, { client: ControlClient; seen: number }>;
  listeners: Set<() => void>; alive: boolean;
}
export interface AgentBackend {
  token: string; file: string; enabled: boolean; control: TerminalControl;
  spawn(name: string, cwd: string, create: boolean): Promise<IPty>;
  prepareInput(name: string, authorized: () => boolean): Promise<void>;
  output?(name: string): void;
  register(name: string, label: string, cwd: string): void;
  cwd?(name: string): Promise<string | null>;
  rename?(name: string, label: string): void;
  remove(name: string, cleanupOnly?: boolean): Promise<void>;
}

/** Raw persistent terminal API. No completion claims are inferred from a quiet screen. */
export class AgentApi {
  private journal: AgentJournal;
  private sessions = new Map<string, Session>();
  private runtimes = new Map<string, Runtime>();
  private opening = new Map<string, Promise<Runtime>>();
  private creates: Record<string, RecordEntry> = {};
  private failures = new Map<string, { count: number; until: number }>();
  private active = 0;
  private creation: Promise<unknown> = Promise.resolve();
  constructor(private backend: AgentBackend) {
    this.journal = new AgentJournal(backend.file + '.history');
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
  flushHistory(): void { this.journal.flush(); }
  private async directory(s: Session) {
    let cwd: string | null = null;
    if (!s.ended) { try { cwd = await this.backend.cwd?.(s.name) ?? null; } catch { /* unknown */ } }
    return { cwd, observedAt: new Date().toISOString(), source: cwd ? 'pane_current_path' : 'unavailable', semantics: 'observation, not guaranteed command execution directory' };
  }
  private async describe(s: Session) {
    const { requests, ...info } = s;
    return { ...info, initialCwd: s.cwd, currentDirectory: await this.directory(s), createdAt: s.createdAt ?? null,
      lastActivityAt: s.lastActivityAt ?? null, closedAt: s.closedAt ?? null, requestCount: Object.keys(requests).length,
      connected: this.runtimes.get(s.id)?.alive ?? false };
  }
  isAgent(name: string): boolean { return [...this.sessions.values()].some(s => s.name === name); }
  /** Browser administrator closure; retain identity, commands and output history. */
  async closeFromBrowser(name: string, force = false, cleanup = false): Promise<void> {
    if (!/^agent_[a-f0-9]{32}$/.test(name)) throw new ApiError(400, 'INVALID_AGENT_SESSION');
    const unlock = this.backend.control.beginClose(name, force);
    if (!unlock) throw new ApiError(409, 'SESSION_BUSY');
    try {
      const s = [...this.sessions.values()].find(s => s.name === name);
      if (s) await this.opening.get(s.id);
      await this.backend.remove(name, cleanup);
      if (s) {
        s.ended = true; s.closedAt ??= new Date().toISOString(); this.save();
        const r = this.runtimes.get(s.id);
        if (r) { r.alive = false; this.event(r, 'closed', 'Closed by browser administrator'); }
      }
      this.journal.flush();
    } finally { unlock(); }
  }
  /** Update presentation only. Neither terminal identity nor control ownership changes. */
  rename(name: string, label: string): boolean {
    const s = [...this.sessions.values()].find(s => s.name === name);
    if (!s) return false;
    if (s.ended) throw new ApiError(410, 'SESSION_GONE');
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 64 || /[\x00-\x1f\x7f]/.test(label)) throw new ApiError(400, 'INVALID_LABEL');
    const previous = s.label;
    s.label = label.trim();
    try { this.save(); } catch (error) { s.label = previous; throw error; }
    this.backend.rename?.(s.name, s.label);
    return true;
  }
  history(name: string): unknown {
    const s = [...this.sessions.values()].find(s => s.name === name);
    return s ? { label: s.label, records: Object.values(s.requests).map(r => withCommandPreview(r.result)) } : null;
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
      this.journal.append(r.sessionId, type, part);
      r.events.push(e); r.bytes += Buffer.byteLength(part) + 128;
      while (r.bytes > 8 * 1024 * 1024 && r.events.length) {
        const removed = r.events.shift()!; r.bytes -= Buffer.byteLength(removed.data) + 128;
      }
    }
    for (const wake of r.listeners) wake();
  }
  private runtime(s: Session, create = false): Promise<Runtime> {
    if (this.backend.control.isClosing(s.name)) return Promise.reject(new ApiError(409, 'SESSION_CLOSING'));
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
      const r: Runtime = { sessionId: s.id, proc, events: [], bytes: 0, seq: 0, epoch: crypto.randomUUID(), clients: new Map(), listeners: new Set(), alive: true };
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
  private request(store: Record<string, RecordEntry>, body: any, action: () => unknown, metadata: Record<string, unknown> = {}): unknown {
    if (!uuid(body.requestId)) throw new ApiError(400, 'REQUEST_ID_REQUIRED');
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const old = store[body.requestId];
    if (old) { if (old.hash !== hash) throw new ApiError(409, 'REQUEST_CONFLICT'); return old.result; }
    if (Object.keys(store).length >= 10000) throw new ApiError(429, 'REQUEST_HISTORY_FULL');
    // Durable uncertainty BEFORE writing any terminal bytes. Never replay an ambiguous request.
    if (Buffer.byteLength(JSON.stringify(store, (key, value) => ['decodedInput', 'decodedEncoding', 'decodedScope', 'decodedParts'].includes(key) ? undefined : value)) > 8 * 1024 * 1024) throw new ApiError(429, 'REQUEST_HISTORY_FULL');
    store[body.requestId] = { hash, result: { ...metadata, state: 'unknown', requestId: body.requestId, time: new Date().toISOString(),
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
      if (route === '/info' && method === 'GET') { reply(200, { version: 1, platform: process.platform, capabilities: ['raw', 'persistent-session', 'cursor', 'dedupe', 'rename', 'history', 'cwd-observation'], completion: false }); return true; }
      if (route === '/sessions' && method === 'GET') { const sessions = await Promise.all([...this.sessions.values()].map(s => this.describe(s))); reply(200, { total: sessions.length, open: sessions.filter(s => !s.ended).length, closed: sessions.filter(s => s.ended).length, sessions }); return true; }
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
            const s: Session = { id, generation: crypto.randomUUID(), name: 'agent_' + id.replaceAll('-', ''), label: '🌐 ' + body.label, cwd: body.cwd, createdAt: new Date().toISOString(), requests: {} };
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
      const match = /^\/sessions\/([a-f0-9-]{36})(?:\/(events|input|control|requests|history))?$/.exec(route);
      const s = match && this.sessions.get(match[1]); if (!s) throw new ApiError(404, 'SESSION_NOT_FOUND');
      const action = match![2];
      if (!action && method === 'GET') { reply(200, await this.describe(s)); return true; }
      if (action === 'history' && method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? 0), limit = Number(url.searchParams.get('limit') ?? 50);
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'INVALID_PAGINATION');
        const kind = url.searchParams.get('kind') ?? 'requests';
        if (!['requests', 'output'].includes(kind)) throw new ApiError(400, 'INVALID_HISTORY_KIND');
        const records = Object.values(s.requests).map(r => withCommandPreview(r.result));
        const page: unknown[] = []; let bytes = 0;
        for (const record of records.slice(after, after + limit)) {
          const size = Buffer.byteLength(JSON.stringify(record));
          if (page.length && bytes + size > 2 * 1024 * 1024) break;
          page.push(record); bytes += size;
        }
        reply(200, { sessionId: s.id, label: s.label, initialCwd: s.cwd, kind,
          ...(kind === 'output' ? this.journal.read(s.id, after, limit) : {
            records: page, total: records.length,
            nextCursor: Math.min(after + page.length, records.length), hasMore: after + page.length < records.length,
            coverage: 'Agent API inputs only; legacy records may lack directory observations' }) }); return true;
      }
      if (!action && method === 'PATCH') {
        const body = await this.body(req);
        if (body.generation !== s.generation) throw new ApiError(409, 'GENERATION_MISMATCH');
        this.rename(s.name, body.label);
        reply(200, { sessionId: s.id, name: s.name, label: s.label, generation: s.generation }); return true;
      }
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
        await this.backend.remove(s.name); s.ended = true; s.closedAt = new Date().toISOString(); this.save(); this.journal.flush(); reply(200, { state: 'closed' }); return true;
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
        const directory = s.requests[body.requestId] ? null : await this.directory(s);
        if (!authorized()) throw new ApiError(409, 'CONTROL_LOST');
        const preview = decodeCommandPreview(body.text, !!body.sensitive) ?? {};
        const result = this.request(s.requests, body, () => {
          s.lastActivityAt = new Date().toISOString();
          this.event(r, 'input', body.sensitive ? '[sensitive input]' : body.text);
          r.proc.write(body.text);
          return { ...preview, requestId: body.requestId, state: 'sent', completion: 'unknown', directoryBeforeInput: directory, time: new Date().toISOString(), input: body.sensitive ? '[sensitive input]' : body.text };
        }, { ...preview, directoryBeforeInput: directory }); reply(200, result); return true;
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

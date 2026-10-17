import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import type { Duplex } from 'node:stream';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Other terminal-web servers this one can drive. The browser only ever talks to
 * this server: everything under /remote/<id>/… is forwarded, HTTP and WebSocket
 * alike, with the remote's token put on in place of ours. The token never
 * reaches the browser, every page stays same-origin, and a phone outside the
 * LAN reaches the remote through whatever already reaches this server.
 */
export interface Remote { id: string; name: string; url: string; token: string }
export type PublicRemote = Omit<Remote, 'token'>;

const PREFIX = /^\/remote\/([a-z0-9]{1,16})(\/.*)$/;
// A remote may itself drive remotes; this stops two servers that list each
// other from passing one request back and forth for ever.
const MAX_HOPS = 3;
const HOP_HEADER = 'x-tw-hops';
// Hop-by-hop and identity headers: ours are not the remote's.
const DROP = new Set(['host', 'cookie', 'origin', 'referer', 'connection', 'keep-alive', 'proxy-connection',
  'transfer-encoding', 'upgrade', 'x-forwarded-proto', 'x-forwarded-for', 'x-forwarded-host', HOP_HEADER]);

// Pooled sockets are dropped after a short idle: one that sat through a
// network change (a laptop moved to another room, Tailscale re-routed) is dead,
// and reusing it would cost a request its first attempt.
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 64, timeout: 30_000 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 64, timeout: 30_000 });
const agents = [httpAgent, httpsAgent];

// How long a remote may take to answer the headers of an ordinary request.
// Streams (agent status, downloads) are exempt once they have started.
const CONNECT_TIMEOUT_MS = 8_000;
// Idle limit on a forwarded terminal: the browser pings every 20 s and the
// remote pings every 20 s, so a minute of silence means the path is gone.
const WS_IDLE_MS = 60_000;

/**
 * Whether each remote is reachable, checked from the server. While one is up it
 * is checked every 30 s; once it stops answering, every 3 s at first, backing
 * off to 15 s, so it is seen again within seconds of the network coming back.
 * A network change on this machine (an interface going up or down) restarts
 * every check at once. Pages are told through /api/remotes/events and so do
 * not have to find out by timing out themselves.
 */
export interface RemoteHealth { online: boolean; since: number; error?: string; latencyMs?: number }

const UP_INTERVAL_MS = 30_000;
const DOWN_MIN_MS = 3_000;
const DOWN_MAX_MS = 15_000;

export class RemoteMonitor {
  private readonly state = new Map<string, RemoteHealth>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly delays = new Map<string, number>();
  private readonly listeners = new Set<(health: Record<string, RemoteHealth>) => void>();
  private netSignature = '';
  private netTimer: NodeJS.Timeout | null = null;

  constructor(private readonly store: RemoteStore, private readonly interfaces: () => string) {}

  start(): void {
    void this.sync();
    this.netSignature = this.interfaces();
    // Polled rather than evented: Node has no interface-change event. Cheap,
    // and a moved laptop is noticed within 2 s rather than at the next probe.
    this.netTimer = setInterval(() => {
      const signature = this.interfaces();
      if (signature === this.netSignature) return;
      this.netSignature = signature;
      console.log('[remotes] network changed; re-checking remotes now');
      for (const agent of agents) agent.destroy(); // pooled sockets died with the old route
      void this.checkAll();
    }, 2_000);
    this.netTimer.unref();
  }

  stop(): void {
    if (this.netTimer) clearInterval(this.netTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  snapshot(): Record<string, RemoteHealth> {
    return Object.fromEntries(this.state);
  }

  subscribe(fn: (health: Record<string, RemoteHealth>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  isOnline(id: string): boolean {
    return this.state.get(id)?.online !== false;
  }

  /** Follow the remote list: start checking new ones, forget removed ones. */
  async sync(): Promise<void> {
    const remotes = await this.store.list();
    const ids = new Set(remotes.map(r => r.id));
    for (const id of [...this.state.keys()]) {
      if (ids.has(id)) continue;
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.state.delete(id);
      this.delays.delete(id);
    }
    for (const r of remotes) if (!this.timers.has(r.id)) void this.check(r.id);
    this.emit();
  }

  /** Check every remote now (network change, or a page asking for a retry). */
  async checkAll(): Promise<void> {
    await Promise.all((await this.store.list()).map(r => this.check(r.id)));
  }

  /** A forwarded request just failed to connect: check it now rather than at the next tick. */
  reportFailure(id: string): void {
    if (this.state.get(id)?.online === false) return;
    void this.check(id);
  }

  async check(id: string): Promise<void> {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const remote = await this.store.get(id);
    if (!remote) return;
    const started = Date.now();
    const result = await probeRemote(remote.url, remote.token);
    const online = result === 'ok';
    const before = this.state.get(id);
    const health: RemoteHealth = {
      online,
      since: before && before.online === online ? before.since : Date.now(),
      ...(online ? { latencyMs: Date.now() - started } : { error: result }),
    };
    this.state.set(id, health);
    if (!before || before.online !== online || before.error !== health.error) {
      console.log(`[remotes] ${remote.name} (${remote.url}) ${online ? 'online' : `offline: ${result}`}`);
      this.emit();
    }
    const delay = online ? UP_INTERVAL_MS : Math.min(DOWN_MAX_MS, Math.max(DOWN_MIN_MS, (this.delays.get(id) ?? 0) * 1.6));
    this.delays.set(id, online ? 0 : delay);
    const timer = setTimeout(() => void this.check(id), delay);
    timer.unref();
    this.timers.set(id, timer);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}

export function validRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 32);
  return name || null;
}

function cleanToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  return token && token.length <= 512 && !/[\s;]/.test(token) ? token : null;
}

export class RemoteStore {
  private cache: Remote[] | null = null;
  private write: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  async list(): Promise<Remote[]> {
    if (this.cache) return this.cache;
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      this.cache = Array.isArray(parsed) ? parsed.filter((r): r is Remote =>
        !!r && typeof r.id === 'string' && /^[a-z0-9]{1,16}$/.test(r.id) && typeof r.name === 'string' &&
        typeof r.url === 'string' && !!validRemoteUrl(r.url) && typeof r.token === 'string') : [];
    } catch { this.cache = []; }
    return this.cache;
  }

  async get(id: string): Promise<Remote | undefined> {
    return (await this.list()).find(r => r.id === id);
  }

  static view(remotes: Remote[]): PublicRemote[] {
    return remotes.map(({ id, name, url }) => ({ id, name, url }));
  }

  private async save(next: Remote[]): Promise<void> {
    this.cache = next;
    this.write = this.write.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, this.file);
    }).catch(err => console.error('[remotes] write failed:', (err as Error).message));
    await this.write;
  }

  /** Apply one edit from the settings UI; throws with a message for the user. */
  async edit(body: Record<string, unknown>): Promise<Remote[]> {
    const all = [...await this.list()];
    if (body.action === 'add' || body.action === 'update') {
      const existing = body.action === 'update' ? all.find(r => r.id === body.id) : undefined;
      if (body.action === 'update' && !existing) throw new Error('远程主机不存在');
      const name = cleanName(body.name) ?? existing?.name;
      const url = body.url === undefined && existing ? existing.url : validRemoteUrl(body.url);
      const token = (body.token === undefined || body.token === '') && existing ? existing.token : cleanToken(body.token);
      if (!name) throw new Error('请填写名称');
      if (!url) throw new Error('地址需为 http(s)://主机:端口');
      if (!token) throw new Error('请填写远程访问 Token');
      const probe = await probeRemote(url, token);
      if (probe !== 'ok') throw new Error(probe);
      const remote: Remote = { id: existing?.id ?? randomBytes(4).toString('hex'), name, url, token };
      await this.save(existing ? all.map(r => r.id === remote.id ? remote : r) : [...all, remote]);
      return this.list();
    }
    if (body.action === 'remove') {
      await this.save(all.filter(r => r.id !== body.id));
      return this.list();
    }
    throw new Error('未知操作');
  }
}

function target(remote: Remote, rest: string): URL {
  return new URL(remote.url + rest);
}

function forwardHeaders(req: http.IncomingMessage, remote: Remote, to: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!DROP.has(key) && value !== undefined) headers[key] = value;
  }
  headers.host = to.host;
  headers.cookie = `tw_auth=${encodeURIComponent(remote.token)}`;
  // The remote checks that a write comes from its own origin; through us it does.
  if (req.headers.origin) headers.origin = to.origin;
  headers[HOP_HEADER] = String(hops(req) + 1);
  return headers;
}

function hops(req: http.IncomingMessage): number {
  const n = Number(req.headers[HOP_HEADER]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Whether the token works against that server: 'ok', or why not. */
export async function probeRemote(url: string, token: string): Promise<string> {
  const to = new URL(url + '/api/sessions');
  return new Promise(resolve => {
    const request = (to.protocol === 'https:' ? https : http).request(to, {
      // A fresh connection every time: the point is whether the path works now,
      // which a pooled socket from before a network change says nothing about.
      method: 'GET', timeout: 5000, agent: false,
      headers: { cookie: `tw_auth=${encodeURIComponent(token)}`, accept: 'application/json' },
    }, res => {
      res.resume();
      if (res.statusCode === 200) resolve('ok');
      else if (res.statusCode === 401) resolve('Token 不正确');
      else resolve(`远程返回 ${res.statusCode}，请确认是 WebTerminal 服务`);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', err => resolve(err.message === 'timeout' ? '连接超时' : `无法连接：${err.message}`));
    request.end();
  });
}

/** The remote and the path on it, for a /remote/<id>/… request; null for anything else. */
export function remoteRoute(pathname: string): { id: string; rest: string } | null {
  const m = PREFIX.exec(pathname);
  return m ? { id: m[1], rest: m[2] } : null;
}

/**
 * Forward one HTTP request and stream the answer back, uploads, downloads and
 * the agent-status event stream included. The remote turning our token down is
 * reported as a gateway error, never as a 401: the browser reads a 401 as its
 * own sign-in having lapsed, and would reload into our login page.
 */
export function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, remote: Remote, rest: string, search: string,
                          monitor?: RemoteMonitor): void {
  if (hops(req) >= MAX_HOPS) { res.writeHead(508).end('Loop detected'); return; }
  // Known to be down: answer at once instead of making the page wait out a
  // connect timeout for every request while the network is gone.
  if (monitor && !monitor.isOnline(remote.id)) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '3', 'X-Remote-Offline': '1' });
    res.end(JSON.stringify({ error: `远程主机「${remote.name}」暂时无法连接，恢复后自动重连` }));
    return;
  }
  const to = target(remote, rest + search);
  const lib = to.protocol === 'https:' ? https : http;
  const upstream = lib.request(to, {
    method: req.method, headers: forwardHeaders(req, remote, to),
    agent: to.protocol === 'https:' ? httpsAgent : httpAgent,
  }, answer => {
    clearTimeout(headerTimer);
    const status = answer.statusCode ?? 502;
    if (status === 401) {
      answer.resume();
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'X-Remote-Auth': 'failed' });
      res.end(JSON.stringify({ error: `远程主机「${remote.name}」的 Token 无效，请在设置中更新` }));
      return;
    }
    const headers = { ...answer.headers };
    delete headers['set-cookie'];
    delete headers.connection;
    delete headers['keep-alive'];
    const location = headers.location;
    if (typeof location === 'string' && location.startsWith('/') && !location.startsWith('//')) {
      headers.location = `/remote/${remote.id}${location}`;
    }
    res.writeHead(status, headers);
    res.flushHeaders();
    answer.pipe(res);
  });
  // Until the remote starts answering; a stream that has started may then be
  // as quiet as it likes (the agent-status stream pings every 25 s anyway).
  const headerTimer = setTimeout(() => upstream.destroy(new Error('连接超时')), CONNECT_TIMEOUT_MS);
  upstream.on('socket', socket => socket.setKeepAlive(true, 10_000));
  upstream.on('error', err => {
    clearTimeout(headerTimer);
    if (!answered) monitor?.reportFailure(remote.id);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `远程主机「${remote.name}」无法连接：${err.message}` }));
    } else res.destroy();
  });
  let answered = false;
  upstream.on('response', () => { answered = true; });
  res.on('close', () => { clearTimeout(headerTimer); if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}

/**
 * Forward a WebSocket handshake and then splice the two sockets together. No
 * frame is read or rewritten on the way: terminal output goes through as the
 * bytes it arrived as, so the only cost over a direct connection is one LAN hop.
 */
export function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, remote: Remote, rest: string, search: string,
                             monitor?: RemoteMonitor): void {
  const refuse = (line: string): void => { socket.write(`HTTP/1.1 ${line}\r\n\r\n`); socket.destroy(); };
  if (hops(req) >= MAX_HOPS) { refuse('508 Loop Detected'); return; }
  if (monitor && !monitor.isOnline(remote.id)) { refuse('503 Remote Offline'); return; }
  const to = target(remote, rest + search);
  const headers = forwardHeaders(req, remote, to);
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade ?? 'websocket';
  const upstream = (to.protocol === 'https:' ? https : http).request(to, { method: 'GET', headers, agent: false });
  const connectTimer = setTimeout(() => upstream.destroy(new Error('timeout')), CONNECT_TIMEOUT_MS);
  upstream.on('upgrade', (answer, remoteSocket, remoteHead) => {
    clearTimeout(connectTimer);
    const lines = [`HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? 'Switching Protocols'}`];
    for (let i = 0; i < answer.rawHeaders.length; i += 2) {
      if (answer.rawHeaders[i].toLowerCase() !== 'set-cookie') lines.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remoteSocket.write(head);
    for (const s of [socket, remoteSocket] as (Duplex & Partial<net.Socket>)[]) {
      s.setNoDelay?.(true);
      // TCP keepalive notices a dead path even with nobody typing; the idle
      // limit catches the case where keepalive is not enough (a sleeping NAT
      // that still ACKs). Either way both ends close, so the browser's own
      // reconnect starts at once instead of after the OS gives up minutes later.
      s.setKeepAlive?.(true, 10_000);
      s.setTimeout?.(WS_IDLE_MS, () => { socket.destroy(); remoteSocket.destroy(); });
      s.on('error', () => { socket.destroy(); remoteSocket.destroy(); });
    }
    remoteSocket.pipe(socket);
    socket.pipe(remoteSocket);
    socket.on('close', () => remoteSocket.destroy());
    remoteSocket.on('close', () => socket.destroy());
  });
  upstream.on('response', answer => {
    clearTimeout(connectTimer);
    answer.resume();
    refuse(answer.statusCode === 401 ? '502 Remote Token Rejected' : `${answer.statusCode ?? 502} Remote Refused`);
  });
  upstream.on('error', () => {
    clearTimeout(connectTimer);
    monitor?.reportFailure(remote.id);
    refuse('502 Bad Gateway');
  });
  socket.on('error', () => upstream.destroy());
  upstream.end();
}

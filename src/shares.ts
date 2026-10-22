import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { activeShare, digest, ShareStore, type Share, type ShareSession } from './share-store.js';
import { content, within, handleFileApi } from './file-api.js';
import { isAuthed, validOrigin } from './auth.js';
import { proxyHttp, proxyUpgrade, type RemoteStore, type Remote } from './remotes.js';
import type { FolderData } from './projects.js';
import type { SavedSession } from './session-store.js';

const PEER = '/api/share-peer';
const SCOPE = 'x-tw-share-scope';
export interface ShareScope { grant?: string; authorize?: () => boolean; session: ShareSession; expiresAt: number | null }
export class ShareError extends Error { constructor(message: string, public status = 400) { super(message); } }
const json = (res: http.ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
};
async function body(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { const chunk = Buffer.from(c); size += chunk.length; if (size > 128_000) throw new ShareError('请求过大', 413); chunks.push(chunk); }
  try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!b || Array.isArray(b) || typeof b !== 'object') throw 0; return b; } catch { throw new ShareError('无效请求'); }
}
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const key = (s: Pick<ShareSession, 'host' | 'name'>) => `${s.host}/${s.name}`;
export async function sharePath(root: string, relative: string): Promise<string> {
  if (!relative || relative === '.') relative = '';
  if (relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new ShareError('不能访问分享目录之外的路径', 403);
  const base = await fs.realpath(root);
  // A moved/replaced symlink must not silently widen the grant.
  if (path.relative(root, base) !== '') throw new ShareError('分享根目录已变化，请管理员重新授权', 403);
  const p = path.resolve(base, relative);
  if (!within(p, base)) throw new ShareError('不能访问分享目录之外的路径', 403);
  const actual = await fs.realpath(p);
  if (!within(actual, base)) throw new ShareError('链接指向分享目录之外', 403);
  return actual;
}
interface Dependencies {
  token: string; publicDir: string; remotes: RemoteStore;
  collect(): Promise<SavedSession[]>;
  get(name: string): SavedSession | undefined;
  cwd(name: string): Promise<string | null>;
  closed(name: string): boolean;
  info(): unknown;
  subscribe(listener: () => void): () => void;
  revokeControl(grant: string): void;
  folders(): Promise<FolderData>;
  self(): Promise<unknown>;
  status(): { mode: string; sessions: Record<string, unknown> };
  remoteStatuses(): { host: string; status: unknown }[];
  health(): Record<string, unknown>;
}
export class ShareService {
  readonly requests = new WeakMap<http.IncomingMessage, ShareScope>();
  isSessionShared(host: string, name: string): boolean {
    const identity = host ? undefined : this.d.get(name)?.identity;
    return (!host && this.store.remotelyShared(name, identity)) || this.store.list().some(share => activeShare(share) && share.sessions.some(session =>
      session.host === host && session.name === name && (host !== '' || session.identity === identity)));
  }
  private terminalConnections = new Map<string, Set<Duplex>>();
  private connections = new Map<string, Set<() => void>>();
  private remoteBindings = new Map<() => void, Pick<Remote, 'id' | 'url' | 'token'>>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(readonly store: ShareStore, private d: Dependencies) {
    void this.syncRemotePolicies();
    const policyTimer = setInterval(() => { void this.syncRemotePolicies(); }, 15000); policyTimer.unref();
    const timer = setInterval(() => {
      for (const id of this.connections.keys()) { const s = store.get(id); if (!s || !activeShare(s)) this.disconnect(id); }
      if (this.remoteBindings.size) void d.remotes.list().then(remotes => {
        for (const [close, bound] of this.remoteBindings) {
          const current = remotes.find(r => r.id === bound.id);
          if (!current || current.url !== bound.url || current.token !== bound.token) close();
        }
      }).catch(() => { for (const close of this.remoteBindings.keys()) close(); });
    }, 500);
    timer.unref();
  }
  private policyQueues = new Map<string, Promise<void>>();
  private policyAcknowledged = new Map<string, string>();
  private async syncRemotePolicies(hosts?: string[]): Promise<void> {
    try {
      if (hosts && !hosts.length) return;
      const source = createHmac('sha256', this.d.token).update('share-policy-source').digest('hex');
      const remotes = (await this.d.remotes.list()).filter(r => !hosts || hosts.includes(r.id));
      await Promise.allSettled(remotes.map(remote => {
        const previous = this.policyQueues.get(remote.id) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(async () => {
          // Compute the latest snapshot when this host's turn starts, not when queued.
          const sessions = this.store.list().filter(s => activeShare(s)).flatMap(s => s.sessions.filter(item => item.host === remote.id).map(item => ({name:item.name, identity:item.identity, expiresAt:s.expiresAt})));
          const payload = JSON.stringify({source,sessions});
          const signature = digest(remote.url + remote.token + payload);
          if (this.policyAcknowledged.get(remote.id) === signature) return;
          const response = await fetch(remote.url + PEER + '/policy', {method:'POST', headers:{Cookie:`tw_auth=${encodeURIComponent(remote.token)}`, 'Content-Type':'application/json'}, body:payload, signal:AbortSignal.timeout(3000), redirect:'error'});
          await response.arrayBuffer();
          if (response.ok) this.policyAcknowledged.set(remote.id, signature);
        });
        this.policyQueues.set(remote.id, next);
        void next.finally(() => { if (this.policyQueues.get(remote.id) === next) this.policyQueues.delete(remote.id); }).catch(() => {});
        return next;
      }));
    } catch { /* The periodic sync retries unavailable hosts. */ }
  }
  private bindRemote(remote: Remote, close: () => void, done: (fn: () => void) => void): void {
    this.remoteBindings.set(close, { id: remote.id, url: remote.url, token: remote.token });
    done(() => this.remoteBindings.delete(close));
  }
  disconnect(id: string, previous?: Share): void {
    const s = previous ?? this.store.get(id);
    if (s) { const grant = createHmac('sha256', this.d.token).update('control:' + s.id).digest('hex'); this.d.revokeControl(grant);
      void this.d.remotes.list().then(remotes => Promise.allSettled(remotes.filter(r => s.sessions.some(item => item.host === r.id)).map(remote =>
        fetch(remote.url + PEER + '/release-control', { method: 'POST', headers: { Cookie: `tw_auth=${encodeURIComponent(remote.token)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({grant}), signal: AbortSignal.timeout(8000), redirect:'error' })))).catch(() => {});
    }
    for (const close of this.connections.get(id) ?? []) close(); this.connections.delete(id); }
  private track(id: string, close: () => void, done: (fn: () => void) => void): void {
    let set = this.connections.get(id); if (!set) this.connections.set(id, set = new Set()); set.add(close);
    done(() => { set!.delete(close); if (!set!.size) this.connections.delete(id); });
  }
  private signature(s: Share, value: string): string { return createHmac('sha256', this.d.token).update(`${s.id}:${s.revision}:${s.tokenHash}:${value}:${value.startsWith('preview:') ? digest(JSON.stringify(s.sessions)) : ''}`).digest('hex'); }
  private cookieName(id: string) { return `tw_share_${id.replaceAll('-', '')}`; }
  private authed(req: http.IncomingMessage, s: Share): boolean {
    const prefix = this.cookieName(s.id) + '=';
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(prefix))?.slice(prefix.length) ?? '';
    const [nonce, sig] = cookie.split('.');
    return activeShare(s) && !!nonce && /^[a-f0-9]{32}$/.test(nonce) && !!sig && /^[a-f0-9]{64}$/.test(sig) && equal(sig, this.signature(s, nonce));
  }
  validScope(scope: ShareScope): boolean {
    const tab = this.d.get(scope.session.name);
    return (!scope.authorize || scope.authorize()) && (!scope.expiresAt || scope.expiresAt > Date.now()) && !this.d.closed(scope.session.name) && !!tab && tab.identity === scope.session.identity;
  }
  private peerScope(req: http.IncomingMessage): ShareScope {
    try {
      const raw = req.headers[SCOPE]; if (typeof raw !== 'string' || raw.length > 16000) throw 0;
      const scope = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (!scope.session || scope.authorize !== undefined || !this.validScope(scope) || typeof scope.session.root !== 'string') throw 0;
      return scope;
    } catch { throw new ShareError('会话授权已失效', 403); }
  }
  private async remoteJson(remote: Remote, route: string, timeoutMs = 8000): Promise<any> {
    const r = await fetch(remote.url + PEER + route, { headers: { Cookie: `tw_auth=${encodeURIComponent(remote.token)}` }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!r.ok || !r.headers.get('content-type')?.includes('application/json')) throw new ShareError('远端不可用或尚未升级分享协议', 503);
    return r.json();
  }
  private async localCatalog(): Promise<ShareSession[]> {
    const tabs = await this.d.collect();
    const result = await Promise.all(tabs.map(async tab => {
      if (!tab.cwd || !tab.identity) return null;
      try { return { host: '', hostName: '本机', name: tab.name, identity: tab.identity, displayName: tab.displayName, sourceRoot: tab.cwd, root: await fs.realpath(tab.cwd) }; } catch { return null; }
    }));
    return result.filter((s): s is ShareSession => s !== null);
  }
  private catalogCache = new Map<string, {until:number; value:ShareSession[]}>();
  private catalogFlights = new Map<string, Promise<ShareSession[]>>();
  private remoteCatalog(remote: Remote, fresh = false): Promise<ShareSession[]> {
    const cacheKey = digest(remote.id + remote.url + remote.token);
    const cached = this.catalogCache.get(cacheKey);
    if (!fresh && cached && cached.until > Date.now()) return Promise.resolve(cached.value);
    const pending = this.catalogFlights.get(cacheKey);
    if (pending) return pending;
    const request = this.remoteJson(remote, '/catalog', 3000).then(data => {
      if (data.version !== 3 || !Array.isArray(data.sessions)) throw new ShareError('远端需要升级分享协议', 503);
      const value = data.sessions.map((s: ShareSession) => ({...s, host:remote.id, hostName:remote.name}));
      this.catalogCache.set(cacheKey, {until:Date.now()+5000, value});
      return value;
    });
    this.catalogFlights.set(cacheKey, request);
    void request.finally(() => this.catalogFlights.delete(cacheKey)).catch(() => {});
    return request;
  }
  private async catalog(hosts?: Set<string>) {
    const remotes = (await this.d.remotes.list()).filter(r => !hosts || hosts.has(r.id));
    // Local and remote inventories run together; no sequential full-host scan.
    const local = !hosts || hosts.has('') ? this.localCatalog() : Promise.resolve([]);
    const groups = Promise.all(remotes.map(async remote => {
      try { return {host:remote.id, hostName:remote.name, sessions:await this.remoteCatalog(remote, !!hosts)}; }
      catch { return {host:remote.id, hostName:remote.name, sessions:[], error:'主机暂未响应（3 秒）或需要升级，可稍后重新加载'}; }
    }));
    const [sessions, remoteGroups] = await Promise.all([local, groups]);
    return [{host:'', hostName:'本机', sessions}, ...remoteGroups];
  }
  private async selection(raw: unknown, old: ShareSession[] = []): Promise<ShareSession[]> {
    if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new ShareError('请选择 1 至 100 个会话');
    for (const entry of raw) if (!entry || typeof entry.host !== 'string' || typeof entry.name !== 'string') throw new ShareError('无效会话');
    const groups = await this.catalog(new Set(raw.map(entry => entry.host)));
    const all = groups.flatMap(g => g.sessions) as ShareSession[];
    const selected: ShareSession[] = [];
    for (const entry of raw) {
      if (entry.fromMain && !entry.identity) throw new ShareError('此会话尚未获得身份信息，请先取消勾选、刷新会话列表，再重新选择', 409);
      const prior = old.find(s => key(s) === key(entry));
      const current = all.find(s => key(s) === key(entry));
      if (!prior && !current) throw new ShareError('所选会话或主机暂不可用，请重新加载后再试', 409);
      if (!prior && current && ((entry.root !== undefined && entry.root !== current.root && entry.root !== current.sourceRoot) || (entry.identity !== undefined && entry.identity !== current.identity))) throw new ShareError('会话或目录已变化，请重新打开选择器确认', 409);
      const s = prior ?? current;
      if (!s || (current && prior && current.identity !== prior.identity)) throw new ShareError('会话已变化，请移除后重新选择');
      if (!selected.some(item => key(item) === key(s))) selected.push(s);
    }
    return selected;
  }
  private publicShare(s: Share) {
    const { tokenHash: _, encryptedToken, createRequestId: _request, ...rest } = s;
    return { ...rest, tokenAvailable: !!encryptedToken, status: s.revokedAt ? 'revoked' : activeShare(s) ? 'active' : 'expired', connections: this.terminalConnections.get(s.id)?.size ?? 0 };
  }
  private async stampAssets(html: string): Promise<string> {
    const files = ['dist/terminal.js', 'dist/terminal.css', 'styles.css', 'dist/file-browser.js', 'dist/file-browser.css', 'dist/shares.js', 'dist/shares.css'];
    const stamp = digest((await Promise.all(files.map(async file => { try { const st = await fs.stat(path.join(this.d.publicDir, file)); return `${st.size}:${st.mtimeMs}`; } catch { return ''; } }))).join('|')).slice(0, 12);
    return html.replace(/((?:src|href)="[^"?]+\.(?:js|css))(?:\?[^"]*)?"/g, `$1?v=${stamp}"`);
  }
  private async shell(res: http.ServerResponse, admin: boolean): Promise<void> {
    const html = await fs.readFile(path.join(this.d.publicDir, 'shares.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-src 'self' blob:; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'" });
    res.end(await this.stampAssets(html.replace('data-mode="guest"', `data-mode="${admin ? 'admin' : 'guest'}"`)));
  }
  private async applicationPage(res: http.ServerResponse, id: string, file: 'index.html' | 'file-browser.html'): Promise<void> {
    const html = await fs.readFile(path.join(this.d.publicDir, file), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(await this.stampAssets(html.replace(/(src|href)="\//g, `$1="/share/${id}/assets/`)));
  }
  private previewPrefix(s: Share, index: number): string {
    const expiry = Math.min(Date.now() + 30 * 60_000, s.expiresAt ?? Infinity);
    return `/share/${s.id}/preview/${index}/${expiry}.${this.signature(s, `preview:${index}:${expiry}`)}/`;
  }
  private lastRemoteStatuses = new Map<string, {mode?:string; sessions?:Record<string,unknown>}>();
  private statusFor(s: Share, host: string) {
    let snapshot = (host ? this.d.remoteStatuses().find(item => item.host === host)?.status : this.d.status()) as { mode?: string; sessions?: Record<string, unknown> } | undefined;
    if (host) { if (snapshot) this.lastRemoteStatuses.set(host, snapshot); else snapshot = this.lastRemoteStatuses.get(host); }
    const names = new Set(s.sessions.filter(item => item.host === host).map(item => item.name));
    return { mode: snapshot?.mode ?? 'hooks', sessions: Object.fromEntries(Object.entries(snapshot?.sessions ?? {}).filter(([name]) => names.has(name))) };
  }
  private async application(req: http.IncomingMessage, res: http.ServerResponse, s: Share, route: string, url: URL): Promise<void> {
    const remoteRoute = /^\/remote\/([a-z0-9]{1,16})(\/.*)$/.exec(route);
    const host = remoteRoute?.[1] ?? ''; route = remoteRoute?.[2] ?? route;
    const allowed = s.sessions.filter(item => item.host === host);
    if (host && !allowed.length) throw new ShareError('主机未授权', 403);
    const method = req.method ?? 'GET';
    if (route === '/auth/logout' && method === 'POST') {
      res.setHeader('Set-Cookie', `${this.cookieName(s.id)}=; Path=/share/${s.id}/; HttpOnly; SameSite=Strict; Max-Age=0`); json(res, 200, { ok: true }); return;
    }
    if (route === '/api/agent-status/read' && method === 'POST') { json(res, 200, { ok: true }); return; }
    if (!['GET', 'HEAD'].includes(method)) throw new ShareError('分享无权修改会话或文件', 403);
    if (route === '/api/sessions') {
      const tabs = allowed.map(item => ({ name: item.name, displayName: (!host && this.d.get(item.name)?.displayName) || item.displayName, cwd: item.root }));
      json(res, 200, { tabs }); return;
    }
    if (route === '/api/remotes' && !host) {
      const remotes = (await this.d.remotes.list()).filter(r => s.sessions.some(item => item.host === r.id)).map(({ token: _, ...r }) => r);
      const health = Object.fromEntries(Object.entries(this.d.health()).filter(([id]) => remotes.some(r => r.id === id)));
      json(res, 200, { remotes, health, self: await this.d.self() }); return;
    }
    if (route === '/api/host-info') {
      if (!host) { json(res, 200, this.d.info()); return; }
      const remote = await this.d.remotes.get(host); if (!remote) throw new ShareError('远程主机已移除', 410);
      const result = await this.remoteJson(remote, '/catalog'); json(res, 200, result.info ?? {}); return;
    }
    if (route === '/api/folders') {
      let data: FolderData;
      if (host) { const remote = await this.d.remotes.get(host); if (!remote) throw new ShareError('远程主机已移除', 410); data = (await this.remoteJson(remote, '/catalog')).folders ?? { folders: [], members: {}, dirNames: {} }; }
      else data = await this.d.folders();
      const names = new Set(allowed.map(item => item.name));
      const members = Object.fromEntries(Object.entries(data.members).filter(([name]) => names.has(name)));
      const folders = data.folders.filter(folder => Object.values(members).includes(folder.id));
      const rootsFor = (id: string) => new Set(allowed.filter(item => (members[item.name] ?? '') === id).map(item => item.root));
      const dirNames = Object.fromEntries(Object.entries(data.dirNames).map(([id, entries]) => [id, Object.fromEntries(Object.entries(entries).filter(([root]) => rootsFor(id).has(root)))]).filter(([, entries]) => Object.keys(entries).length));
      const cardOrder = Object.fromEntries(Object.entries(data.cardOrder ?? {}).map(([id, roots]) => [id, roots.filter(root => rootsFor(id).has(root))]));
      json(res, 200, { folders, members, dirNames, cardOrder, pinned: (data.pinned ?? []).filter(name => names.has(name)), emptied: [] }); return;
    }
    if (route === '/api/quick-commands') { json(res, 200, { revision: 0, commands: [] }); return; }
    if (route === '/api/terminal-colors') { json(res, 200, { enabled: true }); return; }
    if (route === '/api/agent-status') { json(res, 200, this.statusFor(s, host)); return; }
    if (route === '/api/agent-status/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const emit = () => {
        if (res.destroyed) return;
        const current = this.store.get(s.id);
        if (!current || !this.authed(req, current)) { res.write('event: share-ended\ndata: {}\n\n'); res.end(); return; }
        res.write(`data: ${JSON.stringify(this.statusFor(current, ''))}\n\n`);
        const hosts = [...new Set(current.sessions.map(item => item.host).filter(Boolean))];
        for (const id of hosts) res.write(`event: remote\ndata: ${JSON.stringify({ host: id, status: this.statusFor(current, id) })}\n\n`);
        res.write(`event: health\ndata: ${JSON.stringify(Object.fromEntries(Object.entries(this.d.health()).filter(([id]) => hosts.includes(id))))}\n\n`);
      };
      this.track(s.id, () => { if (!res.destroyed) { res.write('event: share-ended\ndata: {}\n\n'); res.end(); } }, done => res.once('close', done));
      emit(); const unsubscribe = this.d.subscribe(emit);
      const timer = setInterval(() => { if (!res.destroyed) res.write('event: ping\ndata: \n\n'); }, 15000); timer.unref(); res.once('close', () => { clearInterval(timer); unsubscribe(); }); return;
    }
    const name = url.searchParams.get('session');
    const session = allowed.find(item => item.name === name);
    if (!session) throw new ShareError('会话未授权', 403);
    const index = s.sessions.indexOf(session);
    if (route === '/api/sessions/cwd') { json(res, 200, { path: session.root, readOnly: true, previewPrefix: this.previewPrefix(s, index) }); return; }
    if (route === '/api/sessions/note') { json(res, 200, { note: '', displayName: session.displayName }); return; }
    const fileRoute = route === '/api/download' ? 'content' : route.startsWith('/api/files/') ? route.slice('/api/files/'.length) : '';
    if (!['list', 'stat', 'text', 'content'].includes(fileRoute)) throw new ShareError('分享无权访问此功能', 403);
    const params = new URLSearchParams(url.searchParams); params.set('route', fileRoute);
    if (route === '/api/download') params.set('download', '1');
    const scope: ShareScope = { session, expiresAt: s.expiresAt, authorize: () => { const current = this.store.get(s.id); return !!current && this.authed(req, current) && current.sessions.some(item => key(item) === key(session) && item.identity === session.identity); } };
    this.track(s.id, () => res.destroy(), done => res.once('close', done));
    if (host) {
      const remote = await this.d.remotes.get(host); if (!remote) throw new ShareError('远程主机已移除', 410);
      if (res.destroyed || !scope.authorize!()) return;
      req.headers[SCOPE] = Buffer.from(JSON.stringify(scope)).toString('base64url');
      this.bindRemote(remote, () => res.destroy(), done => res.once('close', done));
      proxyHttp(req, res, remote, PEER + '/files-app', '?' + params); return;
    }
    await this.applicationFiles(req, res, scope, params);
  }
  private async applicationFiles(req: http.IncomingMessage, res: http.ServerResponse, scope: ShareScope, params: URLSearchParams): Promise<void> {
    if (!this.validScope(scope)) throw new ShareError('会话授权已失效', 410);
    const route = params.get('route') ?? '';
    if (!['list', 'stat', 'text', 'content'].includes(route) || !['GET', 'HEAD'].includes(req.method ?? '')) throw new ShareError('文件管理只读', 403);
    const input = params.get('path') ?? '';
    const raw = path.isAbsolute(input) ? input : path.resolve(scope.session.root, input);
    const relative = path.relative(scope.session.root, raw).split(path.sep).join('/');
    const checked = await sharePath(scope.session.root, relative);
    if (!this.validScope(scope) || res.destroyed) throw new ShareError('会话授权已失效', 410);
    const target = new URL('/api/files/' + route, 'http://localhost'); target.search = params.toString(); target.searchParams.set('path', checked);
    const timer = setInterval(() => { if (!this.validScope(scope)) res.destroy(); }, 500); timer.unref(); res.once('close', () => clearInterval(timer));
    await handleFileApi(req, res, target, { maxUpload: 0, tmuxConf: '' });
  }
  async publicHttp(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/share/') && !url.pathname.startsWith('/share-assets/')) return false;
    try {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      if (url.pathname.startsWith('/share-assets/')) {
        if (!['GET', 'HEAD'].includes(req.method ?? '')) throw new ShareError('只允许读取', 405);
        const name = url.pathname.slice('/share-assets/'.length);
        if (!/^(shares|chunk-[A-Z0-9]+)\.(js|css)(\.map)?$/.test(name)) throw new ShareError('不存在', 404);
        const data = await fs.readFile(path.join(this.d.publicDir, 'dist', name));
        res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(req.method === 'HEAD' ? undefined : data); return true;
      }
      const match = /^\/share\/([a-f0-9-]{36})(?:\/(.*))?$/.exec(url.pathname);
      if (!match) throw new ShareError('分享不存在', 404);
      const [, id, action = ''] = match;
      const s = this.store.get(id);
      if (action.startsWith('assets/') && ['GET', 'HEAD'].includes(req.method ?? '')) {
        const asset = action.slice(7);
        if (!/^(?:dist\/[A-Za-z0-9_.-]+\.(?:js|css|map)|styles\.css|[a-z0-9-]+\.(?:png|svg|webmanifest))$/.test(asset)) throw new ShareError('不存在', 404);
        const data = await fs.readFile(path.join(this.d.publicDir, asset));
        res.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Type': asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.svg') ? 'image/svg+xml' : asset.endsWith('.png') ? 'image/png' : 'application/json' }); res.end(req.method === 'HEAD' ? undefined : data); return true;
      }
      if (action === '' && req.method === 'GET') {
        if (!url.pathname.endsWith('/')) { res.writeHead(302, { Location: url.pathname + '/' }).end(); return true; }
        if (s && this.authed(req, s)) await this.applicationPage(res, id, 'index.html');
        else await this.shell(res, false); return true;
      }
      if (!s || !activeShare(s)) throw new ShareError('分享已结束、已过期或不存在', 410);
      if (req.method !== 'GET' && req.method !== 'HEAD' && !validOrigin(req)) throw new ShareError('请求来源不合法', 403);
      if (action === 'login' && req.method === 'POST') {
        const addr = req.socket.remoteAddress ?? '';
        const attempt = this.attempts.get(addr);
        if (attempt && attempt.until > Date.now() && attempt.count >= 6) throw new ShareError('尝试过多，请一分钟后重试', 429);
        const b = await body(req);
        if (typeof b.token !== 'string' || !equal(digest(b.token.trim()), s.tokenHash)) {
          if (this.attempts.size > 1000) for (const [k, v] of this.attempts) if (v.until <= Date.now()) this.attempts.delete(k);
          this.attempts.set(addr, { count: attempt && attempt.until > Date.now() ? attempt.count + 1 : 1, until: Date.now() + 60_000 });
          throw new ShareError('Token 不正确', 401);
        }
        this.attempts.delete(addr);
        const nonce = randomBytes(16).toString('hex');
        const secure = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' ? '; Secure' : '';
        this.store.update(id, { lastAccessAt: Date.now() });
        res.setHeader('Set-Cookie', `${this.cookieName(id)}=${nonce}.${this.signature(s, nonce)}; Path=/share/${id}/; HttpOnly; SameSite=Strict${secure}`);
        json(res, 200, { ok: true }); return true;
      }
      const preview = /^preview\/(\d+)\/(?:(\d{13})\.([a-f0-9]{64})\/)?(.*)$/.exec(action);
      const previewAuthorized = !!preview?.[2] && Number(preview[2]) > Date.now() && equal(preview[3], this.signature(s, `preview:${preview[1]}:${preview[2]}`));
      if (preview?.[2] && !previewAuthorized) throw new ShareError('预览已过期，请重新打开', 403);
      if (!previewAuthorized && !this.authed(req, s)) throw new ShareError('请输入分享 Token', 401);
      if (action === 'preview-ticket' && req.method === 'POST') {
        const b = await body(req); const index = b.index;
        if (!Number.isInteger(index) || !s.sessions[index]) throw new ShareError('会话未授权', 403);
        const expiry = Math.min(Date.now() + 30 * 60_000, s.expiresAt ?? Infinity);
        json(res, 200, { prefix: `preview/${index}/${expiry}.${this.signature(s, `preview:${index}:${expiry}`)}/` }); return true;
      }
      if (action === 'file-browser.html' && req.method === 'GET') { await this.applicationPage(res, id, 'file-browser.html'); return true; }
      if (action.startsWith('app/')) { await this.application(req, res, s, '/' + action.slice(4), url); return true; }
      if (action === 'logout' && req.method === 'POST') {
        res.setHeader('Set-Cookie', `${this.cookieName(id)}=; Path=/share/${id}/; HttpOnly; SameSite=Strict; Max-Age=0`); json(res, 200, { ok: true }); return true;
      }
      if (action === 'state' && req.method === 'GET') {
        const hosts = [...new Set(s.sessions.map(item => item.host).filter(Boolean))];
        const catalogs = new Map<string, ShareSession[] | null>();
        await Promise.all(hosts.map(async host => {
          try { const remote = await this.d.remotes.get(host); const data = remote && await this.remoteJson(remote, '/catalog'); catalogs.set(host, data?.version === 3 ? data.sessions : null); }
          catch { catalogs.set(host, null); }
        }));
        const sessions = await Promise.all(s.sessions.map(async ({ identity, ...session }) => {
          const current = session.host ? catalogs.get(session.host)?.find(t => t.name === session.name && t.identity === identity) : this.d.get(session.name);
          const available = !!current && (session.host ? true : current.identity === identity && !this.d.closed(session.name) && !!await this.d.cwd(session.name));
          return { ...session, displayName: current?.displayName ?? session.displayName, available, ...(!available ? { error: '原会话、目录或远程主机不可用，不会自动创建' } : {}) };
        }));
        if (!this.authed(req, this.store.get(id)!)) throw new ShareError('分享权限已更新', 401);
        json(res, 200, { id: s.id, name: s.name, expiresAt: s.expiresAt, sessions }); return true;
      }
      if (!['GET', 'HEAD'].includes(req.method ?? '')) throw new ShareError('分享文件管理为只读', 403);
      if (action !== 'files' && !preview) throw new ShareError('分享无权访问此功能', 403);
      const index = Number(preview?.[1] ?? url.searchParams.get('index'));
      if (!Number.isInteger(index) || !s.sessions[index]) throw new ShareError('会话未授权', 403);
      const session = s.sessions[index];
      const scope: ShareScope = { session, expiresAt: s.expiresAt, authorize: () => { const current = this.store.get(id); return !!current && current.revision === s.revision && activeShare(current) && current.sessions.some(item => key(item) === key(session) && item.identity === session.identity); } };
      const params = new URLSearchParams({ op: preview ? 'preview' : url.searchParams.get('op') ?? 'list', path: preview ? decodeURIComponent(preview[4]) : url.searchParams.get('path') ?? '' });
      this.track(id, () => res.destroy(), done => res.once('close', done));
      if (session.host) {
        const remote = await this.d.remotes.get(session.host);
        if (!remote) throw new ShareError('远程主机不存在', 410);
        if (res.destroyed || !activeShare(this.store.get(id)!)) return true;
        req.headers[SCOPE] = Buffer.from(JSON.stringify(scope)).toString('base64url');
        this.bindRemote(remote, () => res.destroy(), done => res.once('close', done));
        proxyHttp(req, res, remote, PEER + '/files', '?' + params.toString());
      } else await this.files(req, res, scope, params);
      return true;
    } catch (e) { this.error(res, e); return true; }
  }
  async adminHttp(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/shares' && !url.pathname.startsWith('/api/shares') && !url.pathname.startsWith(PEER)) return false;
    try {
      if (url.pathname === '/shares' && req.method === 'GET') { await this.shell(res, true); return true; }
      if (url.pathname === PEER + '/policy' && req.method === 'POST') {
        const b = await body(req);
        if (typeof b.source !== 'string' || !/^[a-f0-9]{64}$/.test(b.source) || !Array.isArray(b.sessions) || b.sessions.length > 10000 || b.sessions.some((s: any) => !s || typeof s.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.name) || typeof s.identity !== 'string' || !s.identity || (s.expiresAt !== null && (!Number.isFinite(s.expiresAt) || s.expiresAt <= 0)))) throw new ShareError('invalid share policy');
        this.store.setRemotePolicy(b.source, b.sessions.map((s: any) => ({name:s.name, identity:s.identity, expiresAt:s.expiresAt})));
        json(res, 200, {ok:true}); return true;
      }
      if (url.pathname === PEER + '/release-control' && req.method === 'POST') { const b = await body(req); if (typeof b.grant !== 'string' || !/^[a-f0-9]{64}$/.test(b.grant)) throw new ShareError('invalid grant'); this.d.revokeControl(b.grant); json(res, 200, {ok:true}); return true; }
      if (url.pathname === PEER + '/catalog' && req.method === 'GET') { json(res, 200, { version: 3, info: this.d.info(), folders: await this.d.folders(), sessions: await this.localCatalog() }); return true; }
      if (url.pathname === PEER + '/files-app' && ['GET', 'HEAD'].includes(req.method ?? '')) { await this.applicationFiles(req, res, this.peerScope(req), url.searchParams); return true; }
      if (url.pathname === PEER + '/files' && ['GET', 'HEAD'].includes(req.method ?? '')) { await this.files(req, res, this.peerScope(req), url.searchParams); return true; }
      if (url.pathname === '/api/shares/catalog' && req.method === 'GET') { json(res, 200, { groups: await this.catalog() }); return true; }
      if (url.pathname !== '/api/shares') throw new ShareError('不存在', 404);
      if (req.method === 'GET') { json(res, 200, { shares: this.store.list().map(s => this.publicShare(s)) }); return true; }
      if (req.method !== 'POST') throw new ShareError('不支持的操作', 405);
      const b = await body(req);
      if (b.action === 'create' && b.requestId !== undefined) {
        if (typeof b.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(b.requestId)) throw new ShareError('无效请求标识');
        const existing = this.store.findCreateRequest(b.requestId);
        if (existing) { json(res, 200, {share:this.publicShare(existing), token:this.store.revealToken(existing.id)}); return true; }
      }
      const old = typeof b.id === 'string' ? this.store.get(b.id) : undefined;
      if (b.action !== 'create' && !old) throw new ShareError('分享不存在', 404);
      if (b.action === 'delete') {
        if (!old?.revokedAt) throw new ShareError('请先终止分享，再删除记录', 409);
        this.disconnect(old.id, old); this.store.delete(old.id);
        json(res, 200, {ok:true}); return true;
      }
      if (old?.revokedAt) throw new ShareError('已终止的分享不能恢复', 409);
      if (b.action === 'token') {
        const token = this.store.revealToken(old!.id);
        if (!token) throw new ShareError('此历史记录仅保存了 Token 摘要，无法还原。请先重置一次，此后即可随时查看和复制。', 409);
        json(res, 200, {share:this.publicShare(old!), token}); return true;
      }

      let result: { share: Share; token?: string };
      if (b.action === 'revoke') result = this.store.update(old!.id, { revokedAt: Date.now() });
      else if (b.action === 'reset') result = this.store.update(old!.id, {}, true);
      else if (b.action === 'create' || b.action === 'update') {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (!name || name.length > 80) throw new ShareError('分享名称需要 1 至 80 字');
        const expiresAt = b.expiresAt === null ? null : Number(b.expiresAt);
        if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new ShareError('有效期必须晚于当前时间');
        const sessions = await this.selection(b.sessions, old?.sessions);
        result = old ? this.store.update(old.id, { name, sessions, expiresAt }) : this.store.create(name, sessions, expiresAt, b.requestId);
      } else throw new ShareError('未知操作');
      if (old) this.disconnect(old.id, old);
      // Resetting a token does not change which sessions are shared. Do not
      // wait for every remote host (including offline hosts) to sync unchanged policy.
      if (b.action !== 'reset') await this.syncRemotePolicies([...new Set([...(old?.sessions ?? []), ...result.share.sessions].map(s => s.host).filter(Boolean))]);
      json(res, 200, { share: this.publicShare(result.share), ...(result.token ? { token: result.token } : {}) });
    } catch (e) { this.error(res, e); }
    return true;
  }
  private async files(req: http.IncomingMessage, res: http.ServerResponse, scope: ShareScope, params: URLSearchParams): Promise<void> {
    if (!this.validScope(scope)) throw new ShareError('会话授权已失效', 410);
    const op = params.get('op');
    if (!['list', 'preview', 'download', 'text'].includes(op ?? '')) throw new ShareError('只允许浏览和下载', 403);
    const timer = setInterval(() => { if (!this.validScope(scope)) res.destroy(); }, 500); timer.unref(); res.once('close', () => clearInterval(timer));
    let p = await sharePath(scope.session.root, params.get('path') ?? '');
    if (op === 'list') {
      const names = await fs.readdir(p); if (names.length > 10000) throw new ShareError('目录文件过多，请进入子目录');
      const entries = [];
      for (const name of names) {
        const child = path.join(p, name);
        try {
          const real = await fs.realpath(child);
          if (!within(real, scope.session.root)) { entries.push({ name, blocked: true, directory: false, size: 0 }); continue; }
          const stat = await fs.stat(real);
          if (!stat.isFile() && !stat.isDirectory()) continue;
          entries.push({ name, directory: stat.isDirectory(), size: stat.size });
        } catch { entries.push({ name, blocked: true, directory: false, size: 0 }); }
      }
      json(res, 200, { entries }); return;
    }
    if (op === 'preview' && (await fs.stat(p)).isDirectory()) p = await sharePath(scope.session.root, path.relative(scope.session.root, path.join(p, 'index.html')).split(path.sep).join('/'));
    // Preview scripts run in an opaque origin, including when opened outside the iframe.
    if (op === 'preview') { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('X-Content-Type-Options', 'nosniff'); }
    if (op === 'preview') res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'self' https: http: data: blob: 'unsafe-inline'; connect-src 'self' https: http:; object-src 'none'; base-uri 'none'; form-action 'none'");
    await content(req, res, p, op === 'download' ? 'download' : op === 'preview' ? 'site' : 'inline');
  }
  async upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, accept: (scope: ShareScope) => void): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/share/') && url.pathname !== PEER + '/ws') return false;
    try {
      if (!validOrigin(req)) throw new ShareError('来源不合法', 403);
      let scope: ShareScope;
      if (url.pathname === PEER + '/ws') {
        if (!isAuthed(req, this.d.token)) throw new ShareError('未登录', 401);
        scope = this.peerScope(req);
      } else {
        const match = /^\/share\/([a-f0-9-]{36})\/(?:ws|app\/(?:remote\/[a-z0-9]{1,16}\/)?ws)$/.exec(url.pathname);
        const s = match && this.store.get(match[1]);
        if (!s || !this.authed(req, s)) throw new ShareError('分享已失效', 401);
        const appHost = /\/app\/remote\/([a-z0-9]{1,16})\/ws$/.exec(url.pathname)?.[1] ?? '';
        const index = url.pathname.includes('/app/') ? s.sessions.findIndex(item => item.host === appHost && item.name === url.searchParams.get('session')) : Number(url.searchParams.get('index'));
        if (!Number.isInteger(index) || !s.sessions[index]) throw new ShareError('会话未授权', 403);
        scope = { session: s.sessions[index], expiresAt: s.expiresAt, grant: createHmac('sha256', this.d.token).update('control:' + s.id).digest('hex') };
        this.track(s.id, () => socket.destroy(), done => socket.once('close', done));
        let terminals = this.terminalConnections.get(s.id); if (!terminals) this.terminalConnections.set(s.id, terminals = new Set());
        terminals.add(socket); socket.once('close', () => { terminals!.delete(socket); if (!terminals!.size) this.terminalConnections.delete(s.id); });
        if (scope.session.host) {
          const remote = await this.d.remotes.get(scope.session.host);
          if (!remote || socket.destroyed || !this.authed(req, this.store.get(s.id)!)) throw new ShareError('远端或分享不可用', 410);
          req.headers[SCOPE] = Buffer.from(JSON.stringify(scope)).toString('base64url');
          const search = new URLSearchParams({ client: url.searchParams.get('client') ?? '', cols: url.searchParams.get('cols') ?? '80', rows: url.searchParams.get('rows') ?? '24' });
          this.bindRemote(remote, () => socket.destroy(), done => socket.once('close', done));
          proxyUpgrade(req, socket, head, remote, PEER + '/ws', '?' + search); return true;
        }
      }
      if (url.pathname.startsWith('/share/')) {
        const id = url.pathname.split('/')[2];
        const revision = this.store.get(id)!.revision;
        scope.authorize = () => { const current = this.store.get(id); return !!current && activeShare(current) && current.revision === revision && current.sessions.some(s => key(s) === key(scope.session) && s.identity === scope.session.identity); };
      }
      if (!this.validScope(scope)) throw new ShareError('原会话授权已失效', 410);
      if (!await this.d.cwd(scope.session.name)) throw new ShareError('原会话未运行，不会自动创建', 410);
      if (socket.destroyed || !this.validScope(scope)) return true;
      url.pathname = '/ws'; url.searchParams.delete('create'); url.searchParams.delete('dir'); url.searchParams.delete('from'); url.searchParams.set('session', scope.session.name);
      req.url = url.pathname + url.search;
      this.requests.set(req, scope); accept(scope);
    } catch (e) { console.warn('[share] terminal refused:', e instanceof Error ? e.message : 'unavailable'); socket.end(`HTTP/1.1 ${e instanceof ShareError ? e.status : 503} Share Unavailable\r\nConnection: close\r\n\r\n`); }
    return true;
  }
  private error(res: http.ServerResponse, e: unknown): void {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    const code = (e as NodeJS.ErrnoException).code;
    json(res, e instanceof ShareError ? e.status : code === 'ENOENT' ? 404 : 500, { error: e instanceof ShareError ? e.message : code === 'ENOENT' ? '文件或目录不存在' : '操作失败，请检查主机连接和文件权限' });
  }
}

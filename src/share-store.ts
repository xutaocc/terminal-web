import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';

export interface ShareSession {
  host: string;
  name: string;
  identity: string;
  displayName: string;
  hostName: string;
  root: string;
  sourceRoot?: string;
}
export interface Share {
  id: string;
  name: string;
  sessions: ShareSession[];
  tokenHash: string;
  encryptedToken?: string;
  createRequestId?: string;
  revision: number;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastAccessAt?: number;
}
export const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
export const activeShare = (s: Share, now = Date.now()): boolean => !s.revokedAt && (!s.expiresAt || s.expiresAt > now);
export interface RemoteSharePolicy { name: string; identity: string; expiresAt: number | null }
export class ShareStore {
  private shares: Share[];
  private remotePolicies: Record<string, RemoteSharePolicy[]> = {};
  constructor(private file: string) {
    try { this.remotePolicies = JSON.parse(fs.readFileSync(file + '.remote-policies.json', 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    try {
      this.shares = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(this.shares) || this.shares.some(s =>
        !s || typeof s.id !== 'string' || !/^[a-f0-9-]{36}$/.test(s.id) || typeof s.name !== 'string' ||
        typeof s.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(s.tokenHash) ||
        !Number.isInteger(s.revision) || s.revision < 1 || !Number.isFinite(s.createdAt) ||
        (s.expiresAt !== null && !Number.isFinite(s.expiresAt)) || (s.revokedAt !== null && !Number.isFinite(s.revokedAt)) ||
        !Array.isArray(s.sessions) || s.sessions.some(item => !item || typeof item.host !== 'string' ||
          typeof item.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.name) ||
          typeof item.identity !== 'string' || !item.identity || typeof item.root !== 'string' || !item.root))) {
        throw new Error('Invalid share store; refusing to restore share access');
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.shares = []; }
  }
  list(): Share[] { return structuredClone(this.shares); }
  remotelyShared(name: string, identity: string | undefined): boolean {
    return Object.values(this.remotePolicies).some(items => items.some(item => item.name === name && item.identity === identity && (!item.expiresAt || item.expiresAt > Date.now())));
  }
  setRemotePolicy(source: string, sessions: RemoteSharePolicy[]): void {
    if (JSON.stringify(this.remotePolicies[source] ?? []) === JSON.stringify(sessions)) return;
    const next = { ...this.remotePolicies, [source]: sessions };
    if (!sessions.length) delete next[source];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const destination = this.file + '.remote-policies.json';
    const temp = destination + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 }); fs.renameSync(temp, destination);
    this.remotePolicies = next;
  }
  get(id: string): Share | undefined { const s = this.shares.find(s => s.id === id); return s && structuredClone(s); }
  private save(next: Share[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    this.shares = next;
  }
  private tokenKey(create = false): Buffer {
    const file = this.file + '.token-key';
    try {
      const key = fs.readFileSync(file);
      if (key.length !== 32) throw new Error('Token 密钥损坏');
      return key;
    } catch (e) {
      if (!create || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
      const key = randomBytes(32);
      try { fs.writeFileSync(file, key, {flag:'wx', mode:0o600}); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.tokenKey(); throw error; }
      return key;
    }
  }
  private encryptToken(token: string, id: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.tokenKey(true), iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }
  revealToken(id: string): string | undefined {
    const share = this.get(id);
    if (!share || share.revokedAt) throw new Error('分享已终止或不存在');
    if (!share.encryptedToken) return undefined;
    try {
      const data = Buffer.from(share.encryptedToken, 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', this.tokenKey(), data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28)); cipher.setAAD(Buffer.from(id));
      const token = Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
      if (digest(token) !== share.tokenHash) throw new Error('invalid token');
      return token;
    } catch { throw new Error('无法读取保存的 Token，请重置 Token 后重试'); }
  }
  delete(id: string): void {
    const share = this.get(id);
    if (!share?.revokedAt) throw new Error('请先终止分享，再删除记录');
    this.save(this.shares.filter(s => s.id !== id));
  }
  findCreateRequest(requestId: string): Share | undefined {
    const share = this.shares.find(s => s.createRequestId === requestId);
    return share && structuredClone(share);
  }
  create(name: string, sessions: ShareSession[], expiresAt: number | null, requestId?: string) {
    const existing = requestId ? this.findCreateRequest(requestId) : undefined;
    if (existing) return {share:existing, token:this.revealToken(existing.id)!};
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const share: Share = { id, name, sessions, ...(requestId ? {createRequestId:requestId} : {}), tokenHash: digest(token), encryptedToken: this.encryptToken(token, id), revision: 1, createdAt: Date.now(), expiresAt, revokedAt: null };
    this.save([...this.shares, share]);
    return { share, token };
  }
  update(id: string, patch: Partial<Pick<Share, 'name' | 'sessions' | 'expiresAt' | 'revokedAt' | 'lastAccessAt'>>, reset = false) {
    const previous = this.get(id);
    if (!previous) throw new Error('分享不存在');
    const token = reset ? randomBytes(32).toString('base64url') : undefined;
    const share = { ...previous, ...patch, ...(reset ? { tokenHash: digest(token!), encryptedToken: this.encryptToken(token!, id), revision: previous.revision + 1 } : {}) };
    this.save(this.shares.map(s => s.id === id ? share : s));
    return { share, token };
  }
}

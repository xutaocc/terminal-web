import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface ShareSession {
  host: string;
  name: string;
  identity: string;
  displayName: string;
  hostName: string;
  root: string;
}
export interface Share {
  id: string;
  name: string;
  sessions: ShareSession[];
  tokenHash: string;
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
  create(name: string, sessions: ShareSession[], expiresAt: number | null) {
    const token = randomBytes(32).toString('base64url');
    const share: Share = { id: randomUUID(), name, sessions, tokenHash: digest(token), revision: 1, createdAt: Date.now(), expiresAt, revokedAt: null };
    this.save([...this.shares, share]);
    return { share, token };
  }
  update(id: string, patch: Partial<Pick<Share, 'name' | 'sessions' | 'expiresAt' | 'revokedAt' | 'lastAccessAt'>>, reset = false) {
    const previous = this.get(id);
    if (!previous) throw new Error('分享不存在');
    const token = reset ? randomBytes(32).toString('base64url') : undefined;
    const share = { ...previous, ...patch, ...(reset ? { tokenHash: digest(token!), revision: previous.revision + 1 } : {}) };
    this.save(this.shares.map(s => s.id === id ? share : s));
    return { share, token };
  }
}

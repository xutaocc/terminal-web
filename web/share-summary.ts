import { makeKey } from './hosts.js';
export interface ShareSummaryRecord {
  id: string; status: string; expiresAt: number | null;
  sessions: { host: string; name: string; identity?: string }[];
}
export function summarizeShares(shares: ShareSummaryRecord[], identities: Map<string, string | undefined>, now = Date.now()): { count: number; sessions: Map<string, number> } {
  const active = new Map(shares.filter(s => s.status === 'active' && (!s.expiresAt || s.expiresAt > now)).map(s => [s.id, s]));
  const sessions = new Map<string, number>();
  for (const share of active.values()) {
    const keys = new Set(share.sessions.filter(s => {
      const identity = identities.get(makeKey(s.host, s.name));
      return !identity || !s.identity || identity === s.identity;
    }).map(s => makeKey(s.host, s.name)));
    for (const key of keys) sessions.set(key, (sessions.get(key) ?? 0) + 1);
  }
  return { count: active.size, sessions };
}

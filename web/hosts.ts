/**
 * Which server a session, folder or request belongs to. '' is this server; any
 * other id is a remote this server forwards to under /remote/<id>/ (see
 * src/remotes.ts), so a remote's API is this server's API with a prefix.
 *
 * Sessions and folders of different servers can share a name, so the page
 * tells them apart by a key: a local one's key is its plain name (what this
 * page has always stored), a remote one's is "@<host>/<name>". Neither a tmux
 * session name nor a folder id can contain "@" or "/".
 */
export interface RemoteHost { id: string; name: string; url: string; note?: string; color?: string }

/**
 * The tag colours a server can have (src/remotes.ts LABEL_COLORS), with their
 * names for the picker. Six far apart, so servers tell apart at a glance.
 */
export const LABEL_COLORS = [
  ['green', '绿'], ['amber', '橙'], ['blue', '蓝'], ['purple', '紫'], ['red', '红'], ['teal', '青'],
] as const;
export const LABEL_MAX = 6;

/** A server's tag as a badge: its name, coloured. `title` goes on hover. */
export function labelBadge(name: string, color: string | undefined, title = ''): HTMLElement {
  const badge = document.createElement('span');
  const known = LABEL_COLORS.some(([c]) => c === color);
  badge.className = `host-badge label-${known ? color : 'amber'}`;
  badge.textContent = name;
  if (title) badge.title = title;
  return badge;
}

const KEY = /^@([a-z0-9]{1,16})\/(.*)$/s;

export function makeKey(host: string, raw: string): string {
  return host ? `@${host}/${raw}` : raw;
}

export function splitKey(key: string): { host: string; raw: string } {
  const m = KEY.exec(key);
  return m ? { host: m[1], raw: m[2] } : { host: '', raw: key };
}

export function hostOfKey(key: string): string {
  return splitKey(key).host;
}

/** A path on the server that owns `host`'s API: '/api/x' or '/remote/<id>/api/x'. */
export function hostUrl(host: string, path: string): string {
  return host ? `/remote/${host}${path}` : path;
}

/**
 * An absolute directory on whichever server reported it: "/home/x" from a Unix
 * host, "C:\Users\x" from a Windows one (psmux). Hosts of both kinds can be
 * open in one page, so this cannot follow the browser's own platform.
 */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * The shortest tail of each address that still tells them apart: ".56" and
 * ".119" for 172.16.69.56 and 192.168.88.119, ".1.5" and ".2.5" when the last
 * parts collide. A host name keeps its first label. Tabs carry this; the full
 * address is in their tooltip.
 */
export function shortAddresses(ips: readonly string[]): string[] {
  const ipv4 = /^\d+(\.\d+){3}$/;
  let tails: string[] = [];
  for (let take = 1; take <= 4; take++) {
    tails = ips.map(ip => !ip ? '' : ipv4.test(ip) ? '.' + ip.split('.').slice(-take).join('.') : ip.split('.')[0].slice(0, 12));
    const shown = tails.filter(Boolean);
    if (new Set(shown).size === shown.length) break;
  }
  return tails;
}

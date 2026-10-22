/** Route the existing application through the share authorization boundary.
 * Never replace browser globals: admin tabs and shared file iframes stay independent.
 */
export const shareBase = typeof location === 'undefined' ? '' : /^\/share\/[a-f0-9-]{36}\//.exec(location.pathname)?.[0] ?? '';
export const isShare = !!shareBase;
const nativeFetch = globalThis.fetch.bind(globalThis);
export function shareUrl(value: string): string {
  if (!isShare) return value;
  const url = new URL(value, location.href);
  if (url.host !== location.host || !/^\/(api\/|remote\/|ws(?:$|\?)|auth\/logout)/.test(url.pathname)) return value;
  url.pathname = shareBase + 'app' + url.pathname;
  return /^wss?:/.test(url.protocol) ? url.href : url.pathname + url.search;
}
export function sharePage(page: string): string { return isShare ? shareBase + page.replace(/^\//, '') : page; }
export const shareStorage = {
  getItem(key: string) { return globalThis.localStorage.getItem(isShare ? `${shareBase}:${key}` : key); },
  setItem(key: string, value: string) { globalThis.localStorage.setItem(isShare ? `${shareBase}:${key}` : key, value); },
  removeItem(key: string) { globalThis.localStorage.removeItem(isShare ? `${shareBase}:${key}` : key); },
};
export async function shareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isShare) return nativeFetch(input, init);
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  // Preferences are private to this browser and share; never write admin preferences.
  if (url.origin === location.origin && url.pathname === '/api/prefs') {
    let prefs: Record<string, unknown> = {};
    try { prefs = JSON.parse(shareStorage.getItem('prefs') ?? '{}'); } catch { /* unavailable */ }
    if (init?.method === 'POST') {
      try { prefs = { ...prefs, ...JSON.parse(String(init.body)) }; shareStorage.setItem('prefs', JSON.stringify(prefs)); } catch { /* private browsing */ }
    }
    return Response.json({ prefs });
  }
  return nativeFetch(shareUrl(url.href), init);
}
export class ShareWebSocket extends globalThis.WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) { super(shareUrl(String(url)), protocols); }
}
export class ShareEventSource extends globalThis.EventSource {
  constructor(url: string | URL, config?: EventSourceInit) {
    super(shareUrl(String(url)), config);
    if (isShare) this.addEventListener('share-ended', () => { this.close(); location.replace(shareBase); });
  }
}
if (isShare) {
  document.body.classList.add('share-mode');
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    checking = true;
    try { const r = await nativeFetch(shareBase + 'state', { cache: 'no-store', signal: AbortSignal.timeout(12000) }); if (r.status === 401 || r.status === 410) location.replace(shareBase); }
    catch { /* temporary network loss uses the normal reconnect UI */ }
    finally { checking = false; }
  }, 5000);
}

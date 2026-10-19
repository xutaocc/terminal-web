import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "tw_auth";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* invalid cookie */ }
    }
  }
  return out;
}

/** Constant-time compare; false on any length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Load one persistent shared secret; never silently disable authentication. */
export function loadAuthToken(file: string, configured?: string): string {
  if (configured?.trim()) return configured.trim();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  }
  fs.chmodSync(file, 0o600);
  const token = fs.readFileSync(file, "utf8").trim();
  if (!token) throw new Error("Token file is empty; refusing to start.");
  return token;
}

export function browserId(req: http.IncomingMessage): string | undefined {
  const id = parseCookies(req.headers.cookie).tw_browser;
  return id && /^[a-f0-9]{32}$/.test(id) ? id : undefined;
}

/** Browser requests must originate from this host, including WebSocket handshakes. */
export function validOrigin(req: http.IncomingMessage): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients still need the token cookie
  try {
    const expected = `${reqIsHttps(req) ? "https" : "http"}://${req.headers.host}`;
    return new URL(origin).origin === new URL(expected).origin;
  } catch { return false; }
}

function hasValidCookie(req: http.IncomingMessage, token: string): boolean {
  const got = parseCookies(req.headers.cookie)[COOKIE];
  return typeof got === "string" && safeEqual(got, token);
}

/** Every request requires the shared secret. */
export function isAuthed(req: http.IncomingMessage, token: string): boolean {
  return Boolean(token) && hasValidCookie(req, token);
}

function reqIsHttps(req: http.IncomingMessage): boolean {
  const xf = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(xf) ? xf[0] : xf) ?? "";
  // Behind a tunnel/proxy the edge sets X-Forwarded-Proto; only then is it safe
  // to mark the cookie Secure (a Secure cookie wouldn't work over plain-HTTP
  // tailnet access).
  return proto.split(",")[0]?.trim() === "https";
}

function authCookie(token: string, secure: boolean): string {
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=34560000",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// Only same-site absolute paths are accepted as the post-login destination.
function safeNext(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
}

// ---------------------------------------------------------------------------
// Sign-in throttling. Six wrong tokens from one address lock it out for a
// minute, and each further lockout doubles, up to an hour. A right token clears
// it. Counted per client address — behind a proxy that is the proxy, which is
// still better than no limit at all.
// ---------------------------------------------------------------------------
const MAX_FAILURES = 6;
const LOCK_BASE_MS = 60_000;
const LOCK_MAX_MS = 60 * 60_000;
interface Attempts { failures: number; lockouts: number; lockedUntil: number; seen: number }
const attempts = new Map<string, Attempts>();

function clientKey(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function attemptsFor(key: string, now: number): Attempts {
  // Forget addresses that have been quiet for a day, so the map cannot grow for ever.
  if (attempts.size > 1000) for (const [k, a] of attempts) if (now - a.seen > 86_400_000) attempts.delete(k);
  let a = attempts.get(key);
  if (!a) attempts.set(key, a = { failures: 0, lockouts: 0, lockedUntil: 0, seen: now });
  a.seen = now;
  return a;
}

function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.ceil(s / 60)} 分钟` : `${s} 秒`;
}

const escapeAttr = (v: string): string => v.replace(/[&"<>]/g, c => `&#${c.charCodeAt(0)};`);

function loginPage(error: string, next = "/", locked = false): string {
  const err = error
    ? `<p class="err" role="alert">${error.replace(/[<>&]/g, "")}</p>`
    : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Web Terminal — sign in</title>
<style>
  :root { color-scheme: dark; }
  html,body { height:100%; margin:0; background:#1e1e1e; color:#d4d4d4;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .wrap { min-height:100%; display:flex; align-items:center; justify-content:center; padding:24px; }
  form { width:min(92vw,340px); background:#252526; border:1px solid #3a3a3a; border-radius:12px;
    padding:22px; box-shadow:0 8px 30px rgba(0,0,0,.5); }
  h1 { font-size:15px; margin:0 0 14px; color:#fff; }
  .user { position:absolute; left:-9999px; width:1px; height:1px; opacity:0; }
  input { width:100%; box-sizing:border-box; background:#1e1e1e; color:#d4d4d4;
    border:1px solid #3a3a3a; border-radius:8px; padding:12px; font:inherit; font-size:15px; }
  button { width:100%; margin-top:12px; padding:12px; background:#2472c8; color:#fff;
    border:1px solid #3b8eea; border-radius:8px; font:inherit; font-size:15px; cursor:pointer; }
  button:active { background:#2069b8; }
  button:disabled { background:#3a3a3a; border-color:#4a4a4c; color:#999; cursor:not-allowed; }
  .err { color:#f14c4c; font-size:13px; margin:10px 0 0; line-height:1.5; }
  .hint { color:#8a8f98; font-size:11.5px; margin:10px 0 0; line-height:1.5; }
</style></head>
<body><div class="wrap">
  <form id="f" method="post" action="/auth/login">
    <h1>Web Terminal</h1>
    <!-- A fixed user name, so the browser's password manager offers to save the
         token and fills it in next time; the field itself stays out of sight. -->
    <input class="user" type="text" name="username" value="webterminal" autocomplete="username"
      tabindex="-1" aria-hidden="true" readonly />
    <input id="t" type="password" name="token" placeholder="请输入访问 Token" autofocus required
      autocapitalize="off" autocomplete="current-password" spellcheck="false" ${locked ? "disabled" : ""} />
    <input type="hidden" name="next" value="${escapeAttr(next)}" />
    <button type="submit" ${locked ? "disabled" : ""}>登录</button>
    ${err}
    <p class="hint">登录后浏览器会提示保存 Token，下次自动填充。连续输错 ${MAX_FAILURES} 次将暂时锁定。</p>
  </form>
</div>

</body></html>`;
}

/**
 * Gate an HTTP request. Returns true when it fully handled the response (the
 * login page, or the redirect after signing in) and the caller should stop;
 * false when the request is signed in and should proceed normally.
 *
 * The token is accepted only in the body of POST /auth/login. A ?token= in the
 * address is never honoured — an address ends up in history, synced history,
 * proxy and router logs — and is taken out of the address before anything else.
 */
export async function gateHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  token: string,
): Promise<boolean> {
  res.setHeader("Cache-Control", "no-store");
  // no-referrer makes browser form POSTs send Origin: null. Keep same-origin
  // forms verifiable while withholding referrers from other sites.
  res.setHeader("Referrer-Policy", "same-origin");
  // An old-style link: drop the token from the address (so it is not kept in
  // history as the current page) and go on as if it was never there.
  if (req.method === "GET" && url.searchParams.has("token")) {
    url.searchParams.delete("token");
    const qs = url.searchParams.toString();
    res.writeHead(302, { "Referrer-Policy": "no-referrer", Location: safeNext(url.pathname + (qs ? `?${qs}` : "")) });
    res.end();
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/login") {
    const now = Date.now();
    const a = attemptsFor(clientKey(req), now);
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 4096) {
        res.writeHead(413).end();
        return true;
      }
    }
    const form = new URLSearchParams(body);
    const supplied = form.get("token") ?? "";
    const next = safeNext(form.get("next"));
    if (a.lockedUntil > now) {
      res.writeHead(429, { "Content-Type": "text/html; charset=utf-8", "Retry-After": String(Math.ceil((a.lockedUntil - now) / 1000)) });
      res.end(loginPage(`尝试次数过多，已锁定，请 ${waitText(a.lockedUntil - now)}后再试。`, next, true));
      return true;
    }
    if (token && safeEqual(supplied.trim(), token)) {
      attempts.delete(clientKey(req));
      res.setHeader("Referrer-Policy", "no-referrer");
      res.writeHead(302, {
        "Set-Cookie": [authCookie(token, reqIsHttps(req)),
          `tw_browser=${browserId(req) || randomBytes(16).toString("hex")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000${reqIsHttps(req) ? "; Secure" : ""}`],
        Location: next,
      });
      res.end();
      return true;
    }
    a.failures += 1;
    if (a.failures >= MAX_FAILURES) {
      const lock = Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** a.lockouts);
      a.lockouts += 1;
      a.failures = 0;
      a.lockedUntil = now + lock;
      console.warn(`[auth] ${clientKey(req)} locked out for ${Math.round(lock / 1000)}s after ${MAX_FAILURES} wrong tokens`);
      res.writeHead(429, { "Content-Type": "text/html; charset=utf-8", "Retry-After": String(Math.ceil(lock / 1000)) });
      res.end(loginPage(`Token 不正确，已连续错误 ${MAX_FAILURES} 次，锁定 ${waitText(lock)}。`, next, true));
      return true;
    }
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginPage(`Token 不正确（第 ${a.failures} 次），还可尝试 ${MAX_FAILURES - a.failures} 次。`, next));
    return true;
  }

  if (hasValidCookie(req, token)) return false; // already signed in

  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
  // Remember the requested page (e.g. a /site/ HTML link) so signing in returns there.
  const a = attempts.get(clientKey(req));
  const locked = !!a && a.lockedUntil > Date.now();
  res.end(loginPage(locked ? `尝试次数过多，已锁定，请 ${waitText(a!.lockedUntil - Date.now())}后再试。` : "",
    req.method === "GET" ? safeNext(url.pathname + url.search) : "/", locked));
  return true;
}

/** Clear this browser only; the shared secret and other devices remain valid. */
export function logout(req: http.IncomingMessage, res: http.ServerResponse): void {
  const secure = reqIsHttps(req) ? "; Secure" : "";
  res.writeHead(204, { "Cache-Control": "no-store", "Set-Cookie":
    ["tw_auth", "tw_browser"].map(name => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`) });
  res.end();
}

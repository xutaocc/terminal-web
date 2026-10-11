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

function loginPage(error: string): string {
  const err = error
    ? `<p class="err">${error.replace(/[<>&]/g, "")}</p>`
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
  input { width:100%; box-sizing:border-box; background:#1e1e1e; color:#d4d4d4;
    border:1px solid #3a3a3a; border-radius:8px; padding:12px; font:inherit; font-size:15px; }
  button { width:100%; margin-top:12px; padding:12px; background:#2472c8; color:#fff;
    border:1px solid #3b8eea; border-radius:8px; font:inherit; font-size:15px; cursor:pointer; }
  button:active { background:#2069b8; }
  .err { color:#f14c4c; font-size:13px; margin:10px 0 0; }
</style></head>
<body><div class="wrap">
  <form id="f" method="post" action="/auth/login" autocomplete="off">
    <h1>Web Terminal</h1>
    <input id="t" type="password" name="token" placeholder="请输入访问 Token" autofocus
      autocapitalize="off" autocomplete="current-password" spellcheck="false" />
    <button type="submit">登录</button>
    ${err}
  </form>
</div>

</body></html>`;
}

/**
 * Gate an HTTP request when auth is enabled. Returns true when it fully handled
 * the response (redirect after login, or served the login page) and the caller
 * should stop; false when the request is authed and should proceed normally.
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
  let supplied = req.method === "GET" ? url.searchParams.get("token") : null;
  if (req.method === "POST" && url.pathname === "/auth/login") {
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 4096) {
        res.writeHead(413).end();
        return true;
      }
    }
    supplied = new URLSearchParams(body).get("token") ?? "";
  }
  if (supplied !== null) {
    if (token && safeEqual(supplied, token)) {
      // Never forward a token-bearing URL as a referrer after login.
      res.setHeader("Referrer-Policy", "no-referrer");
      url.searchParams.delete("token");
      const qs = url.searchParams.toString();
      res.writeHead(302, {
        "Set-Cookie": [authCookie(token, reqIsHttps(req)),
          `tw_browser=${browserId(req) || randomBytes(16).toString("hex")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000${reqIsHttps(req) ? "; Secure" : ""}`],
        Location: (url.pathname === "/auth/login" || url.pathname.startsWith("//")) ? "/" : url.pathname + (qs ? `?${qs}` : ""),
      });
      res.end();
      return true;
    }
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginPage("Token 不正确。"));
    return true;
  }

  if (hasValidCookie(req, token)) return false; // already signed in

  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
  res.end(loginPage(""));
  return true;
}

/** Clear this browser only; the shared secret and other devices remain valid. */
export function logout(req: http.IncomingMessage, res: http.ServerResponse): void {
  const secure = reqIsHttps(req) ? "; Secure" : "";
  res.writeHead(204, { "Cache-Control": "no-store", "Set-Cookie":
    ["tw_auth", "tw_browser"].map(name => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`) });
  res.end();
}

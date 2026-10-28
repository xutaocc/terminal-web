import { TerminalControl, type ControlClient, type ControlAction } from './terminal-control.js';
import http from "node:http";
import https from "node:https";
import { AgentViewerHub } from './agent-viewer.js';
import { AgentApi } from "./agent-api.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { URL } from "node:url";

import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";

import { loadConfig } from "./config.js";
import { terminalEnvironment, configureColorPolicy, getTerminalColors, setTerminalColors } from './terminal-env.js';
import { hasWheelInput, isKeyboardInput, HistoryInputCheck } from './history-input.js';
import {
  TMUX,
  psmuxEnv,
  IS_PSMUX,
  sanitizeSession,
  tmuxArgs,
  ensureTmuxAvailable,
  tagWebSession,
  setWebTabLabel,
  listWebTabs,
  listSessionCwds,
  listTmuxSessions,
  mateStartDir,
  findClientTty,
  refreshClient,
  getSessionNote,
  setSessionNote,
} from "./tmux.js";
import type { ServerMessage } from "./types.js";
import { isClientMessage } from "./types.js";
import { gateHttp, isAuthed, validOrigin, browserId, logout } from "./auth.js";

import { handleFileApi, handleSite } from "./file-api.js";
import { QuickCommandStore, validQuickCommands } from './quick-commands.js';
import { FolderStore, validFolderName, validSession } from './projects.js';
import { AgentStatusMonitor, isAgentStatusMode } from './agent-status.js';
import { RemoteMonitor, RemoteStatusHub, RemoteStore, cleanColor, cleanLabel, cleanNote, proxyHttp, proxyUpgrade, remoteRoute, sameLabel } from './remotes.js';

import { ShareService, type ShareScope } from './shares.js';
import { ShareStore } from './share-store.js';
import { ShareInputGuard } from './share-input.js';
import { SessionStore } from './session-store.js';

import { ViewerStateStore } from './viewer-state.js';
const config = loadConfig();
const viewerState = new ViewerStateStore(process.env.VIEWER_STATE_FILE || path.join(os.homedir(), '.terminal-web', 'viewer-state.json'));
const adminViewer = 'admin:' + crypto.createHash('sha256').update(config.authToken).digest('hex');
const sessionStore = new SessionStore(process.env.SESSIONS_FILE ||
  path.join(os.homedir(), '.terminal-web', 'sessions.json'));
const quickCommands = new QuickCommandStore(process.env.QUICK_COMMANDS_FILE ||
  path.join(os.homedir(), '.terminal-web', 'quick-commands.json'));
const agentStatus = new AgentStatusMonitor(process.env.AGENT_STATUS_FILE ||
  path.join(os.homedir(), '.terminal-web', 'agent-status.json'));
void agentStatus.start();
// The file keeps its old name: the first read turns the path-based projects
// it used to hold into folders (see migrate in projects.ts).
// Only tabs go in folders, never the hidden second half of a split.
const folders = new FolderStore(process.env.PROJECTS_FILE ||
  path.join(os.homedir(), '.terminal-web', 'projects.json'), async () => {
  const cwds = await listSessionCwds();
  const combined = new Map(sessionStore.list().filter(tab => tab.cwd).map(tab => [tab.name, tab.cwd!]));
  for (const [name, cwd] of cwds ?? []) if (!name.endsWith('__b')) combined.set(name, cwd);
  return combined;
});

// Tab names and directories live on disk independently of tmux. This set just
// tracks sessions with a live WebSocket right now, so a freshly-connected tab
// shows up in /api/sessions immediately, before its tag write has landed.
const liveSessions = new Set<string>();

// Every pty currently alive (one per attached WebSocket). Its size is capped at
// config.maxPtys before we ever spawn another tmux client, so a runaway or
// rapidly-reconnecting client can't exhaust the host's small system-wide pty
// table (macOS kern.tty.ptmx_max is only ~511) and lock everything — including
// new SSH logins — out of allocating a terminal.
const livePtys = new Set<pty.IPty>();

// node-pty 1.1.0 leaked ~3 fds per spawn on macOS (an untracked "twin" /dev/ptmx
// master, the slave /dev/ttysN, and a kqueue) — destroy() closed only the
// tracked master, so reconnect churn once crept toward macOS's ~511 pty cap and
// locked SSH out (the 2026-06-13 incident). We used to reap the twin ourselves
// at spawn. node-pty 1.2.0-beta.14 closes all of them on teardown (verified: a
// spawn→kill→destroy loop leaks ~0.03 fds vs 1.1.0's ~3), so the reaper is gone
// and plain pty.spawn() is used below. The pty-fd watchdog still backstops any
// future regression.

// Every WebSocket currently attached to each session name. Used to tell the
// *other* devices on a session that it was closed, so they drop the tab instead
// of auto-reconnecting (which would resurrect the just-killed tmux session).
const sessionClients = new Map<string, Set<WebSocket>>();

function addSessionClient(name: string, ws: WebSocket): void {
  let set = sessionClients.get(name);
  if (!set) {
    set = new Set();
    sessionClients.set(name, set);
  }
  set.add(ws);
}

function removeSessionClient(name: string, ws: WebSocket): void {
  const set = sessionClients.get(name);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) sessionClients.delete(name);
}

/**
 * Tell every client of `name` that the session was closed, so its tab goes away
 * on every device instead of being recreated by a reconnect. `except` skips the
 * socket that asked, where there is one — closing over HTTP has none.
 */
function broadcastClosed(name: string, except?: WebSocket): void {
  const set = sessionClients.get(name);
  if (!set) return;
  for (const peer of set) {
    if (peer !== except) sendJson(peer, { type: "closed" });
  }
}

// The suffix that makes a session the second half of a split (see web/
// terminal.ts, where the pairing is explained). Reserved: a session named this
// way belongs to the tab it is named after and is not one of its own.
const MATE_SUFFIX = "__b";

/** The second session of the pair, for killing both halves together. */
function mateNameOf(name: string): string {
  return name + MATE_SUFFIX;
}

// ---------------------------------------------------------------------------
// Closed tabs. Telling the clients attached to a session that it was closed
// (broadcastClosed) only reaches the ones connected at that moment. A page on a
// device that was asleep — an iPad in a drawer, a phone in a pocket — still has
// the tab, and when it wakes it reconnects every socket it had open. Attaching
// is `new-session -A`, so each of those reconnects quietly created the session
// again, empty, and tagged it as a tab on every device: close a tab here, and
// an hour later it is back.
//
// So the server remembers what was closed, and a connect to one of those names
// that does not say it means to create the session is answered with "closed"
// instead — the same message a connected client gets, so the stale page drops
// the tab the same way. Kept on disk, because a deploy restarts this server and
// a device can sleep for days.
// ---------------------------------------------------------------------------

const CLOSED_FILE = process.env.CLOSED_SESSIONS_FILE || path.join(os.homedir(), ".terminal-web", "closed.json");
/** How long a closed name is refused to a stale page. */
const CLOSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** name -> when it was closed (epoch ms). */
let closedTabs: Map<string, number> = loadClosedTabs();
let closedWrite: Promise<void> = Promise.resolve();

function loadClosedTabs(): Map<string, number> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CLOSED_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const now = Date.now();
      return new Map(
        Object.entries(parsed as Record<string, unknown>).filter(
          (e): e is [string, number] => typeof e[1] === "number" && now - e[1] < CLOSED_TTL_MS
        )
      );
    }
  } catch {
    /* missing or unreadable: nothing remembered */
  }
  return new Map();
}

function saveClosedTabs(): void {
  const data = JSON.stringify(Object.fromEntries(closedTabs), null, 2);
  // Chained, so two quick closes cannot land out of order.
  closedWrite = closedWrite
    .then(async () => {
      await fsp.mkdir(path.dirname(CLOSED_FILE), { recursive: true });
      const tmp = `${CLOSED_FILE}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, data, "utf8");
      await fsp.rename(tmp, CLOSED_FILE);
    })
    .catch((err: Error) => {
      console.error("[closed] write failed:", err.message);
    });
}

function markClosed(names: string[]): void {
  const now = Date.now();
  for (const n of names) {
    closedTabs.set(n, now);
    sessionStore.remove(n);
  }
  saveClosedTabs();
}

/** A tab made on purpose under a closed name: it, and its second half, are open again. */
function clearClosed(name: string): void {
  const base = name.endsWith(MATE_SUFFIX) ? name.slice(0, -MATE_SUFFIX.length) : name;
  let changed = false;
  for (const n of [base, mateNameOf(base)]) changed = closedTabs.delete(n) || changed;
  if (changed) saveClosedTabs();
}

function isClosed(name: string): boolean {
  const at = closedTabs.get(name);
  if (at === undefined) return false;
  if (Date.now() - at < CLOSED_TTL_MS) return true;
  closedTabs.delete(name);
  return false;
}

// Short hostname of the machine running this server, used to label the page
// title so several hosts open in different tabs are easy to tell apart. Strip
// any DNS domain suffix (e.g. "nuc.local" -> "nuc").
const HOST_LABEL = os.hostname().replace(/\..*$/, "") || os.hostname();

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Map a request URL pathname to an absolute file path under publicDir.
 * Returns null for unknown routes. Guards against path traversal by resolving
 * and confirming the result stays within publicDir.
 */
const PWA_ASSETS = new Set([
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
]);

function resolveStaticPath(pathname: string): string | null {
  let rel: string | null = null;

  if (pathname === "/" || pathname === "/index.html") {
    rel = "index.html";
  } else if (pathname === "/file-browser.html") {
    rel = "file-browser.html";
  } else if (pathname === "/styles.css") {
    rel = "styles.css";
  } else if (PWA_ASSETS.has(pathname)) {
    // PWA manifest + icons live at the web root.
    rel = pathname.slice(1);
  } else if (pathname.startsWith("/dist/")) {
    // Anything emitted by esbuild: terminal.js, terminal.css, *.map, etc.
    rel = "dist/" + pathname.slice("/dist/".length);
  } else {
    return null;
  }

  // Normalize and ensure the resolved path is inside publicDir.
  const target = path.resolve(config.publicDir, rel);
  const root = path.resolve(config.publicDir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null; // traversal attempt
  }
  return target;
}

/**
 * Every asset index.html links to, relative to publicDir — the files whose URLs
 * carry the build stamp. That has to be all of them and not just the bundle:
 * one unstamped file is enough to pair a new client with an old copy of itself,
 * and nothing about the result says so.
 *
 * styles.css was the one left out. It holds the touch-selection handles and the
 * selection action bar, so an iPad partway through a Browser Cache TTL ran the
 * new terminal.js against a stylesheet that had never heard of either: the bar
 * was created and unhidden, then laid out as an unstyled block at the top of
 * the document, behind the fixed terminal. ?debug=sel measured it at 0,0
 * 1210x22 where the rules would have put a small box above the key bar.
 */
const STAMPED_ASSETS = ["dist/terminal.js", "dist/terminal.css", "styles.css", "dist/file-browser.js", "dist/file-browser.css"];

/**
 * A short token identifying the currently built client, from the size + mtime
 * of the assets above. Stamped onto their URLs in index.html so a rebuild
 * produces URLs nothing can have cached.
 *
 * We send Cache-Control: no-cache on every static response, but Cloudflare
 * rewrites that to its Browser Cache TTL — measured at max-age=14400 — for
 * requests through the public hostname. A browser that has terminal.js pinned
 * for four hours then keeps running the old client across deploys, silently:
 * a plain reload never asks the server, the WebSocket reconnects fine, and only
 * a hard refresh escapes. Direct tailnet access is unaffected, which is exactly
 * what makes it easy to miss. The URL changing on each build sidesteps all of
 * it — for the edge cache and the browser cache alike — without depending on
 * any Cloudflare setting. index.html itself is served no-cache and comes back
 * DYNAMIC (uncached) through Cloudflare, so the fresh stamp always arrives.
 */
async function assetVersion(): Promise<string> {
  try {
    const parts = await Promise.all(
      STAMPED_ASSETS.map(async (rel) => {
        const st = await fsp.stat(path.join(config.publicDir, rel));
        return `${st.size}-${Math.round(st.mtimeMs)}`;
      })
    );
    return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
  } catch {
    return ""; // not built yet — leave the URLs untouched
  }
}

/**
 * Serve index.html with the machine's hostname injected into <title>, so each
 * host shows up as a distinct browser tab, and the asset URLs stamped with the
 * current build. The file is tiny, so reading it per request is fine
 * (responses are no-cache anyway).
 */
async function serveIndexHtml(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string
): Promise<void> {
  let html: string;
  try {
    html = await fsp.readFile(filePath, "utf8");
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  const title = path.basename(filePath) === "file-browser.html" ? "文件管理 · Web 终端" : `${escapeHtml(HOST_LABEL)} · WebTerminal xutaocc`;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);

  const version = await assetVersion();
  if (version) {
    // Driven off the same list the stamp is computed from, so an asset added to
    // one can't be missed by the other.
    for (const rel of STAMPED_ASSETS) {
      const href = new RegExp(`(["'])(/${rel.replace(/\./g, "\\.")})(?:\\?[^"']*)?\\1`, "g");
      html = html.replace(href, `$1$2?v=${version}$1`);
    }
  }

  const body = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): Promise<void> {
  if (pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  if (pathname === "/" || pathname === "/index.html" || pathname === "/file-browser.html") {
    await serveIndexHtml(req, res, filePath);
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => {
    console.error(`[static] read error for ${filePath}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end();
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// File upload (POST /upload): save a pasted/dropped/attached file to disk so
// the program in the terminal (e.g. Claude Code) can read it by path. The
// client sends the raw bytes as the body, the file's Content-Type as a header,
// and the original filename as ?name= so we can preserve its extension/name.
// Any file type is accepted — not just images.
// ---------------------------------------------------------------------------

// Fallback extensions for common image types, used only when the client sends
// no usable filename (e.g. a clipboard image paste has no name).
const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/tiff": ".tiff",
};

/**
 * Reduce a client-supplied filename to a safe basename for our upload dir:
 * strip any directory components, collapse anything outside [A-Za-z0-9._-] to
 * "_", drop leading dots (no hidden/".." names), and bound the length while
 * keeping the extension. Returns null if nothing usable remains.
 */
function safeUploadBaseName(raw: string | null): string | null {
  if (!raw) return null;
  let base = raw.replace(/\\/g, "/");
  base = base.slice(base.lastIndexOf("/") + 1); // basename only
  base = base.replace(/[^A-Za-z0-9._-]+/g, "_"); // collapse unsafe chars (incl. spaces)
  base = base.replace(/^[.]+/, ""); // never start with a dot
  if (base.length > 96) {
    const ext = path.extname(base).slice(0, 16);
    base = base.slice(0, 96 - ext.length) + ext;
  }
  return base.length ? base : null;
}

function sendJsonHttp(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read a small request body fully, rejecting anything over `maxBytes`. */
async function readBody(
  req: http.IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Cross-device tab sync (GET/POST /api/sessions...). The tab list lives on the
// server so any browser sees the same sessions; display names persist here too.
// ---------------------------------------------------------------------------

async function handleSessionNote(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  let body: { name?: unknown; text?: unknown; tags?: unknown; displayName?: unknown } = {};
  if (req.method === 'POST') {
    try { body = JSON.parse((await readBody(req, 32768)).toString('utf8')); }
    catch { sendJsonHttp(res, 400, { error: 'Invalid note' }); return; }
  }
  const name = req.method === 'GET' ? url.searchParams.get('session') : body?.name;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    sendJsonHttp(res, 400, { error: 'Invalid session' }); return;
  }
  if (req.method === 'POST' && (typeof body.text !== 'string' || body.text.length > 4000)) {
    sendJsonHttp(res, 400, { error: 'Note must contain at most 4000 characters' }); return;
  }
  if (req.method === 'POST' && body.tags !== undefined &&
      (!Array.isArray(body.tags) || body.tags.length > 20 ||
       body.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 64 || /[\x00-\x1f\x7f]/.test(tag)))) {
    sendJsonHttp(res, 400, { error: 'Use at most 20 tags, each up to 64 characters' }); return;
  }
  if (req.method === 'POST' && body.displayName !== undefined &&
      (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 64 || /[\x00-\x1f\x7f]/.test(body.displayName))) {
    sendJsonHttp(res, 400, { error: 'Invalid display name' }); return;
  }
  const current = await getSessionNote(name);
  if (!current) { sendJsonHttp(res, 404, { error: 'Session not found' }); return; }
  if (req.method === 'GET') { sendJsonHttp(res, 200, current); return; }
  const note = { text: body.text as string, tags: body.tags === undefined ? current.tags ?? [] : [...new Set((body.tags as string[]).map(tag => tag.trim()))], updatedAt: new Date().toISOString() };
  if (!await setSessionNote(name, note)) {
    sendJsonHttp(res, 409, { error: 'Could not save session note' }); return;
  }
  if (typeof body.displayName === 'string') {
    sessionStore.update({ name, displayName: body.displayName.trim() });
    setWebTabLabel(name, body.displayName.trim());
  }
  sendJsonHttp(res, 200, { ...note, displayName: body.displayName });
}

async function handleQuickCommands(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') { sendJsonHttp(res, 200, await quickCommands.get()); return; }
  let body: { revision?: unknown; commands?: unknown };
  try { body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')); }
  catch { sendJsonHttp(res, 400, { error: 'Invalid commands' }); return; }
  if (typeof body?.revision !== 'string' || !validQuickCommands(body.commands)) {
    sendJsonHttp(res, 400, { error: 'Invalid commands' }); return;
  }
  const saved = await quickCommands.save(body.revision, body.commands);
  if (!saved) { sendJsonHttp(res, 409, { error: 'Commands changed on another device' }); return; }
  sendJsonHttp(res, 200, saved);
}

async function handleListSessions(res: http.ServerResponse): Promise<void> {
  const tabs = await collectSavedSessions();
  await folders.prune(new Set(tabs.map(tab => tab.name))).catch(() => {});
  sendJsonHttp(res, 200, { tabs });
}

/** Querying tmux enriches the registry; an empty/dead server never deletes tabs. */
async function collectSavedSessions() {
  const [tagged, cwds] = await Promise.all([listWebTabs(), listSessionCwds()]);
  const current = new Map((tagged ?? []).map(tab => [tab.name, tab]));
  for (const name of liveSessions) {
    if (!current.has(name)) current.set(name, { name, displayName: name });
  }
  for (const tab of current.values()) {
    if (isClosed(tab.name) || tab.name.endsWith(MATE_SUFFIX)) continue;
    const saved = sessionStore.get(tab.name);
    sessionStore.update({ ...tab, displayName: saved?.displayName ?? tab.displayName,
      cwd: cwds?.get(tab.name) });
  }
  // Include saved tabs whose tmux tag is still being applied, too.
  for (const tab of sessionStore.list()) {
    const cwd = cwds?.get(tab.name);
    if (cwd && !isClosed(tab.name)) sessionStore.update({ ...tab, cwd });
  }
  return sessionStore.list().filter(tab => !isClosed(tab.name));
}

void collectSavedSessions().catch(error => console.error('[sessions] initial save failed:', error));
const sessionDirectoryTimer = setInterval(() => {
  void collectSavedSessions().catch(error => console.error('[sessions] save failed:', error));
}, 5000);
sessionDirectoryTimer.unref();

// ---------------------------------------------------------------------------
// Agent status (see agent-status.ts). Hooks report in from inside tmux panes;
// browsers read a live snapshot over server-sent events and say what they saw.
// ---------------------------------------------------------------------------
async function handleAgentHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: { pane?: unknown; session?: unknown; event?: unknown; tool?: unknown; kind?: unknown };
  try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); }
  catch { sendJsonHttp(res, 400, { error: 'invalid body' }); return; }
  const word = (v: unknown): string => typeof v === 'string' && /^[A-Za-z0-9_]{0,64}$/.test(v) ? v : '';
  const pane = typeof body?.pane === 'string' && /^%\d{1,6}$/.test(body.pane) ? body.pane : '';
  const session = typeof body?.session === 'string' && validSession(body.session) ? body.session : undefined;
  if (!pane || !word(body.event)) { sendJsonHttp(res, 400, { error: 'invalid hook' }); return; }
  const used = await agentStatus.hook(pane, word(body.event), word(body.tool), word(body.kind), session);
  sendJsonHttp(res, 200, { ok: true, used });
}

function handleAgentStatusEvents(req: http.IncomingMessage, res: http.ServerResponse, withHealth = false): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const send = (snapshot: unknown): void => { res.write(`data: ${JSON.stringify(snapshot)}\n\n`); };
  const viewerChanged = (scope: string) => { if (scope === adminViewer && !res.destroyed) res.write('event: viewer-state\ndata: {}\n\n'); };
  const unsubscribeViewer = viewerState.subscribe(viewerChanged);
  send(agentStatus.snapshot());
  const unsubscribe = agentStatus.subscribe(send);
  // A page asks for remote health on its own server's status stream (?health=1)
  // rather than opening /api/remotes/events beside it: every open page holds its
  // streams for good, and a browser allows only six connections per host, so two
  // each left a third tab on the same address waiting for ever on an empty page.
  const sendHealth = (health: unknown): void => { res.write(`event: health\ndata: ${JSON.stringify(health)}\n\n`); };
  if (withHealth) sendHealth(remoteMonitor.snapshot());
  const unsubscribeHealth = withHealth ? remoteMonitor.subscribe(sendHealth) : () => {};
  // Every remote's status too (see RemoteStatusHub), as `remote` events: the
  // page needs no stream of its own per remote.
  const sendRemote = (update: unknown): void => { res.write(`event: remote\ndata: ${JSON.stringify(update)}\n\n`); };
  if (withHealth) for (const update of remoteStatus.snapshot()) sendRemote(update);
  const unsubscribeRemote = withHealth ? remoteStatus.subscribe(sendRemote) : () => {};
  // Frequent enough that a page notices a dead link to this server quickly. A
  // named event, not an SSE comment: comments never reach the page's code, and
  // the page decides the link is dead by what it has heard.
  const keepAlive = setInterval(() => res.write(withHealth ? 'event: ping\ndata: \n\n' : ': ping\n\n'), withHealth ? 15_000 : 25_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
    unsubscribeViewer();
    unsubscribeHealth();
    unsubscribeRemote();
  });
}

async function handleAgentStatusRead(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: { sessions?: unknown; output?: unknown };
  try { body = JSON.parse((await readBody(req, 8192)).toString('utf8')); }
  catch { sendJsonHttp(res, 400, { error: 'invalid body' }); return; }
  const names = Array.isArray(body?.sessions) ? body.sessions.filter((n): n is string =>
    typeof n === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(n)) : [];
  // Kept for older clients. Read cursors are now private to each visitor;
  // execution activity is reported by the owning terminal connection only.
  void names;
  sendJsonHttp(res, 200, { ok: true });
}

/**
 * Sidebar folders. GET answers { folders, members, emptied: [] }; POST takes
 * one edit and answers the same, with the folders that edit left empty (and so
 * removed) in `emptied`:
 *   { action: "create", name, session }   new folder holding its first session
 *   { action: "rename", id, name }
 *   { action: "move", sessions: [...], folder, card? }   folder "" takes them out;
 *       card { cwd, name } carries a dragged card's name unless the target has its own
 *   { action: "renameDir", folder, cwd, name }   name "" restores the directory's own
 *   { action: "orderCards", folder, cwds: [...] }   the folder's cards, first to last
 * There is deliberately no "delete": a folder goes when its last session does.
 */
async function handleFolders(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') { sendJsonHttp(res, 200, { ...(await folders.get()), emptied: [], home: os.homedir() }); return; }
  let body: {
    action?: unknown; name?: unknown; session?: unknown; id?: unknown;
    sessions?: unknown; folder?: unknown; cwd?: unknown; card?: unknown; cwds?: unknown; pinned?: unknown;
  };
  try { body = JSON.parse((await readBody(req, 16384)).toString('utf8')); }
  catch { sendJsonHttp(res, 400, { error: 'invalid body' }); return; }
  try {
    if (body.action === 'create' && validFolderName(body.name) && validSession(body.session)) {
      const { data, emptied, folder } = await folders.create(body.name, body.session);
      sendJsonHttp(res, 200, { ...data, emptied, created: folder });
    } else if (body.action === 'rename' && typeof body.id === 'string' && validFolderName(body.name)) {
      sendJsonHttp(res, 200, await folders.rename(body.id, body.name).then(r => ({ ...r.data, emptied: r.emptied })));
    } else if (body.action === 'move' && Array.isArray(body.sessions) && body.sessions.length <= 100 &&
               body.sessions.every(validSession) && typeof body.folder === 'string') {
      const card = body.card as { cwd?: unknown; name?: unknown } | undefined;
      const carry = card && typeof card.cwd === 'string' && path.isAbsolute(card.cwd) && validFolderName(card.name)
        ? { cwd: card.cwd, name: card.name } : undefined;
      const r = await folders.move(body.sessions as string[], body.folder, carry);
      sendJsonHttp(res, 200, { ...r.data, emptied: r.emptied });
    } else if (body.action === 'pin' && Array.isArray(body.sessions) && body.sessions.length <= 100 &&
               body.sessions.every(validSession) && typeof body.pinned === 'boolean') {
      const r = await folders.pin(body.sessions as string[], body.pinned);
      sendJsonHttp(res, 200, { ...r.data, emptied: r.emptied });
    } else if (body.action === 'renameDir' && typeof body.folder === 'string' && typeof body.cwd === 'string' &&
               path.isAbsolute(body.cwd) && body.cwd.length <= 4096 &&
               (body.name === '' || validFolderName(body.name))) {
      const r = await folders.renameDir(body.folder, body.cwd, body.name as string);
      sendJsonHttp(res, 200, { ...r.data, emptied: r.emptied });
    } else if (body.action === 'orderCards' && typeof body.folder === 'string' && Array.isArray(body.cwds) &&
               body.cwds.length <= 500 &&
               body.cwds.every(c => typeof c === 'string' && path.isAbsolute(c) && c.length <= 4096)) {
      const r = await folders.orderCards(body.folder, body.cwds as string[]);
      sendJsonHttp(res, 200, { ...r.data, emptied: r.emptied });
    } else {
      sendJsonHttp(res, 400, { error: 'invalid folder edit' });
    }
  } catch (error) {
    sendJsonHttp(res, 400, { error: (error as Error).message });
  }
}

/** Page tmux history, or forward paging keys to a mouse-aware application. */
async function handleScrollSession(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
  } catch {
    sendJsonHttp(res, 400, { error: 'invalid body' });
    return;
  }
  const obj = body as { name?: unknown; action?: unknown } | null;
  if (typeof obj?.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(obj.name) ||
      !['up', 'down', 'top', 'bottom'].includes(String(obj.action))) {
    sendJsonHttp(res, 400, { error: 'invalid scroll action' });
    return;
  }
  sendJsonHttp(res, 403, { error: '请通过当前拥有操作权的终端连接翻页' });
}
// Shared invalidation also covers scrolling from another attached browser.
let historyInputRevision = 0;
async function scrollControlledSession(obj: {name: string; action: string}, authorized: () => boolean): Promise<void> {
  historyInputRevision++;
  const target = `=${obj.name}:`;
  const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    if (!authorized()) { reject(new Error('operation right changed')); return; }
    execFile(TMUX, args, { timeout: 3000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
  try {
    const state = await run(['display-message', '-p', '-t', target,
      '#{pane_mode}|#{mouse_any_flag}|#{history_size}']);
    const [mode, appMouse, history] = state.split('|');
    const inMode = mode === 'copy-mode';
    if (inMode || appMouse !== '1') {
      if (obj.action === 'bottom') {
        if (inMode) await run(['send-keys', '-t', target, '-X', 'cancel']);
      } else if (obj.action === 'top') {
        // The oldest line of the history, staying in copy-mode to read on from there.
        if (inMode || Number(history) > 0) {
          await run([...(inMode ? [] : ['copy-mode', '-t', target, ';']), 'send-keys', '-t', target, '-X', 'history-top']);
        }
      } else if (inMode || (obj.action === 'up' && Number(history) > 0)) {
        const args = inMode ? [] : ['copy-mode', '-t', target, ';'];
        await run([...args, 'send-keys', '-t', target, '-X',
          obj.action === 'up' ? 'page-up' : 'page-down', ';',
          'if-shell', '-F', '-t', target,
          '#{&&:#{==:#{pane_mode},copy-mode},#{==:#{scroll_position},0}}',
          `send-keys -t ${target} -X cancel`]);
      }
    } else {
      // A mouse-aware TUI owns its scrollback; let it interpret paging keys.
      await run(['send-keys', '-t', target,
        obj.action === 'up' ? 'PPage' : obj.action === 'down' ? 'NPage' : obj.action === 'top' ? 'C-Home' : 'C-End']);
    }

  } catch {
    throw new Error('session unavailable or operation right changed');
  } finally {
    historyInputRevision++;
  }
}

/** Persist a tab's display-name change ({ name, displayName }). */
async function handleRenameSession(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 4096)).toString("utf8"));
  } catch {
    sendJsonHttp(res, 400, { error: "invalid body" });
    return;
  }
  const obj = body as { name?: unknown; displayName?: unknown };
  if (typeof obj?.name !== "string") {
    sendJsonHttp(res, 400, { error: "missing name" });
    return;
  }
  const name = sanitizeSession(obj.name);
  const displayName =
    typeof obj.displayName === "string" ? obj.displayName : name;
  if (!isClosed(name)) sessionStore.update({ name,
    displayName: displayName.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 64) || name });
  setWebTabLabel(name, displayName);
  sendJsonHttp(res, 200, { ok: true });
}

/**
 * Re-adopt as web tabs the sessions a device remembers having.
 *
 * The tab list lives on the tmux sessions themselves (@twtab), and that tag is
 * written when a tab attaches. tmux-resurrect brings sessions back after a
 * reboot WITHOUT it, and a tab only attaches when you open it now — so nothing
 * would re-tag the restored ones and the whole list would disappear on the next
 * sync. A device that still remembers them says so here instead.
 *
 * Only sessions that really exist in tmux are tagged, so a tab closed on
 * another device stays closed rather than being resurrected by a stale cache.
 */
async function handleAdoptSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 327680)).toString("utf8"));
  } catch {
    sendJsonHttp(res, 400, { error: "invalid body" });
    return;
  }
  const names = (body as { names?: unknown })?.names;
  if (!Array.isArray(names)) {
    sendJsonHttp(res, 400, { error: "missing names" });
    return;
  }
  // A browser may be the last owner of a legacy tab's directory after reboot.
  // Fill registered tabs only; stale caches must not recreate closed tabs or
  // replace a newer directory already saved by this host.
  const directories = (body as { directories?: unknown }).directories;
  if (Array.isArray(directories)) {
    for (const entry of directories.slice(0, 64)) {
      if (!entry || typeof entry.name !== 'string' || typeof entry.cwd !== 'string' ||
          entry.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(entry.cwd) || !path.isAbsolute(entry.cwd)) continue;
      const saved = sessionStore.get(entry.name);
      if (saved && !saved.cwd && !isClosed(entry.name)) sessionStore.update({ ...saved, cwd: entry.cwd });
    }
  }
  const existing = await listTmuxSessions();
  if (!existing) {
    sendJsonHttp(res, 200, { adopted: [] }); // tmux unreachable — say nothing
    return;
  }
  const alive = new Set(existing);
  const adopted: string[] = [];
  for (const raw of names.slice(0, 64)) {
    if (typeof raw !== "string") continue;
    const name = sanitizeSession(raw);
    // A second half is never adopted as a tab of its own; its tab carries it.
    if (name.endsWith(MATE_SUFFIX)) continue;
    if (!alive.has(name) || adopted.includes(name)) continue;
    tagWebSession(name);
    adopted.push(name);
  }
  if (adopted.length) {
    console.log(`[api] re-adopted as web tabs: ${adopted.join(", ")}`);
  }
  sendJsonHttp(res, 200, { adopted });
}

/**
 * Close a tab for good: kill its tmux session, with everything running in it.
 *
 * Over HTTP rather than the session's own socket, because a tab need not have
 * one — a tab only attaches when you first look at it, so most of them are
 * sitting there unconnected. The clients that DO have one are told first, so
 * they drop the tab rather than reconnecting into a session `new-session -A`
 * would recreate.
 */
async function handleKillSession(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 4096)).toString("utf8"));
  } catch {
    sendJsonHttp(res, 400, { error: "invalid body" });
    return;
  }
  const obj = body as { name?: unknown };
  if (typeof obj?.name !== "string") {
    sendJsonHttp(res, 400, { error: "missing name" });
    return;
  }
  const name = sanitizeSession(obj.name);
  if (agentApi.isAgent(name.replace(/__b$/, ""))) { sendJsonHttp(res, 403, {error: "AGENT_READ_ONLY"}); return; }
  // A tab is up to two sessions — its own and, if it was ever split, the one
  // named after it. Closing the tab closes both; nothing else is touched, and
  // the second name is derived here rather than taken from the request, so a
  // caller cannot name a session of its own to take down with it.
  const names = name.endsWith(MATE_SUFFIX) ? [name] : [name, mateNameOf(name)];
  for (const target of names) {
    // Killing a session is the only irreversible thing this server does, so it
    // says so either way. Logging just the failures left no record of what had
    // been killed, which is not what you want when sessions have gone missing.
    console.log(`[api] kill-session "${target}" requested`);
    broadcastClosed(target);
    liveSessions.delete(target);
  }
  // Before anything that waits: a sleeping page could wake in the meantime.
  markClosed(names);
  // Save first, and wait for it: this command has taken whole tmux servers down
  // with it (see snapshotBeforeKill). The tab is already gone in the browser —
  // it does not wait on this reply — so the second or two costs nothing. One
  // save covers both halves.
  await snapshotBeforeKill(name);
  for (const target of names) {
    execFile(TMUX, ["kill-session", "-t", target], (err) => {
      // A tab that was never split has no second session, and "can't find
      // session" is the expected answer for it rather than a failure.
      if (err) console.error(`[api] kill-session "${target}" failed:`, err.message);
      else console.log(`[api] kill-session "${target}" done`);
    });
  }
  sendJsonHttp(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// UI prefs (GET/POST /api/prefs). The browser used to be the only place these
// lived, and localStorage is not somewhere they survive: in the iOS launcher
// the terminal runs in a cross-origin iframe whose storage goes away with the
// app, so every relaunch came back at the default font, with the key bar reset
// and the first tab showing instead of the one that was open. They live here
// now, next to the tab list, keyed by device class so a phone's font size is
// not imposed on a desktop. The browser still caches them — this is what fills
// the cache back in.
// ---------------------------------------------------------------------------

const PREFS_FILE = process.env.PREFS_FILE || path.join(os.homedir(), ".terminal-web", "prefs.json");
configureColorPolicy(`${PREFS_FILE}.colors.json`);

interface UiPrefs {
  newSessionCommand?: string;
  theme?: "dark" | "light";
  /** Tab (tmux session) this device class last had focused. */
  activeTab?: string;
  /** Terminal font size in px. */
  fontSize?: number;
  /** Font size kept apart for the phone and the PC layout. */
  fontSizeMobile?: number;
  fontSizeDesktop?: number;
  /** Whether the on-screen key bar is shown. */
  keybar?: boolean;
  /** Explicit keyboard activation on touch devices; defaults to false. */
  keyboardLocked?: boolean;
  /** Floating page buttons on touch devices; defaults to on there. */
  pager?: boolean;
  /** ⌘ / Ctrl = − and pinch size the terminal font; defaults to on. */
  zoomKeys?: boolean;
  /** The recently picked sessions on this kind of device, newest first. */
  recentTabs?: string[];
  recentVisits?: string[];
  recentVisitLimit?: number;
  recentVisitLimitVersion?: number;
  /** Shared session order across desktop and touch devices. */
  tabOrder?: string[];
  /** Shared order of the servers' blocks in the sidebar ('' is this server). */
  hostOrder?: string[];
  /** Key bar and keyboard lock, kept apart for the phone and the PC layout. */
  keybarMobile?: boolean;
  keybarDesktop?: boolean;
  keyboardLockedMobile?: boolean;
  keyboardLockedDesktop?: boolean;
}

/** Device class prefs, plus shared fields under "shared". */
type PrefsByScope = Record<string, UiPrefs>;

let prefsCache: PrefsByScope | null = null;
// Writes are chained rather than fired in parallel, so two quick POSTs can't
// race each other into the file with one of them holding stale state.
let prefsWrite: Promise<void> = Promise.resolve();

function prefScope(raw: unknown): string | null {
  return raw === "touch" || raw === "desktop" ? raw : null;
}

async function loadPrefs(): Promise<PrefsByScope> {
  if (prefsCache) return prefsCache;
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(PREFS_FILE, "utf8"));
    prefsCache =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as PrefsByScope)
        : {};
  } catch {
    prefsCache = {}; // missing or unreadable: prefs are a convenience, not state
  }
  return prefsCache;
}

/** Write via a temp file + rename, so a crash can never truncate the real one. */
async function writePrefs(data: PrefsByScope): Promise<void> {
  await fsp.mkdir(path.dirname(PREFS_FILE), { recursive: true });
  const tmp = `${PREFS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, PREFS_FILE);
}

async function handleGetPrefs(
  res: http.ServerResponse,
  scopeRaw: string | null
): Promise<void> {
  const scope = prefScope(scopeRaw);
  if (!scope) {
    sendJsonHttp(res, 400, { error: "bad scope" });
    return;
  }
  const all = await loadPrefs();
  // Host blocks are shared across device classes. Prefer the old desktop
  // order when migrating a file that predates the shared scope.
  const hostOrder = all.shared?.hostOrder ?? all.desktop?.hostOrder ?? all.touch?.hostOrder;
  const tabOrder = all.shared?.tabOrder ?? all.desktop?.tabOrder ?? all.touch?.tabOrder;
  sendJsonHttp(res, 200, { prefs: { ...(all[scope] ?? {}), newSessionCommand: all.shared?.newSessionCommand ?? '', ...(hostOrder ? { hostOrder } : {}), ...(tabOrder ? { tabOrder } : {}) } });
}

/** Merge a partial update into one scope's prefs ({ scope, ...fields }). */
async function handleSetPrefs(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 65536)).toString("utf8")); // room for a long tab order
  } catch {
    sendJsonHttp(res, 400, { error: "invalid body" });
    return;
  }
  const obj = body as { scope?: unknown } & UiPrefs;
  const scope = prefScope(obj?.scope);
  if (!scope) {
    sendJsonHttp(res, 400, { error: "bad scope" });
    return;
  }
  if (obj.newSessionCommand !== undefined && (typeof obj.newSessionCommand !== 'string' || obj.newSessionCommand.length > 2000 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(obj.newSessionCommand))) {
    sendJsonHttp(res, 400, { error: '默认命令须为不含换行或控制字符的单行文本，最多 2000 字符' });
    return;
  }
  const operation = prefsWrite.then(async () => {
    const all = { ...await loadPrefs() };
    const next: UiPrefs = { ...(all[scope] ?? {}) };
    // Only the fields actually present change; everything else is left alone, so
    // a client that knows about one pref can't blank the ones it doesn't.
    if (typeof obj.activeTab === "string" && obj.activeTab.trim()) {
      // A tab on a remote host is remembered by its page key, "@<host>/<name>".
      const remote = /^(@[a-z0-9]{1,16}\/)(.+)$/.exec(obj.activeTab.trim());
      next.activeTab = remote ? remote[1] + sanitizeSession(remote[2]) : sanitizeSession(obj.activeTab);
    }
    if (typeof obj.fontSize === "number" && Number.isFinite(obj.fontSize)) {
      next.fontSize = Math.min(28, Math.max(8, Math.round(obj.fontSize)));
    }
    for (const key of ["fontSizeMobile", "fontSizeDesktop"] as const) {
      const v = obj[key];
      if (typeof v === "number" && Number.isFinite(v)) next[key] = Math.min(28, Math.max(8, Math.round(v)));
    }
    if (typeof obj.keybar === "boolean") next.keybar = obj.keybar;
    if (typeof obj.keyboardLocked === "boolean") next.keyboardLocked = obj.keyboardLocked;
    if (typeof obj.pager === "boolean") next.pager = obj.pager;
    if (typeof obj.zoomKeys === "boolean") next.zoomKeys = obj.zoomKeys;
    if (obj.recentVisitLimitVersion === 2) next.recentVisitLimitVersion = 2;
    if (typeof obj.recentVisitLimit === 'number' && Number.isFinite(obj.recentVisitLimit)) {
      next.recentVisitLimit = Math.max(1, Math.min(50, Math.round(obj.recentVisitLimit)));
    }
    if (Array.isArray(obj.recentVisits)) {
      next.recentVisits = [...new Set(obj.recentVisits
        .filter((n): n is string => typeof n === 'string' && /^(@[a-z0-9]{1,16}\/)?[A-Za-z0-9_-]{1,64}$/.test(n)))].slice(0, 50);
    }
    if (Array.isArray(obj.recentTabs)) {
      // Page keys: a session name, or "@<host>/<name>" for a remote one.
      next.recentTabs = obj.recentTabs
        .filter((n): n is string => typeof n === "string" && /^(@[a-z0-9]{1,16}\/)?[A-Za-z0-9_-]{1,64}$/.test(n))
        .slice(0, 20);
    }
    if (Array.isArray(obj.tabOrder)) {
      next.tabOrder = obj.tabOrder
        .filter((n): n is string => typeof n === "string" && /^(@[a-z0-9]{1,16}\/)?[A-Za-z0-9_-]{1,64}$/.test(n))
        .slice(0, 500);
    }
    if (Array.isArray(obj.hostOrder)) {
      // A server's key: '' for this one, else its remote id (see remotes.ts).
      next.hostOrder = obj.hostOrder
        .filter((h): h is string => typeof h === "string" && /^[a-z0-9]{0,16}$/.test(h))
        .slice(0, 100);
    }
    for (const key of ["keybarMobile", "keybarDesktop", "keyboardLockedMobile", "keyboardLockedDesktop"] as const) {
      if (typeof obj[key] === "boolean") next[key] = obj[key];
    }
    if (obj.theme === "dark" || obj.theme === "light") next.theme = obj.theme;
    if (Array.isArray(obj.hostOrder)) {
      all.shared = { ...all.shared, hostOrder: next.hostOrder };
    }
    if (Array.isArray(obj.tabOrder)) all.shared = { ...all.shared, tabOrder: next.tabOrder };
    if (typeof obj.newSessionCommand === 'string') all.shared = { ...all.shared, newSessionCommand: obj.newSessionCommand.trim() };
    all[scope] = next;
    await writePrefs(all);
    prefsCache = all;
  });
  // Serialize the entire read/merge/write, and keep the queue usable on failure.
  prefsWrite = operation.catch(() => {});
  try {
    await operation;
    sendJsonHttp(res, 200, { ok: true });
  } catch (err) {
    console.error("[prefs] write failed:", err);
    sendJsonHttp(res, 500, { error: "preferences could not be saved" });
  }
}

// Matches the files we generate (clip-<ISO-stamp>-<rand>...), regardless of the
// original name/extension appended after, so pruning only ever touches ours.
const UPLOAD_NAME_RE = /^clip-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-z0-9]/i;

/**
 * Keep the upload directory bounded: delete our `clip-*` files older than
 * uploadRetentionHours, then keep only the newest uploadMaxFiles. Only touches
 * files matching our own naming pattern. Never throws.
 */
async function pruneUploads(): Promise<void> {
  try {
    let names: string[];
    try {
      names = await fsp.readdir(config.uploadDir);
    } catch {
      return; // dir doesn't exist yet — nothing to prune
    }
    const stats: { fp: string; mtime: number }[] = [];
    for (const name of names) {
      if (!UPLOAD_NAME_RE.test(name)) continue;
      const fp = path.join(config.uploadDir, name);
      try {
        const st = await fsp.stat(fp);
        if (st.isFile()) stats.push({ fp, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }

    const now = Date.now();
    const maxAgeMs = config.uploadRetentionHours * 3_600_000;
    const survivors: { fp: string; mtime: number }[] = [];
    for (const s of stats) {
      if (maxAgeMs > 0 && now - s.mtime > maxAgeMs) {
        await fsp.unlink(s.fp).catch(() => {});
      } else {
        survivors.push(s);
      }
    }

    if (config.uploadMaxFiles > 0 && survivors.length > config.uploadMaxFiles) {
      survivors.sort((a, b) => b.mtime - a.mtime); // newest first
      for (const s of survivors.slice(config.uploadMaxFiles)) {
        await fsp.unlink(s.fp).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[upload] prune error:", err);
  }
}

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  nameParam: string | null
): Promise<void> {
  const ctype = (req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  // Any file type is allowed. Prefer the original (sanitized) filename so the
  // saved file keeps its name and extension; fall back to a content-type ext
  // (mainly for clipboard image pastes, which carry no name), then ".bin".
  const safeName = safeUploadBaseName(nameParam);

  const maxBytes = config.uploadMaxBytes;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (maxBytes > 0 && size > maxBytes) {
        const mb = Math.round(maxBytes / (1024 * 1024));
        sendJsonHttp(res, 413, { error: `file too large (max ${mb} MB)` });
        req.destroy();
        return;
      }
      chunks.push(buf);
    }
  } catch (err) {
    console.error("[upload] read error:", err);
    if (!res.headersSent) sendJsonHttp(res, 400, { error: "read failed" });
    return;
  }

  if (size === 0) {
    sendJsonHttp(res, 400, { error: "empty body" });
    return;
  }

  try {
    await fsp.mkdir(config.uploadDir, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[:]/g, "-")
      .replace(/\..+$/, "")
      .replace("T", "_");
    const rand = Math.random().toString(36).slice(2, 8) || "x";
    const suffix = safeName ? `-${safeName}` : IMAGE_EXT[ctype] ?? ".bin";
    const filename = `clip-${stamp}-${rand}${suffix}`;
    const filePath = path.join(config.uploadDir, filename);
    await fsp.writeFile(filePath, Buffer.concat(chunks), { mode: 0o600 });
    console.log(`[upload] saved ${filePath} (${size} bytes)`);
    sendJsonHttp(res, 200, { path: filePath, name: filename, size });
    void pruneUploads(); // keep the upload dir bounded

  } catch (err) {
    console.error("[upload] write error:", err);
    sendJsonHttp(res, 500, { error: "could not save file" });
  }
}

// ---------------------------------------------------------------------------
// File download (GET/HEAD /api/download?path=…): stream a file from the host
// back to the browser as an attachment — the reverse of /upload. It will read
// any file the server's user can read, but that is NOT a wider trust boundary
// than we already expose: the terminal itself grants full shell access behind
// the SAME auth gate (a client who can attach a session can already
// `base64 afile` and copy it out). gateHttp() runs before this handler, so the
// same tw_auth cookie / Cloudflare-token rules apply. A leading `~` expands to
// the server user's home; a bare relative path is resolved against it.
// ---------------------------------------------------------------------------
/** The active pane's working directory for a tmux session, or null if unknown. */
function sessionCwd(session: string | null): Promise<string | null> {
  if (!session) return Promise.resolve(null);
  const name = sanitizeSession(session);
  return new Promise((resolve) => {
    execFile(
      TMUX,
      ["-u", "display-message", "-p", "-t", `=${name}:`, "#{pane_current_path}"],
      { timeout: 3000 },
      (err, stdout) => resolve(err ? null : stdout.toString().replace(/\n$/, '') || null)
    );
  });
}

/** Read the exact session's active pane without injecting commands into its CLI. */
async function handleSessionCwd(res: http.ServerResponse, session: string | null): Promise<void> {
  if (!session || !/^[A-Za-z0-9_-]{1,64}$/.test(session)) {
    sendJsonHttp(res, 400, { error: 'invalid session' });
    return;
  }
  const liveCwd = await sessionCwd(session);
  const saved = sessionStore.get(session);
  if (liveCwd && saved) sessionStore.update({ ...saved, cwd: liveCwd });
  const cwd = liveCwd ?? saved?.cwd;
  if (!cwd || !path.isAbsolute(cwd)) {
    sendJsonHttp(res, 409, { error: 'working directory unavailable' });
    return;
  }
  sendJsonHttp(res, 200, { path: cwd });
}

async function handleDownload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathParam: string | null,
  sessionParam: string | null
): Promise<void> {
  const raw = (pathParam ?? "").trim();
  if (!raw) {
    sendJsonHttp(res, 400, { error: "missing ?path" });
    return;
  }
  let abs: string;
  // "~\" is how a Windows user writes it; on Unix a backslash is a file name character.
  if (raw === "~" || raw.startsWith("~/") || (process.platform === "win32" && raw.startsWith("~\\"))) {
    abs = path.resolve(path.join(os.homedir(), raw.slice(1)));
  } else if (path.isAbsolute(raw)) {
    abs = path.resolve(raw);
  } else {
    // A bare name / relative path resolves against the tmux session's current
    // working directory, so you can download from wherever you are in the
    // terminal without typing an absolute path. Falls back to $HOME.
    const cwd = await sessionCwd(sessionParam);
    abs = path.resolve(cwd ?? os.homedir(), raw);
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(abs); // follows symlinks
  } catch {
    sendJsonHttp(res, 404, { error: "not found" });
    return;
  }
  if (!stat.isFile()) {
    sendJsonHttp(res, 400, { error: "not a regular file" });
    return;
  }

  const base = path.basename(abs);
  // RFC 6266: an ASCII-only fallback plus a UTF-8 filename* so names with
  // non-ASCII characters (or quotes/backslashes) still download with the right
  // name instead of a mojibake or a broken header.
  const asciiName = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.writeHead(200, {
    "Content-Type": "application/octet-stream", // force a download, not a preview
    "Content-Length": stat.size,
    "Content-Disposition":
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(base)}`,
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(abs);
  stream.on("error", (err) => {
    console.error(`[download] read error for ${abs}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end();
  });
  stream.pipe(res);
  console.log(`[download] served ${abs} (${stat.size} bytes)`);
}

// ---------------------------------------------------------------------------
// Remote hosts (src/remotes.ts): other terminal-web servers driven from here.
// The list and the remotes' tokens stay on this server; the browser sees names
// and addresses, plus this server's own token so it can be added over there.
// ---------------------------------------------------------------------------

const remotes = new RemoteStore(process.env.REMOTES_FILE || path.join(os.homedir(), ".terminal-web", "remotes.json"));
// Which addresses this machine has, as one string: it changes when Wi-Fi drops,
// a new network is joined or the Tailscale tunnel comes back up.
function interfaceSignature(): string {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).filter((a) => !a.internal).map((a) => `${name}=${a.address}`))
    .sort().join(",");
}
const remoteMonitor = new RemoteMonitor(remotes, interfaceSignature);
const remoteStatus = new RemoteStatusHub(remotes, remoteMonitor);

/**
 * This machine's IPv4 addresses, in the order they are preferred for display.
 * Fixed priority first: the overlay network (10.144.x.x, the remote-office
 * mesh) is how these machines reach each other from anywhere, then the local
 * LAN (192.168.x.x). Anything else after them: physical interfaces (en*, eth*,
 * wl*, ens*…) before tunnels, private ranges before public ones. VM /
 * container bridges and proxy fake-IP tunnels (198.18.0.0/15) never count.
 */
const PREFERRED_PREFIXES = ["10.144.", "192.168."];

function lanAddresses(): string[] {
  const virtual = /^(bridge|docker|br-|veth|vmnet|vboxnet|virbr|lo)/;
  const physical = /^(en|eth|wl|wlan|ens|enp|eno)/;
  const found: { ip: string; score: number }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (virtual.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const ip = a.address;
      if (ip.startsWith("169.254.") || /^198\.1[89]\./.test(ip)) continue;
      const preferred = PREFERRED_PREFIXES.findIndex((prefix) => ip.startsWith(prefix));
      const privateRange = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
      const score = preferred >= 0
        ? preferred * 10 + (physical.test(name) ? 0 : 1)
        : 100 + (physical.test(name) ? 0 : 2) + (privateRange ? 0 : 1);
      found.push({ ip, score });
    }
  }
  return [...new Set(found.sort((x, y) => x.score - y.score).map((f) => f.ip))];
}

/** The address this machine is shown by. It follows the machine: a laptop on another network shows its new one. */
function lanAddress(): string {
  return lanAddresses()[0] ?? "";
}

/**
 * Who this server is: name, addresses and operating system, for the page and
 * for servers that list it as a remote. `platform` is Node's ('win32',
 * 'darwin', 'linux', …): a page showing several servers needs it to quote a path
 * for the right shell and to label each host.
 */
function hostInfo(): { name: string; ip: string; ips: string[]; port: number; platform: NodeJS.Platform } {
  return { name: os.hostname(), ip: lanAddress(), ips: lanAddresses(), port: config.port, platform: process.platform };
}

// This server's own tag: the name its 本地 badge shows (and other servers
// see when they list it), a note on what it is, and a colour. Kept beside the
// remote list so every device shows the same.
interface SelfLabel { name: string; note: string; color: string }
const SELF_LABEL_FILE = path.join(path.dirname(process.env.REMOTES_FILE || path.join(os.homedir(), ".terminal-web", "remotes.json")), "self-label.json");
let selfLabelCache: SelfLabel | null = null;
async function selfLabel(): Promise<SelfLabel> {
  if (selfLabelCache) return selfLabelCache;
  try {
    const d = JSON.parse(await fsp.readFile(SELF_LABEL_FILE, "utf8")) as Partial<SelfLabel>;
    selfLabelCache = { name: cleanLabel(d.name) ?? "本地", note: cleanNote(d.note), color: cleanColor(d.color) ?? "green" };
  } catch {
    selfLabelCache = { name: "本地", note: "", color: "green" };
  }
  return selfLabelCache;
}
async function saveSelfLabel(body: Record<string, unknown>): Promise<void> {
  const before = await selfLabel();
  const name = body.name === undefined ? before.name : cleanLabel(body.name);
  if (!name) throw new Error("请填写名称");
  if ((await remotes.list()).some(r => sameLabel(r.name, name))) throw new Error(`保存失败：名称「${name}」已存在，请换一个`);
  const next: SelfLabel = {
    name,
    note: body.note === undefined ? before.note : cleanNote(body.note),
    color: cleanColor(body.color) ?? before.color,
  };
  await fsp.mkdir(path.dirname(SELF_LABEL_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${SELF_LABEL_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, SELF_LABEL_FILE);
  selfLabelCache = next;
}

async function handleRemotes(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const reply = async (): Promise<void> => sendJsonHttp(res, 200, {
    remotes: RemoteStore.view(await remotes.list()),
    health: remoteMonitor.snapshot(),
    // No token here: a page asks for one only when it copies it (POST /api/access).
    self: { ...hostInfo(), label: await selfLabel() },
  });
  if (req.method === "GET") { await reply(); return; }
  let body: Record<string, unknown>;
  try { body = JSON.parse((await readBody(req, 4096)).toString("utf8")); }
  catch { sendJsonHttp(res, 400, { error: "invalid body" }); return; }
  // "Reconnect now", from a page that just came back online or was woken up.
  if (body?.action === "check") {
    if (typeof body.id === "string") await remoteMonitor.check(body.id);
    else await remoteMonitor.checkAll();
    await reply();
    return;
  }
  if (body?.action === "self") {
    try { await saveSelfLabel(body); }
    catch (err) { sendJsonHttp(res, 400, { error: (err as Error).message }); return; }
    await reply();
    return;
  }
  try { await remotes.edit(body ?? {}, [(await selfLabel()).name]); }
  catch (err) { sendJsonHttp(res, 400, { error: (err as Error).message }); return; }
  await remoteMonitor.sync();
  await remoteStatus.sync();
  await reply();
}

/** Remote reachability as it changes (see RemoteMonitor), for the pages. */
function handleRemoteEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  const send = (health: unknown): void => { res.write(`data: ${JSON.stringify(health)}\n\n`); };
  send(remoteMonitor.snapshot());
  const unsubscribe = remoteMonitor.subscribe(send);
  // Frequent enough that a page notices a dead link to this server quickly.
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const shares = new ShareService(new ShareStore(process.env.SHARES_FILE || path.join(os.homedir(), '.terminal-web', 'shares.json')), {
  viewerState, maxUpload: config.uploadMaxBytes, token: config.authToken, publicDir: config.publicDir, remotes,
  subscribe: listener => {
    const off = [agentStatus.subscribe(listener), remoteStatus.subscribe(listener), remoteMonitor.subscribe(listener)];
    return () => off.forEach(fn => fn());
  },
  revokeControl: grant => terminalControl.revoke(`share:${grant}`),
  info: hostInfo, folders: () => folders.get(), self: async () => ({ ...hostInfo(), label: await selfLabel() }), status: () => agentStatus.snapshot(), remoteStatuses: () => remoteStatus.snapshot(), health: () => remoteMonitor.snapshot(),
  collect: async () => (await collectSavedSessions()).filter(s => !s.name.startsWith('agent_')), get: name => sessionStore.get(name), cwd: sessionCwd, closed: isClosed,
});
const sharedSockets = new WeakMap<WebSocket, ShareScope>();

const tlsCert = process.env.TLS_CERT_FILE;
const tlsKey = process.env.TLS_KEY_FILE;
if (!!tlsCert !== !!tlsKey) throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be set together');
const createHttpServer: (handler: http.RequestListener) => http.Server = tlsCert
  ? ((handler: http.RequestListener) => https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey!) }, handler))
  : http.createServer;
const server = createHttpServer((req, res) => {
  // Wrap in a try/catch so a single bad request never takes down the process.
  void (async () => {
    try {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }
      const requestUrl = new URL(req.url, "http://localhost");
      const method = req.method ?? "GET";

      if (await agentApi.http(req, res, requestUrl)) return;
      if (await shares.publicHttp(req, res, requestUrl)) return;

      // Mandatory token gate. Handles the login page and
      // the ?token=… sign-in for every route.
      if (method !== "GET" && method !== "HEAD" && !validOrigin(req)) {
        res.writeHead(403).end("Forbidden origin");
        return;
      }
      if (method === "POST" && requestUrl.pathname === "/auth/logout") {
        const id = isAuthed(req, config.authToken) ? browserId(req) : undefined;
        if (id) for (const ws of wss.clients) {
          if (socketBrowsers.get(ws) === id) ws.close(4001, "Logged out");
        }
        logout(req, res);
        return;
      }
      if (await gateHttp(req, res, requestUrl, config.authToken)) return;
      if (await shares.adminHttp(req, res, requestUrl)) return;
      if (requestUrl.pathname === '/api/agent-history' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(agentApi.history(requestUrl.searchParams.get('session') ?? ''), null, 2)); return;
      }
      if (requestUrl.pathname === '/api/viewer-state') {
        await viewerState.http(req, res, adminViewer, name => /^(?:@[a-z0-9]{1,16}\/)?[A-Za-z0-9_-]{1,64}$/.test(name)); return;
      }
      const viaRemote = remoteRoute(requestUrl.pathname);
      if (viaRemote) {
        const remote = await remotes.get(viaRemote.id);
        if (!remote) { sendJsonHttp(res, 404, { error: '远程主机不存在' }); return; }
        // A remote's remote list carries its own token; this page has no use for it.
        if (viaRemote.rest.startsWith('/api/remotes') || viaRemote.rest.startsWith('/api/access')) {
          sendJsonHttp(res, 404, { error: 'not available through a remote' }); return;
        }
        proxyHttp(req, res, remote, viaRemote.rest, requestUrl.search, remoteMonitor);
        return;
      }
      if (method === 'GET' && requestUrl.pathname === '/api/host-info') {
        res.setHeader('Cache-Control', 'no-store');
        sendJsonHttp(res, 200, hostInfo());
        return;
      }
      if (method === 'GET' && requestUrl.pathname === '/api/remotes/events') {
        handleRemoteEvents(req, res);
        return;
      }
      if (method === 'POST' && requestUrl.pathname === '/api/access') {
        // A host's sign-in token, for "复制地址和 Token" in the settings panel:
        // this server's ({}), or a remote's ({ id }). POST only, asked for at
        // the moment of copying, so a token never sits in a URL, a GET or a
        // page's state. Whoever is signed in here can already drive that remote
        // through this server.
        res.setHeader('Cache-Control', 'no-store');
        let body: { id?: unknown };
        try { body = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}'); }
        catch { sendJsonHttp(res, 400, { error: 'invalid body' }); return; }
        if (body?.id === undefined || body.id === '') { sendJsonHttp(res, 200, { token: config.authToken }); return; }
        const remote = await remotes.get(typeof body.id === 'string' ? body.id : '');
        if (!remote) { sendJsonHttp(res, 404, { error: '远程主机不存在' }); return; }
        sendJsonHttp(res, 200, { token: remote.token });
        return;
      }
      if ((method === 'GET' || method === 'POST') && requestUrl.pathname === '/api/remotes') {
        await handleRemotes(req, res);
        return;
      }
      if (await handleSite(req, res, requestUrl)) return;
      if (await handleFileApi(req, res, requestUrl, { maxUpload: config.uploadMaxBytes, tmuxConf: config.tmuxConfPath })) return;

      if (method === "POST" && requestUrl.pathname === "/upload") {
        await handleUpload(req, res, requestUrl.searchParams.get("name"));
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/sessions") {
        await handleListSessions(res);
        return;
      }

      if (method === 'GET' && requestUrl.pathname === '/api/sessions/cwd') {
        res.setHeader('Cache-Control', 'no-store');
        await handleSessionCwd(res, requestUrl.searchParams.get('session'));
        return;
      }

      if (method === 'POST' && requestUrl.pathname === '/api/sessions/scroll') {
        await handleScrollSession(req, res);
        return;
      }

      if ((method === 'GET' || method === 'POST') && requestUrl.pathname === '/api/sessions/note') {
        await handleSessionNote(req, res, requestUrl);
        return;
      }
      if (method === 'POST' && requestUrl.pathname === '/api/agent-hook') {
        await handleAgentHook(req, res);
        return;
      }
      if (method === 'GET' && requestUrl.pathname === '/api/agent-status') {
        sendJsonHttp(res, 200, agentStatus.snapshot());
        return;
      }
      if (method === 'GET' && requestUrl.pathname === '/api/agent-status/events') {
        handleAgentStatusEvents(req, res, requestUrl.searchParams.get('health') === '1');
        return;
      }
      if (method === 'POST' && requestUrl.pathname === '/api/agent-status/mode') {
        let body: { mode?: unknown };
        try { body = JSON.parse((await readBody(req, 1024)).toString('utf8')); }
        catch { sendJsonHttp(res, 400, { error: 'invalid body' }); return; }
        if (!isAgentStatusMode(body?.mode)) { sendJsonHttp(res, 400, { error: 'invalid mode' }); return; }
        await agentStatus.setMode(body.mode);
        sendJsonHttp(res, 200, agentStatus.snapshot());
        return;
      }
      if (method === 'POST' && requestUrl.pathname === '/api/agent-status/read') {
        await handleAgentStatusRead(req, res);
        return;
      }
      if ((method === 'GET' || method === 'POST') && requestUrl.pathname === '/api/folders') {
        await handleFolders(req, res);
        return;
      }
      if ((method === 'GET' || method === 'POST') && requestUrl.pathname === '/api/quick-commands') {
        await handleQuickCommands(req, res);
        return;
      }
      if (method === "POST" && requestUrl.pathname === "/api/sessions/rename") {
        await handleRenameSession(req, res);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/sessions/kill") {
        await handleKillSession(req, res);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/sessions/adopt") {
        await handleAdoptSessions(req, res);
        return;
      }

      if (requestUrl.pathname === '/api/terminal-colors' && (method === 'GET' || method === 'POST')) {
        if (method === 'POST') {
          let body: unknown;
          try { body = JSON.parse((await readBody(req, 1024)).toString('utf8')); }
          catch { sendJsonHttp(res, 400, { error: 'invalid body' }); return; }
          const enabled = (body as { enabled?: unknown } | null)?.enabled;
          if (typeof enabled !== 'boolean') {
            sendJsonHttp(res, 400, { error: 'enabled must be boolean' }); return;
          }
          setTerminalColors(enabled);
        }
        res.setHeader('Cache-Control', 'no-store');
        sendJsonHttp(res, 200, { enabled: getTerminalColors() });
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/prefs") {
        await handleGetPrefs(res, requestUrl.searchParams.get("scope"));
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/prefs") {
        await handleSetPrefs(req, res);
        return;
      }

      if (
        (method === "GET" || method === "HEAD") &&
        requestUrl.pathname === "/api/download"
      ) {
        await handleDownload(
          req,
          res,
          requestUrl.searchParams.get("path"),
          requestUrl.searchParams.get("session")
        );
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, {
          "Content-Type": "text/plain; charset=utf-8",
          Allow: "GET, HEAD",
        });
        res.end("Method Not Allowed");
        return;
      }

      await serveStatic(req, res, requestUrl.pathname);
    } catch (err) {
      console.error("[http] unhandled request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    }
  })();
});

server.on("clientError", (err, socket) => {
  // Malformed HTTP from a client; respond minimally and don't crash.
  console.error("[http] client error:", err.message);
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
});

// Node caps a whole request (body included) at requestTimeout — default 300s.
// A large file upload over a slow/relayed mobile link easily exceeds 5 min and
// was being cut off mid-transfer ("uploaded halfway then dropped"). Disable it:
// the total bytes per request are already bounded by uploadMaxBytes, and
// headersTimeout still guards the header phase against slow-loris. server.timeout
// (socket inactivity) is 0/off by default, so nothing else caps a slow upload.
server.requestTimeout = 0;

// ---------------------------------------------------------------------------
// WebSocket terminal bridge
// ---------------------------------------------------------------------------

// Only a fallback for a client that doesn't state its size: every terminal-web
// client sends the size it will actually use as ?cols=&rows= (see below).
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
// Sanity bounds on a client-supplied size. The low end matters: tmux sizes a
// window to its most recently used client, so one client attaching at a silly
// size resizes the window for everyone else on that session — and a program on
// the alternate screen (Claude Code) has no scrollback, so everything that no
// longer fits is destroyed rather than scrolled off.
const MIN_DIM = 10;
const MAX_COLS = 1000;
const MAX_ROWS = 500;
// How long after the last resize to make tmux repaint. Long enough that
// dragging a window costs one repaint rather than sixty.
//
// The browser's split needs nothing from tmux now — two sessions side by side
// have no border to draw. This is for a split made INSIDE tmux, which is still
// one window drawn into one grid: tmux sends only differences, so a grid that
// drifts from its model keeps a crooked border until something redraws it all.
const REPAINT_DELAY_MS = 400;
const HEARTBEAT_MS = 20_000;

/** Parse a ?cols=/?rows= param, falling back when absent or out of bounds. */
function parseDim(raw: string | null, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(n) || n < MIN_DIM || n > max) return fallback;
  return n;
}

// This server's own configuration env vars. They must NOT leak into the user's
// shell: e.g. zsh's `%m` prompt escape reads $HOST, so an exported HOST (the
// bind address) would make the prompt show "100" instead of the real hostname.
const SERVER_ENV_VARS = ["HOST", "PORT", "DEFAULT_SESSION", "AUTH_TOKEN", "TLS_KEY_FILE", "TLS_CERT_FILE"];

function hasUtf8(value: string | undefined): boolean {
  return typeof value === "string" && /utf-?8/i.test(value);
}

function buildChildEnv(): NodeJS.ProcessEnv {
  const env = terminalEnvironment(process.env);
  for (const key of SERVER_ENV_VARS) {
    delete env[key];
  }
  // A server started from inside a terminal — one of its own tabs, say — has
  // that terminal's tmux / psmux identity in its environment. Passed on, it
  // makes the new client think it is nested: psmux refuses outright ("sessions
  // should be nested with care") and the tab closes the moment it opens.
  for (const key of ["TMUX", "TMUX_PANE", "PSMUX_SESSION", "PSMUX_TARGET_SESSION", "PSMUX_TARGET_FULL", "PSMUX_ACTIVE"]) {
    delete env[key];
  }
  // Ensure a UTF-8 locale. Under launchd the environment has no LANG, which
  // leaves the shell and tmux in a non-UTF-8 (C) locale — CJK/wide characters
  // then render as "_" and multibyte (IME) input is mangled. Only set a default
  // if none of the locale vars already request UTF-8.
  if (!hasUtf8(env.LC_ALL) && !hasUtf8(env.LC_CTYPE) && !hasUtf8(env.LANG)) {
    env.LANG = "en_US.UTF-8";
  }
  return env;
}

interface LiveSocket extends WebSocket {
  isAlive: boolean;
}

// ---------------------------------------------------------------------------
// Noticing that the tmux server has died.
//
// A tmux client exits 1 the moment its server disappears, so a burst of ptys
// exiting that way is not a dozen sessions closing — it is the whole tmux
// server going down, taking every session's contents with it. That happened on
// the NUC and left no trace beyond a scattering of "pty exited (code 1)" lines
// that had to be read backwards to work out what they meant. One line instead.
// ---------------------------------------------------------------------------
const SERVER_DEATH_WINDOW_MS = 3000;
const SERVER_DEATH_MIN_EXITS = 3;
let abnormalExits: number[] = [];
let lastDeathReport = 0;

function noteAbnormalPtyExit(): void {
  const now = Date.now();
  abnormalExits = abnormalExits.filter((at) => now - at < SERVER_DEATH_WINDOW_MS);
  abnormalExits.push(now);
  if (abnormalExits.length < SERVER_DEATH_MIN_EXITS) return;
  if (now - lastDeathReport < SERVER_DEATH_WINDOW_MS) return; // one line per event
  lastDeathReport = now;
  const count = abnormalExits.length;
  void listTmuxSessions().then((names) => {
    if (names === null) {
      console.error(
        `[tmux] THE TMUX SERVER IS GONE — ${count} clients exited at once and ` +
          "no server is answering. Every session's contents are lost; what " +
          `survives is the last snapshot in ${RESURRECT_DIR}.`
      );
    } else {
      console.error(
        `[tmux] ${count} tmux clients exited at once. A server is answering ` +
          `again with ${names.length} session(s) — if they are empty, the old ` +
          "one died and these are new."
      );
    }
  });
}

const wss = new WebSocketServer({ noServer: true });
const terminalControl = new TerminalControl();
const agentApi = new AgentApi({
  enabled: process.env.AGENT_ENABLED === '1', token: config.authToken,
  file: process.env.AGENT_SESSIONS_FILE || path.join(os.homedir(), '.terminal-web', 'agent-sessions.json'),
  control: terminalControl,
  async spawn(name, cwd, create) {
    if (livePtys.size >= config.maxPtys) throw new Error('PTY_LIMIT');
    if (!create) await new Promise<void>((resolve, reject) => execFile(TMUX, ['has-session', '-t', `=${name}`], {timeout: 3000}, error => error ? reject(new Error('SESSION_GONE')) : resolve()));
    if (livePtys.size >= config.maxPtys) throw new Error('PTY_LIMIT');
    const proc = pty.spawn(TMUX, create ? tmuxArgs(name, config.tmuxConfPath, cwd)
      : ['-u', '-f', config.tmuxConfPath, 'attach-session', '-t', `=${name}`], {
      name: 'xterm-256color', cols: 120, rows: 35, cwd: os.homedir(),
      env: { ...buildChildEnv(), ...psmuxEnv(config.tmuxConfPath) }, useConptyDll: IS_PSMUX,
    });
    livePtys.add(proc); proc.onExit(() => livePtys.delete(proc)); return proc;
  },
  async prepareInput(name, authorized) {
    if (!authorized()) throw new Error('CONTROL_LOST');
    const target = `=${name}:`;
    await new Promise<void>((resolve, reject) => execFile(TMUX,
      ['if-shell', '-F', '-t', target, '#{==:#{pane_mode},copy-mode}', `send-keys -t ${target} -X cancel`],
      {timeout: 3000}, error => error ? reject(error) : resolve()));
  },
  register(name, label, cwd) {
    sessionStore.update({name, displayName: label, cwd}); liveSessions.add(name);
    tagWebSession(name); setWebTabLabel(name, label);
    execFile(TMUX, ['set-option', '-w', '-t', `=${name}:`, 'window-size', 'manual'], {timeout: 3000}, () => {});
  },
  async remove(name) {
    const exists = await new Promise<boolean>(resolve => execFile(TMUX, ['has-session', '-t', `=${name}`], {timeout: 3000}, error => resolve(!error)));
    if (exists) await new Promise<void>((resolve, reject) => execFile(TMUX, ['kill-session', '-t', `=${name}`], {timeout: 3000}, error => error ? reject(error) : resolve()));
    markClosed([name]); broadcastClosed(name); liveSessions.delete(name);
  },
});
agentApi.markRecovered();
const agentViewerHub = new AgentViewerHub(name => new Promise((resolve, reject) => {
  execFile(TMUX, ['capture-pane', '-p', '-S', '-2000', '-t', `=${name}:`],
    {timeout: 3000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'}, (error, stdout) => {
      if (error) { reject(error); return; }
      const lines = stdout.replace(/\r\n/g, '\n').split('\n');
      resolve({text: lines.slice(-2000).join('\n'), truncated: lines.length > 2000, limit: 2000});
    });
}));
const controlTimer = setInterval(() => terminalControl.sweep(), 500); controlTimer.unref();
const controlMetadata = new WeakMap<WebSocket, { resume: string; principal: string; label: string; admin: boolean }>();
const socketBrowsers = new WeakMap<WebSocket, string>();

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("[ws] failed to send json:", err);
    }
  }
}

wss.on("connection", (rawWs: WebSocket, req: http.IncomingMessage) => {
  const ws = rawWs as LiveSocket;
  ws.isAlive = true;
  const shareScope = shares.requests.get(req);
  if (shareScope) sharedSockets.set(ws, shareScope);

  // Resolve the requested session — and the size to attach at — from the query
  // string. Spawning at the client's real size rather than 80x24 keeps the tmux
  // window steady: it used to shrink to 80x24 on every connect and reconnect,
  // for a beat, for every client attached to that session.
  let requested: string | null = null;
  let create = false;
  let createFrom: string | undefined;
  let createDirectory: string | undefined;
  let cols = DEFAULT_COLS;
  let rows = DEFAULT_ROWS;
  try {
    const u = new URL(req.url ?? "/ws", "http://localhost");
    requested = u.searchParams.get("session");
    create = u.searchParams.get("create") === "1";
    const from = u.searchParams.get("from");
    if (create && from && /^[A-Za-z0-9_-]{1,64}$/.test(from)) createFrom = from;
    const directory = u.searchParams.get('dir');
    if (create && u.searchParams.has('dir')) {
      createDirectory = directory ?? '';
    }
    cols = parseDim(u.searchParams.get("cols"), DEFAULT_COLS, MAX_COLS);
    rows = parseDim(u.searchParams.get("rows"), DEFAULT_ROWS, MAX_ROWS);
  } catch {
    requested = null;
  }
  const session = sanitizeSession(requested ?? config.defaultSession);
  if (agentApi.isAgent(session.replace(/__b$/, ''))) {
    if (shareScope || session.endsWith('__b')) { ws.close(1008, 'AGENT_READ_ONLY'); return; }
    if (isClosed(session)) { sendJson(ws, {type:'closed'}); ws.close(1000); return; }
    addSessionClient(session, ws);
    ws.once('close', () => removeSessionClient(session, ws));
    agentViewerHub.attach(ws, session);
    return;
  }
  const controlUrl = new URL(req.url ?? '/ws', 'http://localhost');
  const resume = /^[a-f0-9]{48}$/.test(controlUrl.searchParams.get('client') ?? '') ? controlUrl.searchParams.get('client')! : crypto.randomBytes(24).toString('hex');
  controlMetadata.set(ws, { resume, principal: shareScope ? `share:${shareScope.grant ?? shareScope.session.identity}` : 'admin',
    label: `${shareScope ? '分享访客' : '管理员'} ${resume.slice(0, 4)}`, admin: !shareScope });

  // Guard the host's system-wide pty table: refuse the connection (before
  // spawning any pty) once we're at the cap, rather than letting a runaway or
  // flapping client pile up ptys until macOS can't allocate one for SSH either.
  if (livePtys.size >= config.maxPtys) {
    console.warn(
      `[ws] pty cap reached (${livePtys.size}/${config.maxPtys}); refusing "${session}". ` +
        "Close unused tabs, or raise MAX_PTYS."
    );
    sendJson(ws, {
      type: "info",
      message: `Server is at its terminal limit (${config.maxPtys}). Close an unused tab and reconnect.`,
    });
    try {
      ws.close(1013, "pty cap reached");
    } catch {
      /* ignore */
    }
    return;
  }

  if (create) {
    clearClosed(session);
  } else if (isClosed(session)) {
    // A kill may still be waiting for its snapshot. Only create=1 reopens it.
    sendJson(ws, { type: "closed" });
    ws.close(1000, "closed");
    return;
  }
  if (shareScope) attachSession(ws, session, cols, rows);
  else startAttach(ws, session, cols, rows, createFrom, createDirectory);
});

/**
 * New tabs and splits start in their base session's current directory.
 * Reattaching an existing session never changes its working directory.
 */
function startAttach(ws: LiveSocket, session: string, cols: number, rows: number, createFrom?: string, directory?: string): void {
  directory ??= sessionStore.get(session)?.cwd;
  const base = createFrom ?? (session.endsWith(MATE_SUFFIX) ? session.slice(0, -MATE_SUFFIX.length) : null);
  if (!base && directory === undefined) {
    attachSession(ws, session, cols, rows);
    return;
  }
  void mateStartDir(session, base ?? session, directory).then((dir) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (directory && dir && path.isAbsolute(directory) && path.normalize(directory) !== path.normalize(dir)) {
      sendJson(ws, { type: 'info', message: `原会话目录不可用，已进入用户主目录：${directory}` });
    }
    attachSession(ws, session, cols, rows, dir ?? undefined);
  });
}

/** Spawn the tmux client for `session` and wire it to this socket. */
async function attachSession(
  ws: LiveSocket,
  session: string,
  cols: number,
  rows: number,
  startDir?: string
): Promise<void> {
  // A close may arrive while asynchronous directory resolution runs.
  if (ws.readyState !== WebSocket.OPEN || isClosed(session)) {
    sendJson(ws, { type: 'closed' });
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'closed');
    return;
  }
  // Explicit window sizing prevents a newly attached spectator changing the shared screen.
  await new Promise<void>(resolve => execFile(TMUX, ['set-option', '-w', '-t', `=${session}:`, 'window-size', 'manual'], { timeout: 3000 }, () => resolve()));
  if (ws.readyState !== WebSocket.OPEN) return;
  const initialSize = await new Promise<{cols:number;rows:number} | undefined>(resolve => execFile(TMUX,
    ['display-message', '-p', '-t', `=${session}:`, '#{window_width} #{window_height}'], {timeout:3000}, (err, output) => {
      const [width,height] = String(output).trim().split(' ').map(Number);
      resolve(!err && width > 0 && height > 0 ? {cols:width,rows:height} : undefined);
    }));
  if (initialSize) { cols = initialSize.cols; rows = initialSize.rows; }
  if (ws.readyState !== WebSocket.OPEN) return;
  let proc: pty.IPty;
  try {
    proc = pty.spawn(TMUX, sharedSockets.has(ws) || agentApi.isAgent(session)
      ? ['-u', '-f', config.tmuxConfPath, 'attach-session', '-t', `=${session}`]
      : tmuxArgs(session, config.tmuxConfPath, startDir), {
      name: "xterm-256color",
      cols,
      rows,
      cwd: os.homedir(),
      env: { ...buildChildEnv(), ...psmuxEnv(config.tmuxConfPath) },
      // Windows: the ConPTY that node-pty puts between us and psmux re-renders
      // psmux's output. The console host inbox in Windows mis-tracks wide (CJK)
      // characters there and leaves ghost copies of them ("中 文") across the
      // screen; the OpenConsole that node-pty ships does not.
      useConptyDll: IS_PSMUX,
    });
  } catch (err) {
    console.error(`[ws] failed to spawn tmux for session "${session}":`, err);
    sendJson(ws, { type: "info", message: "Failed to start terminal session." });
    try {
      ws.close(1011, "spawn failed");
    } catch {
      /* ignore */
    }
    return;
  }

  livePtys.add(proc);
  console.log(
    `[ws] connected -> tmux session "${session}" (pid ${proc.pid}) ` +
      `[${livePtys.size}/${config.maxPtys} ptys]`
  );

  // Tag the tmux session as a web tab so every device sees it (cross-device
  // sync), and note it as live so /api/sessions lists it without waiting for
  // the tag write. Tagging on every connect also adopts pre-existing sessions.
  //
  // Except the second half of a split: it is reached through the tab it is
  // named after, and a tab of its own is the one thing it must not become.
  if (!sharedSockets.has(ws) && !session.endsWith(MATE_SUFFIX)) {
    liveSessions.add(session);
    const saved = sessionStore.get(session);
    sessionStore.update({ name: session, displayName: saved?.displayName ?? session, cwd: startDir });
    tagWebSession(session);
    if (saved) setWebTabLabel(session, saved.displayName);
  }
  addSessionClient(session, ws);

  let closed = false;
  const scope = sharedSockets.get(ws);
  const controlKey = session; // owned by this host, regardless of proxy/share entry point
  let controlClient: ControlClient | undefined;
  let operationFence: number | undefined;
  const validAccess = () => !scope || shares.validScope(scope);
  const canViewHistory = () => !scope && validAccess() && (!!controlClient?.readOnly?.() || (agentApi.isAgent(session) && !!controlClient && !terminalControl.owns(controlKey, controlClient)));
  const canInput = () => !!controlClient && terminalControl.accepts(controlKey, controlClient, operationFence) && validAccess() && !closed && ws.readyState === WebSocket.OPEN;
  const meta = controlMetadata.get(ws)!;
  controlClient = terminalControl.join(controlKey, { ...meta, readOnly: () => !scope && shares.isSessionShared('', session), valid: validAccess, send: value => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(agentApi.isAgent(session) ? { ...(value as object), historyUrl: '/api/agent-history?session=' + encodeURIComponent(session) } : value));
  } }, initialSize ?? {cols, rows}, !!scope || (!agentApi.isAgent(session) && !shares.isSessionShared('', session)));
  const leasePing = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { try { ws.ping(); } catch { /* closing */ } } }, 4000);
  leasePing.unref(); ws.once('close', () => clearInterval(leasePing));
  ws.once('close', (code) => terminalControl.leave(controlKey, controlClient!, code === 4001 || !validAccess()));
  // New sessions must also use manual sizing; no spectator can drive window-size.
  execFile(TMUX, ['set-option', '-w', '-t', `=${session}:`, 'window-size', 'manual'], { timeout: 3000 }, () => {});
  let submitted = false;

  // tmux sends only differences, so a browser grid that has drifted from tmux's
  // model of it never gets corrected — that is the pane divider drawn a column
  // or two off on a few rows, and it stays for as long as the page is open (see
  // tmux.ts). The two moments the two can come apart are a resize and a
  // split-view switch, because the divider column itself moves; both schedule a
  // full repaint here. Coalesced, so dragging a window costs one.
  let clientTty: string | null = null;
  let repaintTimer: NodeJS.Timeout | null = null;
  const scheduleRepaint = (): void => {
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      if (closed) return;
      void (async () => {
        // The tty is stable for the life of this pty, so it is looked up once.
        if (!clientTty) clientTty = await findClientTty(proc.pid);
        if (clientTty && !closed) await refreshClient(clientTty);
      })();
    }, REPAINT_DELAY_MS);
  };

  // xterm.js auto-answers the terminal-identity queries (DA1 ESC[?..c /
  // DA2 ESC[>..c) tmux sends when a client attaches. tmux 3.6 only *consumes*
  // those replies for ~3s after attach; one that arrives later (phone waking
  // up over the tunnel) or a second one (stale query answered post-reconnect)
  // is parsed as keystrokes and lands in the foreground program's input as
  // literal "?1;2c" — regardless of escape-time. Let each kind through once,
  // early; strip the rest. OSC color replies are consumed anytime, left alone.
  const DA_WINDOW_MS = 2500;
  const attachedAt = Date.now();
  const daSeen: Record<"?" | ">", boolean> = { "?": false, ">": false };
  const filterDaReplies = (input: string): string => {
    if (!input.includes("\x1b[")) return input;
    return input.replace(/\x1b\[([?>])[0-9;]*c/g, (seq, kind: "?" | ">") => {
      if (!daSeen[kind] && Date.now() - attachedAt <= DA_WINDOW_MS) {
        daSeen[kind] = true;
        return seq;
      }
      console.log(
        `[ws] stripped late/duplicate DA reply for "${session}": ${JSON.stringify(seq)}`
      );
      return "";
    });
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (repaintTimer) {
      clearTimeout(repaintTimer);
      repaintTimer = null;
    }
    liveSessions.delete(session);
    livePtys.delete(proc);
    try {
      // Killing the pty only detaches this tmux client; the server/session
      // persist so the session can be resumed on reconnect.
      proc.kill();
    } catch (err) {
      console.error("[ws] error killing pty:", err);
    }
    // kill() only signals the child — node-pty closes the TRACKED master fd
    // (proc.fd) when its ReadStream reaches EOF, but ws.on("close") disposes
    // onData first, pausing that stream, so the close can lag. destroy() force-
    // closes it (and, on node-pty 1.2, the slave + kqueue) promptly. IPty's
    // public typing omits destroy(); the runtime UnixTerminal has it.
    // Not on Windows: there destroy() is kill() again, and closing the same
    // pseudoconsole twice corrupts the heap and takes the whole server down.
    if (process.platform !== "win32") try {
      (proc as unknown as { destroy?: () => void }).destroy?.();
    } catch (err) {
      console.error("[ws] error destroying pty:", err);
    }
  };

  // pty output -> ws (binary)
  // OpenConsole (useConptyDll) opens by asking its terminal who it is (DA1,
  // ESC[c) and holds the client's output for ~3s until it hears back. That
  // question is for this server, not the browser: answer it here, once, so a
  // tab opens at once, and do not pass it on (the browser's answer would be a
  // second one, which psmux would read as typed text).
  let conptyAsked = !IS_PSMUX;
  const onData = proc.onData((raw: string) => {
    let data = raw;
    if (submitted && controlClient && terminalControl.owns(controlKey, controlClient)) agentStatus.legacyOutput(session);
    if (!conptyAsked && data.includes("\x1b[c")) {
      conptyAsked = true;
      proc.write("\x1b[?62;22c");
      data = data.replace("\x1b[c", "");
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const scope = sharedSockets.get(ws);
    if (scope && !shares.validScope(scope)) return;
    try {
      // node-pty emits strings; send raw bytes so xterm gets exact output.
      ws.send(Buffer.from(data, "utf8"), { binary: true });
    } catch (err) {
      console.error("[ws] send error:", err);
    }
  });

  const onExit = proc.onExit(({ exitCode, signal }) => {
    console.log(
      `[ws] pty for "${session}" exited (code ${exitCode}, signal ${signal ?? "none"})`
    );
    // Exit 1 with no signal is what a tmux client does when its server goes.
    if (exitCode === 1 && !signal) noteAbnormalPtyExit();
    if (controlClient) terminalControl.leave(controlKey, controlClient, true);
    closed = true; // pty is already gone; avoid kill() in cleanup
    liveSessions.delete(session);
    livePtys.delete(proc);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(1000, "pty exited");
      } catch {
        /* ignore */
      }
    }
  });

  // Keep keyboard and wheel bytes ordered while leaving tmux copy-mode.
  // Coalesce keystrokes arriving during the command so pasted text stays intact.
  const inputQueue: { data: string; fence: number }[] = [];
  const historyInputCheck = new HistoryInputCheck();
  let preparingInput = false;
  const drainInput = (): void => {
    if (preparingInput || closed) return;
    if (!canInput()) { inputQueue.length = 0; return; }
    const scope = sharedSockets.get(ws);
    if (scope && (!shares.validScope(scope) || ws.readyState !== WebSocket.OPEN)) { inputQueue.length = 0; return; }
    const entry = inputQueue.shift();
    if (!entry) return;
    const input = entry.data;
    const canWrite = () => canInput() && terminalControl.accepts(controlKey, controlClient!, entry.fence);
    if (!canWrite()) { drainInput(); return; }
    if (!isKeyboardInput(input)) {
      // Mouse gestures can enter history, including legacy mouse reports.
      if (/\x1b\[(?:<|M)/.test(input)) historyInputRevision++;
      // psmux takes a wheel from its client for copy-mode even over a program
      // that reads the mouse itself (Claude Code, vim) — tmux has a binding
      // for that (web.tmux.conf), psmux has no bindings — and keeps every
      // later wheel there. Such a program, with nothing in tmux's history, sat
      // unscrollable behind an empty "[copy mode]". So when the program asks
      // for the mouse, leave copy-mode and hand the wheel straight to the
      // program with send-keys; a plain shell still scrolls tmux's history.
      if (IS_PSMUX && hasWheelInput(input)) {
        preparingInput = true;
        const target = `=${session}:`;
        const done = (): void => {
          historyInputRevision++;
          preparingInput = false;
          if (closed) { inputQueue.length = 0; return; }
          drainInput();
        };
        execFile(TMUX, ['display-message', '-p', '-t', target, '#{mouse_any_flag} #{pane_mode}'],
        { timeout: 3000 }, (error, stdout) => {
          if (!canWrite()) { done(); return; }
          const [mouse, mode] = String(stdout).trim().split(' ');
          if (closed || error || mouse !== '1') {
            if (canWrite()) proc.write(input);
            done();
            return;
          }
          const send = (): void => {
            if (!canWrite()) { done(); return; }
            execFile(TMUX, ['send-keys', '-t', target, '-l', input], { timeout: 3000 }, done);
          };
          if (mode === 'copy-mode') {
            execFile(TMUX, ['send-keys', '-t', target, '-X', 'cancel'], { timeout: 3000 }, send);
          } else {
            send();
          }
        });
        return;
      }
      if (canWrite()) proc.write(input);
      drainInput();
      return;
    }
    if (historyInputCheck.allows(input, historyInputRevision, performance.now())) {
      if (canWrite()) proc.write(input);
      drainInput();
      return;
    }
    historyInputCheck.invalidate();
    // A mux prefix/control sequence may change modes after it is delivered.
    const printable = !/[\x00-\x1f\x7f]/.test(input);
    if (!printable) historyInputRevision++;
    const checkedRevision = historyInputRevision;
    preparingInput = true;
    const target = `=${session}:`;
    execFile(TMUX, ['if-shell', '-F', '-t', target,
      '#{==:#{pane_mode},copy-mode}', `send-keys -t ${target} -X cancel`],
    { timeout: 3000 }, (error) => {
      preparingInput = false;
      if (closed) { inputQueue.length = 0; return; }
      if (error) console.error('[ws] could not leave history mode:', error.message);
      if (!error && printable && canWrite()) historyInputCheck.checked(checkedRevision, performance.now());
      if (canWrite()) proc.write(input);
      drainInput();
    });
  };

  const shareScope = sharedSockets.get(ws);
  const shareGuard = shareScope ? new ShareInputGuard(shareScope.session.root, () => new Promise(resolve => {
    execFile(TMUX, ['display-message', '-p', '-t', `=${session}:`, '#{pane_current_path}\n#{pane_current_command}'], { timeout: 2000 }, (err, stdout) => {
      const [cwd, command] = stdout.trim().split('\n'); resolve(err || !cwd || !command ? null : { cwd, command });
    });
  }), () => sendJson(ws, { type: 'info', message: '普通终端不能切换到分享根目录之外；文件管理范围保持不变。' })) : null;
  let shareInput = Promise.resolve();
  const shareTimer = shareScope ? setInterval(() => { if (!shares.validScope(shareScope)) ws.terminate(); }, 500) : null;
  if (shareTimer) { shareTimer.unref(); ws.once('close', () => clearInterval(shareTimer)); }
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (closed || (shareScope && !shares.validScope(shareScope))) return;
    try {
      if (isBinary) {
        const fence = terminalControl.fence(controlKey, controlClient!);
        if (fence === undefined) return;
        // Clear bytes from a previous lease before accepting a new one.
        if (operationFence !== fence) { inputQueue.length = 0; historyInputCheck.invalidate(); operationFence = fence; }
        // Raw user input bytes -> pty.
        const buf = Array.isArray(data)
          ? Buffer.concat(data.map((d) => Buffer.from(d)))
          : Buffer.from(data as ArrayBuffer);
        const input = filterDaReplies(buf.toString("utf8"));
        if (/[\r\n]/.test(input) && !input.includes('\x1b[200~')) submitted = true;
        if (input && shareGuard) {
          shareInput = shareInput.then(async () => {
            if (!terminalControl.accepts(controlKey, controlClient!, fence)) return;
            const filtered = await shareGuard.filter(input);
            if (terminalControl.accepts(controlKey, controlClient!, fence) && canInput()) { inputQueue.push({ data: filtered, fence }); drainInput(); }
          }).catch(() => { ws.terminate(); });
          return;
        }
        if (input) {
          // Merge only adjacent keyboard chunks; mouse/keyboard order matters.
          const last = inputQueue.length - 1;
          if (last >= 0 && isKeyboardInput(input) && inputQueue[last].fence === fence && isKeyboardInput(inputQueue[last].data)) {
            inputQueue[last].data += input;
          } else inputQueue.push({ data: input, fence });
          drainInput();
        }
        return;
      }

      // TEXT frame: JSON control message.
      const text = Array.isArray(data)
        ? Buffer.concat(data.map((d) => Buffer.from(d))).toString("utf8")
        : Buffer.from(data as ArrayBuffer).toString("utf8");

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return; // ignore non-JSON text frames
      }

      // Read-only admins may scroll, but never send arbitrary terminal bytes.
      if (parsed && typeof parsed === 'object' && (parsed as {type?:string}).type === 'view-scroll') {
        if (!canViewHistory()) return;
        const wheel = parsed as {ticks?:number; col?:number; row?:number};
        if (!Number.isInteger(wheel.ticks) || !wheel.ticks || Math.abs(wheel.ticks!) > 100 || !Number.isInteger(wheel.col) || !Number.isInteger(wheel.row)) return;
        const col = Math.max(1, Math.min(cols, wheel.col!));
        const row = Math.max(1, Math.min(rows, wheel.row!));
        historyInputRevision++;
        proc.write(`\x1b[<${wheel.ticks! > 0 ? 64 : 65};${col};${row}M`.repeat(Math.abs(wheel.ticks!)));
        return;
      }

      if (parsed && typeof parsed === 'object' && (parsed as {type?:string}).type === 'scroll') {
        const action = (parsed as {action?:string}).action;
        terminalControl.action(controlKey, controlClient!, 'interact');
        const fence = terminalControl.fence(controlKey, controlClient!);
        const mayView = canViewHistory;
        if ((fence !== undefined || mayView()) && ['up','down','top','bottom'].includes(action ?? '')) {
          void scrollControlledSession({ name: session, action: action! }, () => mayView() || (terminalControl.accepts(controlKey, controlClient!, fence) && validAccess())).catch(() => {});
        }
        return;
      }
      if (parsed && typeof parsed === 'object' && (parsed as {type?:string}).type === 'control') {
        const message = parsed as { action?: string; target?: string };
        if (['interact','release','heartbeat', ...(agentApi.isAgent(session) && !scope ? ['takeover','acquire'] : [])].includes(message.action ?? '')) {
          terminalControl.action(controlKey, controlClient!, message.action as ControlAction, typeof message.target === 'string' ? message.target : undefined);
        }
        return;
      }
      if (!isClientMessage(parsed)) return;
      if (shareScope && parsed.type !== 'resize' && parsed.type !== 'ping') return;

      if (parsed.type === "resize") {
        if (!terminalControl.owns(controlKey, controlClient!)) return;
        // Same bounds as the query-string size: a client that asks for a
        // degenerate window would shrink it for every other client on the
        // session, destroying whatever is on the alternate screen.
        const next = {
          cols: parseDim(String(parsed.cols), 0, MAX_COLS),
          rows: parseDim(String(parsed.rows), 0, MAX_ROWS),
        };
        // Clients re-state their size on every reconnect, so most of these
        // messages ask for the size we already have: acting on those would
        // make tmux redraw, and mark this client the "latest" one, for nothing.
        if (next.cols && next.rows) {
          cols = next.cols;
          rows = next.rows;
          try {
            terminalControl.resize(controlKey, controlClient!, {cols, rows});
            proc.resize(cols, rows);
            const resizeFence = terminalControl.fence(controlKey, controlClient!);
            if (terminalControl.accepts(controlKey, controlClient!, resizeFence)) execFile(TMUX, ['resize-window', '-t', `=${session}:`, '-x', String(cols), '-y', String(rows)], {timeout:3000}, () => {});
            scheduleRepaint();
          } catch (err) {
            console.error("[ws] resize error:", err);
          }
        }
      } else if (parsed.type === "ping") {
        sendJson(ws, { type: "pong" });
      } else if (parsed.type === "restart") {
        const restartFence = terminalControl.fence(controlKey, controlClient!);
        if (restartFence === undefined) return;
        // Kill this session's tmux session. The attached pty (tmux client)
        // then exits, the ws closes, and the client reconnects into a fresh
        // session via `new-session -A`.
        //
        // Same kill, same insurance as closing a tab: restarting one session is
        // not meant to cost the other twelve, which is what it does on the day
        // this command takes the server with it.
        void snapshotBeforeKill(session).then(() => {
          if (!terminalControl.accepts(controlKey, controlClient!, restartFence)) return;
          execFile(TMUX, ["kill-session", "-t", session], (err) => {
            if (err) {
              console.error(
                `[ws] restart: kill-session "${session}" failed:`,
                err.message
              );
              sendJson(ws, { type: "info", message: "Restart failed." });
            }
          });
        });
      } else if (parsed.type === "debug") {
        console.error(
          `[ime-debug] session=${session} event=${parsed.event} ` +
            `data=${JSON.stringify(parsed.data ?? "")} at=${parsed.at ?? ""}`
        );
      }
    } catch (err) {
      console.error("[ws] message handler error:", err);
    }
  });

  // Heartbeat bookkeeping (protocol-level pong).
  ws.on("pong", () => {
    ws.isAlive = true;
    terminalControl.action(controlKey, controlClient!, 'heartbeat');
  });

  ws.on("error", (err) => {
    console.error(`[ws] socket error (session "${session}"):`, err);
  });

  ws.on("close", () => {
    onData.dispose();
    onExit.dispose();
    removeSessionClient(session, ws);
    cleanup();
    console.log(`[ws] disconnected from "${session}" (tmux session persists)`);
  });
}

wss.on("error", (err) => {
  console.error("[wss] server error:", err);
});

// Upgrade only on the /ws path; reject everything else.
server.on("upgrade", (req, socket, head) => {
  void shares.upgrade(req, socket, head, () => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  }).then(handled => { if (!handled) upgradeAdmin(req, socket, head); }).catch(() => socket.destroy());
});
function upgradeAdmin(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }

  const viaRemote = remoteRoute(pathname);
  if (pathname !== "/ws" && viaRemote?.rest !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  // The terminal stream is the sensitive part: reject the upgrade unless the
  // request carries the auth cookie (the browser sends it automatically once
  // signed in). This applies to direct LAN access too.
  if (!validOrigin(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!isAuthed(req, config.authToken)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  if (viaRemote) {
    void remotes.get(viaRemote.id).then((remote) => {
      if (!remote) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      let search = "";
      try { search = new URL(req.url ?? "/", "http://localhost").search; } catch { /* checked above */ }
      proxyUpgrade(req, socket, head, remote, viaRemote.rest, search, remoteMonitor);
    });
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const id = browserId(req);
    if (id) socketBrowsers.set(ws, id);
    wss.emit("connection", ws, req);
  });
}

// Heartbeat: terminate sockets that stopped responding to pings.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as LiveSocket;
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

// Safety net for pty-fd leaks we can't fix from JS: a failed pty.spawn() can
// orphan a master fd in node-pty's native layer (the throw leaves us no handle
// to close), and we can't rule out other node-pty leaks. The destroy() in
// cleanup() fixes the known disconnect leak, but ANY residual leak must never be
// allowed to creep up to macOS's ~511 system-wide pty cap and lock SSH out
// again (the 2026-06-13 incident). Periodically count THIS process's open pty
// masters (character-device fds) via /dev/fd; if they exceed a ceiling far below
// the system limit but well above maxPtys, log loudly and exit so launchd
// (KeepAlive) restarts us cleanly. The tmux sessions live in a separate server
// process and survive, so clients just reconnect into them.
//
// node-pty 1.2 holds ~2 character-device fds per LIVE pty (the /dev/ptmx master
// plus the slave /dev/ttysN); older builds held more. The ceiling stays at
// 4 * maxPtys (+ a little for stdio) — comfortably above the real footprint at
// capacity, yet still hundreds of fds short of the ~511 system cap, so it trips
// only on a genuine leak.
const PTY_FD_CEILING = config.maxPtys * 4 + 16;

function countOwnPtyFds(): number {
  let fds: string[];
  try {
    fds = fs.readdirSync("/dev/fd");
  } catch {
    return 0; // not introspectable here (non-macOS / sandbox) — skip the check
  }
  let n = 0;
  for (const entry of fds) {
    const fd = Number(entry);
    if (!Number.isInteger(fd)) continue;
    try {
      if (fs.fstatSync(fd).isCharacterDevice()) n++;
    } catch {
      /* fd vanished or not stat-able (kqueue, listening socket) — ignore */
    }
  }
  return n;
}

const ptyLeakWatchdog = setInterval(() => {
  const ptyFds = countOwnPtyFds();
  if (ptyFds > PTY_FD_CEILING) {
    console.error(
      `[watchdog] open pty fds (${ptyFds}) exceeded ceiling ${PTY_FD_CEILING} ` +
        `(live ptys ${livePtys.size}/${config.maxPtys}) — a pty fd leak is ` +
        "filling the system pty table; exiting so launchd restarts cleanly " +
        "(tmux sessions persist)."
    );
    process.exit(1);
  }
}, HEARTBEAT_MS);
ptyLeakWatchdog.unref();

// ---------------------------------------------------------------------------
// Session snapshots.
//
// tmux/web.tmux.conf loads tmux-resurrect and tmux-continuum so a snapshot is
// taken every 15 minutes and a dead tmux server costs nothing. That has never
// actually happened: continuum drives its save off the status line being
// redrawn, and this config hides the status line (`set -g status off`) for an
// edge-to-edge terminal, so the hook it installs is never evaluated. Both
// plugins were installed, enabled, and silently doing nothing — when a tmux
// server died on the NUC the newest snapshot turned out to be ten weeks old,
// which made the loss total.
//
// So the save runs from here, where it depends on nothing being drawn. This
// service is already running on every machine that has the sessions.
// ---------------------------------------------------------------------------
const SNAPSHOT_MS = 5 * 60_000;
// The first one is early: a machine that has just come up should have a recent
// snapshot without waiting out a full interval.
const FIRST_SNAPSHOT_MS = 90_000;
const RESURRECT_DIR = path.join(os.homedir(), ".local/share/tmux/resurrect");
const RESURRECT_SAVE = path.join(
  os.homedir(),
  ".tmux/plugins/tmux-resurrect/scripts/save.sh"
);

/**
 * Count the pane lines in the snapshot resurrect just wrote, so the log can
 * say what was really saved rather than that the script exited 0.
 *
 * The first version of this saved a 20-byte file holding "state_terminal-web_"
 * and nothing else, and reported success. resurrect's format is tab-separated,
 * and tmux rewrites control characters in -F output to "_" unless the locale
 * is UTF-8 — which the bare environment a service gets is not. Every field
 * merged into one, every pane was dropped, and the `last` symlink moved to
 * point at the result. Hence the UTF-8 environment below, and this check: a
 * snapshot nobody has verified is how we got here.
 */
async function readSnapshot(): Promise<{ panes: number; sessions: number; ageMs: number } | null> {
  const file = path.join(RESURRECT_DIR, "last");
  try {
    const [text, stat] = await Promise.all([
      fsp.readFile(file, "utf8"),
      fsp.stat(file),
    ]);
    const lines = text.split("\n").filter((line) => line.startsWith("pane\t"));
    const sessions = new Set(lines.map((line) => line.split("\t")[1]));
    return { panes: lines.length, sessions: sessions.size, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

// A snapshot taken right after a disaster overwrites the one taken before it,
// and `last` is what continuum restores from on the next boot. So a sudden
// collapse in the number of sessions is treated as "something just went very
// wrong" and the save is skipped, loudly, rather than writing over the only
// record of what was there. Bounded in time: once the smaller set has been the
// truth for this long, it IS the truth and snapshots resume.
const COLLAPSE_GRACE_MS = 2 * 60 * 60_000;

/**
 * How long to wait for a save before going ahead without it. The snapshot is
 * insurance, not a gate: whatever the user asked for still has to happen.
 */
const SNAPSHOT_TIMEOUT_MS = 10_000;

async function snapshotSessions(reason = "interval"): Promise<void> {
  try {
    await fsp.access(RESURRECT_SAVE, fs.constants.X_OK);
  } catch {
    return; // resurrect isn't installed here — nothing to do
  }
  // Never snapshot an empty tmux: that would overwrite the last good one with
  // nothing, which is exactly the moment a snapshot is worth having.
  const names = await listTmuxSessions();
  if (!names || names.length === 0) return;
  const previous = await readSnapshot();
  if (
    previous &&
    previous.ageMs < COLLAPSE_GRACE_MS &&
    previous.sessions >= 2 &&
    names.length * 2 <= previous.sessions
  ) {
    console.error(
      `[snapshot] NOT saving: ${names.length} session(s) live but the last ` +
        `snapshot holds ${previous.sessions} — keeping it rather than writing ` +
        "over the only record of what was there. Restore from " +
        `${RESURRECT_DIR} if this was not deliberate.`
    );
    return;
  }
  // buildChildEnv for the locale: resurrect's format is tab-separated and tmux
  // only emits real tabs under a UTF-8 locale (see readSnapshot).
  //
  // Awaited, rather than left to finish on its own, because a caller about to
  // kill a session needs the save to have happened BEFORE it does — see
  // snapshotBeforeKill.
  const saved = await new Promise<boolean>((resolve) => {
    execFile(
      RESURRECT_SAVE,
      ["quiet"],
      { env: buildChildEnv(), timeout: SNAPSHOT_TIMEOUT_MS },
      (err) => {
        if (err) {
          console.error(`[snapshot] resurrect save failed (${reason}):`, err.message);
          resolve(false);
          return;
        }
        resolve(true);
      }
    );
  });
  if (!saved) return;
  const snap = await readSnapshot();
  const panes = snap?.panes ?? null;
  if (panes === null) {
    console.error("[snapshot] saved, but the snapshot could not be read back");
  } else if (panes === 0) {
    console.error(
      `[snapshot] SAVED NOTHING: ${names.length} session(s) live but the ` +
        "snapshot holds no panes — it cannot be restored from"
    );
  } else {
    console.log(
      `[snapshot] saved ${panes} pane(s) across ${names.length} session(s) (${reason})`
    );
  }
}

/**
 * Save before killing anything, and wait for it.
 *
 * `tmux kill-session` is the one command here that has been observed to take a
 * whole tmux server with it: on the NUC (tmux 3.4) every server death in a
 * fortnight — four of them — landed within a second of one, each time with the
 * kill itself reporting "server exited unexpectedly", and each time every other
 * session went with it. Reproducing it on a scratch server never worked, so
 * what is treated here is the damage rather than the cause: a snapshot taken
 * in the moment before means a death costs seconds instead of the up-to-five
 * minutes back to the last interval save, whatever it turns out to be.
 *
 * Never fatal, and bounded by SNAPSHOT_TIMEOUT_MS: the kill the user asked for
 * happens either way.
 */
async function snapshotBeforeKill(name: string): Promise<void> {
  try {
    await snapshotSessions(`before killing "${name}"`);
  } catch (err) {
    console.error("[snapshot] pre-kill save threw:", err);
  }
}

setTimeout(() => void snapshotSessions(), FIRST_SNAPSHOT_MS).unref();
const snapshotTimer = setInterval(() => void snapshotSessions(), SNAPSHOT_MS);
snapshotTimer.unref();

// ---------------------------------------------------------------------------
// Startup & graceful shutdown
// ---------------------------------------------------------------------------

function logStartup(): void {
  const port = config.port;
  // Addresses only: a token in a link ends up in history and logs. Open one,
  // and paste the token printed above it into the login page.
  const accessUrl = (host: string): string =>
    `${tlsCert ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${port}/`;
  const allInterfaces = config.host === "0.0.0.0" || config.host === "::";

  console.log("");
  console.log("  terminal-web is running.");
  console.log(`  Listening: ${config.host}:${port}`);
  console.log(process.env.AUTH_TOKEN ? "  Token: configured through AUTH_TOKEN" : `  Token file: ${config.authTokenFile}`);
  if (tlsCert) console.log(`  TLS SHA256: ${new crypto.X509Certificate(fs.readFileSync(tlsCert)).fingerprint256.replaceAll(":", "")}`);
  console.log("  访问地址（打开后在登录页输入配置的 Token）：");
  if (allInterfaces || config.host === "127.0.0.1" || config.host === "localhost") {
    console.log(`  Local: ${accessUrl("127.0.0.1")}`);
  }

  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.add(entry.address);
    }
  }
  for (const address of addresses) {
    const note = allInterfaces || config.host === address ? "" : "  （当前未监听此地址）";
    console.log(`  LAN: ${accessUrl(address)}${note}`);
  }
  if (!allInterfaces && !addresses.has(config.host) && config.host !== "127.0.0.1" && config.host !== "localhost") {
    console.log(`  Host: ${accessUrl(config.host)}`);
  }
  if (!allInterfaces && addresses.size > 1) {
    console.log("  如需通过所有局域网地址访问，请设置 HOST=0.0.0.0。");
  }

  if (!ensureTmuxAvailable()) {
    console.warn(IS_PSMUX
      ? "  WARNING: psmux (tmux.exe) was not found. Sessions will fail to start. Put psmux in this project's .psmux\\ folder (see docs/部署与使用指南.md, section 10.2), or set TMUX_BIN."
      : "  WARNING: tmux was not found on PATH. Sessions will fail to start. Install tmux (e.g. `brew install tmux`).");
  } else if (IS_PSMUX) {
    console.log(`  psmux: ${TMUX}`);
  }
  console.log(`  Authentication: required for all access. Token file: ${config.authTokenFile}`);
  console.log(`  Default session: "${config.defaultSession}"  (override with ?session=NAME)`);
  console.log(`  Max concurrent terminals: ${config.maxPtys}  (set MAX_PTYS to change)`);
  console.log("");
}

server.listen(config.port, config.host, () => {
  logStartup();
  void pruneUploads(); // tidy old uploads on boot
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRNOTAVAIL") {
    // launchd starts us at boot before tailscaled has configured the tailnet IP
    // we bind to, so the first bind fails with EADDRNOTAVAIL. Wait and retry the
    // same bind instead of exiting — exiting made launchd crash-loop us dozens
    // of times until Tailscale finally came up. The original `listen` callback
    // (registered via once('listening')) still fires on the eventual success.
    console.warn(
      `[server] cannot bind to ${config.host}:${config.port} yet ` +
        "(address not available — waiting for Tailscale/interface). Retrying in 3s…"
    );
    setTimeout(() => server.listen(config.port, config.host), 3000);
    return;
  }
  if (err.code === "EADDRINUSE") {
    console.error(
      `[server] port ${config.port} on ${config.host} is already in use. ` +
        "Set PORT to a free port or stop the other process."
    );
  } else {
    console.error("[server] error:", err);
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] received ${signal}, shutting down...`);

  clearInterval(heartbeat);
  remoteMonitor.stop();

  // Close all websockets (detaches their tmux clients; sessions persist).
  for (const client of wss.clients) {
    try {
      client.close(1001, "server shutting down");
    } catch {
      /* ignore */
    }
  }

  wss.close(() => {
    server.close(() => {
      console.log("[server] closed. Goodbye.");
      process.exit(0);
    });
  });

  // Force exit if something hangs.
  setTimeout(() => {
    console.warn("[server] forced exit after timeout.");
    process.exit(0);
  }, 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Last-resort guards so one stray error never kills the whole server.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
});

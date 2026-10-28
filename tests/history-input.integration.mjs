// Real PTY regression: isolated service and disposable session, including psmux.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const windows = process.platform === 'win32';
const mux = process.env.TMUX_BIN || (windows ? path.resolve('.psmux/tmux.exe') : 'tmux');
const name = `input_verify_${process.pid}`;
const target = `=${name}:`;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-input-'));
const token = randomBytes(24).toString('hex');
const listener = net.createServer().listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const env = {...process.env, HOST:'127.0.0.1', PORT:String(port), AUTH_TOKEN:token,
  TMUX_BIN:mux, AGENT_STATUS_MODE:'hooks', DEFAULT_SESSION:name};
delete env.TLS_CERT_FILE; delete env.TLS_KEY_FILE;
for (const key of ['SESSIONS_FILE','SHARES_FILE','REMOTES_FILE','PREFS_FILE','AGENT_STATUS_FILE',
  'VIEWER_STATE_FILE','PROJECTS_FILE','QUICK_COMMANDS_FILE','CLOSED_SESSIONS_FILE','AGENT_SESSIONS_FILE','AUTH_TOKEN_FILE']) {
  env[key] = path.join(dir, key + '.json');
}
const service = spawn(process.execPath, ['--import','tsx','src/server.ts'], {env, stdio:['ignore','pipe','pipe']});
let log = '', ws;
service.stdout.on('data', data => log += data);
service.stderr.on('data', data => log += data);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  for (let i=0;i<100;i++) {
    try { if (await check()) return; } catch {}
    await sleep(100);
  }
  let lastScreen = '';
  try { lastScreen = screen(); } catch {}
  throw Error(description + '\n' + lastScreen + '\n' + log);
}
const tmux = (...args) => execFileSync(mux, args, {encoding:'utf8', timeout:3000, stdio:['ignore','pipe','pipe']}).trim();
const mode = () => tmux('display-message','-p','-t',target,'#{pane_mode}');
const screen = () => tmux('capture-pane','-p','-t',target);
const send = input => ws.send(Buffer.from(input));
try {
  await until(() => log.includes('Listening:'), 'server started');
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${name}&create=1&cols=100&rows=24`, {
    headers:{Cookie:`tw_auth=${token}`},
  });
  ws.on('message', () => {});
  await once(ws,'open');
  await until(() => screen().length > 0, 'shell ready');
  await sleep(500);
  send(windows ? "1..100 | ForEach-Object { Write-Output ('history-' + $_) }\r" : "for i in $(seq 1 100); do echo history-$i; done\r");
  await until(() => screen().includes('history-100'), 'history created');
  // Exercise cached typing followed immediately by a control key and scrolling.
  for (const char of 'echo hello') { send(char); await sleep(30); }
  send('\x03');
  await sleep(300); // let the shell consume Ctrl-C before browsing its history
  ws.send(JSON.stringify({type:'scroll', action:'up'}));
  await until(() => mode() === 'copy-mode', 'paging enters history');
  const command = windows ? "Write-Output ('INPUT_' + 'ORDER_OK')" : "printf 'INPUT_%s\\n' 'ORDER_OK'";
  for (const char of command) { send(char); await sleep(30); }
  send('\r');
  await until(() => screen().includes('INPUT_ORDER_OK'), 'typing exits history and executes in order');
  assert.equal(mode(), '');
  console.log('PASS real PTY: continuous typing, Ctrl-C, paging, history exit and command order');
} finally {
  ws?.terminate();
  try { tmux('kill-session','-t',`=${name}`); } catch {}
  if (service.exitCode === null) { service.kill(); await once(service,'exit'); }
  // Keep diagnostics in the isolated temp directory; never touch user sessions.
  await fs.writeFile(path.join(dir,'server.log'), log);
}

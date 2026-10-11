// Run against the deployed local service with tmux on PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const authToken = process.env.AUTH_TOKEN || readFileSync(process.env.AUTH_TOKEN_FILE || path.join(os.homedir(), '.config/terminal-web/auth-token'), 'utf8').trim();
const authHeaders = { Cookie: `tw_auth=${encodeURIComponent(authToken)}` };

const name = `history_verify_${process.pid}`;
const target = `=${name}:`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' }).trim();
const state = format => tmux('display-message', '-p', '-t', target, format);
const mode = () => state('#{pane_mode}');
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(40);
  }
  throw new Error('timed out waiting for terminal state');
}
const ws = new WebSocket(`ws://192.168.88.119:8090/ws?session=${name}&cols=80&rows=24`, { headers: authHeaders });
let output = '';
ws.on('message', data => { output += data.toString(); });
await new Promise((resolve, reject) => {
  ws.once('open', resolve); ws.once('error', reject);
});
const send = text => ws.send(Buffer.from(text));
const wheel = direction => send(`\x1b[<${direction};10;10M`);
try {
  await delay(300);
  assert.equal(state('#{history_size}'), '0');
  wheel(64); await delay(200);
  assert.equal(mode(), '', 'no-history swipe must not enter copy-mode');
  const response = await fetch('http://192.168.88.119:8090/api/sessions/scroll', {
    method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, action: 'up' }),
  });
  assert.equal(response.status, 200);
  assert.equal(mode(), '', 'no-history page-up must not enter copy-mode');

  send("for i in {1..150}; do echo history-line-$i; done\r");
  await until(() => Number(state('#{history_size}')) > 50);
  wheel(64);
  await until(() => mode() === 'copy-mode');
  const originalPid = state('#{pane_pid}');
  send('\x1b[?1;2c'); await delay(100);
  assert.equal(mode(), 'copy-mode', 'terminal replies must not cancel browsing');
  send("printf '输入_%s\\n' '恢复成功'\r");
  await until(() => output.includes('输入_恢复成功'));
  assert.equal(mode(), '', 'typing must leave copy-mode');
  assert.equal(state('#{pane_pid}'), originalPid);

  wheel(64); await until(() => mode() === 'copy-mode');
  for (let i = 0; i < 50 && mode() === 'copy-mode'; i++) {
    wheel(65); await delay(40);
  }
  assert.equal(mode(), '', 'scrolling to bottom must leave copy-mode');

  wheel(64); await until(() => mode() === 'copy-mode');
  for (const char of "printf 'ORDER_%s\\n' 'OK'\r") send(char);
  await until(() => output.includes('ORDER_OK'));
  assert.equal(mode(), '', 'rapid keystrokes must execute in order');
  console.log('PASS: empty-history swipe/paging, reply isolation, Chinese input, bottom exit, rapid input order and preserved process');
} finally {
  ws.close(); await delay(100);
  tmux('kill-session', '-t', `=${name}`);
}

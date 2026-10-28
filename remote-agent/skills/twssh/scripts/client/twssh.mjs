#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { request } from './transport.mjs';

const args = process.argv.slice(2), options = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2); options[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  } else positional.push(args[i]);
}
const dir = process.env.TWSSH_HOME || path.join(os.homedir(), '.config', 'twssh');
const file = path.join(dir, 'config.json');
let config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { hosts: {}, sessions: {} };
function save() {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const tmp = file + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), {mode: 0o600}); fs.renameSync(tmp, file);
}
const output = data => process.stdout.write(JSON.stringify(data) + '\n');
async function main() {
  if (positional[0] === 'host' && positional[1] === 'add') {
    const alias = positional[2];
    if (!alias || typeof options.url !== 'string' || typeof options['token-file'] !== 'string') throw Error('host add NAME --url http://HOST:PORT --token-file FILE [--pin SHA256:HEX]');
    const host = { url: options.url, token: fs.readFileSync(options['token-file'], 'utf8').trim(), pin: options.pin };
    const info = await request(host, '/info'); config.hosts[alias] = host; save(); output(info); return;
  }
  const command = positional[0];
  const sessionCommand = command === 'session';
  const action = sessionCommand ? positional[1] : command;
  const alias = positional[sessionCommand ? 2 : 1];
  const host = config.hosts[alias]; if (!host) throw Error('Unknown host. Use host add NAME --url http://HOST:PORT --token-file FILE [--pin SHA256:HEX]');
  if (action === 'doctor') { output(await request(host, '/info')); return; }
  if (action === 'list') { output(await request(host, '/sessions')); return; }
  if (action === 'create') {
    const requestId = options['request-id'] || crypto.randomUUID();
    process.stderr.write(`requestId=${requestId}\n`);
    const data = await request(host, '/sessions', 'POST', { requestId, label: options.name || `${os.hostname()} · agent`, cwd: options.cwd });
    if (data.sessionId) { config.sessions[`${alias}/${data.sessionId}`] = {generation: data.generation, client: crypto.randomBytes(24).toString('hex'), cursor: 0}; save(); }
    output(data); return;
  }
  const id = options.session; if (typeof id !== 'string') throw Error('--session ID is required');
  const key = `${alias}/${id}`;
  if (!config.sessions[key]) {
    const info = await request(host, `/sessions/${id}`);
    config.sessions[key] = { generation: info.generation, client: crypto.randomBytes(24).toString('hex'), cursor: 0 }; save();
  }
  const state = config.sessions[key];
  const call = (suffix, method, data) => request(host, `/sessions/${id}${suffix}`, method, data, state.client);
  const control = async action => call('/control', 'POST', { generation: state.generation, action });
  const send = async text => {
    const owner = await control('acquire'); if (!owner.mine) throw Error('CONTROL_LOST: another operator owns the terminal');
    const requestId = options['request-id'] || crypto.randomUUID();
    // Save exact payload BEFORE sending; a caller can query it after an ambiguous failure.
    const body = { requestId, generation: state.generation, controlEpoch: owner.epoch, text, sensitive: !!options.sensitive };
    state.lastRequestId = requestId; save(); if (action !== 'attach') process.stderr.write(`requestId=${requestId}\n`);
    return call('/input', 'POST', body);
  };
  if (sessionCommand && action === 'rename') {
    if (typeof options.name !== 'string' || !options.name.trim()) throw Error('--name is required');
    output(await call('', 'PATCH', { generation: state.generation, label: options.name })); return;
  }
  if (action === 'status') { output(await call('', 'GET')); return; }
  if (action === 'result') { output(await call('/requests?id=' + encodeURIComponent(options['request-id'] || state.lastRequestId || ''), 'GET')); return; }
  if (action === 'read') {
    const cursor = options.after === undefined ? state.cursor : Number(options.after);
    const query = `?after=${cursor}&waitMs=${Math.min(5000, Number(options.wait || 0) * 1000)}${state.epoch ? '&epoch=' + state.epoch : ''}`;
    const data = await call('/events' + query, 'GET'); state.cursor = data.cursor; state.epoch = data.epoch; save(); output(data); return;
  }
  if (action === 'detach') { output(await control('release')); return; }
  if (action === 'close') {
    try { if (!(await control('acquire')).mine) throw Error('CONTROL_LOST'); }
    catch (error) { if (error.status !== 410) throw error; }
    output(await call('', 'DELETE', {generation: state.generation})); return;
  }
  if (action === 'attach') {
    if (!process.stdin.isTTY) throw Error('attach requires an interactive terminal; Agents should use exec/input/read');
    if (!(await control('acquire')).mine) throw Error('CONTROL_LOST');
    let stopped = false, queue = Promise.resolve(), failure;
    const onInput = bytes => {
      if (bytes.includes(0x1d)) { stopped = true; return; } // Ctrl+] detaches; Ctrl+C goes to Windows.
      queue = queue.then(() => send(bytes.toString('utf8'))).catch(e => {failure = e; stopped = true;});
    };
    process.stderr.write('Connected. Ctrl+] detaches and preserves the Shell.\n');
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onInput);
    try {
      while (!stopped) {
        const data = await call(`/events?after=${state.cursor}&waitMs=1000${state.epoch ? '&epoch=' + state.epoch : ''}`, 'GET');
        state.cursor = data.cursor; state.epoch = data.epoch; save();
        if (data.gap) process.stderr.write('\n[Output gap]\n');
        for (const event of data.events) if (event.type === 'output') process.stdout.write(event.data);
        if (!data.alive || !data.mine) { stopped = true; failure = Error('Terminal closed or control transferred'); }
      }
      await queue; if (failure) throw failure;
    } finally {
      process.stdin.off('data', onInput); process.stdin.setRawMode(false); process.stdin.pause();
      await control('release').catch(() => {});
    }
    return;
  }
  if (action === 'interrupt') { output(await send('\x03')); return; }
  if (action === 'exec') {
    const text = typeof options.file === 'string' ? fs.readFileSync(options.file, 'utf8') : options.command;
    if (typeof text !== 'string' || !text.trim()) throw Error('--command TEXT or --file FILE is required');
    // Raw mode intentionally claims only sent, never completion or idle detection.
    output(await send(text.replace(/\r?\n/g, '\r') + '\r')); return;
  }
  if (action === 'input') {
    if (typeof options.text !== 'string') throw Error('--text TEXT is required');
    output(await send(options.text + (options.enter ? '\r' : ''))); return;
  }
  throw Error('Commands: doctor, session create/list/rename/close, status, exec, input, interrupt, read, result, attach, detach');
}
main().catch(e => { process.stderr.write(String(e.message) + '\n'); process.exitCode = 1; });

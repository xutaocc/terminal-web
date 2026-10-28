import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentApi } from '../src/agent-api.js';
import { TerminalControl } from '../src/terminal-control.js';

test('browser closure preserves history, rejects busy/invalid names and unlocks after failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-close-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'sessions.json'), name = 'agent_' + 'a'.repeat(32);
  fs.writeFileSync(file, JSON.stringify({sessions:[{id:'a', name, label:'test', cwd:dir, generation:'g', requests:{r:{hash:'h',result:{input:'hello'}}}}]}));
  const control = new TerminalControl(); let fail = false, removals = 0;
  const api = new AgentApi({file, control, enabled:true, token:'test', spawn: async()=>{throw Error('must not spawn');}, prepareInput:async()=>{}, register:()=>{},
    remove:async (_name, cleanup) => { assert(control.isClosing(name)); if(fail) throw Error('unavailable'); assert.equal(cleanup, true); removals++; }});
  const c = control.join(name, {resume:'r',principal:'p',label:'owner',admin:false,valid:()=>true,send:()=>{}});
  control.action(name,c,'acquire');
  await assert.rejects(api.closeFromBrowser(name), /SESSION_BUSY/);
  await assert.rejects(api.closeFromBrowser('ordinary', true), /INVALID_AGENT_SESSION/);
  fail = true;
  await assert.rejects(api.closeFromBrowser(name, true, true), /unavailable/);
  assert.equal(control.isClosing(name), false);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).sessions[0].ended, undefined);
  fail = false;
  await api.closeFromBrowser(name, false, true);
  const saved = JSON.parse(fs.readFileSync(file,'utf8')).sessions[0];
  assert.equal(saved.ended,true); assert(saved.closedAt); assert.equal(saved.requests.r.result.input,'hello');
  assert(api.history(name)); assert.equal(removals,1);
  api.flushHistory();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentJournal } from '../src/agent-journal.js';
test('journal survives restart, paginates and explicitly marks bounded history gaps', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = new AgentJournal(dir);
  journal.append('test', 'output', 'hello'); journal.flush();
  const restored = new AgentJournal(dir);
  assert.equal(restored.read('test', 0, 1).events[0].data, 'hello');
  for (let i = 0; i < 70; i++) restored.append('test', 'output', 'a'.repeat(8192));
  const page = restored.read('test', 0, 2);
  assert.equal(page.truncated, true); assert.equal(page.gap, true); assert.equal(page.hasMore, true);
  assert.equal(restored.read('test', page.nextCursor, 2).events[0].seq, page.nextCursor + 1);
  assert.equal(restored.read('test', 99999, 2).gap, true);
});

test('purged journal cannot be recreated by delayed output or flush timers', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purged-journal-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const journal=new AgentJournal(dir);
  journal.append('closed','output','before close');
  journal.flush(); assert(journal.bytes('closed')>0);
  journal.append('closed','output','pending');
  journal.remove('closed');
  journal.append('closed','output','late callback');
  journal.flush();
  assert.equal(journal.bytes('closed'),0);
  assert.equal(journal.read('closed',0,50).events.length,0);
  assert(!fs.existsSync(path.join(dir,'closed.json')));
  journal.append('active','output','keep'); journal.flush();
  assert(journal.bytes('active')>0);
});

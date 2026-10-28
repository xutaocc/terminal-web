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

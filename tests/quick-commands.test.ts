import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QuickCommandStore, validQuickCommands } from '../src/quick-commands.js';

const commands = [
  { id: 'git', label: '查看状态', text: 'git status' },
  { id: 'logs', label: '查看日志', text: "printf '中文\\n'\ngit log -5" },
];
test('validate command limits and reject duplicate IDs and missing fields', () => {
  assert.ok(validQuickCommands(commands));
  for (const bad of [null, [{ id: 'a', label: '', text: 'ls' }],
    [commands[0], commands[0]], [{ ...commands[0], text: 'a'.repeat(4001) }],
    [{ ...commands[0], label: 'a\nb' }], Array(51).fill(commands[0])]) {
    assert.equal(validQuickCommands(bad), false);
  }
});
test('commands and drag order survive reload, stale revisions cannot overwrite them', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'quick-command-test-'));
  const file = path.join(folder, 'commands.json');
  try {
    const store = new QuickCommandStore(file);
    assert.deepEqual(await store.get(), { revision: '', commands: [] });
    const saved = await store.save('', commands);
    assert.ok(saved);
    assert.deepEqual(await new QuickCommandStore(file).get(), saved);
    assert.equal(await store.save('', []), null);
    const sorted = await store.save(saved.revision, [...commands].reverse());
    assert.ok(sorted);
    assert.deepEqual((await store.get()).commands, [...commands].reverse());
    const [first, second] = await Promise.all([
      store.save(sorted.revision, [commands[0]]), store.save(sorted.revision, []),
    ]);
    assert.ok(first);
    assert.equal(second, null, 'concurrent stale writes cannot erase a newer save');
    const empty = await store.save(first.revision, []);
    assert.ok(empty);
    assert.deepEqual((await store.get()).commands, []);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

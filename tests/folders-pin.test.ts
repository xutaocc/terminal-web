import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { FolderStore } from '../src/projects.js';

test('pins are kept most recent first, unpinned on request, and pruned with their sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-pin-'));
  const store = new FolderStore(path.join(dir, 'folders.json'), async () => new Map());
  await store.pin(['a'], true);
  let { data } = await store.pin(['b'], true);
  assert.deepEqual(data.pinned, ['b', 'a']);
  ({ data } = await store.pin(['a'], true));
  assert.deepEqual(data.pinned, ['a', 'b']);
  ({ data } = await store.pin(['b'], false));
  assert.deepEqual(data.pinned, ['a']);
  ({ data } = await store.prune(new Set(['x'])));
  assert.deepEqual(data.pinned, []);
  await fs.rm(dir, { recursive: true });
});

test('a folders file written before pinning still loads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-pin-'));
  const file = path.join(dir, 'folders.json');
  await fs.writeFile(file, JSON.stringify({ folders: [], members: {}, dirNames: {} }));
  const data = await new FolderStore(file, async () => new Map()).get();
  assert.equal(data.pinned, undefined);
  await fs.rm(dir, { recursive: true });
});

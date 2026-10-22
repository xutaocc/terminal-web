import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ShareStore, activeShare, digest } from '../src/share-store.js';
import { sharePath } from '../src/shares.js';
import { ShareInputGuard } from '../src/share-input.js';
import { SessionStore } from '../src/session-store.js';

test('share tokens rotate and revocation survives restart without plaintext tokens', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-store-'));
  try {
    const file = path.join(dir, 'shares.json'); const store = new ShareStore(file);
    const { share, token } = store.create('联调', [], null);
    assert.equal(share.tokenHash, digest(token)); assert(activeShare(share));
    assert(!(await fs.readFile(file, 'utf8')).includes(token));
    const changed = store.update(share.id, {}, true); assert.notEqual(changed.share.tokenHash, share.tokenHash); assert.equal(changed.share.revision, 2);
    store.update(share.id, { revokedAt: Date.now() });
    assert(!activeShare(new ShareStore(file).get(share.id)!));
    assert(!activeShare({ ...share, expiresAt: Date.now() - 1 }));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('session identity survives rename/restart but changes after deletion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-identity-'));
  try {
    const file = path.join(dir, 'sessions.json'); const store = new SessionStore(file);
    store.update({ name: 'one', displayName: 'One' }); const id = store.get('one')!.identity;
    store.update({ name: 'one', displayName: 'Two' }); assert.equal(store.get('one')!.identity, id);
    assert.equal(new SessionStore(file).get('one')!.identity, id);
    store.remove('one'); store.update({ name: 'one', displayName: 'One' }); assert.notEqual(store.get('one')!.identity, id);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('file root rejects parent, prefix sibling and external symlink paths', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'share-path-')));
  try {
    const root = path.join(dir, 'project'); await fs.mkdir(root); await fs.mkdir(path.join(dir, 'project-other'));
    await fs.writeFile(path.join(root, 'ok.txt'), 'yes');
    assert.equal(await sharePath(root, 'ok.txt'), path.join(root, 'ok.txt'));
    for (const input of ['..', '../project-other', '/etc/passwd', 'C:\\Windows', '..\\outside']) await assert.rejects(sharePath(root, input));
    try { await fs.symlink(path.join(dir, 'project-other'), path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (e) { t.diagnostic(`symlink unavailable: ${e}`); return; }
    await assert.rejects(sharePath(root, 'escape'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('ordinary cd outside root is blocked but Claude input is unchanged', async () => {
  const root = path.resolve(os.tmpdir(), 'project'); let cwd = root; let command = 'bash'; let warnings = 0;
  const guard = new ShareInputGuard(root, async () => ({ cwd, command }), () => warnings++);
  assert.equal(await guard.filter('cd '), 'cd '); assert.equal(await guard.filter('..\r'), '..\x03'); assert.equal(warnings, 1);
  cwd = path.join(root, 'child'); assert.equal(await guard.filter('cd ..\r'), 'cd ..\r');
  command = 'claude'; cwd = root; assert.equal(await guard.filter('cd ..\r'), 'cd ..\r');
  command = 'node'; assert.equal(await guard.filter('cd /\r'), 'cd /\r');
});

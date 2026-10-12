import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionDirectory } from '../src/tmux.js';

test('startup directory accepts Unicode/spaces and uses home for invalid input', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'startup-dir-'));
  try {
    const directory = path.join(temp, '中文 project trailing ');
    await mkdir(directory);
    const file = path.join(temp, 'regular-file');
    await writeFile(file, 'test');
    assert.equal(await resolveSessionDirectory(directory), directory);
    for (const invalid of ['', 'relative/path', path.join(temp, 'missing'), file, '/bad\0path']) {
      assert.equal(await resolveSessionDirectory(invalid), os.homedir());
    }
    assert.equal(await resolveSessionDirectory('~'), os.homedir());
  } finally { await rm(temp, { recursive: true, force: true }); }
});

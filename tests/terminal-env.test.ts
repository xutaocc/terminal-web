import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalEnvironment } from '../src/terminal-env.js';

test('web terminal drops launcher NO_COLOR without changing parent environment', () => {
  const source = { NO_COLOR: '1', TERM: 'dumb', PATH: '/bin', LANG: 'zh_CN.UTF-8' };
  const env = terminalEnvironment(source);
  assert.equal(env.NO_COLOR, undefined);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.PATH, source.PATH);
  assert.equal(env.LANG, source.LANG);
  assert.equal(source.NO_COLOR, '1');
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tmuxColorArgs, TERMINAL_COLORS_ENABLED } from '../src/terminal-env.js';

test('disabled policy removes inherited force-color flags', () => {
  assert.equal(TERMINAL_COLORS_ENABLED, true);
  const env = terminalEnvironment({ FORCE_COLOR: '3', CLICOLOR_FORCE: '1', COLORTERM: 'truecolor' }, false);
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.CLICOLOR, '0');
  assert.equal(env.COLORTERM, undefined);
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.CLICOLOR_FORCE, undefined);
});

test('new tmux shells follow policy changes even when the server already exists', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-color-'));
  const socket = `tw-color-${process.pid}-${Date.now()}`;
  const tmux = (args: string[]) => execFileSync('tmux', ['-L', socket, ...args], {
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '3' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (const [i, enabled] of [true, false, true].entries()) {
      const file = path.join(dir, `result-${i}`);
      const quoted = "'" + file.replace(/'/g, "'\\''") + "'";
      tmux(['-f', '/dev/null', ...tmuxColorArgs(enabled), 'new-session', '-d', '-s', `check${i}`,
        `/bin/sh -c 'printf "%s|%s|%s" "\${NO_COLOR-unset}" "\${CLICOLOR-unset}" "\${FORCE_COLOR-unset}"' > ${quoted}; sleep 30`]);
      let value = '';
      for (let retry = 0; retry < 50; retry++) {
        try { value = readFileSync(file, 'utf8'); } catch { /* shell starting */ }
        if (value) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(value, enabled ? 'unset|1|unset' : '1|0|unset');
    }
  } finally {
    try { tmux(['kill-server']); } catch { /* test startup may fail */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

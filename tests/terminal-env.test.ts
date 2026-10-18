import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalEnvironment, configureColorPolicy, getTerminalColors, setTerminalColors, TERMINAL_COLORS_ENABLED } from '../src/terminal-env.js';

test('web terminal drops launcher NO_COLOR without changing parent environment', () => {
  const source = { NO_COLOR: '1', TERM: 'dumb', PATH: '/bin', LANG: 'zh_CN.UTF-8' };
  const env = terminalEnvironment(source, true);
  assert.equal(env.NO_COLOR, undefined);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.PATH, source.PATH);
  assert.equal(env.LANG, source.LANG);
  assert.equal(source.NO_COLOR, '1');
});

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tmuxColorArgs } from '../src/terminal-env.js';

test('saved color policy survives reload and controls both child and tmux environments', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-color-policy-'));
  const file = path.join(dir, 'colors.json');
  try {
    configureColorPolicy(file);
    assert.equal(getTerminalColors(), TERMINAL_COLORS_ENABLED);
    setTerminalColors(false);
    configureColorPolicy(file);
    assert.equal(getTerminalColors(), false);
    assert.equal(terminalEnvironment({}).NO_COLOR, '1');
    assert.ok(tmuxColorArgs().join(' ').includes('-g NO_COLOR 1'));
    setTerminalColors(true);
    configureColorPolicy(file);
    assert.equal(terminalEnvironment({ NO_COLOR: '1' }).NO_COLOR, undefined);
    assert.ok(tmuxColorArgs().join(' ').includes('-gu NO_COLOR'));
  } finally {
    configureColorPolicy(path.join(dir, 'missing.json'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disabled policy removes inherited force-color flags', () => {
  const env = terminalEnvironment({ FORCE_COLOR: '3', CLICOLOR_FORCE: '1', COLORTERM: 'truecolor' }, false);
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.CLICOLOR, '0');
  assert.equal(env.COLORTERM, undefined);
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.CLICOLOR_FORCE, undefined);
});

test('new tmux shells follow policy changes even when the server already exists', async (t) => {
  // tmux's -L socket, -f /dev/null and the sh one-liner are Unix's. On Windows
  // (psmux) there is one server per session, so a new session simply inherits
  // the spawn's environment — the psmux test below covers that.
  if (process.platform === 'win32') { t.skip('Unix tmux only'); return; }
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

test('new psmux sessions (Windows) get the colour policy from their spawn environment', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows (psmux) only'); return; }
  const bin = process.env.TMUX_BIN || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '.psmux', 'tmux.exe');
  if (!existsSync(bin)) { t.skip('psmux not found in .psmux\\ (or set TMUX_BIN)'); return; }
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-color-'));
  const names: string[] = [];
  try {
    for (const [i, enabled] of [true, false, true].entries()) {
      const file = path.join(dir, `result-${i}.txt`);
      const script = path.join(dir, `probe-${i}.cjs`);
      writeFileSync(script, `const e = process.env; require('fs').writeFileSync(${JSON.stringify(file)}, ` +
        `[e.NO_COLOR, e.CLICOLOR, e.FORCE_COLOR].map(v => v ?? 'unset').join('|')); setTimeout(() => {}, 30000);`);
      const name = `twcolor${process.pid}x${i}`;
      names.push(name);
      // As the server spawns a session: the environment it builds, then the pane's program.
      execFileSync(bin, ['new-session', '-d', '-s', name, '--', process.execPath, script], {
        env: { ...terminalEnvironment({ ...process.env, NO_COLOR: '1', FORCE_COLOR: '3' }, enabled), PSMUX_NO_WARM: '1' } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let value = '';
      for (let retry = 0; retry < 100; retry++) {
        try { value = readFileSync(file, 'utf8'); } catch { /* starting */ }
        if (value) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(value, enabled ? 'unset|1|unset' : '1|0|unset');
    }
  } finally {
    for (const name of names) try { execFileSync(bin, ['kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error -- plain ESM file copied verbatim by install-agent-hooks.mjs
import { computeState, parseEnvText, transitionEvent } from '../scripts/opencode-status/tui.js';

test('opencode hook env parses the installer format', () => {
  const env = parseEnvText([
    '# Written by scripts/install-agent-hooks.mjs',
    "TERMINAL_WEB_URL='http://127.0.0.1:8090'",
    'TERMINAL_WEB_TOKEN_FILE="/tmp/token"',
    'PLAIN=value',
    '',
  ].join('\n'));
  assert.deepEqual(env, {
    TERMINAL_WEB_URL: 'http://127.0.0.1:8090',
    TERMINAL_WEB_TOKEN_FILE: '/tmp/token',
    PLAIN: 'value',
  });
});

test('opencode state follows the running flag and settles permission prompts', () => {
  assert.equal(computeState({ running: false, blocked: false }), 'idle');
  assert.equal(computeState({ running: true, blocked: false }), 'working');
  // A permission that is answered by a saved rule comes and goes at once.
  assert.equal(computeState({ running: true, blocked: true, blockedMs: 0 }), 'working');
  assert.equal(computeState({ running: true, blocked: true, blockedMs: 499 }), 'working');
  assert.equal(computeState({ running: true, blocked: true, blockedMs: 500 }), 'waiting');
  // Nothing trustworthy while a prompt for an already-finished turn settles.
  assert.equal(computeState({ running: false, blocked: true, blockedMs: 0 }), null);
});

test('opencode transitions post the same events as the other agents', () => {
  assert.equal(transitionEvent(null, 'working'), 'UserPromptSubmit');
  assert.equal(transitionEvent('working', 'waiting'), 'PermissionRequest');
  assert.equal(transitionEvent('waiting', 'working'), 'UserPromptSubmit');
  assert.equal(transitionEvent('working', 'idle'), 'Stop');
  assert.equal(transitionEvent('waiting', 'idle'), 'Stop');
  // Idle at load must not wipe a "done" the pane already shows.
  assert.equal(transitionEvent(null, 'idle'), null);
  assert.equal(transitionEvent('idle', 'idle'), null);
  assert.equal(transitionEvent(null, null), null);
});

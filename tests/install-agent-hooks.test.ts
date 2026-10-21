import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error -- installer is a plain ESM script
import { removeOwnHooks, qwenCheckRequired } from '../scripts/install-agent-hooks.mjs';

test('refresh/uninstall preserves foreign hooks inside a mixed group', () => {
  for (const command of [
    '/bin/sh /home/user/.terminal-web/agent-hook.sh qwen Stop',
    '"C:/Program Files/nodejs/node.exe" "C:/Users/user/.terminal-web/agent-hook.mjs" qwen Stop',
    '"C:\\Users\\user\\.terminal-web\\agent-hook.mjs" qwen Stop',
  ]) {
    const foreign = { type: 'command', command: 'echo external', timeout: 9 };
    const mixed = { matcher: '*', custom: true, hooks: [{ type: 'command', command }, foreign] };
    const separate = { matcher: 'Read', hooks: [foreign] };
    const own = { hooks: [{ type: 'command', command }] };
    const groups = [mixed, separate, own];
    const snapshot = structuredClone(groups);
    assert.deepEqual(removeOwnHooks(groups), [
      { matcher: '*', custom: true, hooks: [foreign] }, separate,
    ]);
    assert.deepEqual(groups, snapshot, 'cleanup must not mutate the input');
    assert.deepEqual(removeOwnHooks(removeOwnHooks(groups)), removeOwnHooks(groups));
  }
});

test('default check skips absent qwen but explicit qwen checks still require installation', () => {
  assert.equal(qwenCheckRequired(undefined, false), false);
  assert.equal(qwenCheckRequired(undefined, true), true);
  assert.equal(qwenCheckRequired('qwen', false), true);
  assert.equal(qwenCheckRequired('qwen', true), true);
  assert.equal(qwenCheckRequired('opencode', true), false);
});

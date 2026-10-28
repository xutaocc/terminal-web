import test from 'node:test';
import assert from 'node:assert/strict';
import { agentSessionId, agentDisplayLabel } from '../web/agent-identity.js';
test('agent identity survives label changes and ordinary names are untouched', () => {
  const raw = 'agent_cf105e66e79f40279fd9451de3f1c161';
  assert.equal(agentSessionId(raw), 'cf105e66-e79f-4027-9fd9-451de3f1c161');
  assert.equal(agentDisplayLabel(raw, '新名字'), '新名字 · #cf105e66');
  assert.equal(agentSessionId('agent_other'), null);
  assert.equal(agentDisplayLabel('ordinary', '原名称'), '原名称');
});

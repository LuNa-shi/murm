import test from 'node:test';
import assert from 'node:assert/strict';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { AGENT_ROLES } from '../src/agent/capability-profile.js';

test('Bridge exposes one authenticated deterministic role profile endpoint', async () => {
  const bridge = new ServicesBridge({
    taskService: {},
    contextService: {},
    runtime: {},
    role: AGENT_ROLES.SELECTION,
  });
  const environment = await bridge.start();
  try {
    const unauthorized = await fetch(`${environment.SWARMENV_BRIDGE_URL}/profile`);
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`${environment.SWARMENV_BRIDGE_URL}/profile`, {
      headers: { authorization: `Bearer ${environment.SWARMENV_BRIDGE_TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.profile.role, AGENT_ROLES.SELECTION);
    assert.equal(typeof body.profile.profile_hash, 'string');
    assert.ok(body.profile.capabilities.some((capability) => capability.operation === 'claim'));
    assert.ok(!body.profile.capabilities.some((capability) => capability.service_id === 'workspace'));
  } finally {
    await bridge.stop();
  }
});

test('Bridge changes profile from Selection to Bound after a handoff binding', async () => {
  const bridge = new ServicesBridge({
    taskService: {},
    contextService: {},
    runtime: {},
    role: AGENT_ROLES.SELECTION,
  });
  assert.equal(bridge.getCapabilityProfile().role, AGENT_ROLES.SELECTION);
  await bridge.bindClaim({ task: { task_id: 'task-1' }, execution: { execution_id: 'execution-1' } });
  assert.equal(bridge.getCapabilityProfile().role, AGENT_ROLES.BOUND);
  assert.ok(!bridge.getCapabilityProfile().capabilities.some((capability) => capability.operation === 'claim'));
  await bridge.releaseClaim();
  assert.equal(bridge.getCapabilityProfile().role, AGENT_ROLES.SELECTION);
});

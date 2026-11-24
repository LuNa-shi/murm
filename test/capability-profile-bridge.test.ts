import test from 'node:test';
import assert from 'node:assert/strict';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { AGENT_ROLES } from '../src/agent/capability-profile.js';

test('Bridge exposes one authenticated reusable-identity profile endpoint', async () => {
  const bridge = new ServicesBridge({
    taskService: {},
    contextService: {},
    runtime: {},
    role: AGENT_ROLES.BOUND,
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
    assert.equal(body.profile.role, AGENT_ROLES.BOUND);
    assert.equal(typeof body.profile.profile_hash, 'string');
    assert.ok(body.profile.capabilities.some((capability) => capability.operation === 'task_take'));
    assert.ok(body.profile.capabilities.every((capability) => capability.service_id !== 'workspace'));
  } finally {
    await bridge.stop();
  }
});

test('Bridge keeps the reusable identity profile across binding and release', async () => {
  const bridge = new ServicesBridge({
    taskService: {},
    contextService: {},
    runtime: {},
    role: AGENT_ROLES.BOUND,
  });
  assert.equal(bridge.getCapabilityProfile().role, AGENT_ROLES.BOUND);
  await bridge.bindTake({ task: { task_id: 'task-1' }, execution: { execution_id: 'execution-1' } });
  assert.equal(bridge.getCapabilityProfile().role, AGENT_ROLES.BOUND);
  await bridge.releaseTake();
  assert.equal(bridge.getCapabilityProfile().role, AGENT_ROLES.BOUND);
});

test('Bridge advertises a provider-reachable URL when bound to a non-loopback host', async () => {
  const bridge = new ServicesBridge({
    taskService: {},
    contextService: {},
    runtime: {},
    role: AGENT_ROLES.BOUND,
    host: '0.0.0.0',
    publicUrl: 'http://host-gateway:{port}',
  });
  const environment = await bridge.start();
  try {
    assert.match(environment.SWARMENV_BRIDGE_URL, /^http:\/\/host-gateway:\d+$/);
  } finally {
    await bridge.stop();
  }
});

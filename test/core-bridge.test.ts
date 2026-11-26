import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoreBridge } from '../src/core/bridge.js';

test('Core Bridge authenticates live Agent credentials and revocation closes access', async t => {
  const agent = { profile: 'worker', model: 'default', status: 'starting' };
  const bridge = await createCoreBridge({ runtimeId: 'runtime-test',
    configuration: { host: '127.0.0.1', publicUrl: 'http://127.0.0.1:{port}' },
    getAgent: agentId => agentId === 'agent-test' ? agent : null, registrations: new Map() });
  t.after(() => bridge.close());
  const credentials = bridge.credentialsForAgent('agent-test');
  assert.equal(credentials.environment.MURM_BRIDGE_URL, bridge.publicUrl);
  assert.equal((await fetch(`${bridge.publicUrl}/health`)).status, 403);
  const headers = { authorization: `Bearer ${credentials.secretEnvironment.MURM_BRIDGE_TOKEN}` };
  assert.deepEqual(await (await fetch(`${bridge.publicUrl}/health`, { headers })).json(), {
    ok: true, runtimeId: 'runtime-test', agentId: 'agent-test',
  });
  agent.status = 'idle';
  const pending = await fetch(`${bridge.publicUrl}/call`, { method: 'POST', headers, body: '{}' });
  assert.equal(pending.status, 400);
  assert.equal((await pending.json()).error.code, 'INVALID_CONTRACT');
  bridge.revokeAgent('agent-test');
  assert.equal((await fetch(`${bridge.publicUrl}/health`, { headers })).status, 403);
  agent.status = 'closing';
  assert.throws(() => bridge.credentialsForAgent('agent-test'), { code: 'NOT_ALLOWED' });
  await Promise.all([bridge.close(), bridge.close()]);
});

test('invalid advertised Bridge configuration rejects before opening a listener', async () => {
  await assert.rejects(createCoreBridge({ runtimeId: 'runtime-test',
    configuration: { host: '127.0.0.1', publicUrl: 'http://0.0.0.0:{port}' },
    getAgent: () => null, registrations: new Map() }), { code: 'INVALID_CONTRACT' });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoreBridge } from '../src/core/bridge.js';

test('Core Bridge authenticates live Bot credentials and revocation closes access', async t => {
  const bot = { profile: 'worker', model: 'default', status: 'starting' };
  const bridge = await createCoreBridge({ runtimeId: 'runtime-test',
    configuration: { host: '127.0.0.1', publicUrl: 'http://127.0.0.1:{port}' },
    getBot: botId => botId === 'bot-test' ? bot : null, registrations: new Map() });
  t.after(() => bridge.close());
  const credentials = bridge.credentialsForBot('bot-test');
  assert.equal(credentials.environment.SWARMENV_BRIDGE_URL, bridge.publicUrl);
  assert.equal((await fetch(`${bridge.publicUrl}/health`)).status, 403);
  const headers = { authorization: `Bearer ${credentials.secretEnvironment.SWARMENV_BRIDGE_TOKEN}` };
  assert.deepEqual(await (await fetch(`${bridge.publicUrl}/health`, { headers })).json(), {
    ok: true, runtimeId: 'runtime-test', botId: 'bot-test',
  });
  bot.status = 'idle';
  const pending = await fetch(`${bridge.publicUrl}/call`, { method: 'POST', headers, body: '{}' });
  assert.equal(pending.status, 503);
  assert.equal((await pending.json()).error.code, 'SERVICE_UNAVAILABLE');
  bridge.revokeBot('bot-test');
  assert.equal((await fetch(`${bridge.publicUrl}/health`, { headers })).status, 403);
  bot.status = 'closing';
  assert.throws(() => bridge.credentialsForBot('bot-test'), { code: 'NOT_ALLOWED' });
  await Promise.all([bridge.close(), bridge.close()]);
});

test('invalid advertised Bridge configuration rejects before opening a listener', async () => {
  await assert.rejects(createCoreBridge({ runtimeId: 'runtime-test',
    configuration: { host: '127.0.0.1', publicUrl: 'http://0.0.0.0:{port}' },
    getBot: () => null, registrations: new Map() }), { code: 'INVALID_CONTRACT' });
});

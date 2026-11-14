import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpDomainProxy } from '../src/index.js';

test('HttpDomainProxy preserves envelopes and maps HTTP JSON results', () => {
  let call = null;
  const proxy = createHttpDomainProxy({
    serviceId: 'context', url: 'http://context.test:8787', token: 'proxy-token', actorRef: 'service:task',
    spawnSyncImpl: (command, args, options) => {
      call = { command, args, options };
      return { status: 0, stdout: `${JSON.stringify({ ok: true, result: { material: { material_id: 'm1' } } })}\n200`, stderr: '' };
    },
  });
  const result = proxy.getMaterial('m1');
  assert.equal(result.material_id, 'm1');
  assert.equal(call.command, 'curl');
  assert.equal(call.args.includes('authorization: Bearer proxy-token'), true);
  assert.equal(call.args[call.args.indexOf('--data-binary') + 1], '@-');
  const body = JSON.parse(call.options.input);
  assert.equal(body.input.material_id, 'm1');
  assert.equal(body.envelope.actor_ref, 'service:task');
  assert.equal(body.role, 'recovery');
  assert.throws(() => proxy.dispatch('context_get_material', { material_id: 'm1' }, {
    actor_ref: 'bot:other', operation_id: 'forged',
  }), { code: 'NOT_ALLOWED' });
});

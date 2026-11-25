import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIsolationUpstream } from './fixtures/core-isolation-upstream.js';

test('controlled isolation fixture requires a correlated successful guest result before final output', async t => {
  const step = { model: 'k3', prompt: 'ROLE_A', command: 'fixed-command' };
  const upstream = await createIsolationUpstream(new Map([['T03_A1', step]]));
  t.after(() => upstream.close());
  const input = [{ role: 'system', content: 'ROLE_A' }, { role: 'user', content: 'T03_A1' }];
  const send = async items => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: items }) });
  const first = await send(input);
  assert.match(await first.text(), /fixed-command/);
  assert.equal(step.evidence, undefined);
  const second = await send([...input, { type: 'function_call_output', call_id: 'call_T03_A1', output: '{"private_file":true}' }]);
  assert.match(await second.text(), /A_PRIVATE_SESSION_FACT/);
  assert.deepEqual(step.evidence, { private_file: true });
  assert.equal(upstream.receipts.length, 2);
  assert.equal(upstream.failure, undefined);
});

test('controlled isolation fixture rejects a false guest assertion and sanitizes its failure', async t => {
  const upstream = await createIsolationUpstream(new Map([['T03_B1', { model: 'k3', prompt: 'ROLE_B', command: 'fixed' }]]));
  t.after(() => upstream.close());
  const input = [{ role: 'system', content: 'ROLE_B' }, { role: 'user', content: 'T03_B1' }];
  const send = async items => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: items }) });
  await (await send(input)).text();
  const failed = await send([...input, { type: 'function_call_output', call_id: 'call_T03_B1', output: '{"env":false}' }]);
  assert.equal(failed.status, 400);
  assert.deepEqual(await failed.json(), { error: { message: 'Controlled isolation check failed' } });
  assert.deepEqual(upstream.failure, { code: 'CONTROLLED_EVIDENCE_FAILED' });
});

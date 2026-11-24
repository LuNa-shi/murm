import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPiRpcSubmissions } from '../scripts/pi-rpc-submissions.js';

test('in-flight Pi RPC replay shares one input and late evidence survives an expired wait', async () => {
  const writes = [];
  const rpc = createPiRpcSubmissions({ write: message => writes.push(message) });
  const message = { type: 'prompt', id: 'input-one', message: 'fixed input', streamingBehavior: 'steer' };
  const first = rpc.submit(message, 10);
  const repeated = rpc.submit({ ...message }, 10);
  await assert.rejects(rpc.submit({ ...message, message: 'changed' }, 10), { code: 'CONFLICT' });
  assert.equal(writes.length, 1);
  assert.deepEqual(await first, { state: 'pending' });
  assert.deepEqual(await repeated, { state: 'pending' });
  assert.deepEqual(rpc.query(message.id), { state: 'pending' });
  const response = { type: 'response', id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } };
  rpc.observe(response);
  assert.deepEqual(await rpc.submit(message, 10), { state: 'complete', response });
  assert.deepEqual(rpc.query(message.id), { state: 'complete', response });
  assert.equal(writes.length, 1);
  assert.deepEqual(rpc.query('unknown'), { state: 'not_found' });
});

test('fast Pi acknowledgement is observed before submit returns and old IDs cannot be evicted into redelivery', async () => {
  let writes = 0;
  const rpc = createPiRpcSubmissions({ write(message) {
    writes += 1;
    rpc.observe({ type: 'response', id: message.id, command: message.type, success: true, data: { disposition: 'handled' } });
  } });
  for (let number = 0; number < 300; number += 1) {
    const receipt = await rpc.submit({ type: 'prompt', id: `id-${number}`, message: 'fixed' }, 10);
    assert.equal(receipt.response.data.disposition, 'handled');
  }
  assert.equal((await rpc.submit({ type: 'prompt', id: 'id-0', message: 'fixed' }, 10)).state, 'complete');
  assert.equal(writes, 300);
  await assert.rejects(rpc.submit({ type: 'prompt', id: 'invalid' }, Infinity), { code: 'INVALID_CONTRACT' });
  assert.equal(writes, 300);
});

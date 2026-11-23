import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPeerUpstream, peerInputs } from './fixtures/agensh-peer-upstream.js';

test('controlled peer fixture counts every arrival and permits only four fixed local requests', async t => {
  const upstream = await createPeerUpstream({ deniedOrigin: 'http://172.17.0.1:1' }); t.after(() => upstream.close()); upstream.start();
  const pushedCommit = 'a'.repeat(40); const privateCommit = 'b'.repeat(40);
  for (let number = 1; number <= 5; number++) {
    const turn = number <= 2 ? 1 : 2;
    const evidence = turn === 1 ? { turn, cwd: '/project', pushedCommit, prNumber: 1, messageId: 'message', boardLabel: 'G1', networkDenied: true }
      : { turn, cwd: '/project', pushedCommit, privateCommit, continued: true };
    const response = await fetch(upstream.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'k3', input: [
      { type: 'message', content: peerInputs[turn - 1] }, ...(number % 2 ? [] : [{ type: 'function_call_output', call_id: `call_peer_${turn}`, output: JSON.stringify(evidence) }]),
    ] }) });
    await response.text(); assert.equal(response.status, number <= 4 ? 200 : 400);
  }
  assert.equal(upstream.receipt().arrivals, 5); assert.equal(upstream.receipt().accepted, 4); assert.equal(upstream.receipt().failure, 'FIXED_PEER_PROTOCOL_FAILED');
});

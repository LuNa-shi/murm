import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

export async function createIsolationUpstream(plan) {
  const receipts = [];
  const turns = new Map();
  let failure;
  const deadlineAt = Date.now() + 180_000;
  const server = createServer(async (request, response) => {
    try {
      assert.ok(Date.now() < deadlineAt && receipts.length < 12, 'Controlled workload limit');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 2 * 1024 * 1024);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const user = body.input.filter(item => item.role === 'user').at(-1);
      const text = typeof user?.content === 'string' ? user.content : user?.content?.map(item => item.text ?? '').join('');
      const turn = /^T03_[ABC][12]$/.test(text) ? text : null;
      const step = plan.get(turn);
      assert.ok(step, 'Only the fixed workload may execute');
      assert.equal(body.model, step.model);
      assert.ok(JSON.stringify(body).includes(step.prompt), 'Frozen role prompt must be sent');
      const priorFact = JSON.stringify(body.input).includes('A_PRIVATE_SESSION_FACT');
      if (turn === 'T03_A2') assert.equal(priorFact, true, 'Same Session must retain prior conversational fact');
      if (turn.startsWith('T03_B') || turn.startsWith('T03_C')) assert.equal(priorFact, false, 'Other Sessions must not contain A history');
      const ordinal = (turns.get(turn) ?? 0) + 1;
      turns.set(turn, ordinal);
      assert.ok(ordinal <= 2);
      let item;
      if (ordinal === 1) {
        item = { type: 'function_call', id: `fc_${turn}`, call_id: `call_${turn}`, name: 'bash',
          arguments: JSON.stringify({ command: step.command, timeout: 30 }) };
      } else {
        const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === `call_${turn}`);
        assert.equal(typeof result?.output, 'string');
        const evidence = JSON.parse(result.output.trim());
        assert.ok(Object.keys(evidence).length > 0);
        assert.ok(Object.values(evidence).every(value => value === true), 'All guest evidence checks must pass');
        step.evidence = evidence;
        item = { type: 'message', id: `msg_${turn}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: turn === 'T03_A1' ? 'A_PRIVATE_SESSION_FACT' : `${turn}_OK`, annotations: [] }] };
      }
      receipts.push({ turn, model: body.model, ordinal, priorFact, verified: ordinal === 2 });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse(body.model, receipts.length, item));
    } catch (error) {
      failure = { code: 'CONTROLLED_EVIDENCE_FAILED' };
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Controlled isolation check failed' } }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipts,
    get failure() { return failure; },
    close() { return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); },
  };
}

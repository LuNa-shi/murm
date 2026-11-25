import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { peerCommand } from './agensh-peer-upstream.js';
import { streamResponse } from './core-controlled-upstream.js';
export const routerInputs = ['T14_FIXED_KICKOFF', 'T14_FIXED_EXTERNAL', 'T14_FIXED_USER'];
export function eventCommand(batch) {
  return `node --input-type=module <<'ROUTER_EVENT'
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';
const before=JSON.parse(readFileSync('.peer-state.json','utf8'));const event=${JSON.stringify(batch)};
assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000}).trim(),before.pushedCommit);
assert.equal(event.source,'gitea');assert.match(event.eventId,/^comment:[0-9]+$/);assert.equal(event.text,'T14_FIXED_EXTERNAL');
const result={turn:2,cwd:process.cwd(),pushedCommit:before.pushedCommit,event};writeFileSync('router-event.json',JSON.stringify(result));console.log(JSON.stringify(result));
ROUTER_EVENT`;
}
export async function createRouterUpstream({ deadlineAt, deniedOrigin, onFailure = () => {} }) {
  let arrivals = 0, accepted = 0, failure; const evidence = [];
  const server = createServer(async (request, response) => {
    const arrival = ++arrivals, turn = Math.ceil(arrival / 2); let stage = 'bounds';
    try {
      assert.ok(!failure && arrival <= 6 && Date.now() < deadlineAt); assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      stage = 'request'; const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.model, 'k3'); assert.ok(body.max_output_tokens > 0 && body.max_output_tokens <= 128);
      stage = 'batch'; const user = body.input.filter(row => row.role === 'user').at(-1);
      const text = typeof user?.content === 'string' ? user.content : user.content.map(part => part.text ?? '').join('');
      const batch = JSON.parse(text.slice(text.indexOf('\n') + 1));
      if (turn === 3) { assert.match(batch.text, /^@peer-[a-z0-9-]+ T14_FIXED_USER$/); assert.equal(batch.kind, 'mention'); assert.match(batch.eventId, /^post:[a-z0-9]+$/); }
      else assert.equal(batch.text, routerInputs[turn - 1]);
      assert.equal(batch.source, ['kickoff', 'gitea', 'mattermost'][turn - 1]); assert.equal(typeof batch.context, 'string'); if (turn > 1) assert.ok(batch.context.includes('T13 fixed fact'));
      const callId = `router_${turn}`; let item;
      if (arrival % 2) item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'bash', arguments: JSON.stringify({ command: turn === 2 ? eventCommand({ batchId: batch.batchId, source: batch.source, eventId: batch.eventId, text: batch.text }) : peerCommand(turn === 1 ? 1 : 2, deniedOrigin), timeout: turn === 1 ? 60 : 20 }) };
      else {
        stage = 'tool-json'; const outputs = body.input.filter(row => row.type === 'function_call_output' && row.call_id === callId); assert.equal(outputs.length, 1);
        const row = JSON.parse(outputs[0].output.trim()); assert.equal(row.turn, turn === 3 ? 2 : turn); assert.match(row.pushedCommit, /^[a-f0-9]{40}$/);
        if (turn > 1) { assert.equal(row.pushedCommit, evidence[0].pushedCommit); assert.equal(row.cwd, evidence[0].cwd); }
        if (turn === 2) assert.deepEqual(row.event, { batchId: batch.batchId, source: batch.source, eventId: batch.eventId, text: batch.text });
        if (turn === 3) assert.equal(row.untrackedBase64, 'AP9BCg==');
        evidence.push(row); item = { type: 'message', id: `msg_router_${turn}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `ROUTER_${turn}_OK`, annotations: [] }] };
      }
      assert.ok(!failure && Date.now() < deadlineAt); accepted++; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', arrival, item));
    } catch {
      const first = !failure; failure ??= { code: 'T14_FIXTURE_FAILED', stage, arrival, turn };
      const terminal = { type: 'response.failed', response: { id: `router_failed_${arrival}`, object: 'response', model: 'k3', status: 'failed', output: [], error: { code: failure.code, message: failure.code }, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`); if (first) onFailure();
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ arrivals, accepted, failure, evidence }), close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

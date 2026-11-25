import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

export function notesCommand(botId) {
  return `node --input-type=module <<'NOTES_CHECK'\nimport assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
const cli=(...args)=>JSON.parse(execFileSync('swarm',args,{encoding:'utf8',timeout:10000}));
const expected={key:'fixed',text:'handoff',author:${JSON.stringify(botId)}};
for(const service of ['notes','remote-notes']) {
 const metadata=cli('service','view',service);
 assert.deepEqual(metadata.capabilities.map(item=>item.operation),['put','get']);
 assert.deepEqual(cli(service,'put','--key','fixed','--text','handoff','--request-id',service+'-write'),expected);
 assert.deepEqual(cli(service,'get','--key','fixed','--request-id',service+'-read'),expected);
}
assert.notEqual(spawnSync('swarm',['notes','put','--key','forged','--text','bad','--author','other'],{timeout:10000}).status,0);
assert.notEqual(spawnSync('swarm',['notes','erase','--key','fixed'],{timeout:10000}).status,0);
console.log(JSON.stringify({inProcess:true,http:true,forgedRejected:true,deniedRejected:true}));
NOTES_CHECK`;
}

export async function createNotesUpstream(plan) {
  let requests = 0;
  let failure;
  let evidence;
  const deadlineAt = Date.now() + 90_000;
  const server = createServer(async (request, response) => {
    try {
      assert.ok(Date.now() < deadlineAt && requests < 2);
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'k3'); assert.ok(Array.isArray(body.input));
      assert.ok(JSON.stringify(body.input).includes('FIXED_NOTES_EXCHANGE'));
      requests++;
      let item;
      if (requests === 1) item = { type: 'function_call', id: 'fc_notes', call_id: 'call_notes', name: 'bash', arguments: JSON.stringify({ command: plan.command, timeout: 60 }) };
      else {
        const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'call_notes');
        evidence = JSON.parse(result.output.trim());
        assert.deepEqual(evidence, { inProcess: true, http: true, forgedRejected: true, deniedRejected: true });
        item = { type: 'message', id: 'msg_notes', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'NOTES_OK', annotations: [] }] };
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse('k3', requests, item));
    } catch { failure = 'CONTROLLED_NOTES_FAILED'; response.writeHead(400); response.end(JSON.stringify({ error: { message: failure } })); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ requests, failure, evidence }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
import { streamResponse } from './core-controlled-upstream.js';

export function botControlBackend(upstream, sandbox, { host = '172.17.0.1', listen = '0.0.0.0' } = {}) {
  const model = url => ({ provider: 'kimi_proxy', model: 'k3', upstream: { url, headers: {} } });
  return createPiOpenSandboxBackend({
    sandbox: { ...sandbox, resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: listen, publicUrl: `http://${host}:{port}` },
    modelGateway: { host: listen, advertiseHost: host, requestTimeoutMs: 80_000, maxOutputTokens: 128 },
    models: { default: model(upstream.parentUrl), child: model(upstream.childUrl) },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  });
}

export function parentCommand(parentId) {
  return `node --input-type=module <<'BOT_CONTROL'
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
const cli=(...args)=>JSON.parse(execFileSync('swarm',args,{encoding:'utf8',timeout:25000}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const end=Date.now()+85000;
const wait=async(id,output)=>{while(Date.now()<end){const b=cli('bot','get','--bot-id',id); if(b.status==='idle'&&b.latestOutput===output)return b; assert.ok(!['closed','closing','exited'].includes(b.status)); await pause(100);} throw new Error('fixed child deadline');};
assert.deepEqual(cli('service','view','bot').capabilities.map(c=>c.operation),['spawn','get','send','stop']);
assert.notEqual(spawnSync('swarm',['bot','spawn','--profile','parent','--request-id','denied'],{timeout:10000}).status,0);
assert.notEqual(spawnSync('swarm',['bot','spawn','--profile','child','--parent-id','forged','--request-id','forged'],{timeout:10000}).status,0);
const args=['bot','spawn','--profile','child','--text','FIXED_CHILD_ONE','--request-id','child-create'];
const first=cli(...args); const duplicate=cli(...args);
assert.equal(first.bot.id,duplicate.bot.id); assert.equal(first.bot.parentId,${JSON.stringify(parentId)}); assert.equal(first.initialInput.status,'accepted');
const one=await wait(first.bot.id,'CHILD_ONE');
const second=cli('bot','send','--bot-id',one.id,'--text','FIXED_CHILD_TWO','--mode','followUp','--request-id','child-second'); assert.equal(second.status,'accepted');
const two=await wait(one.id,'CHILD_TWO'); assert.ok(two.cursor>one.cursor);
const stopped=cli('bot','stop','--bot-id',two.id,'--request-id','child-stop'); assert.equal(stopped.execution,'stopped'); assert.equal(stopped.cleanup,'complete');
assert.equal(cli('bot','get','--bot-id',two.id).status,'closed');
console.log(JSON.stringify({childId:two.id,parentId:two.parentId,duplicate:true,rounds:2,cleanup:'complete',denied:true,forged:true}));
BOT_CONTROL`;
}

export async function createBotControlUpstream(plan) {
  let arrivals = 0; let accepted = 0; let failure; let evidence; let deadlineExceeded = false;
  const counts = { parent: 0, child: 0 }; const deadlineAt = Date.now() + 120000;
  const handle = role => async (request, response) => {
    arrivals++;
    deadlineExceeded ||= Date.now() >= deadlineAt;
    try {
      assert.ok(arrivals <= 6 && !deadlineExceeded);
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.model, 'k3'); assert.ok(Array.isArray(body.input));
      const step = ++counts[role]; assert.ok(step <= (role === 'parent' ? 2 : 4));
      let item;
      if (step % 2 === 1) {
        const round = role === 'parent' ? 1 : (step + 1) / 2;
        const command = role === 'parent' ? plan.command : round === 1 ? "printf 'ROUND_ONE\\n' > carry.txt && printf 'CHILD_BYTES_ONE\\n'" : "test \"$(cat carry.txt)\" = ROUND_ONE && printf 'ROUND_TWO\\n' >> carry.txt && printf 'CHILD_BYTES_TWO\\n'";
        assert.equal(typeof command, 'string');
        const callId = `${role}_${round}`;
        item = { type: 'function_call', id: 'fc_' + callId, call_id: callId, name: 'bash', arguments: JSON.stringify({ command, timeout: role === 'parent' ? 100 : 10 }) };
      } else {
        const round = step / 2; const callId = `${role}_${round}`;
        const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === callId); assert.equal(typeof result?.output, 'string');
        if (role === 'parent') {
          evidence = JSON.parse(result.output.trim());
          assert.equal(evidence.parentId, plan.parentId); assert.equal(typeof evidence.childId, 'string');
          assert.deepEqual({ ...evidence, childId: 'child', parentId: 'parent' }, { childId: 'child', parentId: 'parent', duplicate: true, rounds: 2, cleanup: 'complete', denied: true, forged: true });
        } else assert.equal(result.output.trim(), round === 1 ? 'CHILD_BYTES_ONE' : 'CHILD_BYTES_TWO');
        item = { type: 'message', id: 'msg_' + callId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: role === 'parent' ? 'BOT_CONTROL_OK' : round === 1 ? 'CHILD_ONE' : 'CHILD_TWO', annotations: [] }] };
      }
      accepted++; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', arrivals, item));
    } catch { failure = 'CONTROLLED_BOT_SERVICE_FAILED'; response.writeHead(400); response.end(JSON.stringify({ error: { code: failure, message: failure } })); }
  };
  const servers = ['parent', 'child'].map(role => createServer(handle(role)));
  const close = () => Promise.all(servers.map(server => new Promise(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
  try {
    for (const server of servers) {
      server.requestTimeout = 10_000; server.headersTimeout = 10_000;
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
    }
  } catch (error) { await close(); throw error; }
  const [parentUrl, childUrl] = servers.map(server => `http://127.0.0.1:${server.address().port}/v1/responses`);
  return { parentUrl, childUrl, receipt: () => ({ arrivals, accepted, counts: { ...counts }, failure, evidence, deadlineExceeded }), close };
}

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

export const artifactCommand = `set -eu
git init -q
git config user.name 'Controlled Artifact Test'
git config user.email 'core-artifact-test@example.invalid'
printf 'COMMITTED_T07\\n' > tracked.txt
git add tracked.txt
git -c commit.gpgsign=false commit -q -m 'Fixed local artifact receipt'
printf 'UNCOMMITTED_T07\\n' > uncommitted.txt
node --input-type=module <<'CORE_ARTIFACT_EVIDENCE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000}).trim();
assert.equal(readFileSync('tracked.txt','utf8'),'COMMITTED_T07\\n');
assert.equal(readFileSync('uncommitted.txt','utf8'),'UNCOMMITTED_T07\\n');
assert.equal(git('show','HEAD:tracked.txt'),'COMMITTED_T07');
assert.equal(git('remote'), '');
assert.equal(git('status','--porcelain'), '?? uncommitted.txt');
console.log(JSON.stringify({tracked:true,uncommitted:true,untracked:true,noRemote:true,commit:git('rev-parse','HEAD')}));
CORE_ARTIFACT_EVIDENCE`;

export async function createArtifactsUpstream() {
  let arrivals = 0;
  let failure;
  let evidence;
  const receipts = [];
  const deadlineAt = Date.now() + 120_000;
  const server = createServer(async (request, response) => {
    // Every arrival spends the fixed budget, including malformed and rejected requests.
    const ordinal = ++arrivals;
    try {
      assert.ok(Date.now() < deadlineAt && ordinal <= 2, 'Controlled arrival budget');
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'k3'); assert.ok(Array.isArray(body.input));
      assert.ok(JSON.stringify(body.input).includes('FIXED_ARTIFACT_CAPTURE'));
      let item;
      if (ordinal === 1) item = { type: 'function_call', id: 'fc_artifact', call_id: 'call_artifact', name: 'bash',
        arguments: JSON.stringify({ command: artifactCommand, timeout: 20 }) };
      else {
        const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'call_artifact');
        assert.equal(typeof result?.output, 'string');
        const parsed = JSON.parse(result.output.trim());
        assert.deepEqual(Object.keys(parsed).sort(), ['commit', 'noRemote', 'tracked', 'uncommitted', 'untracked']);
        assert.equal(parsed.tracked, true); assert.equal(parsed.uncommitted, true); assert.equal(parsed.untracked, true); assert.equal(parsed.noRemote, true);
        assert.match(parsed.commit, /^[a-f0-9]{40}$/);
        evidence = parsed;
        item = { type: 'message', id: 'msg_artifact', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'T07_ARTIFACTS_READY', annotations: [] }] };
      }
      receipts.push({ ordinal, verified: ordinal === 2 });
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', ordinal, item));
    } catch { failure = 'CONTROLLED_ARTIFACTS_FAILED'; response.writeHead(400); response.end(JSON.stringify({ error: { message: failure } })); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ arrivals, receipts, evidence, failure }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

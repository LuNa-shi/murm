import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { scaleMASBackendConfiguration } from './fixtures/scalemas-configuration.js';
import { execute, installNotesExample } from './fixtures/notes-installed-package.js';

const artifact = 'FATE_HANDOFF: simplify the cardinality of the finite product with Fintype.card_pi.\n';
const bash = `python3 - <<'FATE_HANDOFF'
import json, subprocess
def cli(service, operation, value, request):
    result = subprocess.run(['swarm', service, operation, '--stdin', '--request-id', request],
        input=json.dumps(value), check=True, text=True, capture_output=True)
    return json.loads(result.stdout)
`;
const commands = {
  producer: bash + `publication=cli('substrate','publish',{'sub_task':'Cardinality of a product','artifact':${JSON.stringify(artifact)},'rationale':'This finite product has a constant factor size.','refs':[]},'native-producer')
print(json.dumps(publication))
FATE_HANDOFF`,
  consumer: bash + `matches=cli('substrate','search',{'query':'FATE_HANDOFF','limit':8},'native-search')['results']
assert len(matches)==1 and matches[0]['artifact']==${JSON.stringify(artifact)}
address=matches[0]['address']
original=cli('substrate','visit',{'addresses':[address]},'native-visit')['results'][0]
assert original==matches[0] and 'author' not in original
rationale=address+' provides the Fintype.card_pi simplification'
successor=cli('substrate','publish',{'sub_task':'Assemble the original proof','artifact':'Applied the simplification from '+original['artifact'],'rationale':rationale,'refs':[address]},'native-adopt')
checked=cli('fate','check_lean',{'proof':'by simp [Fintype.card_pi]'},'native-check')
assert checked['status']=='passed', checked
submission=cli('fate','submit',{'proof':'by simp [Fintype.card_pi]','rationale':rationale,'refs':[address],'finish':True},'native-submit')
print(json.dumps({'original':original,'successor':successor,'submission':submission}))
FATE_HANDOFF`,
};

const optIn = process.env.SWARMENV_FATE_NATIVE_TEST === '1';
test('installed FATE-M peer adopts exact anonymous bytes after the producer is physically gone', { skip: !optIn, timeout: 240_000 }, async t => {
  const installed = await installNotesExample();
  t.after(() => installed.close());
  const evidenceRoot = process.env.SWARMENV_FATE_NATIVE_OUTPUT ?? join(process.cwd(), 'experiments');
  await mkdir(evidenceRoot, { mode: 0o700, recursive: true });
  const runId = `fate-native-${Date.now()}`;
  const runPath = join(evidenceRoot, runId);
  const image = process.env.SWARMENV_CORE_TEST_IMAGE;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  let providerFailure, producerPublication, consumerAdoption;
  let requests = 0, initial = 0, stopSeq;
  const deadline = Date.now() + 170_000;
  const poll = async observe => {
    while (Date.now() < deadline) {
      const result = await observe();
      if (result) return result;
      await delay(30);
    }
    assert.fail('Native evidence did not settle within the controlled window');
  };
  const procedure = async () => {
    const ids = (await readdir(runPath)).filter(id => /^[a-f0-9-]{36}$/.test(id));
    if (ids.length !== 1) return;
    const runtime = JSON.parse(await readFile(join(runPath, ids[0], 'runtime.json'), 'utf8'));
    const rows = (await readFile(runtime.evidence.path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { runtime, rows };
  };
  const server = createServer(async (request, response) => {
    const arrival = ++requests;
    try {
      assert.ok(arrival <= 4);
      assert.equal(request.url, '/v1/responses');
      const text = await Array.fromAsync(request, value => value.toString()).then(chunks => chunks.join(''));
      const parsed = JSON.parse(text);
      assert.equal(parsed.model, 'k3');
      const toolReturn = parsed.input.findLast(row => row.type === 'function_call_output');
      let item;
      if (!toolReturn) {
        const phase = ++initial === 1 ? 'producer' : 'consumer';
        if (phase === 'consumer') {
          const found = await poll(async () => {
            const evidence = await procedure();
            const publish = evidence?.rows.find(row => row.type === 'service' && row.operationId === 'native-producer' && row.outcome === 'succeeded');
            const stopped = evidence?.rows.find(row => row.type === 'stop' && row.botId === publish?.botId && row.state === 'observed' && row.receipt.cleanup === 'complete');
            return stopped ? { ...evidence, stopped } : null;
          });
          stopSeq = found.stopped.seq;
          const key = (prefix, id) => `${prefix}-${createHash('sha256').update(id).digest('hex').slice(0, 48)}`;
          const deleted = await execute('docker', ['ps', '--all', '--quiet', '--filter', `label=runtime_key=${key('r', found.runtime.runtimeId)}`,
            '--filter', `label=bot_key=${key('b', found.stopped.botId)}`], { timeout: 5000 });
          assert.equal(deleted.stdout.trim(), '');
        }
        item = { type: 'function_call', id: `fc_${phase}`, call_id: `call_${phase}`, name: 'bash',
          arguments: JSON.stringify({ command: commands[phase], timeout: 90 }) };
      } else {
        if (toolReturn.call_id === 'call_producer') producerPublication = JSON.parse(toolReturn.output.trim());
        else {
          assert.equal(toolReturn.call_id, 'call_consumer');
          consumerAdoption = JSON.parse(toolReturn.output.trim());
        }
        item = { type: 'message', id: `msg_${arrival}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Work finished.', annotations: [] }] };
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse('k3', arrival, item));
    } catch (error) {
      providerFailure ??= error;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Controlled fixture failed' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const backend = scaleMASBackendConfiguration({ upstreamUrl: `http://127.0.0.1:${server.address().port}/v1/responses`,
    host: process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST,
    lifecycleUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL, endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST,
    apiKey: process.env.SWARMENV_CORE_TEST_API_KEY });
  // The local fixture holds the consumer's first response until the producer
  // is physically gone. The production prompt and driver stay identical.
  backend.modelGateway.requestTimeoutMs = 120_000;
  const configuration = join(installed.directory, 'fate-native.mjs');
  await writeFile(configuration, `export default ${JSON.stringify({
    backend, fate: { projectRoot: process.env.SWARMENV_FATE_TEST_PROJECT, leanRoot: process.env.SWARMENV_FATE_TEST_LEAN, mode: 'shared' },
    runId, image, outputDir: evidenceRoot, poolSize: 2, workTimeoutMs: 120_000, closeTimeoutMs: 30_000, checkpointAfterMs: 1_000,
  })}\n`, { mode: 0o600 });
  const main = join(installed.directory, 'node_modules/@swarmenv/core/dist/examples/scalemas-environment/main.js');
  await execute(process.execPath, [main, configuration], { cwd: installed.directory, env: installed.env, timeout: 180_000, maxBuffer: 4 * 1024 ** 2 });
  assert.ifError(providerFailure);
  assert.equal(requests, 4);
  const result = JSON.parse(await readFile(join(runPath, 'fate-result.json'), 'utf8'));
  assert.equal(result.businessFailure, null);
  assert.equal(result.cleanup.cleanup, 'complete');
  assert.equal(result.scoring.teamSuccess, true);
  assert.ok(result.peers.some(peer => peer.endReason === 'submitted'));
  assert.equal(result.checkpoint.state, 'recorded');
  const checkpoint = JSON.parse(await readFile(join(runPath, 'fate-work-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.runtimeId, result.runtimeId);
  assert.equal(Date.parse(checkpoint.scheduledAt) - Date.parse(result.startedAt), 1_000);
  assert.ok(Date.parse(checkpoint.capturedAt) >= Date.parse(checkpoint.scheduledAt));
  assert.ok(checkpoint.peers.some(peer => peer.active));
  assert.deepEqual(consumerAdoption.original, producerPublication);
  assert.equal(consumerAdoption.original.artifact, artifact);
  assert.ok(consumerAdoption.successor.refs.includes(producerPublication.address));
  assert.ok(result.scoring.candidates.some(row => row.sha256 === consumerAdoption.submission.sha256 && row.status === 'passed'));
  const trail = await procedure();
  for (const operationId of ['native-search', 'native-visit', 'native-adopt', 'native-submit']) {
    const row = trail.rows.find(row => row.type === 'service' && row.operationId === operationId && row.outcome === 'succeeded');
    assert.ok(row.seq > stopSeq);
  }
  const scored = await execute(process.execPath, [main, '--fate-rescore', process.env.SWARMENV_FATE_TEST_PROJECT,
    process.env.SWARMENV_FATE_TEST_LEAN, result.bundlePath], { cwd: installed.directory, env: installed.env, timeout: 60_000 });
  assert.equal(JSON.parse(scored.stdout).teamSuccess, true);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { createBotControlUpstream, parentCommand } from './fixtures/core-bot-service-upstream.js';

const request = (url, input = []) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'k3', input }) });
const tool = (call_id, output) => ({ type: 'function_call_output', call_id, output });
test('fixed parent script parses without execution and controlled fixture requires all six correlated requests', async t => {
  const command = parentCommand('parent-fixed');
  execFileSync('bash', ['-n'], { input: command });
  const program = command.split("<<'BOT_CONTROL'\n")[1].split('\nBOT_CONTROL')[0];
  execFileSync(process.execPath, ['--check', '--input-type=module'], { input: program });
  const upstream = await createBotControlUpstream({ parentId: 'parent-fixed', command }); t.after(() => upstream.close());
  const model = url => ({ provider: 'kimi_proxy', model: 'k3', upstream: { url, headers: {} } });
  assert.doesNotThrow(() => createPiOpenSandboxBackend({
    sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:8080/v1' },
    bridge: { host: '0.0.0.0', publicUrl: 'http://172.17.0.1:{port}' },
    modelGateway: { host: '0.0.0.0', advertiseHost: '172.17.0.1', requestTimeoutMs: 80_000, maxOutputTokens: 128 },
    models: { default: model(upstream.parentUrl), child: model(upstream.childUrl) },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }));
  assert.equal((await request(upstream.parentUrl)).status, 200);
  assert.equal((await request(upstream.childUrl)).status, 200);
  assert.equal((await request(upstream.childUrl, [tool('child_1', 'CHILD_BYTES_ONE\n')])).status, 200);
  assert.equal((await request(upstream.childUrl)).status, 200);
  assert.equal((await request(upstream.childUrl, [tool('child_2', 'CHILD_BYTES_TWO\n')])).status, 200);
  const evidence = { childId: 'child-fixed', parentId: 'parent-fixed', duplicate: true, rounds: 2, cleanup: 'complete', denied: true, forged: true };
  assert.equal((await request(upstream.parentUrl, [tool('parent_1', JSON.stringify(evidence))])).status, 200);
  assert.deepEqual(upstream.receipt().counts, { parent: 2, child: 4 }); assert.equal(upstream.receipt().accepted, 6); assert.equal(upstream.receipt().failure, undefined);
  assert.equal((await request(upstream.parentUrl)).status, 400); assert.equal(upstream.receipt().arrivals, 7); assert.equal(upstream.receipt().accepted, 6);
});
test('invalid arrivals consume budget and tool evidence cannot be invented or mismatched', async t => {
  const upstream = await createBotControlUpstream({ command: 'fixed', parentId: 'parent' }); t.after(() => upstream.close());
  assert.equal((await request(upstream.childUrl)).status, 200);
  assert.equal((await request(upstream.childUrl, [tool('wrong', 'CHILD_BYTES_ONE')])).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await request(upstream.parentUrl + '/invalid')).status, 400);
  assert.equal(upstream.receipt().arrivals, 7); assert.equal(upstream.receipt().accepted, 1); assert.equal(upstream.receipt().failure, 'CONTROLLED_BOT_SERVICE_FAILED');
});

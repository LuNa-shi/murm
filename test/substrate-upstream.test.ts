import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createSubstrateUpstream, substrateCommand } from './fixtures/substrate-upstream.js';
import { completeSimple, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';

for (const poolSize of [3, 6]) test(`all ${poolSize * 2} native fixed programs parse and preserve newline bytes without NUL arguments`, () => {
  for (let peer = 0; peer < poolSize; peer++) for (let cycle = 0; cycle < 2; cycle++) {
    const command = substrateCommand(peer, cycle, { poolSize }); assert.equal(command.includes(String.fromCharCode(0)), false);
    const source = command.split("<<'SUBSTRATE_FIXED'\n")[1].split('\nSUBSTRATE_FIXED')[0];
    execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source });
  }
});

test('controlled native harness rejects bad correlation with one nonretryable terminal and counts every rejected arrival', async t => {
  const upstream = await createSubstrateUpstream({ deadlineAt: Date.now() + 5000 }); t.after(() => upstream.close());
  const model = { id: 'k3', name: 'fixed', provider: 'kimi_proxy', api: 'openai-responses', baseUrl: upstream.url.replace(/\/responses$/, ''),
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 };
  const failed = await completeSimple(model, { messages: [{ role: 'user', content: 'bad fixed input', timestamp: 0 }] }, { apiKey: 'local-only', maxTokens: 128 });
  assert.equal(failed.stopReason, 'error'); assert.equal(isRetryableAssistantError(failed), false);
  assert.match(failed.errorMessage, /FIXED_SUBSTRATE_FAILED/);
  assert.equal(upstream.receipt().arrivals, 1); assert.equal(upstream.receipt().accepted, 0);
});

for (const poolSize of [3, 6]) test(`all ${poolSize * 4} fixed exchanges admit each peer/cycle once and enforce the global arrival cap`, async t => {
  const phases = [];
  const upstream = await createSubstrateUpstream({ deadlineAt: Date.now() + 5000, poolSize, observe: async value => phases.push([value.phase, value.peer]) }); t.after(() => upstream.close());
  const send = (peer, cycle, row) => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', max_output_tokens: 128, input: [
    { role: 'user', content: `Substrate peer=${peer} cycle=${cycle}\nfixed` },
    ...(row ? [{ type: 'function_call_output', call_id: `scale_${peer}_${cycle}`, output: JSON.stringify(row) }] : []),
  ] }) });
  let original;
  for (let peer = 0; peer < poolSize; peer++) for (let cycle = 0; cycle < 2; cycle++) {
    const content = peer === 0 && cycle === 0 ? 'ARITHMETIC_SEED: 7+5=12.\n' : peer === 1 ? 'Adopted exact: ARITHMETIC_SEED: 7+5=12.\n' : 'fixed';
    const published = { address: `content:${(peer * 2 + cycle).toString(16).repeat(64)}`, author: `peer-${peer}`, version: 1, content, references: peer === 1 ? [original.address] : [] };
    const row = { peer, cycle, process: { pid: peer + 10, starttime: String(peer + 20) }, cwd: '/workspace/project', published,
      adopted: peer === 1 ? original : null, sessionId: cycle ? `${peer}`.repeat(36) : null };
    if (peer === 0 && cycle === 0) original = published;
    assert.equal((await send(peer, cycle)).status, 200);
    const response = await send(peer, cycle, row); assert.match(await response.text(), /FIXED_CYCLE_OK/);
  }
  assert.equal(upstream.receipt().arrivals, poolSize * 4); assert.equal(upstream.receipt().accepted, poolSize * 4); assert.equal(upstream.receipt().failure, undefined);
  assert.equal(upstream.receipt().poolSize, poolSize); assert.equal(upstream.receipt().maxRequests, poolSize * 4);
  assert.equal(upstream.receipt().evidence.length, poolSize * 2); assert.equal(phases.length, poolSize * 2);
  assert.match(await (await send(0, 0)).text(), /response.failed/);
  assert.equal(upstream.receipt().arrivals, poolSize * 4 + 1); assert.equal(upstream.receipt().accepted, poolSize * 4);
});

for (const poolSize of [3, 6]) test(`the ${poolSize}-peer native fixture rejects an out-of-pool peer before returning a Bash call`, async t => {
  const upstream = await createSubstrateUpstream({ deadlineAt: Date.now() + 5000, poolSize });
  t.after(() => upstream.close());
  const response = await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', max_output_tokens: 128,
    input: [{ role: 'user', content: `Substrate peer=${poolSize} cycle=0\nfixed` }] }) });
  const stream = await response.text();
  assert.match(stream, /response.failed/);
  assert.ok(!stream.includes('function_call'));
  assert.equal(upstream.receipt().arrivals, 1);
  assert.equal(upstream.receipt().accepted, 0);
  assert.deepEqual(upstream.receipt().evidence, []);
});

test('native fixture capacity accepts only the reviewed three- and six-peer variants', async () => {
  for (const poolSize of [0, 2, 4, 5, 7, 8, 9, '6', null]) {
    await assert.rejects(createSubstrateUpstream({ deadlineAt: Date.now() + 5000, poolSize }));
    assert.throws(() => substrateCommand(0, 0, { poolSize }));
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { completeSimple, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import { eventCommand, createRouterUpstream, routerInputs } from './fixtures/peermesh-router-upstream.js';

test('fixed native event command parses and native Pi treats a correlated fixture failure as nonretryable', async t => {
  const code = eventCommand({ source: 'gitea', eventId: 'comment:1', batchId: 'fixed', text: routerInputs[1] }).split('\n').slice(1, -1).join('\n');
  execFileSync(process.execPath, ['--check', '--input-type=module'], { input: code, timeout: 5000 });
  const upstream = await createRouterUpstream({ deadlineAt: Date.now() + 5000, deniedOrigin: 'http://127.0.0.1:1' }); t.after(() => upstream.close());
  const model = { id: 'k3', name: 'fixed', provider: 'kimi_proxy', api: 'openai-responses', baseUrl: upstream.url.replace(/\/responses$/, ''), reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 };
  const result = await completeSimple(model, { messages: [{ role: 'user', content: 'invalid', timestamp: 0 }] }, { apiKey: 'local-only', maxTokens: 128 });
  assert.equal(result.stopReason, 'error'); assert.equal(isRetryableAssistantError(result), false); assert.equal(upstream.receipt().arrivals, 1);
});

test('six counted fixed requests prove three batch identities and reject every extra arrival', async t => {
  const upstream = await createRouterUpstream({ deadlineAt: Date.now() + 5000, deniedOrigin: 'http://127.0.0.1:1' }); t.after(() => upstream.close());
  for (let arrival = 1; arrival <= 7; arrival++) {
    const turn = Math.ceil(arrival / 2), batch = { batchId: `batch-${turn}`, text: turn === 3 ? '@peer-fixed T14_FIXED_USER' : routerInputs[turn - 1], source: ['kickoff', 'gitea', 'mattermost'][turn - 1], kind: turn === 3 ? 'mention' : 'external', eventId: turn === 3 ? 'post:fixed' : 'comment:7', context: 'T13 fixed fact' };
    const observed = { turn: turn === 3 ? 2 : turn, cwd: '/workspace/project', pushedCommit: 'a'.repeat(40), event: { batchId: batch.batchId, source: batch.source, eventId: batch.eventId, text: batch.text }, untrackedBase64: 'AP9BCg==' };
    const response = await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', max_output_tokens: 128, input: [
      { role: 'user', content: `instruction\n${JSON.stringify(batch)}` }, ...(arrival % 2 ? [] : [{ type: 'function_call_output', call_id: `router_${turn}`, output: JSON.stringify(observed) }]),
    ] }) });
    const text = await response.text(); assert.match(text, arrival === 7 ? /response.failed/ : /response.completed/);
  }
  assert.equal(upstream.receipt().accepted, 6); assert.equal(upstream.receipt().arrivals, 7); assert.equal(upstream.receipt().evidence.length, 3);
});

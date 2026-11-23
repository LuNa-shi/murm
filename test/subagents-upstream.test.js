import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeSimple, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import { createSubagentsUpstream, delegationCommand, childCommand } from './fixtures/subagents-upstream.js';
import { execute } from './fixtures/notes-installed-package.js';

test('subagents native programs parse and terminal fixture failures are not retried by Pi', async t => {
  for (const command of [delegationCommand(), childCommand(false), childCommand(true)]) {
    const program = command.split("<<'SUBAGENTS'\n")[1].split('\nSUBAGENTS')[0];
    await execute('python3', ['-c', 'import ast,sys;ast.parse(sys.argv[1])', program]);
  }
  const upstream = await createSubagentsUpstream(); t.after(() => upstream.close());
  const model = { id: 'k3', name: 'fixed', provider: 'kimi_proxy', api: 'openai-responses', baseUrl: upstream.url.replace(/\/responses$/, ''), reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 512 };
  const failed = await completeSimple(model, { messages: [{ role: 'user', content: 'invalid-role', timestamp: 0 }] }, { apiKey: 'local-only', maxTokens: 128 });
  assert.equal(failed.stopReason, 'error'); assert.equal(isRetryableAssistantError(failed), false);
  assert.match(failed.errorMessage, /SUBAGENTS_FIXTURE_FAILED/); assert.equal(upstream.receipt().arrivals, 1);
});

test('fixed local script adopts both child results and an original child followup in eleven Responses', async t => {
  const observations = [];
  const upstream = await createSubagentsUpstream({ observeSessions: async phase => observations.push(phase) }); t.after(() => upstream.close());
  const send = async input => {
    const response = await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input }) });
    const body = await response.text(); assert.doesNotMatch(body, /response.failed/); return body;
  };
  const parent = [{ role: 'user', content: 'SUBAGENTS_PARENT' }];
  const child = role => [{ role: 'user', content: `SUBAGENTS_CHILD_${role}` }];
  const output = (call_id, row) => ({ type: 'function_call_output', call_id, output: JSON.stringify(row) });
  const identity = { cwd: '/workspace/project', process: { pid: 21, starttime: '123' }, recursionDenied: true };
  const results = [{ childId: 'a', eventSeq: 1, outcome: 'completed', output: 'Validation checks input shape before side effects.' }, { childId: 'b', eventSeq: 1, outcome: 'completed', output: 'Authentication establishes the caller identity.' }];
  await send(parent);
  for (const role of ['A', 'B']) { await send(child(role)); await send([...child(role), output(`child_${role}_1`, identity)]); }
  await send([...parent, output('delegate', { children: [{ id: 'a' }, { id: 'b' }], negativeChecks: [true, true, true, true, true] })]);
  const withResults = [...parent, ...results.map(row => ({ role: 'user', content: JSON.stringify(row) }))];
  await send(withResults);
  await send(child('A')); await send([...child('A'), output('child_A_3', { ...identity, sessionFile: 'persisted-native.jsonl' })]);
  await send([...withResults, output('followup', { status: 'accepted', inputId: 'same-child' })]);
  const final = await send([...withResults, { role: 'user', content: JSON.stringify({ childId: 'a', eventSeq: 2, outcome: 'completed', output: 'Followup: authorization separately checks what this caller may do.' }) }]);
  assert.match(final, /Request validation checks data shape/);
  assert.deepEqual(observations, ['before-followup', 'final']);
  const receipt = upstream.receipt(); assert.equal(receipt.arrivals, 11); assert.equal(receipt.accepted, 11); assert.equal(receipt.results.length, 3); assert.equal(receipt.native.length, 3);
});

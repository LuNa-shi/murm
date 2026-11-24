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

const modelFor = upstream => ({ id: 'k3', name: 'fixed', provider: 'kimi_proxy', api: 'openai-responses', baseUrl: upstream.url.replace(/\/responses$/, ''), reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 512 });
const user = text => ({ role: 'user', content: [{ type: 'input_text', text }] });

async function transcript(t, alterFinal) {
  const observations = [];
  const upstream = await createSubagentsUpstream({ observeSessions: async phase => observations.push(phase) }); t.after(() => upstream.close());
  const send = async input => {
    const response = await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input }) });
    const body = await response.text(); assert.doesNotMatch(body, /response.failed/); return body;
  };
  const parent = [user('SUBAGENTS_PARENT')];
  const child = role => [user(`SUBAGENTS_CHILD_${role}`)];
  const output = (call_id, row) => ({ type: 'function_call_output', call_id, output: JSON.stringify(row) });
  const identity = { cwd: '/workspace/project', process: { pid: 21, starttime: '123' }, recursionDenied: true };
  const results = [{ childId: 'a', eventSeq: 1, outcome: 'completed', output: 'Validation checks input shape before side effects.' }, { childId: 'b', eventSeq: 1, outcome: 'completed', output: 'Authentication establishes the caller identity.' }];
  await send(parent);
  for (const role of ['A', 'B']) { await send(child(role)); await send([...child(role), output(`child_${role}_1`, identity)]); }
  await send([...parent, output('delegate', { children: [{ id: 'a' }, { id: 'b' }], negativeChecks: [true, true, true, true, true] })]);
  const withResults = [...parent, ...results.map(row => user(JSON.stringify(row)))];
  await send(withResults);
  await send(child('A')); await send([...child('A'), output('child_A_3', { ...identity, sessionFile: 'persisted-native.jsonl' })]);
  await send([...withResults, output('followup', { status: 'accepted', inputId: 'same-child' })]);
  const finalInput = [...withResults, user(JSON.stringify({ childId: 'a', eventSeq: 2, outcome: 'completed', output: 'Followup: authorization separately checks what this caller may do.' }))];
  if (alterFinal) {
    const response = await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: alterFinal(finalInput) }) });
    assert.match(await response.text(), /response.failed/);
    assert.equal(upstream.receipt().failure.stage, 'parent-results');
    assert.deepEqual(observations, ['before-followup']);
    return;
  }
  // Exercise the installed Pi converter and parser, rather than assuming the
  // native wire representation of the final context in this positive case.
  const final = await completeSimple(modelFor(upstream), { messages: finalInput.map(row => ({ role: 'user', content: row.content[0].text, timestamp: 0 })) }, { apiKey: 'local-only', maxTokens: 512 });
  assert.equal(final.stopReason, 'stop');
  const delivery = JSON.parse(final.content.find(block => block.type === 'text').text);
  assert.match(delivery.summary, /Request validation checks data shape/);
  assert.deepEqual(delivery.conclusions, upstream.receipt().finalResults.map(row => ({ childId: row.childId, eventSeq: row.eventSeq, quote: row.output })));
  assert.deepEqual(observations, ['before-followup', 'final']);
  const receipt = upstream.receipt(); assert.equal(receipt.arrivals, 11); assert.equal(receipt.accepted, 11); assert.equal(receipt.results.length, 3); assert.equal(receipt.native.length, 3);
}

test('fixed local script adopts both child results and an original child followup in eleven Responses', t => transcript(t));

test('final requires all authentic child results in the current typed user context', async t => {
  const mutate = (input, change) => { const rows = structuredClone(input); const result = JSON.parse(rows[3].content[0].text); change(result); rows[3] = user(JSON.stringify(result)); return rows; };
  const cases = {
    'only third result remains': input => [input[0], input[3]],
    'third result omitted': input => input.slice(0, 3),
    'system echo': input => input.map((row, index) => index === 1 ? { ...row, role: 'system' } : row),
    'assistant echo': input => input.map((row, index) => index === 1 ? { ...row, role: 'assistant' } : row),
    'tool echo': input => input.map((row, index) => index === 1 ? { type: 'function_call_output', call_id: 'spoof', output: row.content[0].text } : row),
    'nested user echo': input => input.map((row, index) => index === 1 ? user(JSON.stringify({ echo: JSON.parse(row.content[0].text) })) : row),
    'wrong typed content': input => input.map((row, index) => index === 1 ? { ...row, content: [{ type: 'output_text', text: row.content[0].text }] } : row),
    'untyped string': input => input.map((row, index) => index === 1 ? { ...row, content: row.content[0].text } : row),
    'forged child': input => mutate(input, row => { row.childId = 'forged'; }),
    'altered output': input => mutate(input, row => { row.output += ' altered'; }),
    'changed historical sequence': input => input.map((row, index) => index === 1 ? user(JSON.stringify({ ...JSON.parse(row.content[0].text), eventSeq: 99 })) : row),
    'reused event sequence': input => mutate(input, row => { row.eventSeq = 1; }),
    'wrong outcome': input => mutate(input, row => { row.outcome = 'failed'; }),
    'duplicate result': input => [...input, input[1]],
  };
  for (const [name, alter] of Object.entries(cases)) await t.test(name, subtest => transcript(subtest, alter));
});

test('all arrivals count before parsing and the seventeenth cannot exceed sixteen admitted Responses', async t => {
  let failures = 0;
  const upstream = await createSubagentsUpstream({ onFailure: () => { failures++; } }); t.after(() => upstream.close());
  const parent = [{ role: 'user', content: 'SUBAGENTS_PARENT' }];
  const send = input => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input }) });
  await send(parent);
  await send([...parent, { type: 'function_call_output', call_id: 'delegate', output: JSON.stringify({ children: [{ id: 'a' }, { id: 'b' }], negativeChecks: [true, true, true, true, true] }) }]);
  for (let index = 2; index < 16; index++) await send(parent);
  assert.equal(upstream.receipt().arrivals, 16); assert.equal(upstream.receipt().accepted, 16);
  const overLimit = await fetch(upstream.url, { method: 'POST', body: 'not-json' });
  assert.match(await overLimit.text(), /response.failed/);
  await send(parent);
  assert.equal(upstream.receipt().arrivals, 18); assert.equal(upstream.receipt().accepted, 16);
  assert.deepEqual(upstream.receipt().failure, { code: 'SUBAGENTS_FIXTURE_FAILED', stage: 'bounds', ordinal: 17 });
  assert.equal(failures, 1);
});

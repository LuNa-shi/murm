import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createTaskPoolTakeUpstream, flatTakeCommand } from './fixtures/taskpool-task-upstream.js';
import { completeSimple, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';

test('fixed native discovery program parses without running any model or sandbox operation', () => {
  const command = flatTakeCommand('fixed-task', 'TASKPOOL_T11_A');
  const script = command.slice(command.indexOf('\n') + 1, command.lastIndexOf('TASKPOOL_FIXED_TAKE'));
  const constants = JSON.parse(execFileSync('python3', ['-c', 'import ast,sys,json; a=ast.parse(sys.stdin.read()); print(json.dumps([n.value for n in ast.walk(a) if isinstance(n,ast.Constant) and isinstance(n.value,str) and (n.value.startswith("fixed λ") or n.value.startswith("FIXED_NATIVE_WRITE"))]))'], { input: script, encoding: 'utf8' }));
  assert.deepEqual(constants.sort(), ['FIXED_NATIVE_WRITE\n', 'FIXED_NATIVE_WRITE\n', 'fixed λ\n'].sort());
  assert.equal(script.includes('glob.glob'), false, 'First-turn process continuity must not require an already flushed Session file');
});

test('native taskpool fixture keeps failed evidence sticky and counts rejected upstream arrivals', async t => {
  const upstream = await createTaskPoolTakeUpstream('fixed-task', Date.now() + 5000); t.after(() => upstream.close());
  const send = input => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input }) });
  await (await send([{ role: 'user', content: 'TASKPOOL_T11_A' }])).text();
  const bad = await send([{ role: 'user', content: 'TASKPOOL_T11_A' }, { type: 'function_call_output', call_id: 'call_TASKPOOL_T11_A', output: '{}' }]);
  assert.equal(bad.status, 200); assert.match(await bad.text(), /response.failed/);
  const firstFailure = upstream.receipt().firstFailure;
  assert.deepEqual(firstFailure, { stage: 'tool-evidence', arrival: 2, input: 'TASKPOOL_T11_A', turn: 2 });
  const later = await send([{ role: 'user', content: 'TASKPOOL_T11_B' }]); assert.equal(later.status, 200); assert.match(await later.text(), /response.failed/);
  assert.equal(upstream.receipt().arrivals, 3); assert.equal(upstream.receipt().failure, 'FIXED_TASKPOOL_TAKE_FAILED');
  assert.deepEqual(upstream.receipt().evidence, {});
  assert.deepEqual(upstream.receipt().firstFailure, firstFailure);
});

test('native fixture errors retain only a fixed first diagnostic and terminate through Pi without retry classification', async t => {
  const upstream = await createTaskPoolTakeUpstream('fixed-task', Date.now() + 5000); t.after(() => upstream.close());
  const model = { id: 'k3', name: 'fixed', provider: 'kimi_proxy', api: 'openai-responses',
    baseUrl: upstream.url.replace(/\/responses$/, ''), reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 };
  const failed = await completeSimple(model, { messages: [{ role: 'user', content: 'not-the-fixed-input', timestamp: 0 }] },
    { apiKey: 'fixed-local-only', maxTokens: 128 });
  assert.equal(failed.stopReason, 'error'); assert.match(failed.errorMessage, /FIXED_TASKPOOL_TAKE_FAILED/);
  assert.equal(isRetryableAssistantError(failed), false);
  assert.equal(upstream.receipt().arrivals, 1);
  assert.deepEqual(upstream.receipt().firstFailure, { stage: 'fixed-input', arrival: 1 });
});

test('native exceptions produce structured fixed stages instead of unparseable traceback text', () => {
  const command = flatTakeCommand('fixed-task', 'TASKPOOL_T11_A');
  const script = command.slice(command.indexOf('\n') + 1, command.lastIndexOf('TASKPOOL_FIXED_TAKE'));
  // A deterministic absent native workDir reproduces a pre-discovery failure;
  // no sandbox, swarm CLI or network request is executed by this check.
  const output = execFileSync('python3', ['-c', script], { cwd: '/tmp', encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { fixture_failure: { stage: 'native-context', kind: 'AssertionError' } });
});

test('four fixed responses require one original correlated tool result per competing Agent', async t => {
  const upstream = await createTaskPoolTakeUpstream('fixed-task', Date.now() + 5000); t.after(() => upstream.close());
  const send = (id, checks) => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [
    { role: 'user', content: [{ type: 'input_text', text: id }] },
    ...(checks ? [{ type: 'function_call_output', call_id: `call_${id}`, output: JSON.stringify(checks) }] : []),
  ] }) });
  for (const id of ['TASKPOOL_T11_A', 'TASKPOOL_T11_B']) assert.match(await (await send(id)).text(), /response.function_call_arguments.done/);
  const common = { readonly_before: true, discovery: true, same_process: true, process_digest: 'a'.repeat(64) };
  await (await send('TASKPOOL_T11_A', { ...common, role: 'winner', pinned_bytes: true, material_bytes: true, native_write: true,
    prepared_digest: 'b'.repeat(64), execution_fence: 1, prepared_version: 1 })).text();
  await (await send('TASKPOOL_T11_B', { ...common, role: 'loser', conflict_preserves_readonly: true })).text();
  assert.equal(upstream.receipt().arrivals, 4); assert.equal(upstream.receipt().accepted, 4);
  assert.equal(upstream.receipt().failure, undefined); assert.equal(Object.keys(upstream.receipt().evidence).length, 2);
});

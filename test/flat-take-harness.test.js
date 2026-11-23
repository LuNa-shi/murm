import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createFlatTakeUpstream, flatTakeCommand } from './fixtures/flat-task-upstream.js';

test('fixed native discovery program parses without running any model or sandbox operation', () => {
  const command = flatTakeCommand('fixed-task', 'FLAT_T11_A');
  const script = command.slice(command.indexOf('\n') + 1, command.lastIndexOf('FLAT_FIXED_TAKE'));
  execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: script });
});

test('native flat fixture keeps failed evidence sticky and counts rejected upstream arrivals', async t => {
  const upstream = await createFlatTakeUpstream('fixed-task', Date.now() + 5000); t.after(() => upstream.close());
  const send = input => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input }) });
  await (await send([{ role: 'user', content: 'FLAT_T11_A' }])).text();
  const bad = await send([{ role: 'user', content: 'FLAT_T11_A' }, { type: 'function_call_output', call_id: 'call_FLAT_T11_A', output: '{}' }]);
  assert.equal(bad.status, 400); await bad.text();
  const later = await send([{ role: 'user', content: 'FLAT_T11_B' }]); assert.equal(later.status, 400); await later.text();
  assert.equal(upstream.receipt().arrivals, 3); assert.equal(upstream.receipt().failure, 'FIXED_FLAT_TAKE_FAILED');
  assert.deepEqual(upstream.receipt().evidence, {});
});

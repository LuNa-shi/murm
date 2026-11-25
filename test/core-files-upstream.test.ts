import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFilesUpstream, stages } from './fixtures/core-files-upstream.js';

test('file handoff fixture requires every expected guest assertion before reporting success', async t => {
  const upstream = await createFilesUpstream(); t.after(() => upstream.close());
  const input = [{ role: 'user', content: 'F06_B1' }];
  const send = items => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: items }) });
  const tool = await send(input); assert.match(await tool.text(), /must-not-exist/);
  const checks = Object.fromEntries(stages.get('F06_B1').keys.map(key => [key, true]));
  const result = await send([...input, { type: 'function_call_output', call_id: 'call_F06_B1', output: JSON.stringify(checks) }]);
  assert.match(await result.text(), /F06_B1_OK/);
  assert.deepEqual(upstream.receipt().evidence.F06_B1, checks);
});

test('file handoff fixture rejects absent or false physical evidence with sanitized diagnostics', async t => {
  for (const output of ['{}', '{"workdir":false}']) {
    const upstream = await createFilesUpstream(); t.after(() => upstream.close());
    const input = [{ role: 'user', content: 'F06_B1' }];
    const send = items => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: items }) });
    await (await send(input)).text();
    const result = await send([...input, { type: 'function_call_output', call_id: 'call_F06_B1', output }]);
    assert.equal(result.status, 400);
    assert.deepEqual(await result.json(), { error: { message: 'CONTROLLED_FILES_FAILED' } });
    assert.deepEqual(upstream.receipt().evidence, {});
    const afterFailure = await send([{ role: 'user', content: 'F06_B2' }]);
    assert.equal(afterFailure.status, 400);
    await afterFailure.text();
    assert.equal(upstream.receipt().arrivals, 3);
    assert.equal(upstream.receipt().receipts.length, 1);
  }
});

test('all fixed guest programs parse as Python without executing a sandbox or file operation', async () => {
  const { execFileSync } = await import('node:child_process');
  const { filesCommand } = await import('./fixtures/core-files-upstream.js');
  for (const { stage } of stages.values()) {
    const command = filesCommand(stage);
    const source = command.slice(command.indexOf('\n') + 1, command.lastIndexOf('CORE_FILES_CHECK'));
    execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source, timeout: 3000 });
  }
});

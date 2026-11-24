import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';

const exec = promisify(execFile);

async function fixture(t) {
  const tasks = new TaskService();
  const context = new ContextService(tasks.db, { taskService: tasks });
  tasks.createMission({ mission_id: 'mission:cli-contract', goal: 'Verify public collaboration contracts' });
  const registry = createBuiltinServiceRegistry({ taskService: tasks, contextService: context });
  const bridges = [];
  const events = [];
  t.after(async () => { await Promise.all(bridges.map(bridge => bridge.stop())); tasks.close(); });
  async function bot(id) {
    const bridge = new ServicesBridge({ taskService: tasks, contextService: context, registry, runtime: {}, coreId: id,
      logger: { append: event => events.push(event) } });
    bridges.push(bridge);
    await bridge.start();
    tasks.registerBot({ botId: id, missionId: 'mission:cli-contract', coreId: id,
      selectionDeadline: new Date(Date.now() + 120_000).toISOString() });
    const env = bridge.startBotIdentity(id);
    tasks.recordBotSandbox(id, { provider: 'controlled', sandboxId: id });
    tasks.markBotReady(id);
    return async (...args) => {
      const { stdout } = await exec(process.execPath, ['scripts/swarm.mjs', ...args], {
        cwd: process.cwd(), env: { ...process.env, ...env }, timeout: 10_000,
      });
      return JSON.parse(stdout);
    };
  }
  return { tasks, bot, events };
}

test('Bridge audit pairs physical dispatches independently of reused request IDs', async t => {
  const { bot, events } = await fixture(t);
  const reader = await bot('reader');
  await Promise.all([reader('task', 'list', '--request-id', 'same-read'), reader('task', 'list', '--request-id', 'same-read')]);
  const starts = events.filter(event => event.event === 'bridge.start' && event.operation_id === 'same-read');
  const completions = events.filter(event => event.event === 'bridge.complete' && event.operation_id === 'same-read');
  assert.equal(starts.length, 2);
  assert.equal(new Set(starts.map(event => event.bridge_call_id)).size, 2);
  assert.deepEqual(completions.map(event => event.bridge_call_id).sort(), starts.map(event => event.bridge_call_id).sort());
  assert.equal(events.filter(event => event.event === 'bridge.response_sent' && event.operation_id === 'same-read').length, 2);
});

test('CLI through authenticated Bridges reads host-supplied tasks and revises their contract with history', async t => {
  const { tasks, bot } = await fixture(t);
  const author = await bot('author');
  const editor = await bot('editor');
  const contract = { mission_id: 'mission:cli-contract', summary: 'Boundary lemma', gap: 'The fixed objective still lacks its boundary implication', expected_output: 'A checked boundary lemma', acceptance_conditions: ['The implication has check evidence'], priority: 'medium' };
  const one = tasks.createTask(contract);
  const two = tasks.createTask({ ...contract, summary: 'Alternative argument' });
  assert.notEqual(one.task.task_id, two.task.task_id);
  assert.equal(one.task.gap, 'The fixed objective still lacks its boundary implication');
  assert.equal(one.task.priority_level, 'medium');
  assert.equal(tasks.getBot('author').state, 'UNBOUND');
  const changed = await editor('task', 'revise', one.task.task_id,
    '--expected-spec-version', String(one.task.spec_version), '--expected-state-version', String(one.task.state_version),
    '--reason', 'This now blocks the available integration', '--changes', '{"priority":"high"}', '--request-id', 'revision-one');
  assert.equal(changed.task.priority_level, 'high');
  const page = await author('task', 'view', one.task.task_id, '--contract-history-limit', '1');
  assert.equal(page.contract_history.length, 1);
  const next = await author('task', 'view', one.task.task_id,
    '--contract-history-after-version', String(page.contract_history_page.next_after_version));
  assert.equal(next.contract_history[0].contract.priority_level, 'high');
  await assert.rejects(editor('task', 'revise', one.task.task_id,
    '--expected-spec-version', String(one.task.spec_version), '--expected-state-version', String(one.task.state_version),
    '--reason', 'A stale edit', '--changes', '{"priority":"low"}', '--request-id', 'stale'), error => {
    assert.equal(JSON.parse(error.stderr.trim().split('\n').at(-1)).code, 'STALE_VERSION');
    return true;
  });
  const cancelled = await editor('task', 'cancel', two.task.task_id,
    '--expected-spec-version', String(two.task.spec_version), '--expected-state-version', String(two.task.state_version),
    '--reason', 'The first responsibility now covers this case', '--request-id', 'cancel-second');
  assert.equal(cancelled.task.state, 'CANCELED');
});

test('CLI process preserves service retryability and request diagnostic fields', async t => {
  const server = createServer((request, response) => {
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: { code: 'WORKSPACE_BUSY', message: 'An admitted save is in progress',
      retryable: false, request_id: 'save-original', details: { active_operation_id: 'save-original', next_operation: 'workspace_status' } } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  await assert.rejects(exec(process.execPath, ['scripts/swarm.mjs', 'workspace', 'save', '--request-id', 'save-original'], {
    env: { ...process.env, SWARMENV_BRIDGE_URL: `http://127.0.0.1:${server.address().port}`, SWARMENV_BRIDGE_TOKEN: 'fixture' },
  }), error => {
    const result = JSON.parse(error.stderr.trim());
    assert.equal(result.retryable, false);
    assert.equal(result.request_id, 'save-original');
    assert.equal(result.details.next_operation, 'workspace_status');
    assert.equal(error.code, 2);
    return true;
  });
});

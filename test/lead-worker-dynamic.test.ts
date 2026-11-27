import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { transport } from './fixtures/core-agent-service-backend.js';
import { decodeFileSeed, partialDigest } from '../scripts/core-file-seed.js';

const execute = promisify(execFile);
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js'))
    return { url: new URL('./fixtures/lead-worker-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createLeadWorkerHarness } = await import('../src/harnesses/lead-worker/index.js');
hook.deregister();

test('Board work wakes original Agents and a ready checker on normal CLI bindings', { timeout: 40_000 }, async t => {
  transport.reset();
  transport.collectable = true;
  const directory = await mkdtemp(join(tmpdir(), 'murm-dynamic-'));
  const commit = 'a'.repeat(40);
  const payload = 'fixed content';
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const body = path.includes('/branches/') ? { commit: { id: commit } } : {
      path: path.split('/contents/').at(-1), size: payload.length, type: 'file',
      encoding: 'base64', content: Buffer.from(payload).toString('base64'),
    };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const address = Object.values(networkInterfaces()).flat().find(row => row.family === 'IPv4' && !row.internal).address;
  const origin = `http://${address}:${server.address().port}`;
  const repositoryUrl = `${origin}/owner/repo.git`;
  const team = {};
  transport.onSpawn = options => { team[options.options.profile] = options.agentId; };
  const actors = Object.fromEntries(['lead', 'helper1', 'helper2', 'checker'].map(role => [role, {
    accountId: role, username: role, token: `private-${role}`, branch: role, binding: `test:${role}`,
  }]));
  const source = { 'checker.mjs': { encoding: 'utf8', data: 'frozen source' } };
  transport.onSnapshot = (agentId, { requestId, paths }) => {
    assert.equal(agentId, team.lead);
    assert.deepEqual(paths, ['checker.mjs']);
    return { requestId, version: 1, scope: 'partial', digest: partialDigest(decodeFileSeed(source).digest), files: source };
  };
  let deployments = 0, calls = 0, verify = 0, removed = 0;
  let harness;
  let error;
  const workers = new Set();
  const claimed = Promise.withResolvers();
  const workReleased = Promise.withResolvers();
  t.after(async () => {
    claimed.resolve();
    workReleased.resolve();
    await harness?.close({ timeoutMs: 2000 });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  harness = await createLeadWorkerHarness({
    runId: 'test', outputDir: directory, image: 'test', sandbox: {}, turnTimeoutMs: null, workTimeoutMs: 1_800_000,
    prepare: () => ({ runId: 'test', origin, repository: { owner: 'owner', name: 'repo' }, repositoryUrl,
      actors: { lead: actors.lead, helper1: actors.helper1, helper2: actors.helper2 }, prepareMember: () => actors.checker }),
    dynamic: {
      initialFiles: {}, goal: 'Deliver orders',
      async deploy({ manifest, source: frozen, resources }) {
        assert.equal(Buffer.from(frozen).toString(), 'frozen source');
        deployments++;
        resources.own({ kind: 'checking-container', id: 'fixture', close: () => { removed++; } });
        return { deploymentRef: 'fixture', registration: { manifest, adapter: { invoke: () => ({ calls: ++calls }) } } };
      },
      async verifyFinal(input) {
        verify++;
        assert.equal(input.sha256, sha256);
        assert.equal(input.commit, commit);
        return { ok: true };
      },
    },
  });
  assert.deepEqual(Object.keys(team), ['lead', 'helper1', 'helper2']);
  assert.equal(transport.spawns.get(team.helper1).options.parentId, team.lead);
  let serial = 0;
  const call = async (role, service, operation, input = {}, stableId) => {
    const requestId = stableId ?? `test-${++serial}`;
    const file = join(directory, `input-${++serial}.json`);
    await writeFile(file, JSON.stringify(input));
    const { credentials } = transport.spawns.get(team[role]);
    const result = await execute(process.execPath, [new URL('../scripts/swarm.js', import.meta.url).pathname,
      service, operation, '--input', file, '--request-id', requestId], {
      env: { ...process.env, ...credentials.environment, ...credentials.secretEnvironment }, timeout: 8000,
    });
    return JSON.parse(result.stdout);
  };
  const board = (role, op, data) => call(role, 'board', op, data);
  const check = role => call(role, 'orders-check', 'check_orders', { jsonl: '{}' });
  const proof = path => ({ path, bytes: payload.length, sha256, commit });
  function arm() {
    transport.next = async inputId => {
      arm();
      const input = transport.submissions.get(inputId);
      const role = Object.keys(team).find(key => team[key] === input.agentId);
      try {
        const state = await board(role, 'read');
        if (role !== 'lead') {
          const task = state.subtasks.find(row => row.state === 'ready' && row.assignee_ids.includes(input.agentId));
          assert.ok(task);
          const { revision } = await board(role, 'claim', { subtask_id: task.id, expected_revision: task.revision });
          if (task.id !== 'check' && task.id !== 'fix') {
            workers.add(role);
            if (workers.size === 2) claimed.resolve();
            await workReleased.promise;
          }
          if (role === 'checker') {
            assert.equal((await check(role)).calls, 2);
            await board(role, 'note', { subtask_id: task.id, text: 'Malformed line should be reported on its original row.' });
          }
          await board(role, 'complete', { subtask_id: task.id, expected_revision: revision, direction_id: state.directions.at(-1).seq, delivery: proof(task.path) });
        } else if (JSON.parse(input.input).type === 'dynamic-goal') {
          await board(role, 'announce', { text: 'Implement JSONL scanner', feedback_ids: [] });
          for (const helper of ['helper1', 'helper2']) {
            await board(role, 'create_subtask', { id: helper, title: helper, path: `${helper}.mjs`, assignee_ids: [team[helper]] });
          }
          await claimed.promise;
          const deployment = { source_path: 'checker.mjs', manifest: { id: 'orders-check', title: 'Check', purpose: 'Validate', operation: 'check_orders' } };
          const first = await call(role, 'manage', 'service_deploy', deployment, 'deploy');
          assert.deepEqual(await call(role, 'manage', 'service_deploy', deployment, 'deploy'), first);
          await assert.rejects(check('helper1'));
          const grant = { agent_id: team.helper1, service_id: 'orders-check', operations: ['check_orders'] };
          await call(role, 'agent', 'grant', grant);
          assert.equal((await check('helper1')).calls, 1);
          await call(role, 'agent', 'revoke', grant);
          await assert.rejects(check('helper1'));
          await call(role, 'manage', 'profile_register', { id: 'checker', prompt: 'Review original rows', check_service_id: 'orders-check' });
          const member = await call(role, 'team', 'spawn_member', { profile: 'checker' }, 'join-member');
          assert.equal(member.status, 'ready', member.error);
          assert.equal(member.agentId, team.checker);
          assert.deepEqual(await call(role, 'team', 'member_get', { request_id: 'join-member' }), member);
          assert.equal(transport.spawns.get(team.checker).options.parentId, team.lead);
          await board(role, 'create_subtask', { id: 'check', title: 'Check row indexes', path: 'feedback.txt', assignee_ids: [team.checker] });
          workReleased.resolve();
        } else {
          const feedback = state.notes.find(row => row.actor === team.checker);
          if (feedback && !state.subtasks.some(row => row.id === 'fix')) {
            await board(role, 'create_subtask', { id: 'fix', title: feedback.text, path: 'fixed.mjs', assignee_ids: [team.helper1] });
          } else if (feedback && state.subtasks.length === 4 && state.subtasks.every(row => row.state === 'complete')) {
            await board(role, 'submit', { delivery: proof('orders.mjs'), feedback_ids: [feedback.seq] });
          }
        }
        transport.spawns.get(input.agentId).onEvent({ type: 'settled', outcome: 'completed', output: 'Settled' });
      } catch (failure) {
        error ??= failure;
        workReleased.resolve();
        transport.spawns.get(input.agentId).onEvent({ type: 'settled', outcome: 'failed', error: { code: 'FIXTURE_FAILED', message: 'Fixture failed' } });
      }
    };
  }
  arm();
  const result = await harness.runDynamic().catch(failure => { throw error ?? failure; });
  assert.equal(result.verdict.ok, true);
  assert.equal(result.harness.board.subtasks.find(row => row.id === 'fix').owner, team.helper1);
  assert.equal(result.harness.inputs.filter(row => row.agentId === team.helper1).length, 2);
  assert.equal(result.harness.board.members[team.checker].ready, true);
  assert.deepEqual([deployments, calls, verify], [1, 2, 1]);
  assert.equal((await harness.close({ timeoutMs: 4000 })).cleanup, 'complete');
  assert.equal(removed, 1);
});

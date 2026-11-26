import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { ServiceRegistry } from '../src/core/services.js';
import { transport } from './fixtures/core-agent-service-backend.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/core-agent-service-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createRuntime } = await import('@murm/core'); hooks.deregister();
async function setup(t, options = {}) {
  transport.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'agent-service-'));
  const base = { prompt: 'fixed', model: 'default', image: 'test', writable: true, services: {} };
  const runtime = await createRuntime({ sandbox: {}, profiles: {
    parent: { ...base, services: { agent: ['spawn', 'get', 'send', 'stop'] }, spawnProfiles: ['child'] }, child: base,
  }, services: new ServiceRegistry(), maxAgents: 8, ...options, outputDir });
  t.after(async () => { assert.equal((await runtime.close()).cleanup, 'complete'); await rm(outputDir, { recursive: true, force: true }); });
  const parent = await runtime.spawn({ profile: 'parent', requestId: 'parent', secretEnv: { PARENT_SECRET: 'private-parent' }, bindings: { agent: 'parent-account' } });
  const call = async (operation, payload, id = 'fixed', caller = parent.id) => {
    const credentials = transport.spawns.get(caller).credentials;
    const response = await fetch(transport.url + '/call', { method: 'POST', headers: { authorization: `Bearer ${credentials.secretEnvironment.MURM_BRIDGE_TOKEN}` }, body: JSON.stringify({ service_id: 'agent', operation, operation_id: id, payload }) });
    return response.json();
  };
  return { runtime, parent, call };
}
test('parent discovers built-in control and creates exactly one child with no initial input', async t => {
  const { runtime, parent, call } = await setup(t);
  const first = await call('spawn', { profile: 'child' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result.agent.parentId, parent.id); assert.equal(first.result.initialInput, null);
  const childStartup = transport.spawns.get(first.result.agent.id);
  assert.equal(childStartup.options.secretEnv, undefined); assert.equal(childStartup.options.bindings, undefined);
  assert.equal(childStartup.options.writable, undefined); assert.equal(childStartup.profile.writable, true);
  assert.equal(childStartup.profile.image, 'test');
  assert.deepEqual(await call('spawn', { profile: 'child' }), first);
  assert.equal(transport.spawns.size, 2); assert.equal(transport.submissions.size, 0);
  assert.equal((await call('get', { agent_id: first.result.agent.id })).result.id, first.result.agent.id);
  assert.equal((await call('stop', { agent_id: first.result.agent.id })).result.cleanup, 'complete');
  assert.equal((await runtime.get(parent.id)).status, 'idle');
});

test('operation permissions, allowed Profiles and direct relationships reject before effects', async t => {
  const { runtime, parent, call } = await setup(t);
  for (const payload of [{ profile: 'parent' }, { profile: 'missing' }, { profile: 'child', parentId: 'forged' }, { profile: 'child', secretEnv: { TOKEN: 'x' } }, { profile: 'child', writable: false }, { profile: 'child', files: {} }, { profile: 'child', bindings: {} }, { profile: 'child', collect: {} }]) assert.equal((await call('spawn', payload)).ok, false);
  assert.equal(transport.spawns.size, 1);
  const child = (await call('spawn', { profile: 'child' })).result.agent;
  const sibling = await runtime.spawn({ profile: 'child', parentId: parent.id, requestId: 'sibling' });
  const grandchild = await runtime.spawn({ profile: 'child', parentId: child.id, requestId: 'grandchild' });
  const foreign = await runtime.spawn({ profile: 'parent', requestId: 'other-parent' });
  for (const target of [grandchild.id, foreign.id, 'unknown']) for (const operation of ['get', 'send', 'stop']) assert.equal((await call(operation, { agent_id: target, ...(operation === 'send' ? { input: 'denied' } : {}) })).error.code, 'NOT_ALLOWED');
  assert.equal((await call('stop', { agent_id: parent.id })).error.code, 'NOT_ALLOWED');
  assert.equal((await call('get', { agent_id: sibling.id }, 'read', child.id)).error.code, 'NOT_ALLOWED');
  assert.equal(transport.submissions.size, 0);
  assert.equal((await call('get', { agent_id: parent.id })).result.id, parent.id);
});

test('concurrent spawn preserves initial input identity, relationships and unknown reconciliation', async t => {
  const { runtime, parent, call } = await setup(t);
  const events = [];
  runtime.onEvent(event => events.push({ event, agent: runtime.get(event.agentId) }));
  transport.next = async inputId => {
    const submission = transport.submissions.get(inputId);
    assert.equal((await runtime.get(submission.agentId)).parentId, parent.id);
    transport.spawns.get(submission.agentId).onEvent({ type: 'settled', outcome: 'completed', output: 'quick completion' });
    submission.receipt = { status: 'unknown' };
  };
  const payload = { profile: 'child', input: 'fixed' };
  const [first, duplicate] = await Promise.all([call('spawn', payload), call('spawn', { ...payload, mode: 'steer' })]);
  assert.deepEqual(first, duplicate); assert.equal(first.result.initialInput.status, 'unknown');
  assert.equal(transport.spawns.size, 2); assert.equal(transport.submissions.size, 1);
  assert.equal((await events[0].agent).parentId, parent.id);
  transport.submissions.get(first.result.initialInput.inputId).receipt = { status: 'accepted', disposition: 'started' };
  assert.equal((await call('spawn', payload)).result.initialInput.status, 'accepted');
  assert.equal(transport.submissions.size, 1);
  assert.equal((await call('spawn', { ...payload, input: 'changed' })).error.code, 'CONFLICT');
  assert.equal((await call('send', { agent_id: first.result.agent.id, input: 'next', mode: 'followUp' }, 'follow')).result.status, 'accepted');
  await runtime.send(first.result.agent.id, 'host', { requestId: 'follow' });
  assert.equal(transport.submissions.size, 3);
  assert.deepEqual([...transport.submissions.values()].map(item => item.mode), ['steer', 'followUp', 'steer']);
  await runtime.stop(parent.id);
  assert.notEqual((await runtime.get(first.result.agent.id)).status, 'closed');
  const closed = await runtime.close();
  const rows = (await readFile(closed.evidence.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const childId = first.result.agent.id;
  const childSpawn = rows.find(row => row.type === 'spawn' && row.state === 'registered' && row.agentId === childId);
  assert.equal(childSpawn.source, `agent:${parent.id}`);
  assert.equal(childSpawn.parentId, parent.id);
  const registered = rows.filter(row => row.type === 'input' && row.state === 'registered' && row.agentId === childId);
  assert.deepEqual(registered.map(row => [row.requestId, row.source]), [
    ['fixed', `agent:${parent.id}:initial`], ['follow', `agent:${parent.id}`], ['follow', 'host'],
  ]);
});

test('initial rejection retains child identity and never resubmits the rejected input', async t => {
  const { call, runtime } = await setup(t);
  transport.next = async () => { throw Object.assign(new Error('fixed rejection'), { code: 'NOT_ALLOWED' }); };
  const first = await call('spawn', { profile: 'child', input: 'fixed' });
  assert.equal(first.ok, true); assert.equal(first.result.initialInput.status, 'rejected');
  assert.equal(first.result.initialInput.error.code, 'NOT_ALLOWED');
  assert.equal((await runtime.get(first.result.agent.id)).parentId !== undefined, true);
  assert.deepEqual(await call('spawn', { profile: 'child', input: 'fixed' }), first);
  assert.equal(transport.submissions.size, 1);
  assert.equal((await call('stop', { agent_id: first.result.agent.id })).result.cleanup, 'complete');
});

test('host spawn and each parent have independent request namespaces', async t => {
  const { runtime, call } = await setup(t);
  const other = await runtime.spawn({ profile: 'parent', requestId: 'other' });
  const a = (await call('spawn', { profile: 'child' }, 'same')).result.agent;
  const b = (await call('spawn', { profile: 'child' }, 'same', other.id)).result.agent;
  const host = await runtime.spawn({ profile: 'child', requestId: 'same' });
  assert.equal(new Set([a.id, b.id, host.id]).size, 3);
  await assert.rejects(runtime.spawn({ profile: 'child', requestId: 'missing-parent', parentId: 'absent' }), { code: 'NOT_FOUND' });
  await runtime.stop(other.id);
  await assert.rejects(runtime.spawn({ profile: 'child', requestId: 'closed-parent', parentId: other.id }), { code: 'NOT_ALLOWED' });
});

test('public CLI discovers built-in operations, creates, inspects, continues and stops a child', async t => {
  const { promisify } = await import('node:util'); const { execFile } = await import('node:child_process');
  const execute = promisify(execFile);
  const { parent } = await setup(t);
  const credentials = transport.spawns.get(parent.id).credentials;
  const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
  const cli = async (...args) => (await execute(process.execPath, ['dist/scripts/swarm.js', ...args], { env, timeout: 5000 })).stdout;
  assert.deepEqual(JSON.parse(await cli('service', 'view', 'agent')).capabilities.map(c => c.operation), ['spawn', 'get', 'send', 'stop']);
  assert.match(await cli('agent', 'spawn', '--help'), /initialInput/);
  assert.match(await cli('agent', '--help'), /initialInput/);
  assert.match(await cli('agent'), /initialInput/);
  const child = JSON.parse(await cli('agent', 'spawn', '--profile', 'child', '--request-id', 'cli-child')).agent;
  assert.equal(JSON.parse(await cli('agent', 'get', '--agent-id', child.id)).id, child.id);
  // Text input uses a JSON file/stdin; --input remains the CLI's JSON-file flag.
  const sent = await cli('agent', 'send', '--agent-id', child.id, '--text', 'fixed', '--request-id', 'cli-send');
  assert.equal(JSON.parse(sent).status, 'accepted');
  assert.equal(JSON.parse(await cli('agent', 'stop', '--agent-id', child.id, '--request-id', 'cli-stop')).cleanup, 'complete');
});

test('capacity errors allocate nothing, startup failures preserve the created identity, and close covers a starting child', async t => {
  const { runtime, call } = await setup(t, { maxAgents: 2 });
  transport.onSpawn = async options => { if (options.profile.services.agent === undefined) throw Object.assign(new Error('fixed startup failure'), { code: 'START_FAILED' }); };
  const failed = await call('spawn', { profile: 'child' }, 'failed');
  assert.equal(failed.error.code, 'START_FAILED');
  assert.ok(failed.error.details.agentId); assert.equal(failed.error.details.cleanup, 'pending');
  await runtime.stop(failed.error.details.agentId);
  let release; let started;
  const starting = new Promise(resolve => { started = resolve; });
  transport.onSpawn = async () => { started(); await new Promise(resolve => { release = resolve; }); };
  const pending = call('spawn', { profile: 'child' }, 'starting').catch(() => ({ disconnected: true }));
  await starting;
  assert.equal((await call('spawn', { profile: 'child' }, 'overflow')).error.code, 'CONFLICT');
  assert.equal(transport.spawns.size, 3); // parent, failed resource, current child
  const closing = runtime.close(); release();
  const interrupted = await pending;
  assert.ok(interrupted.disconnected || interrupted.ok === false);
  const receipt = await closing;
  assert.equal(receipt.cleanup, 'complete'); assert.equal(receipt.agents.length, 3);
  assert.ok(receipt.agents.every(agent => agent.cleanup === 'complete'));
});

test('pending stop retries retain the child and global close also retries it', async t => {
  const { runtime, call } = await setup(t);
  const child = (await call('spawn', { profile: 'child' })).result.agent;
  transport.onStop = async id => { if (id === child.id) throw Object.assign(new Error('fixed cleanup blocker'), { code: 'SERVICE_UNAVAILABLE' }); };
  const stopped = await call('stop', { agent_id: child.id }, 'stop');
  assert.equal(stopped.result.cleanup, 'pending'); assert.equal(stopped.result.agentId, child.id);
  assert.equal((await call('get', { agent_id: child.id })).result.status, 'closing');
  transport.onStop = undefined;
  assert.equal((await call('stop', { agent_id: child.id }, 'stop')).result.cleanup, 'complete');
  assert.equal((await runtime.close()).cleanup, 'complete');
});

test('child creation finishes after parent stop but does not admit a late initial input', async t => {
  const { runtime, parent, call } = await setup(t);
  let ready; let release; const created = new Promise(resolve => { ready = resolve; });
  transport.onSpawn = async options => { ready(options.agentId); await new Promise(resolve => { release = resolve; }); };
  const pending = call('spawn', { profile: 'child', input: 'never dispatched' }).catch(() => ({ disconnected: true }));
  const childId = await created;
  await runtime.stop(parent.id); release(); await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.submissions.size, 0); assert.equal((await runtime.get(childId)).status, 'idle');
  assert.equal((await runtime.get(childId)).parentId, parent.id);
});

test('child creation finishing after a parent fatal error cannot send its late initial input', async t => {
  const { runtime, parent, call } = await setup(t);
  let ready; let release;
  const created = new Promise(resolve => { ready = resolve; });
  transport.onSpawn = async options => { ready(options.agentId); await new Promise(resolve => { release = resolve; }); };
  const pending = call('spawn', { profile: 'child', input: 'never dispatched' });
  const childId = await created;
  transport.spawns.get(parent.id).onEvent({ type: 'error', fatal: true,
    error: { code: 'SERVICE_UNAVAILABLE', message: 'irrecoverable event gap', retryable: false } });
  const failure = await pending;
  assert.equal(failure.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(failure.error.details.request_outcome, 'unknown');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.submissions.size, 0);
  assert.equal((await runtime.get(childId)).status, 'idle');
  assert.equal((await runtime.get(childId)).parentId, parent.id);
  assert.equal((await runtime.stop(childId)).cleanup, 'complete');
});

test('a read-only control grant does not authorize spawn, send or stop', async t => {
  const profile = { prompt: 'fixed', model: 'default', image: 'test', writable: true, services: {} };
  const { runtime, parent, call } = await setup(t, { profiles: { parent: { ...profile, services: { agent: ['get'] }, spawnProfiles: ['child'] }, child: profile } });
  const child = await runtime.spawn({ profile: 'child', parentId: parent.id, requestId: 'host-child' });
  assert.equal((await call('get', { agent_id: child.id })).result.id, child.id);
  assert.equal((await call('spawn', { profile: 'child' })).error.code, 'NOT_ALLOWED');
  assert.equal((await call('send', { agent_id: child.id, input: 'denied' })).error.code, 'NOT_ALLOWED');
  assert.equal((await call('stop', { agent_id: child.id })).error.code, 'NOT_ALLOWED');
  assert.equal(transport.spawns.size, 2); assert.equal(transport.submissions.size, 0);
});

test('the public registry cannot override the reserved built-in identity', () => {
  const services = new ServiceRegistry();
  assert.throws(() => services.registerService({ manifest: { id: 'agent' }, adapter: { invoke() {} } }), { code: 'INVALID_CONTRACT' });
});

test('child Profile collection returns actual saved artifact paths through stop and get', async t => {
  const profile = { prompt: 'fixed', model: 'default', image: 'test', writable: true, services: {} };
  const { call } = await setup(t, { profiles: {
    parent: { ...profile, services: { agent: ['spawn', 'stop', 'get'] }, spawnProfiles: ['child'] },
    child: { ...profile, collect: { paths: ['.'], includeGit: false, maxBytes: 1024, required: true } },
  } });
  transport.collectable = true;
  const child = (await call('spawn', { profile: 'child' })).result.agent;
  const stopped = await call('stop', { agent_id: child.id });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.result.artifacts.length, 2);
  assert.match(stopped.result.artifacts[0], /\/artifacts\/manifest.json$/);
  assert.match(stopped.result.artifacts[1], /\/artifacts\/files$/);
  assert.deepEqual((await call('get', { agent_id: child.id })).result.lastStop, stopped.result);
});

for (const size of [4, 8]) test(`public CLI maintains a ${size}-Agent parent tree across two distinct child rounds`, async t => {
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const execute = promisify(execFile);
  const { runtime, parent } = await setup(t, { maxAgents: size });
  const events = [];
  runtime.onEvent(event => events.push(event));
  const cli = async (caller, ...args) => {
    const credentials = transport.spawns.get(caller).credentials;
    const result = await execute(process.execPath, ['dist/scripts/swarm.js', 'agent', ...args], {
      env: { ...process.env, ...credentials.environment, ...credentials.secretEnvironment }, timeout: 5000,
    });
    return JSON.parse(result.stdout);
  };

  const children = [];
  for (let index = 1; index < size; index++) {
    const receipt = await cli(parent.id, 'spawn', '--profile', 'child', '--request-id', `child-${index}`);
    assert.equal(receipt.initialInput, null);
    assert.equal(receipt.agent.parentId, parent.id);
    children.push(receipt.agent.id);
  }
  assert.equal(new Set([parent.id, ...children]).size, size);
  assert.equal(transport.submissions.size, 0);
  await assert.rejects(cli(parent.id, 'spawn', '--profile', 'child', '--request-id', 'over-capacity'), /CONFLICT/);
  assert.equal(transport.spawns.size, size);

  for (const round of [1, 2]) {
    for (const [index, childId] of children.entries()) {
      const requestId = `child-${index + 1}-round-${round}`;
      const input = `fixed child ${index + 1} round ${round}`;
      const sent = await cli(parent.id, 'send', '--agent-id', childId, '--text', input, '--mode', 'followUp', '--request-id', requestId);
      assert.equal(sent.status, 'accepted');
      assert.equal(sent.disposition, 'started');
      assert.deepEqual(await cli(parent.id, 'send', '--agent-id', childId, '--text', input, '--mode', 'followUp', '--request-id', requestId), sent);
      const result = `result child ${index + 1} round ${round}`;
      transport.spawns.get(childId).onEvent({ type: 'settled', outcome: 'completed', output: result });
      const current = await cli(parent.id, 'get', '--agent-id', childId);
      assert.equal(current.id, childId);
      assert.equal(current.parentId, parent.id);
      assert.equal(current.status, 'idle');
      assert.equal(current.latestOutput, result);
    }
  }
  assert.equal(transport.submissions.size, 2 * (size - 1));
  assert.equal(events.filter(event => event.type === 'settled').length, 2 * (size - 1));
  for (const childId of children) {
    assert.deepEqual(events.filter(event => event.agentId === childId && event.type === 'settled').map(event => event.output), [
      `result child ${children.indexOf(childId) + 1} round 1`,
      `result child ${children.indexOf(childId) + 1} round 2`,
    ]);
    const start = transport.spawns.get(childId);
    assert.equal(start.options.secretEnv, undefined);
    assert.equal(start.options.bindings, undefined);
    await assert.rejects(cli(childId, 'get', '--agent-id', parent.id), /NOT_ALLOWED/);
    await assert.rejects(cli(childId, 'spawn', '--profile', 'child', '--request-id', 'recursive'), /NOT_ALLOWED/);
  }
  assert.equal(transport.spawns.size, size);
  assert.equal(transport.submissions.size, 2 * (size - 1));

  await runtime.stop(parent.id);
  for (const childId of children) assert.equal((await runtime.get(childId)).status, 'idle');
  const closed = await runtime.close();
  assert.equal(closed.cleanup, 'complete');
  assert.equal(closed.agents.length, size);
  assert.ok(closed.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete'));
  const evidence = (await readFile(closed.evidence.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const registrations = evidence.filter(row => row.type === 'input' && row.state === 'registered');
  assert.equal(registrations.length, 2 * (size - 1));
  assert.ok(registrations.every(row => row.source === `agent:${parent.id}`));
  assert.equal(new Set(registrations.map(row => row.inputId)).size, 2 * (size - 1));
});

test('host forks live Agents and rejects stopped sources before allocating a Slot', async t => {
  const { runtime, parent } = await setup(t);
  const child = await runtime.spawn({ profile: 'child', forkFrom: parent.id, requestId: 'fork-live' });
  assert.equal(transport.spawns.get(child.id).options.forkFrom, parent.id);
  assert.deepEqual(await runtime.spawn({ profile: 'child', forkFrom: parent.id, requestId: 'fork-live' }), child);
  await assert.rejects(runtime.spawn({ profile: 'child', forkFrom: 'missing', requestId: 'fork-missing' }), { code: 'NOT_FOUND' });
  await runtime.stop(parent.id);
  await assert.rejects(runtime.spawn({ profile: 'child', forkFrom: parent.id, requestId: 'fork-stopped' }), { code: 'NOT_ALLOWED' });
  assert.equal(transport.spawns.size, 2);
});

test('Agent context fork requires the caller Profile permission and uses its own Session', async t => {
  const { runtime, parent, call } = await setup(t);
  assert.equal((await call('spawn', { profile: 'child', fork: true }, 'denied-fork')).error.code, 'NOT_ALLOWED');
  assert.equal(transport.spawns.size, 1);
  const base = { prompt: 'fixed', model: 'default', image: 'test', writable: true, services: {} };
  const allowed = await setup(t, { profiles: {
    parent: { ...base, services: { agent: ['spawn'] }, spawnProfiles: ['child'], allowContextFork: true }, child: base,
  } });
  const result = await allowed.call('spawn', { profile: 'child', fork: true }, 'fork');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(transport.spawns.get(result.result.agent.id).options.forkFrom, allowed.parent.id);
  assert.equal(result.result.agent.parentId, allowed.parent.id);
  assert.equal((await allowed.call('spawn', { profile: 'child', fork: false }, 'fork')).error.code, 'CONFLICT');
});

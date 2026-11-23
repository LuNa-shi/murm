import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { ServiceRegistry } from '@swarmenv/core/services';
import { transport } from './fixtures/core-bot-service-backend.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/core-bot-service-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createRuntime } = await import('@swarmenv/core'); hooks.deregister();
async function setup(t, options = {}) {
  transport.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'bot-service-'));
  const base = { prompt: 'fixed', model: 'default', image: 'test', writable: true, services: {} };
  const runtime = await createRuntime({ backend: {}, profiles: {
    parent: { ...base, services: { bot: ['spawn', 'get', 'send', 'stop'] }, spawnProfiles: ['child'] }, child: base,
  }, services: new ServiceRegistry(), maxBots: 8, ...options, outputDir });
  t.after(async () => { assert.equal((await runtime.close()).cleanup, 'complete'); await rm(outputDir, { recursive: true, force: true }); });
  const parent = await runtime.spawn({ profile: 'parent', requestId: 'parent', secretEnv: { PARENT_SECRET: 'private-parent' }, bindings: { bot: 'parent-account' } });
  const call = async (operation, payload, id = 'fixed', caller = parent.id) => {
    const credentials = transport.spawns.get(caller).credentials;
    const response = await fetch(transport.url + '/call', { method: 'POST', headers: { authorization: `Bearer ${credentials.secretEnvironment.SWARMENV_BRIDGE_TOKEN}` }, body: JSON.stringify({ service_id: 'bot', operation, operation_id: id, payload }) });
    return response.json();
  };
  return { runtime, parent, call };
}
test('parent discovers built-in control and creates exactly one child with no initial input', async t => {
  const { runtime, parent, call } = await setup(t);
  const first = await call('spawn', { profile: 'child' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result.bot.parentId, parent.id); assert.equal(first.result.initialInput, null);
  const childStartup = transport.spawns.get(first.result.bot.id);
  assert.equal(childStartup.options.secretEnv, undefined); assert.equal(childStartup.options.bindings, undefined);
  assert.equal(childStartup.options.writable, undefined); assert.equal(childStartup.profile.writable, true);
  assert.equal(childStartup.profile.image, 'test');
  assert.deepEqual(await call('spawn', { profile: 'child' }), first);
  assert.equal(transport.spawns.size, 2); assert.equal(transport.submissions.size, 0);
  assert.equal((await call('get', { bot_id: first.result.bot.id })).result.id, first.result.bot.id);
  assert.equal((await call('stop', { bot_id: first.result.bot.id })).result.cleanup, 'complete');
  assert.equal((await runtime.get(parent.id)).status, 'idle');
});

test('operation permissions, allowed Profiles and direct relationships reject before effects', async t => {
  const { runtime, parent, call } = await setup(t);
  for (const payload of [{ profile: 'parent' }, { profile: 'missing' }, { profile: 'child', parentId: 'forged' }, { profile: 'child', secretEnv: { TOKEN: 'x' } }, { profile: 'child', writable: false }, { profile: 'child', files: {} }, { profile: 'child', bindings: {} }, { profile: 'child', collect: {} }]) assert.equal((await call('spawn', payload)).ok, false);
  assert.equal(transport.spawns.size, 1);
  const child = (await call('spawn', { profile: 'child' })).result.bot;
  const sibling = await runtime.spawn({ profile: 'child', parentId: parent.id, requestId: 'sibling' });
  const grandchild = await runtime.spawn({ profile: 'child', parentId: child.id, requestId: 'grandchild' });
  const foreign = await runtime.spawn({ profile: 'parent', requestId: 'other-parent' });
  for (const target of [grandchild.id, foreign.id, 'unknown']) for (const operation of ['get', 'send', 'stop']) assert.equal((await call(operation, { bot_id: target, ...(operation === 'send' ? { input: 'denied' } : {}) })).error.code, 'NOT_ALLOWED');
  assert.equal((await call('stop', { bot_id: parent.id })).error.code, 'NOT_ALLOWED');
  assert.equal((await call('get', { bot_id: sibling.id }, 'read', child.id)).error.code, 'NOT_ALLOWED');
  assert.equal(transport.submissions.size, 0);
  assert.equal((await call('get', { bot_id: parent.id })).result.id, parent.id);
});

test('concurrent spawn preserves initial input identity, relationships and unknown reconciliation', async t => {
  const { runtime, parent, call } = await setup(t);
  const events = [];
  runtime.onEvent(event => events.push({ event, bot: runtime.get(event.botId) }));
  transport.next = async inputId => {
    const submission = transport.submissions.get(inputId);
    assert.equal((await runtime.get(submission.botId)).parentId, parent.id);
    transport.spawns.get(submission.botId).onEvent({ type: 'settled', outcome: 'completed', output: 'quick completion' });
    submission.receipt = { status: 'unknown' };
  };
  const payload = { profile: 'child', input: 'fixed' };
  const [first, duplicate] = await Promise.all([call('spawn', payload), call('spawn', { ...payload, mode: 'steer' })]);
  assert.deepEqual(first, duplicate); assert.equal(first.result.initialInput.status, 'unknown');
  assert.equal(transport.spawns.size, 2); assert.equal(transport.submissions.size, 1);
  assert.equal((await events[0].bot).parentId, parent.id);
  transport.submissions.get(first.result.initialInput.inputId).receipt = { status: 'accepted', disposition: 'started' };
  assert.equal((await call('spawn', payload)).result.initialInput.status, 'accepted');
  assert.equal(transport.submissions.size, 1);
  assert.equal((await call('spawn', { ...payload, input: 'changed' })).error.code, 'CONFLICT');
  assert.equal((await call('send', { bot_id: first.result.bot.id, input: 'next', mode: 'followUp' }, 'follow')).result.status, 'accepted');
  await runtime.send(first.result.bot.id, 'host', { requestId: 'follow' });
  assert.equal(transport.submissions.size, 3);
  assert.deepEqual([...transport.submissions.values()].map(item => item.mode), ['steer', 'followUp', 'steer']);
  await runtime.stop(parent.id);
  assert.notEqual((await runtime.get(first.result.bot.id)).status, 'closed');
});

test('initial rejection retains child identity and never resubmits the rejected input', async t => {
  const { call, runtime } = await setup(t);
  transport.next = async () => { throw Object.assign(new Error('fixed rejection'), { code: 'NOT_ALLOWED' }); };
  const first = await call('spawn', { profile: 'child', input: 'fixed' });
  assert.equal(first.ok, true); assert.equal(first.result.initialInput.status, 'rejected');
  assert.equal(first.result.initialInput.error.code, 'NOT_ALLOWED');
  assert.equal((await runtime.get(first.result.bot.id)).parentId !== undefined, true);
  assert.deepEqual(await call('spawn', { profile: 'child', input: 'fixed' }), first);
  assert.equal(transport.submissions.size, 1);
  assert.equal((await call('stop', { bot_id: first.result.bot.id })).result.cleanup, 'complete');
});

test('host spawn and each parent have independent request namespaces', async t => {
  const { runtime, call } = await setup(t);
  const other = await runtime.spawn({ profile: 'parent', requestId: 'other' });
  const a = (await call('spawn', { profile: 'child' }, 'same')).result.bot;
  const b = (await call('spawn', { profile: 'child' }, 'same', other.id)).result.bot;
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
  const cli = async (...args) => (await execute(process.execPath, ['scripts/swarm.mjs', ...args], { env, timeout: 5000 })).stdout;
  assert.deepEqual(JSON.parse(await cli('service', 'view', 'bot')).capabilities.map(c => c.operation), ['spawn', 'get', 'send', 'stop']);
  assert.match(await cli('bot', 'spawn', '--help'), /initialInput/);
  assert.match(await cli('bot', '--help'), /initialInput/);
  assert.match(await cli('bot'), /initialInput/);
  const child = JSON.parse(await cli('bot', 'spawn', '--profile', 'child', '--request-id', 'cli-child')).bot;
  assert.equal(JSON.parse(await cli('bot', 'get', '--bot-id', child.id)).id, child.id);
  // Text input uses a JSON file/stdin; --input remains the CLI's JSON-file flag.
  const sent = await cli('bot', 'send', '--bot-id', child.id, '--text', 'fixed', '--request-id', 'cli-send');
  assert.equal(JSON.parse(sent).status, 'accepted');
  assert.equal(JSON.parse(await cli('bot', 'stop', '--bot-id', child.id, '--request-id', 'cli-stop')).cleanup, 'complete');
});

test('capacity errors allocate nothing, startup failures preserve the created identity, and close covers a starting child', async t => {
  const { runtime, call } = await setup(t, { maxBots: 2 });
  transport.onSpawn = async options => { if (options.profile.services.bot === undefined) throw Object.assign(new Error('fixed startup failure'), { code: 'START_FAILED' }); };
  const failed = await call('spawn', { profile: 'child' }, 'failed');
  assert.equal(failed.error.code, 'START_FAILED');
  assert.ok(failed.error.details.botId); assert.equal(failed.error.details.cleanup, 'pending');
  await runtime.stop(failed.error.details.botId);
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
  assert.equal(receipt.cleanup, 'complete'); assert.equal(receipt.bots.length, 3);
  assert.ok(receipt.bots.every(bot => bot.cleanup === 'complete'));
});

test('pending stop retries retain the child and global close also retries it', async t => {
  const { runtime, call } = await setup(t);
  const child = (await call('spawn', { profile: 'child' })).result.bot;
  transport.onStop = async id => { if (id === child.id) throw Object.assign(new Error('fixed cleanup blocker'), { code: 'SERVICE_UNAVAILABLE' }); };
  const stopped = await call('stop', { bot_id: child.id }, 'stop');
  assert.equal(stopped.result.cleanup, 'pending'); assert.equal(stopped.result.botId, child.id);
  assert.equal((await call('get', { bot_id: child.id })).result.status, 'closing');
  transport.onStop = undefined;
  assert.equal((await call('stop', { bot_id: child.id }, 'stop')).result.cleanup, 'complete');
  assert.equal((await runtime.close()).cleanup, 'complete');
});

test('child creation finishes after parent stop but does not admit a late initial input', async t => {
  const { runtime, parent, call } = await setup(t);
  let ready; let release; const created = new Promise(resolve => { ready = resolve; });
  transport.onSpawn = async options => { ready(options.botId); await new Promise(resolve => { release = resolve; }); };
  const pending = call('spawn', { profile: 'child', input: 'never dispatched' }).catch(() => ({ disconnected: true }));
  const childId = await created;
  await runtime.stop(parent.id); release(); await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.submissions.size, 0); assert.equal((await runtime.get(childId)).status, 'idle');
  assert.equal((await runtime.get(childId)).parentId, parent.id);
});

test('a read-only control grant does not authorize spawn, send or stop', async t => {
  const profile = { prompt: 'fixed', model: 'default', image: 'test', writable: true, services: {} };
  const { runtime, parent, call } = await setup(t, { profiles: { parent: { ...profile, services: { bot: ['get'] }, spawnProfiles: ['child'] }, child: profile } });
  const child = await runtime.spawn({ profile: 'child', parentId: parent.id, requestId: 'host-child' });
  assert.equal((await call('get', { bot_id: child.id })).result.id, child.id);
  assert.equal((await call('spawn', { profile: 'child' })).error.code, 'NOT_ALLOWED');
  assert.equal((await call('send', { bot_id: child.id, input: 'denied' })).error.code, 'NOT_ALLOWED');
  assert.equal((await call('stop', { bot_id: child.id })).error.code, 'NOT_ALLOWED');
  assert.equal(transport.spawns.size, 2); assert.equal(transport.submissions.size, 0);
});

test('the public registry cannot override the reserved built-in identity', () => {
  const services = new ServiceRegistry();
  assert.throws(() => services.registerService({ manifest: { id: 'bot' }, adapter: { invoke() {} } }), { code: 'INVALID_CONTRACT' });
});

test('child Profile collection returns actual saved artifact paths through stop and get', async t => {
  const profile = { prompt: 'fixed', model: 'default', image: 'test', writable: true, services: {} };
  const { call } = await setup(t, { profiles: {
    parent: { ...profile, services: { bot: ['spawn', 'stop', 'get'] }, spawnProfiles: ['child'] },
    child: { ...profile, collect: { paths: ['.'], includeGit: false, maxBytes: 1024, required: true } },
  } });
  transport.collectable = true;
  const child = (await call('spawn', { profile: 'child' })).result.bot;
  const stopped = await call('stop', { bot_id: child.id });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.result.artifacts.length, 2);
  assert.match(stopped.result.artifacts[0], /\/artifacts\/manifest.json$/);
  assert.match(stopped.result.artifacts[1], /\/artifacts\/files$/);
  assert.deepEqual((await call('get', { bot_id: child.id })).result.lastStop, stopped.result);
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { provider } from './fixtures/core-pi-transport.js';

// Controlled OpenSandbox and Docker boundary, with the actual Core adapter.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/core/pi-opensandbox-backend.js') &&
      /\/runtime\/(opensandbox-manager|docker-bot-network|docker-bot-disk)\.js$/.test(specifier)) {
    return { url: new URL('./fixtures/core-pi-transport.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createRuntime } = await import('@swarmenv/core');
const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
const { ServiceRegistry } = await import('@swarmenv/core/services');
hooks.deregister();

async function setup(t) {
  provider.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'core-pi-input-'));
  const runtime = await createRuntime({
    backend: createPiOpenSandboxBackend({
      sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' },
      bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
      modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
    }),
    profiles: { worker: { prompt: 'fixed', model: 'default', image: 'test', writable: true, services: {} } },
    services: new ServiceRegistry(), maxBots: 1, outputDir,
  });
  t.after(async () => { await runtime.close(); await rm(outputDir, { recursive: true, force: true }); });
  return { runtime, bot: await runtime.spawn({ requestId: 'spawn', profile: 'worker' }) };
}

test('adapter receipt recovery never repeats a prompt after a socket failure', async t => {
  const { runtime, bot } = await setup(t);
  provider.wait = async () => { throw Object.assign(new Error('lost socket'), { code: 'SERVICE_UNAVAILABLE' }); };
  const unknown = await runtime.send(bot.id, 'fixed', { requestId: 'one' });
  assert.equal(unknown.status, 'unknown');
  provider.responses.set(unknown.inputId, { response: { id: unknown.inputId, command: 'prompt', success: true, data: { disposition: 'started' } }, records: [] });
  const accepted = await runtime.send(bot.id, 'fixed', { requestId: 'one' });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.inputId, unknown.inputId);
  assert.equal(provider.messages.filter(message => message.type === 'prompt').length, 1);
  assert.equal(provider.messages.filter(message => message.type === 'get_rpc_result').length, 1);
});

test('prompt acknowledgement replays unread Worker prefix before its own response', async t => {
  const { runtime, bot } = await setup(t);
  const events = [];
  runtime.onEvent(event => events.push(event));
  provider.publish({ type: 'agent_start' });
  provider.wrapperReplay = true;
  provider.wait = async message => {
    const response = { type: 'response', id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } };
    provider.publish(response);
    provider.responses.set(message.id, { response });
    provider.publish({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'fast' }], stopReason: 'stop' } });
    provider.publish({ type: 'agent_settled' });
  };
  const receipt = await runtime.send(bot.id, 'fixed', { requestId: 'unread-prefix' });
  assert.equal(receipt.status, 'accepted');
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(events.find(event => event.type === 'settled')?.output, 'fast');
  assert.equal((await runtime.get(bot.id)).status, 'idle');
});

test('a response for another input cannot establish acceptance or rejection', async t => {
  const { runtime, bot } = await setup(t);
  provider.wait = async message => provider.responses.set(message.id, { response: {
    id: 'other-input', command: 'prompt', success: false, error: 'unrelated rejection',
  } });
  const receipt = await runtime.send(bot.id, 'fixed', { requestId: 'wrong-response' });
  assert.equal(receipt.status, 'unknown');
});

test('unknown original submission stays unknown when receipt lookup loses authorization or the Bot closes', async t => {
  const { runtime, bot } = await setup(t);
  const first = await runtime.send(bot.id, 'fixed', { requestId: 'uncertain' });
  assert.equal(first.status, 'unknown');
  provider.queryError = Object.assign(new Error('query unavailable'), { code: 'NOT_ALLOWED' });
  assert.deepEqual(await runtime.send(bot.id, 'fixed', { requestId: 'uncertain' }), first);
  await runtime.stop(bot.id);
  assert.deepEqual(await runtime.send(bot.id, 'fixed', { requestId: 'uncertain' }), first);
  assert.equal(provider.messages.filter(message => message.type === 'prompt').length, 1);
});

test('execution boundaries clear old output and preserve aborted outcome', async t => {
  const { runtime, bot } = await setup(t);
  const events = [];
  runtime.onEvent(event => events.push(event));
  provider.publish({ type: 'agent_start' });
  provider.publish({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'old' }], stopReason: 'stop' } });
  provider.publish({ type: 'agent_settled' });
  provider.publish({ type: 'agent_start' });
  provider.publish({ type: 'agent_settled' });
  provider.publish({ type: 'agent_start' });
  provider.publish({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } });
  provider.publish({ type: 'agent_settled' });
  const deadline = Date.now() + 1000;
  while (events.filter(event => event.type === 'settled').length < 3 && Date.now() < deadline) await delay(10);
  const settled = events.filter(event => event.type === 'settled');
  assert.equal(settled[0].output, 'old');
  assert.equal(settled[1].output, '');
  assert.equal(settled[2].outcome, 'aborted');
});

test('lost Worker history emits a fatal gap and never fabricates a later settled snapshot', async t => {
  const { runtime, bot } = await setup(t);
  const events = [];
  runtime.onEvent(event => events.push(event));
  provider.records.push({ type: 'agent_settled', worker_sequence: 9 });
  await delay(140);
  const gap = events.find(event => event.type === 'error');
  assert.equal(gap?.fatal, true);
  assert.match(gap.error.message, /gap/);
  assert.equal(events.some(event => event.type === 'settled'), false);
  await assert.rejects(runtime.send(bot.id, 'unsafe fresh input', { requestId: 'after-gap' }), { code: 'NOT_ALLOWED' });
});

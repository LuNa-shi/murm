import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlledUpstream } from './fixtures/core-controlled-upstream.js';
import { createNotesService, notesManifest } from './fixtures/core-notes-service.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';


test('real Pi receives the permitted Service directory and Bash can call its advertised commands', {
  skip: process.env.MURM_CORE_REAL_TEST !== '1' && 'Set MURM_CORE_REAL_TEST=1 with a verified local OpenSandbox image',
  timeout: 180_000,
}, async t => {
  const { createRuntime } = await import('@murm/core');
  const { ServiceRegistry } = await import('@murm/core');

  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.ok(image, 'MURM_CORE_TEST_IMAGE must identify a verified Pi/OpenSandbox image');
  const upstream = await createControlledUpstream({ listServices: true });
  let runtime;
  let close;
  t.after(async () => {
    try {
      if (runtime) close ??= await runtime.close({ timeoutMs: 30_000 });
    } finally {
      await upstream.close();
    }
  });
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-core-smoke-'));
  const backend = runtimeSettings({
    sandbox: {
      lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
      apiKey: process.env.MURM_CORE_TEST_API_KEY,
      commandTimeoutMs: 30_000,
    },
    bridge: { host: '0.0.0.0', publicUrl: process.env.MURM_CORE_TEST_BRIDGE_URL ?? 'http://172.17.0.1:{port}' },
    modelGateway: { host: '0.0.0.0', advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1',
      requestTimeoutMs: 20_000, maxOutputTokens: 128 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 * 1024, inodes: 4096 } },
  });
  const services = new ServiceRegistry();
  services.registerService({ manifest: notesManifest(), adapter: createNotesService().adapter });
  services.registerService({ manifest: notesManifest('other-notes'), adapter: createNotesService().adapter });
  for (const [service, operation] of [['task', 'task_list'], ['context', 'read_materials']]) {
    const manifest = notesManifest(service);
    manifest.capabilities = [{ ...manifest.capabilities[1], name: 'list', description: 'List permitted entries', operation }];
    services.registerService({ manifest, adapter: { invoke: () => null } });
  }
  runtime = await createRuntime({ ...backend, profiles: {
    worker: { prompt: 'Perform the requested local file operation and return its verified result.', model: 'default', image,
      writable: true, services: { notes: ['get'], task: ['task_list'], context: ['read_materials'] } },
  }, services, maxAgents: 1, outputDir });
  assert.deepEqual(await ownedContainers(runtime.id), []);
  const agent = await runtime.spawn({ requestId: 'smoke-spawn', profile: 'worker' });
  assert.equal(agent.status, 'idle');
  assert.equal(upstream.requests.length, 0, 'spawn must not submit model work');
  const active = await ownedContainers(runtime.id);
  assert.equal(active.length, 1);
  const events = [];
  let resolveSettled;
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  const unsubscribe = runtime.onEvent(event => {
    events.push(event);
    if (event.agentId === agent.id && event.type === 'settled') resolveSettled(event);
  });
  t.after(unsubscribe);
  const timer = setTimeout(() => resolveSettled({ type: 'timeout' }), 90_000);
  t.after(() => clearTimeout(timer));
  const receipt = await runtime.send(agent.id, 'Create core-smoke.txt using Bash, read it, and report the verified result.',
    { requestId: 'smoke-input', mode: 'followUp' });
  assert.equal(receipt.status, 'accepted');
  const outcome = await settled;
  assert.equal(outcome.type, 'settled', JSON.stringify(events));
  assert.equal(outcome.outcome, 'completed', JSON.stringify(outcome));
  assert.equal(outcome.output?.trim(), 'FILE_OK');
  assert.equal(upstream.failure, undefined);
  assert.equal(upstream.requests.length, 3);
  const firstRequest = upstream.requests[0];
  const prompt = firstRequest.input.find(item => item.role === 'developer')?.content;
  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /^You are a murm agent/);
  const directory = prompt.match(/<services>\n([\s\S]*?)\n<\/services>/)?.[1];
  assert.ok(directory, 'Pi must send a Service directory in its first model request');
  assert.match(directory, /Fixed notes exchange/);
  assert.match(directory, /swarm notes get.*Read a note/);
  assert.match(directory, /swarm task list.*List permitted entries/);
  assert.match(directory, /swarm material list.*List permitted entries/);
  assert.doesNotMatch(directory, /swarm notes put|other-notes|swarm agent|swarm task task_list|swarm context/);
  assert.doesNotMatch(prompt, /<docs>/);
  assert.match(prompt, /<added_system_prompt>\nPerform the requested local file operation/);
  assert.deepEqual(firstRequest.tools.map(tool => tool.name).sort(), ['bash', 'edit', 'read', 'write']);
  const toolResult = upstream.requests[1].input.find(item => item.type === 'function_call_output');
  const cliDirectory = JSON.parse(toolResult.output);
  assert.deepEqual(cliDirectory.services.map(service => [service.id, service.capabilities.map(capability => capability.operation)]),
    [['notes', ['get']], ['task', ['task_list']], ['context', ['read_materials']]]);
  const idle = await runtime.get(agent.id);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.latestOutput?.trim(), 'FILE_OK');
  assert.deepEqual(await ownedContainers(runtime.id), active);
  await assert.rejects(runtime.spawn({ requestId: 'capacity-check', profile: 'worker' }), { code: 'CONFLICT' });
  const stop = await runtime.stop(agent.id, { timeoutMs: 30_000 });
  assert.equal(stop.execution, 'stopped');
  assert.equal(stop.cleanup, 'complete');
  assert.deepEqual(await ownedContainers(runtime.id), []);
  assert.equal(events.filter(event => event.type === 'exit' && event.expected).length, 1);
  assert.equal((await runtime.get(agent.id)).status, 'closed');
  await assert.rejects(runtime.send(agent.id, 'rejected after close', { requestId: 'closed-input' }), {
    code: 'NOT_ALLOWED', agentId: agent.id, runtimeId: runtime.id, requestId: 'closed-input',
  });
  const replacement = await runtime.spawn({ requestId: 'capacity-check', profile: 'worker' });
  assert.notEqual(replacement.id, agent.id);
  assert.equal(replacement.status, 'idle');
  close = await runtime.close({ timeoutMs: 30_000 });
  assert.equal(close.cleanup, 'complete');
  assert.ok(close.agents.some(value => value.agentId === agent.id && value.cleanup === 'complete'));
  assert.deepEqual(await ownedContainers(runtime.id), []);
  assert.equal(upstream.requests.length, 3);
  t.diagnostic(`Controlled local Responses upstream, real Pi/OpenSandbox, output directory ${outputDir}`);
});

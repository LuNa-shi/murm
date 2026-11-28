import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCoreBridge } from '../src/core/bridge.js';
import { ServiceRegistry, snapshotServiceRegistry } from '../src/core/services.js';
import { createHarnessSession } from '../src/harness/project-harness.js';
import { transport } from './fixtures/core-input-backend.js';

const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './sandbox/opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) {
    return { url: new URL('./fixtures/core-input-backend.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createRuntime } = await import('@luna-shi/murm');
hook.deregister();

test('an authenticated Service question binds its real caller and ends when authority is revoked', { timeout: 5000 }, async t => {
  transport.reset();
  const cwd = await mkdtemp(join(tmpdir(), 'murm-question-project-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-question-output-'));
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); await rm(outputRoot, { recursive: true, force: true }); });
  const ready = Promise.withResolvers<{ url: string; token: string; agentId: string; revoke(): void }>();
  const session = createHarnessSession({ apiVersion: 1, id: 'service-questions', questions: true, async run(context) {
    const runtime = await createRuntime({ sandbox: {}, profiles: { writer: { model: 'default', image: 'test', writable: true, services: {} } }, services: new ServiceRegistry(), maxAgents: 1, outputDir: join(context.outputDir, 'runtime') });
    const unregister = context.registerAgentControls({ runtime });
    let bridge: Awaited<ReturnType<typeof createCoreBridge>> | undefined;
    try {
      const agent = await runtime.spawn({ profile: 'writer', requestId: 'writer' });
      let authorized = true;
      const services = new ServiceRegistry();
      services.registerService({ manifest: {
        id: 'questions', title: 'Questions', purpose: 'Ask a business question', provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' },
        capabilities: [{ name: 'ask', operation: 'ask', description: 'Ask', side_effect: 'read', idempotent: true, timeout_ms: 2000,
          help: { when: 'Need a decision' }, errors: [{ code: 'QUESTION_CANCELLED', retryable: false }],
          input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false },
          output_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } }],
      }, adapter: { async invoke(request) {
        request.assertAuthorized();
        const answer = await context.askUser({ requestId: request.envelope.operation_id, kind: 'text', text: (request.input as { text: string }).text, agentId: request.caller.agentId }, {
          id: request.envelope.operation_id, agentId: request.caller.agentId, signal: request.signal, assertAuthorized: request.assertAuthorized,
        });
        request.assertAuthorized();
        return { answer: answer as string };
      } } });
      bridge = await createCoreBridge({ runtimeId: runtime.id, configuration: { host: '127.0.0.1', publicUrl: 'http://127.0.0.1:{port}' }, registrations: snapshotServiceRegistry(services),
        getAgent(id) { return id === agent.id ? { ...agent, services: authorized ? { questions: ['ask'] } : {} } : undefined; } });
      context.markRunning();
      ready.resolve({ url: bridge.publicUrl, token: bridge.credentialsForAgent(agent.id).secretEnvironment.MURM_BRIDGE_TOKEN, agentId: agent.id, revoke() { authorized = false; } });
      await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
      return { outcome: 'cancelled', reason: 'stopped', artifacts: [], cleanup: { status: 'complete' } };
    } finally { await bridge?.close(); await runtime.close(); unregister(); }
  } }, { outputRoot, clientCapabilities: { questions: true } });
  await session.start({ cwd, prompt: 'work' }, { requestId: 'start' });
  const connection = await ready.promise;
  const call = async (id: string, payload: unknown) => (await fetch(connection.url + '/call', { method: 'POST', headers: { authorization: 'Bearer ' + connection.token }, body: JSON.stringify({ service_id: 'questions', operation: 'ask', operation_id: id, payload }) })).json();
  const created = Promise.withResolvers<void>();
  const unsubscribe = session.onEvent(event => { if (event.type === 'question' && event.question.status === 'pending') created.resolve(); });
  try {
    const forged = await call('forged', { text: 'Ask', agentId: 'another-agent' });
    assert.equal(forged.ok, false);
    assert.equal((await session.getState()).questions.length, 0);
    const pending = call('actual-call', { text: 'Choose a value' });
    await created.promise;
    const question = (await session.getState()).questions[0];
    assert.equal(question.agentId, connection.agentId);
    assert.equal(question.sourceId, 'actual-call');
    connection.revoke();
    const reply = await pending;
    assert.equal(reply.ok, false);
    assert.equal((await session.getState()).questions[0].status, 'cancelled');
    await assert.rejects(session.respond(question.questionId, 'late', { requestId: 'late' }), { code: 'QUESTION_CLOSED' });
  } finally { unsubscribe(); await session.stop({ requestId: 'stop' }); await session.completion; }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenSandboxAgentAdapter } from '../src/index.js';

class FakeSandboxManager {
  constructor() { this.started = null; this.stopped = false; this.executionStopped = false; this.releaseEvents = null; }
  async ensureExecution() {}
  async startAgent(input) { this.started = input; }
  async agentRpc(executionId, message) {
    if (message.type === 'prompt') return { records: [{ type: 'response', id: message.id, success: true, data: {} }, { type: 'agent_settled' }] };
    return { records: [{ type: 'response', id: message.id, success: true, data: { model: { contextWindow: 128_000 } } }] };
  }
  async *agentEvents() { await new Promise((resolve) => { this.releaseEvents = resolve; }); }
  async stopAgent() { this.stopped = true; this.releaseEvents?.(); }
  async stopExecution() { this.executionStopped = true; }
}

test('OpenSandbox Agent adapter keeps Pi RPC inside the provider worker', async () => {
  const manager = new FakeSandboxManager();
  const adapter = createOpenSandboxAgentAdapter({ sandboxManager: manager, provider: 'openai', model: 'gpt-6.1-sol', command: 'pi', systemPrompt: 'identity' });
  const session = await adapter.start({ executionId: 'execution-remote', sessionId: 'session-remote', agentPrompt: 'inspect the task' });
  assert.equal(manager.started.cwd, '/workspace');
  assert.deepEqual(manager.started.args.slice(0, 2), ['--mode', 'rpc']);
  assert.equal(manager.started.args.includes('--no-builtin-tools'), true);
  assert.equal(manager.started.args.includes('--extension'), false);
  assert.equal(manager.started.systemPrompt, 'identity');
  assert.equal(session.sessionId, 'session-remote');
  await session.stop();
  assert.equal(manager.stopped, true);
  assert.equal(manager.executionStopped, true);
});

test('remote Session stop reports sandbox deletion failure and retries even after worker exit', async () => {
  const manager = new FakeSandboxManager();
  let fail = true;
  manager.stopExecution = async () => {
    if (fail) throw new Error('provider deletion unconfirmed');
    manager.executionStopped = true;
  };
  const adapter = createOpenSandboxAgentAdapter({ sandboxManager: manager, provider: 'openai', model: 'gpt-6.1-sol', command: 'pi' });
  const session = await adapter.start({ executionId: 'worker-cleanup' });
  try {
    await assert.rejects(session.stop(), /provider deletion unconfirmed/);
    assert.equal(manager.executionStopped, false);
  } finally { fail = false; }
  await session.stop();
  assert.equal(manager.executionStopped, true);
});

test('failed unbound startup blocks a replacement until its sandbox cleanup succeeds', async () => {
  const manager = new FakeSandboxManager();
  let starts = 0;
  let failCleanup = true;
  manager.startAgent = async () => { starts += 1; throw new Error('worker startup failed'); };
  manager.stopExecution = async () => { if (failCleanup) throw new Error('cleanup pending'); };
  const adapter = createOpenSandboxAgentAdapter({ sandboxManager: manager, provider: 'openai', model: 'gpt-6.1-sol', command: 'pi' });
  await assert.rejects(adapter.start({ executionId: 'first-worker' }), /cleanup pending/);
  await assert.rejects(adapter.start({ executionId: 'second-worker' }), /cleanup pending/);
  assert.equal(starts, 1);
  failCleanup = false;
  await adapter.cleanupPendingStarts();
  await assert.rejects(adapter.start({ executionId: 'second-worker' }), /worker startup failed/);
  assert.equal(starts, 2);
});

test('adapter shutdown joins an in-flight provider creation and prevents a late worker launch', async () => {
  const manager = new FakeSandboxManager();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let finish;
  const pendingCreate = new Promise(resolve => { finish = resolve; });
  manager.ensureExecution = async () => { entered(); await pendingCreate; };
  const adapter = createOpenSandboxAgentAdapter({ sandboxManager: manager, provider: 'openai', model: 'gpt-6.1-sol', command: 'pi' });
  const start = adapter.start({ executionId: 'slow-start' });
  const rejected = assert.rejects(start, /stopped/);
  await started;
  await assert.rejects(adapter.start({ executionId: 'second-start' }), (error) => error.code === 'CONFLICT');
  let cleanupFinished = false;
  const cleanup = adapter.cleanupPendingStarts({ shutdown: true }).then(() => { cleanupFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanupFinished, false);
  finish();
  await Promise.all([rejected, cleanup]);
  assert.equal(manager.started, null);
  assert.equal(manager.executionStopped, true);
  await assert.rejects(adapter.start({ executionId: 'after-shutdown' }), /stopping/);
});

test('OpenSandbox Agent adapter passes the guest extension path to Pi', () => {
  const adapter = createOpenSandboxAgentAdapter({
    sandboxManager: new FakeSandboxManager(),
    provider: 'openai',
    model: 'gpt-6.1-sol',
    command: 'pi',
    extensionPath: '/opt/swarmenv/src/agent/swarmenv-extension.mjs',
  });
  const args = adapter.buildLaunchArgs({ executionId: 'execution-extension' });
  const index = args.indexOf('--extension');
  assert.equal(args[index + 1], '/opt/swarmenv/src/agent/swarmenv-extension.mjs');
});

test('OpenSandbox Agent adapter forwards only configured service environment and explicit secrets', async () => {
  const manager = new FakeSandboxManager();
  const adapter = createOpenSandboxAgentAdapter({
    sandboxManager: manager,
    provider: 'openai',
    model: 'gpt-6.1-sol',
    command: 'pi',
    env: {
      SWARMENV_TASK_SERVICE_URL: 'http://task:8787',
      SWARMENV_BRIDGE_URL: 'http://host-gateway:40123',
      SWARMENV_OPENSANDBOX_URL: 'http://host-provider:8080',
      PI_CODING_AGENT_DIR: '/home/host/.pi/agent',
      OPENAI_API_KEY: 'must-not-be-inherited',
    },
    agentEnvironment: { SWARMENV_CONTEXT_SERVICE_URL: 'http://context:8787' },
    secretEnv: { SWARMENV_TASK_SERVICE_TOKEN: 'task-secret', SWARMENV_BRIDGE_TOKEN: 'bridge-secret', OPENAI_API_KEY: 'explicit-secret' },
  });
  await adapter.start({ executionId: 'execution-env', sessionId: 'session-env' });
  assert.equal(manager.started.env.SWARMENV_TASK_SERVICE_URL, 'http://task:8787');
  assert.equal(manager.started.env.SWARMENV_CONTEXT_SERVICE_URL, 'http://context:8787');
  assert.equal(manager.started.env.SWARMENV_OPENSANDBOX_URL, undefined);
  assert.equal(manager.started.env.PI_CODING_AGENT_DIR, undefined);
  assert.equal(manager.started.env.SWARMENV_BRIDGE_URL, 'http://host-gateway:40123');
  assert.equal(manager.started.env.OPENAI_API_KEY, undefined);
  assert.equal(manager.started.secretEnvironment.SWARMENV_TASK_SERVICE_TOKEN, 'task-secret');
  assert.equal(manager.started.secretEnvironment.SWARMENV_BRIDGE_TOKEN, 'bridge-secret');
  assert.equal(manager.started.secretEnvironment.OPENAI_API_KEY, 'explicit-secret');
});

test('OpenSandbox Agent adapter records versions resolved inside the provider guest', async () => {
  const manager = new FakeSandboxManager();
  manager.agentVersions = async () => ({ piVersion: '1.3.0', nurouterVersion: '0.2.16', nodeVersion: '22.19.0' });
  const adapter = createOpenSandboxAgentAdapter({ sandboxManager: manager, provider: 'openai', model: 'gpt-6.1-sol', command: 'pi' });
  const session = await adapter.start({ executionId: 'execution-versions', sessionId: 'session-versions' });
  assert.equal(session.manifest.pi_version, '1.3.0');
  assert.equal(session.manifest.nurouter_version, null);
  assert.equal(session.manifest.node_version, '22.19.0');
});

test('OpenSandbox Agent adapter reconnects after a transient event-stream interruption', async () => {
  const manager = new FakeSandboxManager();
  let eventCalls = 0;
  manager.agentEvents = async function* () {
    eventCalls += 1;
    if (eventCalls === 1) throw new Error('SSE connection closed');
    await new Promise((resolve) => { manager.releaseEvents = resolve; });
  };
  const adapter = createOpenSandboxAgentAdapter({ sandboxManager: manager, provider: 'openai', model: 'gpt-6.1-sol', command: 'pi' });
  const session = await adapter.start({ executionId: 'execution-reconnect', sessionId: 'session-reconnect' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(session.closed, false);
  assert.ok(eventCalls >= 2);
  await session.stop();
});

test('OpenSandbox Agent adapter replays worker history after provider SSE becomes unavailable', async () => {
  const manager = new FakeSandboxManager();
  let eventCalls = 0;
  const polls = [];
  manager.agentEvents = async function* () {
    eventCalls += 1;
    const error = new Error('OpenSandbox request failed with HTTP 502');
    error.code = 'SERVICE_UNAVAILABLE';
    error.retryable = true;
    throw error;
  };
  manager.agentRpc = async function (executionId, message) {
    if (message.type === 'get_state' && Object.hasOwn(message, 'since')) {
      polls.push(message.since);
      return { records: message.since === 0 ? [{ worker_sequence: 1, type: 'response', id: 'history-1', data: { ok: true } }] : [] };
    }
    return { records: [{ type: 'response', id: message.id, success: true, data: {} }] };
  };
  const adapter = createOpenSandboxAgentAdapter({ sandboxManager: manager, provider: 'openai', model: 'gpt-6.1-sol', command: 'pi' });
  const session = await adapter.start({ executionId: 'execution-poll-history', sessionId: 'session-poll-history' });
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  assert.ok(eventCalls >= 1);
  assert.deepEqual(polls.slice(0, 2), [0, 1]);
  assert.match(session.stdout, /"worker_sequence":1/);
  await session.stop();
});

test('unbound Bot adapter records its Sandbox without copying a Core directory or inventing an Execution', async () => {
  const manager = new FakeSandboxManager();
  let recorded;
  manager.ensureExecution = async ({ executionId, botId, onCreated }) => {
    assert.equal(executionId, 'bot:new');
    assert.equal(botId, 'bot:new');
    const snapshot = { bot_id: botId, execution_id: null, sandbox_id: 'sandbox:new' };
    await onCreated(snapshot);
    return snapshot;
  };
  manager.syncWorkspace = async () => { assert.fail('unbound Bot must not inherit the Core directory'); };
  const events = [];
  const adapter = createOpenSandboxAgentAdapter({ sandboxManager: manager, provider: 'openai', model: 'gpt-6.1-sol', command: 'pi' });
  const session = await adapter.start({ executionId: 'bot:new', bot: { bot_id: 'bot:new' }, cwd: '/host/core', onSandboxCreated: snapshot => { recorded = snapshot; }, observation: event => events.push(event) });
  try {
    assert.equal(recorded.sandbox_id, 'sandbox:new');
    assert.equal(session.executionId, null);
    assert.equal(session.botId, 'bot:new');
    assert.equal(events.find(event => event.kind === 'session_started').executionId, null);
  } finally { await session.stop(); }
});

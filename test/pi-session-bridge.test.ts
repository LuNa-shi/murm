import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiSessionController } from '../scripts/pi-session-controller.js';

test('next-turn context stays outside the current execution and clearQueue discards its identity', async () => {
  const appended: unknown[] = [];
  const session = { isIdle: true, isStreaming: false, isCompacting: false, isRetrying: false,
    sendCustomMessage: async (...args: unknown[]) => { appended.push(args); },
    clearQueue: () => ({ steering: [], followUp: [] }), messages: [] };
  const events: any[] = [];
  const controller = createPiSessionController(session, { emit: e => events.push(e) });
  const result = await controller.command({ type: 'core_context', id: 'ctx-1', input: { type: 'context', customType: 'note', content: 'later' }, delivery: 'nextTurn' });
  assert.equal(result.status, 'pending-next-turn');
  assert.equal(appended.length, 0);
  const cleared = await controller.command({ type: 'core_session_clear_queue', id: 'clear-1' });
  assert.deepEqual(cleared.discardedContextIds, ['ctx-1']);
  await controller.beforePrompt();
  assert.equal(appended.length, 0);
  assert.equal(events.filter(e => e.type === 'core_context_disposition' && e.status === 'discarded').length, 1);
});

test('Guest native Pi SDK applies settings and appends structured context without a model request', { timeout: 20000 }, async t => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const directory = await mkdtemp(join(tmpdir(), 'murm-pi-sdk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, 'agent');
  await mkdir(agentDir);
  await writeFile(join(directory, 'prompt'), 'You are a test Agent.');
  await writeFile(join(directory, 'bridge.json'), JSON.stringify({ args: ['--system-prompt', join(directory, 'prompt')], configuration: { tools: ['read'], compaction: { enabled: false } } }));
  const child = spawn(process.execPath, [new URL('../scripts/pi-session-bridge.js', import.meta.url).pathname, join(directory, 'bridge.json')], {
    cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', data => stderr += data);
  const records: any[] = [];
  createInterface({ input: child.stdout }).on('line', line => records.push(JSON.parse(line)));
  const waitFor = async (predicate: () => any) => {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
      assert.equal(child.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, stderr);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return predicate();
  };
  await waitFor(() => records.find(r => r.type === 'core_session_ready'));
  const command = async (id: string, type: string, values = {}) => {
    child.stdin.write(JSON.stringify({ id, type, ...values }) + '\n');
    const reply = await waitFor(() => records.find(r => r.type === 'response' && r.id === id));
    assert.equal(reply.success, true, JSON.stringify(reply));
    return reply.data;
  };
  const state = await command('state', 'core_session_get_state');
  assert.deepEqual(state.tools, ['read']);
  assert.equal(state.configuration.compaction.enabled, false);
  const updated = await command('config', 'core_session_configure', { patch: { steeringMode: 'all', retry: { enabled: false } } });
  assert.equal(updated.configuration.steeringMode, 'all');
  assert.equal(updated.configuration.retry.enabled, false);
  const context = await command('append', 'core_context', { input: { type: 'context', customType: 'control', content: 'ONLY_CONTEXT', details: { original: true }, display: false }, delivery: 'append' });
  assert.equal(context.status, 'appended');
  const messages = await command('messages', 'core_session_get_messages');
  assert.equal(messages.messages[0].role, 'custom');
  assert.equal(messages.messages[0].customType, 'control');
  assert.deepEqual(messages.messages[0].details, { original: true });
  assert.equal(records.filter(r => r.type === 'agent_start').length, 0);
  child.stdin.end();
});

test('Guest decision deadline fences compaction and rejects a late allow', async () => {
  let aborts = 0;
  const session = { isIdle: false, messages: [], sessionId: 'native-session', clearQueue: () => ({}), abortCompaction() {}, abort: async () => { aborts++; } };
  const events: any[] = [];
  const controller = createPiSessionController(session, { emit: e => events.push(e), beforeCompact: { timeoutMs: 10 } });
  controller.observe({ type: 'compaction_start', reason: 'threshold' });
  assert.deepEqual(await controller.beforeCompact({ reason: 'threshold', signal: new AbortController().signal }), { cancel: true });
  assert.equal(controller.fenced, true);
  assert.equal(aborts, 1);
  const request = events.find(e => e.type === 'core_before_compact');
  await assert.rejects(controller.command({ type: 'core_before_compact_decision', compactionId: request.compactionId, executionEpoch: 0, decision: 'allow' }), { code: 'NOT_ALLOWED' });
  assert.equal(events.find(e => e.type === 'core_before_compact_result').reason, 'HOOK_TIMEOUT');
});

test('manual compact reports busy before calling Pi and failed patches apply no setters', async () => {
  let changes = 0;
  const controller = createPiSessionController({ isIdle: false, messages: [], compact() { changes++; }, setThinkingLevel() { changes++; } }, { emit() {} });
  assert.equal((await controller.command({ type: 'core_session_compact' })).status, 'busy');
  await assert.rejects(controller.command({ type: 'core_session_configure', patch: { thinkingLevel: 'high', retry: { maxRetries: 9 } } }));
  assert.equal(changes, 0);
});

test('Guest native SDK carries context into actual model requests and runs selected Bash/read tools', { timeout: 25000 }, async t => {
  const { createControlledUpstream, SMOKE_MARKER } = await import('./fixtures/core-controlled-upstream.js');
  const { mkdtemp, writeFile, mkdir, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const directory = await mkdtemp(join(tmpdir(), 'murm-pi-sdk-model-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const upstream = await createControlledUpstream();
  t.after(() => upstream.close());
  const agentDir = join(directory, 'agent');
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { controlled: {
    baseUrl: upstream.url.replace('/responses', ''), api: 'openai-responses', apiKey: 'controlled-local-only',
    models: [{ id: 'k3', name: 'controlled', reasoning: false, contextWindow: 32768, maxTokens: 1024 }] } } }));
  await writeFile(join(directory, 'prompt'), 'Execute the tool requests.');
  await writeFile(join(directory, 'bridge.json'), JSON.stringify({ args: ['--provider', 'controlled', '--model', 'k3', '--system-prompt', join(directory, 'prompt')],
    configuration: { tools: ['bash', 'read'], compaction: { enabled: false }, retry: { enabled: false } } }));
  const child = spawn(process.execPath, [new URL('../scripts/pi-session-bridge.js', import.meta.url).pathname, join(directory, 'bridge.json')], {
    cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', data => stderr += data);
  const records: any[] = [];
  createInterface({ input: child.stdout }).on('line', line => records.push(JSON.parse(line)));
  const waitFor = async (predicate: () => any) => {
    const deadline = Date.now() + 18000;
    while (!predicate()) {
      assert.equal(child.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, stderr + JSON.stringify(records.slice(-3)));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return predicate();
  };
  await waitFor(() => records.find(r => r.type === 'core_session_ready'));
  const command = async (id: string, type: string, values = {}) => {
    child.stdin.write(JSON.stringify({ id, type, ...values }) + '\n');
    const reply = await waitFor(() => records.find(r => r.type === 'response' && r.id === id));
    assert.equal(reply.success, true, JSON.stringify(reply));
    return reply.data;
  };
  await command('append', 'core_context', { input: { type: 'context', customType: 'reference', content: 'APPENDED_NATIVE_MARKER' }, delivery: 'append' });
  await command('next', 'core_context', { input: { type: 'context', customType: 'reference', content: 'NEXT_NATIVE_MARKER' }, delivery: 'nextTurn' });
  assert.equal(upstream.requests.length, 0);
  await command('prompt', 'prompt', { message: 'Create and read the file.' });
  await waitFor(() => records.find(r => r.type === 'agent_settled'));
  assert.equal(upstream.failure, undefined);
  assert.equal(upstream.requests.length, 3);
  assert.match(JSON.stringify(upstream.requests[0]), /APPENDED_NATIVE_MARKER/);
  assert.match(JSON.stringify(upstream.requests[0]), /NEXT_NATIVE_MARKER/);
  assert.deepEqual(upstream.requests[0].tools.map((tool: any) => tool.name).sort(), ['bash', 'read']);
  assert.equal((await readFile(join(directory, 'core-smoke.txt'), 'utf8')).trim(), SMOKE_MARKER);
  assert.equal(records.filter(r => r.type === 'tool_execution_end').length, 2);
  const stats = await command('stats', 'core_session_get_stats');
  assert.equal(stats.sessionUsage.source, 'pi-session');
  assert.equal(stats.sessionUsage.toolCalls, 2);
  assert.equal(records.filter(r => r.type === 'core_context_disposition' && r.status === 'appended').length, 2);
  child.stdin.end();
});

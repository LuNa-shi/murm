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

test('idle structured turn promotes deferred context before either delivery starts', async () => {
  for (const delivery of ['steer', 'followUp']) {
    const calls: any[] = [];
    const messages: any[] = [];
    const session = { isIdle: true, messages, sendCustomMessage: async (input: any, options: any) => {
      calls.push({ content: input.content, ...options });
      messages.push({ role: 'custom', ...input });
    } };
    const controller = createPiSessionController(session, { emit() {} });
    await controller.command({ type: 'core_context', id: 'deferred', input: { type: 'context', customType: 'note', content: 'NEXT' }, delivery: 'nextTurn' });
    await controller.command({ type: 'core_context', id: 'wake', input: { type: 'context', customType: 'note', content: 'WAKE' }, delivery });
    assert.deepEqual(calls, [{ content: 'NEXT', triggerTurn: false }, { content: 'WAKE', triggerTurn: true, deliverAs: delivery }]);
    await controller.beforePrompt();
    assert.equal(calls.length, 2);
  }
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
  const messages = await command('message-identities', 'core_session_get_messages');
  const assistantEnd = records.findLast(r => r.type === 'message_end' && r.message?.role === 'assistant');
  const assistantView = messages.messages.findLast((message: any) => message.role === 'assistant');
  assert.equal(assistantView.id, assistantEnd.messageId);
  assert.equal(records.filter(r => r.type === 'core_context_disposition' && r.status === 'appended').length, 2);
  child.stdin.end();
});

test('native automatic compaction commits three summaries and stops before the fourth summary request', { timeout: 25000 }, async t => {
  const { createAgentControlsUpstream } = await import('./fixtures/core-agent-controls-upstream.js');
  const { startNativePiSession } = await import('./fixtures/native-pi-session.js');
  const upstream = await createAgentControlsUpstream({ requestLimit: 12 });
  t.after(() => upstream.close());
  const native = await startNativePiSession(t, { upstream: upstream.url,
    configuration: { tools: [], compaction: { enabled: true, reserveTokens: 3000, keepRecentTokens: 500 }, retry: { enabled: false } },
    beforeCompact: { timeoutMs: 1000 } });
  native.onRecord(record => {
    if (record.type === 'core_before_compact') native.send({ type: 'core_before_compact_decision', id: `decision-${record.compactionId}`,
      compactionId: record.compactionId, executionEpoch: record.executionEpoch,
      decision: record.successfulAutoCompactions < 3 ? 'allow' : 'stop' });
  });
  for (let round = 0; round < 5; round++) {
    const settled = native.records.filter(record => record.type === 'agent_settled').length;
    await native.command(`prompt-${round}`, 'prompt', { message: `ROUND ${round} ` + 'long history content '.repeat(500) });
    await native.waitFor(() => native.records.filter(record => record.type === 'agent_settled').length > settled);
  }
  assert.equal(upstream.failure, undefined);
  assert.equal(upstream.requests.filter(request => request.kind === 'ordinary').length, 5);
  assert.equal(upstream.requests.filter(request => request.kind === 'summary').length, 3);
  const gates = native.records.filter(record => record.type === 'core_before_compact');
  assert.deepEqual(gates.map(record => record.successfulAutoCompactions), [0, 1, 2, 3]);
  assert.equal(new Set(gates.map(record => record.compactionId)).size, 4);
  const entries = await native.command('archive', 'get_entries');
  assert.equal(entries.entries.filter((entry: any) => entry.type === 'compaction').length, 3);
  const stats = await native.command('stats', 'core_session_get_stats');
  assert.equal(stats.compactions.successfulAutoCompactions, 3);
  assert.equal(stats.compactions.manual, 0);
  const stopped = native.records.find(record => record.type === 'core_before_compact_result' && record.decision === 'stop');
  assert.equal(stopped.compactionId, gates[3].compactionId);
  const final = native.records.find(record => record.type === 'compaction_end' && record.compactionId === stopped.compactionId);
  assert.equal(final.aborted, true);
  const requestsAtStop = upstream.requests.length;
  native.send({ id: 'late-prompt', type: 'prompt', message: 'must remain fenced' });
  const rejected = await native.waitFor(() => native.records.find(record => record.type === 'response' && record.id === 'late-prompt'));
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, 'NOT_ALLOWED');
  assert.equal(upstream.requests.length, requestsAtStop);
});


test('interrupt cancels a held compaction decision and rejects its late allow across generations', async () => {
  const records: any[] = [];
  const session = { isIdle: false, messages: [], sessionId: 'native-session', clearQueue: () => ({ steering: [], followUp: [] }), abort: async () => {} };
  const controller = createPiSessionController(session, { emit: record => records.push(record), beforeCompact: { timeoutMs: 1000 } });
  const pending = controller.beforeCompact({ reason: 'overflow', signal: new AbortController().signal });
  const gate = records.find(record => record.type === 'core_before_compact');
  assert.equal(gate.reason, 'overflow');
  await controller.interrupt(1);
  assert.deepEqual(await pending, { cancel: true });
  await assert.rejects(controller.command({ type: 'core_before_compact_decision', compactionId: gate.compactionId, executionEpoch: 0, decision: 'allow' }), { code: 'NOT_ALLOWED' });
  assert.equal(records.filter(record => record.type === 'core_before_compact_result').length, 1);
  assert.equal(records.find(record => record.type === 'core_before_compact_result').reason, 'interrupted');
});

for (const channel of ['lost-decision', 'eof', 'worker-exit'])
test(`native held compaction stays closed after ${channel}`, { timeout: 20000 }, async t => {
  const { once } = await import('node:events');
  const { createAgentControlsUpstream } = await import('./fixtures/core-agent-controls-upstream.js');
  const { startNativePiSession } = await import('./fixtures/native-pi-session.js');
  const upstream = await createAgentControlsUpstream({ requestLimit: 4 }); t.after(() => upstream.close());
  const native = await startNativePiSession(t, { upstream: upstream.url,
    configuration: { tools: [], compaction: { enabled: true, reserveTokens: 3000, keepRecentTokens: 500 }, retry: { enabled: false } },
    beforeCompact: { timeoutMs: channel === 'lost-decision' ? 100 : 10000 } });
  for (let round = 0; round < 3 && !native.records.some(record => record.type === 'core_before_compact'); round++) {
    const settled = native.records.filter(record => record.type === 'agent_settled').length;
    await native.command(`channel-prompt-${round}`, 'prompt', { message: `CHANNEL ROUND ${round} ` + 'long history content '.repeat(500) });
    await native.waitFor(() => native.records.some(record => record.type === 'core_before_compact') || native.records.filter(record => record.type === 'agent_settled').length > settled);
  }
  const gate = native.records.find(record => record.type === 'core_before_compact'); assert.ok(gate);
  if (channel === 'lost-decision') {
    await native.waitFor(() => native.records.some(record => record.type === 'core_before_compact_result' && record.reason === 'HOOK_TIMEOUT'));
    native.send({ type: 'core_before_compact_decision', id: 'late-channel-allow', compactionId: gate.compactionId, executionEpoch: gate.executionEpoch, decision: 'allow' });
    const rejected = await native.waitFor(() => native.records.find(record => record.id === 'late-channel-allow'));
    assert.equal(rejected.success, false); assert.equal(rejected.code, 'NOT_ALLOWED');
    assert.equal((await native.command('channel-entries', 'get_entries')).entries.filter((entry: any) => entry.type === 'compaction').length, 0);
  } else {
    const exit = once(native.child, 'exit');
    if (channel === 'eof') native.child.stdin.end(); else native.child.kill('SIGKILL');
    const [code, signal] = await Promise.race([exit, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Guest exit deadlocked behind gate')), 3000); timer.unref(); })]);
    if (channel === 'eof') {
      assert.equal(code, 0);
      assert.equal(native.records.find(record => record.type === 'core_before_compact_result')?.decision, 'cancel');
    } else assert.equal(signal, 'SIGKILL');
  }
  assert.equal(upstream.failure, undefined);
  assert.equal(upstream.requests.filter(request => request.kind === 'summary').length, 0);
});

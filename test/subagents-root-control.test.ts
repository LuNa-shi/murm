import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createSubagentsController } from '../examples/subagents/harness/controller.js';

function executorBoundary() {
  const handlers = new Set<(event: any) => void>();
  const agents = new Map<string, any>([['root', { id: 'root', status: 'idle' }]]);
  const sent: any[] = [];
  let discarded: string[] = [];
  const runtime: any = {
    id: 'root-control-run', agents, sent,
    onEvent(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    async list() { return [...agents.values()]; },
    async get(id) { const agent = agents.get(id); if (!agent) throw new Error('Missing Agent'); return { ...agent }; },
    async spawn(options) { const agent = { id: 'child', parentId: options.parentId, status: 'idle' }; agents.set(agent.id, agent); return agent; },
    async send(agentId, input, options) {
      const row = { agentId, input, options, inputId: 'input-' + (sent.length + 1) }; sent.push(row);
      if (options.wakeIfIdle === false && agents.get(agentId).status === 'idle') return { inputId: row.inputId, status: 'not-accepted', reason: 'idle' };
      return { inputId: row.inputId, status: 'accepted', disposition: 'queued' };
    },
    async interrupt() { agents.get('root').status = 'idle'; return { agentId: 'root', status: 'interrupted', discardedInputHashes: [...discarded] }; },
    session: { async clearQueue() { return { operationId: 'clear', agentId: 'root', requestId: 'clear', status: 'completed', discardedInputHashes: [...discarded] }; } },
  };
  return { runtime,
    discard(input: string | undefined) { discarded = input ? [createHash('sha256').update(input).digest('hex')] : []; },
    emit(event) { for (const handler of handlers) handler(event); },
  };
}

for (const operation of ['interrupt', 'clearQueue'] as const) {
  for (const discarded of [true, false]) {
    test(`Root ${operation} ${discarded ? 'restores a child bundled in discarded queued work once' : 'settles an already consumed child without redelivery'}`, async () => {
      const boundary = executorBoundary();
      const controller = createSubagentsController(boundary.runtime, { maxDepth: 2 });
      controller.attachRoot('root');
      const signal = new AbortController().signal;
      try {
        await controller.invoke({ caller: { runtimeId: boundary.runtime.id, agentId: 'root', profile: 'root' },
          capability: { operation: 'spawn_agent' }, envelope: { operation_id: 'spawn-child' },
          input: { task_name: 'child', message: 'child task', fork_turns: 'none' }, signal, assertAuthorized() {} } as any);
        boundary.emit({ type: 'settled', agentId: 'child', outcome: 'completed', output: 'UNIQUE_CHILD_RESULT' });
        await controller.drain();
        boundary.runtime.agents.get('root').status = 'running';
        await controller.submitUser('CANCELLED_USER_WORK', 'cancelled-work');
        const queued = boundary.runtime.sent.find(row => row.options.requestId === 'user:cancelled-work');
        const bundled = JSON.parse(queued.input);
        assert.equal(bundled.text, 'CANCELLED_USER_WORK');
        assert.equal(bundled.messages.length, 1);
        assert.equal(bundled.messages[0].text, 'UNIQUE_CHILD_RESULT');
        const messageId = bundled.messages[0].id;
        boundary.discard(discarded ? queued.input : undefined);
        const receipt = await controller.rootQueueControl(operation, operation);
        assert.deepEqual(receipt.harnessEffects.restoredInbox, discarded ? [messageId] : []);
        const paused = controller.exportState() as any;
        assert.deepEqual(paused.members.find(member => member.path === '/root').pending.map(message => message.id), discarded ? [messageId] : []);
        const sendsAtControl = boundary.runtime.sent.length;
        await controller.submitUser('CANCELLED_USER_WORK', 'cancelled-work');
        assert.equal(boundary.runtime.sent.length, sendsAtControl, 'Retry checks the cancelled original admission without submitting work again');
        await controller.submitUser('EXPLICIT_NEXT_WORK', 'next-work');
        const resumed = boundary.runtime.sent.find(row => row.options.requestId === 'user:next-work');
        if (discarded) {
          const next = JSON.parse(resumed.input);
          assert.equal(next.text, 'EXPLICIT_NEXT_WORK');
          assert.deepEqual(next.messages.map(message => message.id), [messageId]);
          assert.equal(next.messages[0].text, 'UNIQUE_CHILD_RESULT');
        } else assert.equal(resumed.input, 'EXPLICIT_NEXT_WORK');
        assert.deepEqual((controller.exportState() as any).members.find(member => member.path === '/root').pending, []);
        await controller.submitUser('ANOTHER_EXPLICIT_WORK', 'another-work');
        assert.equal(boundary.runtime.sent.find(row => row.options.requestId === 'user:another-work').input, 'ANOTHER_EXPLICIT_WORK');
        assert.equal(boundary.runtime.sent.filter(row => row.input.includes('UNIQUE_CHILD_RESULT') && row.options.requestId.startsWith('user:')).length, discarded ? 2 : 1);
      } finally { controller.beginClose(); controller.dispose(); }
    });
  }
}

test('late Root clear receipt restores its original child without deleting later queued work', async () => {
  const boundary = executorBoundary();
  const controller = createSubagentsController(boundary.runtime, { maxDepth: 2 });
  controller.attachRoot('root');
  try {
    const signal = new AbortController().signal;
    await controller.invoke({ caller: { runtimeId: boundary.runtime.id, agentId: 'root' },
      capability: { operation: 'spawn_agent' }, envelope: { operation_id: 'spawn-child' },
      input: { task_name: 'child', message: 'child task', fork_turns: 'none' }, signal, assertAuthorized() {} } as any);
    boundary.emit({ type: 'settled', agentId: 'child', outcome: 'completed', output: 'CHILD_RETAINED' });
    await controller.drain();
    boundary.runtime.agents.get('root').status = 'running';
    await controller.submitUser('original', 'old');
    const original = boundary.runtime.sent.find(row => row.options.requestId === 'user:old');
    boundary.runtime.session.clearQueue = async () => ({ status: 'unknown' });
    await controller.rootQueueControl('clearQueue', 'clear');
    await controller.submitUser('later', 'later');
    const hashes = [createHash('sha256').update(original.input).digest('hex')];
    let queries = 0;
    const query = async () => { queries++; return { status: 'completed', discardedInputHashes: hashes }; };
    const [receipt, concurrent] = await Promise.all([controller.reconcileRootControl('clearQueue', 'clear', query),
      controller.reconcileRootControl('clearQueue', 'clear', query)]);
    assert.deepEqual(concurrent, receipt);
    assert.equal(receipt.harnessEffects.restoredInbox.length, 1);
    assert.equal((controller.exportState() as any).rootInputs.some(row => row.requestId === 'user:later'), true);
    assert.deepEqual(await controller.reconcileRootControl('clearQueue', 'clear', query), receipt);
    assert.equal(queries, 1);
    await controller.submitUser('resume', 'resume');
    const resumed = boundary.runtime.sent.find(row => row.options.requestId === 'user:resume');
    assert.equal(JSON.parse(resumed.input).messages[0].text, 'CHILD_RETAINED');
  } finally { controller.beginClose(); controller.dispose(); }
});

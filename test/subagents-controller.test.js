import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSubagentsController } from '../examples/subagents-environment/controller.mjs';

function runtime() {
  let handler; const sent = [];
  const bots = new Map([['parent', { id: 'parent', status: 'idle' }], ['a', { id: 'a', parentId: 'parent', status: 'idle', latestOutput: 'unrelated latest' }]]);
  return { id: 'run', sent, bots, onEvent(fn) { handler = fn; return () => { handler = undefined; }; },
    async get(id) { if (!bots.has(id)) throw new Error('not found'); return bots.get(id); },
    async send(botId, input, options) { sent.push({ botId, input, ...options }); return { inputId: `input-${sent.length}`, status: 'accepted', disposition: 'queued' }; },
    emit(event) { handler?.(event); } };
}

test('child snapshots are deduplicated and serialized with user input without claiming input completion', async () => {
  const core = runtime(); const controller = createSubagentsController(core, 'parent');
  const supplement = controller.submitUser('additional constraint', { requestId: 'user-1' });
  const event = { type: 'settled', botId: 'a', seq: 1, outcome: 'completed', output: 'original result' };
  core.emit(event); core.emit(event); event.output = 'later mutation';
  await supplement; await controller.drain();
  assert.equal(core.sent.length, 2); assert.equal(core.sent[0].input, 'additional constraint');
  assert.equal(JSON.parse(core.sent[1].input).output, 'original result');
  assert.equal(core.sent[1].mode, 'followUp'); assert.equal(core.sent[1].requestId, 'child-result:a:1');
  assert.equal(controller.report().deliveries[1].receipt.inputId, 'input-2');
  core.emit({ type: 'settled', botId: 'parent', seq: 1, outcome: 'completed', output: 'parent output' });
  await controller.drain();
  assert.equal(controller.report().deliveries[0].completed, undefined);
  controller.stop();
});

test('failed settlement and fatal/exit each yield one failure notification while explicit stop yields none', async () => {
  const core = runtime(); const controller = createSubagentsController(core, 'parent');
  core.emit({ type: 'settled', botId: 'a', seq: 1, outcome: 'failed', output: '', error: { code: 'MODEL_ERROR' } });
  core.emit({ type: 'error', botId: 'a', seq: 2, fatal: true, error: { code: 'FATAL' } });
  core.emit({ type: 'exit', botId: 'a', seq: 3, expected: false });
  await controller.drain(); assert.equal(core.sent.length, 1);
  assert.equal(JSON.parse(core.sent[0].input).outcome, 'failed');
  assert.equal(controller.report().lifecycle.length, 1);
  core.bots.set('b', { id: 'b', parentId: 'parent', status: 'exited' });
  core.emit({ type: 'error', botId: 'b', seq: 1, fatal: true, error: { code: 'FATAL' } });
  core.emit({ type: 'exit', botId: 'b', seq: 2, expected: false });
  core.bots.set('c', { id: 'c', parentId: 'parent', status: 'closed' });
  core.emit({ type: 'exit', botId: 'c', seq: 1, expected: true });
  await controller.drain(); assert.equal(core.sent.length, 2); controller.dispose();
});

test('unknown admission keeps the original input identity and fences later results without retry', async () => {
  const core = runtime(); core.send = async (...args) => { core.sent.push(args); return { inputId: 'uncertain-original', status: 'unknown' }; };
  const controller = createSubagentsController(core, 'parent');
  await controller.submitUser('fixed', { requestId: 'original' });
  core.emit({ type: 'settled', botId: 'a', seq: 1, outcome: 'completed', output: 'result' });
  await controller.drain(); const report = controller.report();
  assert.equal(core.sent.length, 1); assert.equal(report.deliveries[0].receipt.inputId, 'uncertain-original');
  assert.equal(report.deliveries[1].reason, 'input-unknown'); controller.dispose();
});

test('parent closure and controller stop retain undelivered results without creating another parent', async () => {
  for (const reason of ['parent-closed', 'closing']) {
    const core = runtime(); const controller = createSubagentsController(core, 'parent');
    if (reason === 'closing') controller.stop(); else core.bots.get('parent').status = 'closed';
    core.emit({ type: 'settled', botId: 'a', seq: 1, outcome: 'completed', output: 'result' });
    await controller.drain(); assert.equal(core.sent.length, 0);
    assert.equal(controller.report().deliveries[0].reason, reason); controller.dispose();
  }
});

test('final wait observes parent snapshots and fails closed on unknown or a finite deadline', async () => {
  const core = runtime(); const controller = createSubagentsController(core, 'parent');
  const final = controller.waitForFinal({ accept: event => event.output === 'final', timeoutMs: 1000 });
  core.emit({ type: 'settled', botId: 'parent', seq: 1, outcome: 'completed', output: 'intermediate' });
  core.emit({ type: 'settled', botId: 'parent', seq: 2, outcome: 'completed', output: 'final' });
  assert.equal((await final).seq, 2);
  await assert.rejects(controller.waitForFinal({ accept: () => false, timeoutMs: 5 }), { code: 'WORK_DEADLINE' });
  controller.dispose();
});

test('two failed rounds remain two snapshots; the later exit adds no third failure', async () => {
  const core = runtime(); const controller = createSubagentsController(core, 'parent');
  for (const seq of [1, 2]) core.emit({ type: 'settled', botId: 'a', seq, outcome: 'failed', error: { code: `ROUND_${seq}` } });
  core.emit({ type: 'exit', botId: 'a', seq: 3, expected: false });
  await controller.drain(); assert.equal(core.sent.length, 2); controller.dispose();
});

test('a third distinct child fails the fixed example and closes new dispatch', async () => {
  const core = runtime(); const controller = createSubagentsController(core, 'parent');
  for (const id of ['a', 'b', 'c']) {
    core.bots.set(id, { id, parentId: 'parent', status: 'idle' });
    core.emit({ type: 'settled', botId: id, seq: 1, outcome: 'completed', output: 'result' });
  }
  await controller.drain(); const report = controller.report();
  assert.equal(core.sent.length, 2); assert.equal(report.accepting, false); assert.equal(report.errors[0].code, 'CHILD_LIMIT');
  controller.dispose();
});

test('event and user budgets reject excess work without sending replacements', async () => {
  const core = runtime(); const controller = createSubagentsController(core, 'parent');
  for (let index = 0; index < 5; index++) await controller.submitUser('fixed', { requestId: `user-${index}` });
  assert.throws(() => controller.submitUser('excess', { requestId: 'extra' }), TypeError);
  core.emit({ type: 'settled', botId: 'a', seq: 1, outcome: 'completed', output: 'x'.repeat(65536) });
  await controller.drain(); assert.equal(controller.report().errors[0].code, 'EVENT_LIMIT');
  assert.equal(core.sent.length, 5); controller.dispose();
});

for (const ordering of ['parent-first', 'child-queued']) test(`later child delivery cannot retrospectively validate an earlier parent final: ${ordering}`, async () => {
  const core = runtime(); const controller = createSubagentsController(core, 'parent');
  const final = controller.waitForFinal({ timeoutMs: 1000,
    accept: (event, deliveries) => event.output === 'quote: child result' && deliveries.some(row => row.result?.output === 'child result' && row.state === 'accepted') });
  const parentEvent = { type: 'settled', botId: 'parent', seq: 1, outcome: 'completed', output: 'quote: child result' };
  const childEvent = { type: 'settled', botId: 'a', seq: 1, outcome: 'completed', output: 'child result' };
  for (const event of ordering === 'parent-first' ? [parentEvent, childEvent] : [childEvent, parentEvent]) core.emit(event);
  await controller.drain();
  core.emit({ type: 'settled', botId: 'parent', seq: 2, outcome: 'completed', output: 'quote: child result' });
  assert.equal((await final).seq, 2, 'Only the new parent turn can use the subsequently dispatched result');
  controller.dispose();
});

test('fast parent settled before the accepted send receipt can use the already dispatched child snapshot', async () => {
  const core = runtime(); const controller = createSubagentsController(core, 'parent');
  core.send = async (_botId, input, options) => {
    core.sent.push({ input, ...options });
    core.emit({ type: 'settled', botId: 'parent', seq: 1, outcome: 'completed', output: 'quote: child result' });
    await new Promise(resolve => setImmediate(resolve));
    return { inputId: 'fast-original', status: 'accepted', disposition: 'started' };
  };
  const final = controller.waitForFinal({ timeoutMs: 1000,
    accept: (event, deliveries) => event.output === 'quote: child result' && deliveries.some(row => row.result?.output === 'child result' && row.receipt?.inputId === 'fast-original') });
  core.emit({ type: 'settled', botId: 'a', seq: 1, outcome: 'completed', output: 'child result' });
  assert.equal((await final).seq, 1); assert.equal(core.sent.length, 1);
  controller.dispose();
});

test('fast settled with an unknown receipt remains uncertain and cannot validate a final', async () => {
  const core = runtime(); const controller = createSubagentsController(core, 'parent');
  core.send = async () => {
    core.emit({ type: 'settled', botId: 'parent', seq: 1, outcome: 'completed', output: 'guessed final' });
    return { inputId: 'unknown-original', status: 'unknown' };
  };
  const final = controller.waitForFinal({ timeoutMs: 1000, accept: () => true });
  core.emit({ type: 'settled', botId: 'a', seq: 1, outcome: 'completed', output: 'result' });
  await assert.rejects(final, { code: 'INPUT_UNKNOWN' });
  assert.equal(controller.report().deliveries[0].receipt.inputId, 'unknown-original'); controller.dispose();
});

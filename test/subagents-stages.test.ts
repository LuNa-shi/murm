import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSubagentsStages } from '../test-support/subagents/stages.js';

function controlledRuntime() {
  let listener; let parentSeq = 0;
  const children = ['a', 'b', 'c']; const sent = [];
  const core = {
    async get(id) { return { id, status: 'idle', ...(children.includes(id) ? { parentId: 'parent' } : {}) }; },
    onEvent(fn) { listener = fn; return () => { listener = undefined; }; },
    async send(botId, input, options) {
      sent.push({ botId, input, ...options });
      return { status: 'accepted', disposition: 'queued', inputId: `input-${sent.length}` };
    },
    child(id, seq, output, outcome = 'completed') { listener({ botId: id, seq, type: 'settled', outcome, output }); },
    parent(output) { listener({ botId: 'parent', seq: ++parentSeq, type: 'settled', outcome: 'completed', output: JSON.stringify(output) }); },
  };
  return { core, children, sent };
}

test('four groups bind original child events, admitted parent inputs and cumulative parent adoption', async () => {
  const { core, children, sent } = controlledRuntime();
  const stages = await createSubagentsStages(core, 'parent', { childIds: children });
  const conclusions = [];
  for (let stage = 0; stage < 4; stage++) {
    const expected = children.map(id => `group-${stage}-${id}`);
    const waiting = stages.runStage({ stage, input: `group ${stage}`, expected, timeoutMs: 1000 });
    await stages.drain();
    children.forEach((id, index) => { core.child(id, stage + 1, expected[index]); core.child(id, stage + 1, expected[index]); });
    await stages.drain();
    conclusions.push(...children.map((childId, index) => ({ childId, eventSeq: stage + 1, quote: expected[index] })));
    if (stage) {
      const changed = structuredClone(conclusions); changed[0].quote = 'rewritten history';
      core.parent({ stage, summary: 'Invalid rewritten history.', conclusions: changed });
      await stages.drain(); assert.equal(stages.report().stages.length, stage);
    }
    core.parent({ stage, summary: 'Actual child results adopted.', conclusions });
    const result = await waiting;
    assert.equal(result.stage, stage); assert.equal(result.parent.receipt.status, 'accepted');
    assert.equal(result.parent.settled.outcome, 'completed');
    assert.equal(result.conclusions.length, (stage + 1) * 3);
    assert.ok(result.children.every(row => row.receipt.inputId && row.result.eventSeq === stage + 1));
  }
  assert.equal(sent.length, 16); assert.equal(stages.report().stages.length, 4);
  assert.throws(() => stages.runStage({ stage: 4 }), /stage/i);
  stages.dispose();
});

for (const invalid of ['duplicate', 'wrong-child', 'future', 'failed']) {
  test(`stage excludes ${invalid} evidence before accepting the actual completed snapshots`, async () => {
    const { core, children } = controlledRuntime();
    const stages = await createSubagentsStages(core, 'parent', { childIds: children });
    const expected = ['one', 'two', 'three'];
    const waiting = stages.runStage({ stage: 0, input: 'fixed task', expected, timeoutMs: 1000 });
    await stages.drain();
    const conclusions = children.map((childId, index) => ({ childId, eventSeq: 1, quote: expected[index] }));
    if (invalid !== 'future') { children.forEach((id, index) => core.child(id, 1, expected[index], invalid === 'failed' ? 'failed' : 'completed')); await stages.drain(); }
    const bad = structuredClone(conclusions);
    if (invalid === 'duplicate') bad[2] = bad[0];
    if (invalid === 'wrong-child') [bad[0].quote, bad[1].quote] = [bad[1].quote, bad[0].quote];
    core.parent({ stage: 0, summary: 'Invalid integration.', conclusions: bad });
    await stages.drain();
    assert.equal(stages.report().stages.length, 0);
    if (invalid === 'future') { children.forEach((id, index) => core.child(id, 1, expected[index])); await stages.drain(); }
    if (invalid === 'failed') {
      children.forEach((id, index) => core.child(id, 2, expected[index])); await stages.drain();
      conclusions.forEach(row => { row.eventSeq = 2; });
    }
    // A fresh parent event is mandatory; later deliveries cannot rehabilitate the old final.
    core.parent({ stage: 0, summary: 'Actual integration.', conclusions });
    const result = await waiting;
    assert.equal(result.parent.settled.seq, 2); stages.dispose();
  });
}

test('stale child snapshots cannot become a later stage and timeout retains the owner history', async () => {
  const { core, children } = controlledRuntime();
  const stages = await createSubagentsStages(core, 'parent', { childIds: children });
  children.forEach((id, index) => core.child(id, 1, ['one', 'two', 'three'][index])); await stages.drain();
  const waiting = stages.runStage({ stage: 0, input: 'fixed task', expected: ['one', 'two', 'three'], timeoutMs: 30 });
  await stages.drain();
  core.parent({ stage: 0, summary: 'Stale.', conclusions: children.map((childId, index) => ({ childId, eventSeq: 1, quote: ['one', 'two', 'three'][index] })) });
  await assert.rejects(waiting, { code: 'WORK_DEADLINE' });
  assert.equal(stages.report().stages.length, 0);
  assert.equal(stages.report().deliveries.length, 4);
  assert.throws(() => stages.runStage({ stage: 0 }), /Stage/); stages.dispose();
});

test('unknown parent admission fences later stages and preserves input identity', async () => {
  const { core, children } = controlledRuntime();
  core.send = async () => ({ status: 'unknown', inputId: 'original-unknown' });
  const stages = await createSubagentsStages(core, 'parent', { childIds: children });
  await assert.rejects(stages.runStage({ stage: 0, input: 'fixed task', expected: ['one', 'two', 'three'], timeoutMs: 100 }), { code: 'INPUT_UNKNOWN' });
  assert.equal(stages.report().deliveries[0].receipt.inputId, 'original-unknown');
  assert.equal(stages.report().accepting, false); stages.dispose();
});

test('stage identity binding rejects replacement, duplicate and unrelated children before routing', async () => {
  for (const ids of [['a', 'a', 'b'], ['a', 'b', 'outsider']]) {
    const { core } = controlledRuntime();
    await assert.rejects(createSubagentsStages(core, 'parent', { childIds: ids }), TypeError);
  }
});

test('programming verifier sees actual bound outputs and rejects invalid work before retaining a stage', async () => {
  const { core, children } = controlledRuntime();
  const stages = await createSubagentsStages(core, 'parent', { childIds: children });
  const observed = [];
  const waiting = stages.runStage({ stage: 0, input: 'programming task', timeoutMs: 1000,
    async verify(value) { observed.push(value); return value.output !== 'bad program'; } });
  await stages.drain();
  children.forEach((id, index) => core.child(id, 1, ['valid program', 'bad program', 'third program'][index])); await stages.drain();
  core.parent({ stage: 0, summary: 'Integrate programs.', conclusions: children.map((childId, index) => ({ childId, eventSeq: 1, quote: ['valid program', 'bad program', 'third program'][index] })) });
  await assert.rejects(waiting, { code: 'STAGE_RESULT_INVALID' });
  assert.equal(observed[1].childId, 'b'); assert.equal(observed[1].stage, 0);
  assert.equal(stages.report().stages.length, 0); assert.equal(stages.report().accepting, false); stages.dispose();
});

test('a nonsettling host programming verifier is bounded and cannot retain a successful stage', async () => {
  const { core, children } = controlledRuntime();
  const stages = await createSubagentsStages(core, 'parent', { childIds: children });
  const waiting = stages.runStage({stage:0,input:'programming',timeoutMs:30,verify:()=>new Promise(()=>{})});
  await stages.drain();children.forEach(id=>core.child(id,1,'result-'+id));await stages.drain();
  core.parent({stage:0,summary:'Actual text.',conclusions:children.map(childId=>({childId,eventSeq:1,quote:'result-'+childId}))});
  await assert.rejects(waiting,{code:'WORK_DEADLINE'});assert.equal(stages.report().stages.length,0);assert.equal(stages.report().accepting,false);stages.dispose();
});

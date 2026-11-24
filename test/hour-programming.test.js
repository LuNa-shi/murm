import assert from 'node:assert/strict';
import test from 'node:test';
import { createProgrammingContract } from '../src/environments/endurance/programming.js';

test('programming verification uses only the submitted payload and demands strict host success', async () => {
  const calls = [];
  const contract = createProgrammingContract({ prompt: ({peer,stage}) => `CLI ${peer}:${stage}`,
    verify: value => { calls.push(value); return value.submission.answer === 42; } });
  assert.match(contract.prompt(2, 3), /CLI 2:3/);
  await contract.verify(2, 3, { arithmetic: 'unrelated', programming: { answer: 42 } });
  assert.deepEqual(calls, [{ peer: 2, stage: 3, submission: { answer: 42 } }]);
  await assert.rejects(contract.verify(2, 3, {}), { code: 'HOUR_PROGRAMMING_INVALID' });
  await assert.rejects(contract.verify(2, 3, { programming: { answer: 41 } }), { code: 'HOUR_PROGRAMMING_INVALID' });
});
test('malformed or oversized programming ports fail closed', () => {
  assert.throws(() => createProgrammingContract({ prompt: () => 'task' }), { code: 'HOUR_PROGRAMMING_INVALID' });
  const contract = createProgrammingContract({ prompt: () => 'x'.repeat(4097), verify: () => true });
  assert.throws(() => contract.prompt(0, 0), { code: 'HOUR_PROGRAMMING_INVALID' });
});

test('only an explicit negative programming verdict identifies a correctable wrong result', async () => {
  for(const verdict of ['false', 'throw', 'undefined']) {
    const contract = createProgrammingContract({ prompt: () => 'Frozen task', verify() {
      if(verdict === 'throw') throw new Error('Independent checker unavailable');
      return verdict === 'false' ? false : undefined;
    } });
    await assert.rejects(contract.verify(0, 1, { programming: { answer: 'wrong' } }), error =>
      error.code === 'HOUR_PROGRAMMING_INVALID' && (error.rejected === true) === (verdict === 'false'));
  }
});

test('correction selects one new same-peer phase publication and preserves the old wrong evidence', async () => {
  const { createScaleMASArithmeticWorkload } = await import('../src/environments/endurance/scalemas-workload.js');
  const workload = createScaleMASArithmeticWorkload({ programming: { prompt: () => 'Frozen task', verify: ({ submission }) => submission.answer === 42 } });
  workload.ready({ peerIds: ['producer','consumer','third'] });
  const row = (address, answer) => ({ address, author: 'third', references: [], content: JSON.stringify({ peer: 2, phase: 0, n: 51, square: 2601, programming: { answer } }) });
  const wrong = row('wrong', 41), correct = row('correct', 42);
  const context = { peerIndex: 2, botId: 'third', round: 0, attempt: 0, beforeSnapshot: { contents: [] }, snapshot: { contents: [wrong] } };
  const rejected = await workload.cycle(context);
  assert.equal(rejected.rejected.reference, 'wrong'); assert.match(rejected.correction, /Recheck the complete original task input and every case/);
  assert.equal(rejected.correction.includes('42'), false, 'feedback contains no reference answer');
  await assert.rejects(workload.cycle({ ...context, snapshot: { contents: [wrong, correct] } }), { code: 'HOUR_SCALEMAS_ARTIFACT_INVALID' });
  await assert.rejects(workload.cycle({ ...context, beforeSnapshot: { contents: [wrong] } }), { code: 'HOUR_SCALEMAS_ARTIFACT_INVALID' });
  const verified = await workload.cycle({ ...context, attempt: 1, beforeSnapshot: { contents: [wrong] }, snapshot: { contents: [wrong, correct] } });
  assert.equal(verified.proof.reference, 'correct');
  assert.equal(JSON.parse(wrong.content).programming.answer, 41);
});

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

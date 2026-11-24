import assert from 'node:assert/strict';
import test from 'node:test';
import { createHourQuotaGate, createHourRunModelGate, validateHourBudgets } from '../src/environments/endurance/policy.js';
import { controlledHourQuota } from './fixtures/hour-quota-owner.js';
const budgets = { setupMs: 1000, workMs: 3900000, turnMs: 1000, cleanupMs: 1000, recoveryMs: 1000, marginMs: 100 };
test('hour policy rejects missing limits, short owner and changed identity before acceptance', () => {
  assert.throws(() => validateHourBudgets({ ...budgets, workMs: 1 }), { code: 'HOUR_BUDGET_INVALID' });
  assert.throws(() => createHourQuotaGate({ receipt: () => ({ profile: 'short' }) }, budgets), { code: 'HOUR_QUOTA_OWNER_INVALID' });
  const owner = controlledHourQuota(budgets); let changed = false;
  const check = createHourQuotaGate({ receipt() { const receipt = owner.receipt(); if (changed) receipt.deadlineAt++; return receipt; } }, budgets);
  check(); changed = true;
  assert.throws(() => check(), { code: 'HOUR_QUOTA_OWNER_CHANGED' });
});
test('final quota evidence requires confirmed listener close and known terminal settlement', async () => {
  const owner = controlledHourQuota(budgets); let unknown = false;
  const check = createHourQuotaGate({ receipt() { const receipt = owner.receipt(); if (unknown) receipt.requests[0].terminal = false; return receipt; } }, budgets);
  assert.throws(() => check({ final: true }), { code: 'HOUR_MODEL_SETTLEMENT_UNKNOWN' });
  await owner.close(); assert.equal(check({ final: true }).closed, true);
  unknown = true; assert.throws(() => check({ final: true }), { code: 'HOUR_MODEL_SETTLEMENT_UNKNOWN' });
});

test('real lifetime admission preserves its observation clock rather than extending the deadline on return', async () => {
  const { checkHourLifetime } = await import('../src/environments/endurance/policy.js');
  const botIds = ['a','b','c','d'];
  const receipt = { runtimeId: 'runtime', clockId: 'host-clock', observedAtMs: 100, workDeadlineAtMs: 3_900_100,
    stopAtMs: 4_000_000, resources: botIds.map((botId, index) => ({ botId, sandboxId: `sandbox-${index}`, expiresAtMs: 5_000_000 })) };
  assert.equal(checkHourLifetime(receipt, { runtimeId: 'runtime', botIds, workMs: 3_900_000, now: 101, controlled: false }), receipt);
  assert.throws(() => checkHourLifetime({ ...receipt, observedAtMs: -10_000 }, { runtimeId: 'runtime', botIds, workMs: 3_900_000, now: 101, controlled: false }), { code: 'HOUR_LIFETIME_UNCONFIRMED' });
  assert.throws(() => checkHourLifetime({ ...receipt, resources: [] }, { runtimeId: 'runtime', botIds, workMs: 3_900_000, now: 101, controlled: false }), { code: 'HOUR_LIFETIME_UNCONFIRMED' });
});


test('planned dispatch expiry during cleanup does not erase already settled owner evidence', async () => {
  const owner = controlledHourQuota(budgets); let expired = false;
  const check = createHourQuotaGate({ receipt: () => ({...owner.receipt(), deadlineReached: expired}) }, budgets);
  check(); await owner.close(); expired = true;
  assert.equal(check({final:true}).closed,true);
  assert.throws(() => check(), {code:'HOUR_MODEL_BUDGET_FAILED'});
});

test('time-only hour owner permits ordinary model concurrency and keeps unknown accounting visible', () => {
  let receipt = { profile: 'time_only', deadlineAt: Date.now() + budgets.workMs + 500,
    forwarded: 400, active: 8, closed: false, inputBytes: 9_000_000,
    actualInputTokens: 400_000, actualOutputTokens: 230_000, unknownRequests: 1 };
  const gate = createHourRunModelGate({ receipt: () => receipt }, budgets);
  assert.equal(gate.maxConcurrentInputs, undefined);
  assert.equal(gate.check().active, 8);
  assert.throws(() => gate.check({ final: true }), { code: 'HOUR_MODEL_METER_NOT_CLOSED' });
  receipt = { ...receipt, active: 0, closed: true };
  assert.equal(gate.check({ final: true }).unknownRequests, 1);
  assert.throws(() => gate.check(), { code: 'HOUR_MODEL_DEADLINE_REACHED' });
  receipt = { ...receipt, deadlineAt: receipt.deadlineAt + 1 };
  assert.throws(() => gate.check({ final: true }), { code: 'HOUR_MODEL_OWNER_CHANGED' });
});

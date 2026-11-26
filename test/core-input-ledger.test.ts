import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInputLedger } from '../src/core/input-ledger.js';

test('input identity separates Runtime, trusted caller and target while conflicting on changed parameters', () => {
  const ledger = createInputLedger('runtime-one');
  const parameters = { input: 'fixed', mode: 'steer' };
  const reserve = (caller, target = 'target', input = parameters) => ledger.reserve(caller, target, 'same-id', input, () => ({ token: Symbol() }));
  const host = reserve('host');
  assert.equal(reserve('host'), host);
  assert.notEqual(reserve('agent:caller-one'), host);
  assert.notEqual(reserve('agent:caller-two'), reserve('agent:caller-one'));
  assert.notEqual(reserve('host', 'other-target'), host);
  const other = createInputLedger('runtime-two').reserve('host', 'target', 'same-id', parameters, () => ({}));
  assert.notEqual(other, host);
  assert.throws(() => reserve('host', 'target', { ...parameters, mode: 'followUp' }), { code: 'CONFLICT' });
});

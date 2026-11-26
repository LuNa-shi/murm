import assert from 'node:assert/strict';

const order = (id, currency, amount_cents) => ({ id, currency, amount_cents });
const line = value => JSON.stringify(value);
const error = (line, code) => ({ line, code });
const success = (valid = [], totals = {}, errors = []) => ({
  status: errors.length ? 1 : 0,
  stdout: { valid, totals, errors },
  stderr: null,
});
const rejection = code => ({ status: 2, stdout: null, stderr: { code } });

// Published inputs for the two independent Runs. The host pins the chosen ID.
export const publicInputs = Object.freeze({
  'orders-a': [
    '{"id":"a","currency":"USD","amount_cents":100}',
    '{"id":"b","currency":"USD","amount_cents":250}',
    '{"id":"a","currency":"USD","amount_cents":999}',
    '{"id":',
    '{"id":"c","currency":"EUR","amount_cents":50}',
  ].join('\n') + '\n',
  'orders-b': [
    '{"id":"日","currency":"GBP","amount_cents":400}',
    '{"id":"雨","currency":"GBP","amount_cents":125}',
    '{"id":"日","currency":"GBP","amount_cents":900}',
    'not JSON',
    '{"id":"雲","currency":"USD","amount_cents":20}',
  ].join('\r\n'),
});

const maxOrders = Array.from({ length: 1000 }, (_, index) =>
  order(`limit-${index}`, 'USD', 9_000_000_000_000));
const maxInput = maxOrders.map(line).join('\n') + '\n';
const cases = [
  ['orders-a', { stdin: publicInputs['orders-a'] }, success(
    [order('a', 'USD', 100), order('b', 'USD', 250), order('c', 'EUR', 50)],
    { USD: 350, EUR: 50 }, [error(3, 'DUPLICATE_ID'), error(4, 'INVALID_JSON')],
  )],
  ['orders-b', { file: publicInputs['orders-b'] }, success(
    [order('日', 'GBP', 400), order('雨', 'GBP', 125), order('雲', 'USD', 20)],
    { GBP: 525, USD: 20 }, [error(3, 'DUPLICATE_ID'), error(4, 'INVALID_JSON')],
  )],
  ['empty', { stdin: '' }, success()],
  ['blank', { stdin: ' \t\r\n\r\n' }, success()],
  ['fields-currency-amount', { stdin: [
    '',
    'null',
    '[]',
    '{"id":"x","currency":"USD"}',
    '{"id":"x","currency":"USD","amount_cents":"1"}',
    line(order('', 'USD', 1)),
    line(order('x', 'usd', 1)),
    line(order('x', 'JPY', 1)),
    line(order('x', 'USD', -1)),
    line(order('x', 'USD', 0.5)),
    line(order('x', 'USD', 9_000_000_000_001)),
    '{"id":"x","currency":"USD","amount_cents":9007199254740992}',
    '{"id":"x","currency":"USD","amount_cents":1e99}',
    '{"id":"x","currency":"USD","amount_cents":0,"ignore":true}',
    line(order('x', 'EUR', 1)),
    line(order('é', 'GBP', 1)),
    line(order('e\u0301', 'GBP', 2)),
  ].join('\n') }, success(
    [order('x', 'USD', 0), order('é', 'GBP', 1), order('e\u0301', 'GBP', 2)],
    { USD: 0, GBP: 3 },
    [error(2, 'INVALID_FIELDS'), error(3, 'INVALID_FIELDS'), error(4, 'INVALID_FIELDS'),
      error(5, 'INVALID_FIELDS'), error(6, 'INVALID_FIELDS'), error(7, 'INVALID_CURRENCY'),
      error(8, 'INVALID_CURRENCY'), error(9, 'INVALID_AMOUNT'), error(10, 'INVALID_AMOUNT'),
      error(11, 'INVALID_AMOUNT'), error(12, 'INVALID_AMOUNT'), error(13, 'INVALID_AMOUNT'),
      error(15, 'DUPLICATE_ID')],
  )],
  ['exact-record-and-total-limit', { stdin: maxInput },
    success(maxOrders, { USD: 9_000_000_000_000_000 })],
  ['too-many-records', { stdin: maxInput + 'broken\n' }, rejection('INPUT_LIMIT')],
  ['usage', { args: ['first.jsonl', 'second.jsonl'] }, rejection('USAGE')],
  ['missing-file', { args: ['missing.jsonl'] }, rejection('FILE_ERROR')],
].map(([id, input, expected]) => ({ id, input, expected }));

function checkStream(actual, expected) {
  assert.equal(typeof actual, 'string');
  if (expected === null) {
    assert.equal(actual, '');
    return;
  }
  assert.ok(actual.endsWith('\n'), 'JSON output must end with LF');
  assert.deepEqual(JSON.parse(actual), expected);
}

// execute must start the candidate from a fixed commit in a clean, bounded
// environment and capture its exit status and streams. If input.file is set,
// write it to a fresh file and supply its path as the sole argument.
export async function verifyOrders(execute) {
  const results = [];
  for (const { id, input, expected } of cases) {
    try {
      const result = await execute(structuredClone(input));
      assert.equal(result.status, expected.status);
      checkStream(result.stdout, expected.stdout);
      checkStream(result.stderr, expected.stderr);
      results.push({ id, ok: true });
    } catch {
      results.push({ id, ok: false });
    }
  }
  return { ok: results.every(result => result.ok), results };
}

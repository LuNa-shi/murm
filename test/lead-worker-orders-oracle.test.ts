import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

type OrdersInput = { stdin?: string; file?: string; args?: string[] };
type OrdersTranscript = { status: number | null; stdout: string; stderr: string };

const oracleUrl = new URL('../../examples/lead-worker/fixtures/oracle.mjs', import.meta.url);
const fixture = new URL('initial-project/orders.mjs', oracleUrl);
const { verifyOrders } = await import(oracleUrl.href) as {
  verifyOrders(execute: (input: OrdersInput) => Promise<OrdersTranscript>): Promise<{
    ok: boolean;
    results: { id: string; ok: boolean }[];
  }>;
};

test('the independent orders oracle rejects the initial project and a wrong total', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-orders-oracle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const entry = join(directory, 'orders.mjs');
  await copyFile(fixture, entry);

  async function execute({ stdin = '', file, args = [] }: OrdersInput) {
    if (file !== undefined) {
      await writeFile(join(directory, 'input.jsonl'), file);
      args = ['input.jsonl'];
    }
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: directory,
      input: stdin,
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 1024 ** 2,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }

  assert.equal((await execute({ stdin: '' })).status, 1);
  const initial = await verifyOrders(execute);
  assert.equal(initial.ok, false);
  assert.ok(initial.results.every(result => !result.ok));

  const mixedOrders = {
    valid: [
      { id: 'a', currency: 'USD', amount_cents: 100 },
      { id: 'b', currency: 'USD', amount_cents: 250 },
      { id: 'c', currency: 'EUR', amount_cents: 50 },
    ],
    totals: { USD: 350, EUR: 50 },
    errors: [{ line: 3, code: 'DUPLICATE_ID' }, { line: 4, code: 'INVALID_JSON' }],
  };
  const writeMixedOrders = (usd: number) => writeFile(entry, [
    `console.log(${JSON.stringify(JSON.stringify({ ...mixedOrders, totals: { USD: usd, EUR: 50 } }))});`,
    'process.exitCode = 1;',
  ].join('\n'));
  const mixedCase = (result: typeof initial) => result.results.find(row => row.id === 'orders-a');
  await writeMixedOrders(350);
  assert.deepEqual(mixedCase(await verifyOrders(execute)), { id: 'orders-a', ok: true });

  await writeMixedOrders(1349);
  assert.deepEqual(mixedCase(await verifyOrders(execute)), { id: 'orders-a', ok: false });
});

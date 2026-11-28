import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runMockCapacity } from '../benchmarks/kubernetes/mock-capacity.js';

test('32 simulated Agents retain occupied capacity through failed deletion and reconcile every wave', { timeout: 120_000 }, async t => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'murm-mock-capacity-'));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const result = await runMockCapacity({ tier: 32, outputDirectory, waves: 3, rounds: 2, concurrency: 8, maxDurationMs: 100_000 });
  assert.equal(result.status, 'passed-mock-api');
  assert.equal(result.topology, 'loopback-http-simulation');
  assert.equal(result.capacityClaim, false);
  assert.equal(result.waves.length, 3);
  assert.equal(result.pending, 0);
  assert.equal(result.remainingResources, 0);
  assert.equal(result.inputs, 192);
  assert.equal(result.modelRequests, 0);
  assert.ok(result.waves.every(wave => wave.allocations === 32 && wave.cleanup === 'complete' && wave.ledger.complete));
});

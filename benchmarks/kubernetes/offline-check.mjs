#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Plan generation, approval rejection, and private ledger verification require no cluster access.
const runner = resolve(process.argv[2] ?? 'dist/benchmarks/kubernetes/capacity.js');
const directory = await mkdtemp(join(tmpdir(), 'murm-capacity-offline-'));
try {
  const example = JSON.parse(await readFile(new URL('./manifest.example.json', import.meta.url)));
  for (const tier of [2, 8, 32, 128, 1024]) {
    const manifest = { ...structuredClone(example), tier, implementationCommit: '0'.repeat(40), prerequisiteCommit: '1'.repeat(40),
      workerImage: 'registry.example.net/offline-worker@sha256:' + '2'.repeat(64), maxDurationMs: 18_000_000,
      maxModelRequests: 1_000_000, budget: { ...example.budget, maxComputeHours: 100_000,
        existingResourceDescription: 'Offline check only; no resources authorized' } };
    const filename = join(directory, `manifest-${tier}.json`);
    await writeFile(filename, JSON.stringify(manifest));
    const run = args => spawnSync(process.execPath, [runner, filename, ...args], { encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: directory, MURM_CLUSTER_EXECUTION_APPROVAL: '', OPEN_SANDBOX_API_KEY: '' } });
    const planned = run([]);
    assert.equal(planned.status, 0, planned.stderr);
    const parsed = JSON.parse(planned.stdout);
    assert.equal(parsed.status, 'not-run'); assert.equal(parsed.tier, tier); assert.match(parsed.manifestSha256, /^[a-f0-9]{64}$/);
    const refused = run(['--execute']);
    assert.equal(refused.status, 2);
    assert.equal(JSON.parse(refused.stderr.trim().split('\n').find(line => line.startsWith('{'))).status, 'not-run');
    assert.match(refused.stderr, /Explicit owner experiment approval is required/);
    manifest.authorization.approved = true;
    manifest.authorization.source = "Offline rejection test; no owner permission";
    manifest.authorization.approvedManifestSha256 = parsed.manifestSha256;
    await writeFile(filename, JSON.stringify(manifest));
    const stale = run(['--execute']);
    assert.equal(stale.status, 2); assert.equal(stale.stdout, '');
    assert.ok(!stale.stderr.includes('kubectl'), 'Execution must fail before any cluster command');
  }
  const { checkLedger } = await import(join(dirname(runner), 'check-ledger.js'));
  const { AllocationLedger } = await import(resolve(dirname(runner), '../../src/core/allocation-ledger.js'));
  const ledgerDirectory = join(directory, 'run');
  const options = { directory: ledgerDirectory, runtimeId: 'run', configFingerprint: 'offline', maxAgents: 1, hostIdentity: 'same-host' };
  let ledger = AllocationLedger.open(options);
  ledger.reserveIntent({ agentId: 'agent', resourceKey: 'resource', requestId: 'spawn', parameterFingerprint: 'test',
    providerId: 'opensandbox', connectionFingerprint: 'deployment', executionGeneration: 1, profile: 'probe',
    executor: 'pi', image: example.workerImage, timeoutSeconds: 60 });
  ledger.dispatched('resource');
  ledger.observeResource('resource', { sandboxId: 'original-sandbox' });
  ledger.beginClose();
  ledger.recordDeletion('resource', 'original-sandbox', 'offline management absence');
  ledger.close();
  const incomplete = checkLedger(ledgerDirectory, 'run', 1);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.unconfirmedResources, 1);
  assert.deepEqual(incomplete.sandboxIds, ['original-sandbox']);
  ledger = AllocationLedger.open(options);
  ledger.recordStop('resource', 'original-sandbox', 'offline execution stop');
  ledger.completeClose();
  ledger.close();
  assert.equal(checkLedger(ledgerDirectory, 'run', 1).complete, true);
  assert.equal(checkLedger(ledgerDirectory, 'run', 2).complete, false);
  assert.throws(() => checkLedger(ledgerDirectory, 'foreign-run', 1), /identify the original Run/);
  console.log('PASS: all five tier plans, approval rejection paths, and terminal ledger reconciliation; no cluster execution');
} finally { await rm(directory, { recursive: true, force: true }); }

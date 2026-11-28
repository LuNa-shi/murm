#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Only plan generation and the rejection path are exercised. No kubectl/API call is permitted.
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
  console.log('PASS: all five tier plans and approval rejection paths; no cluster execution');
} finally { await rm(directory, { recursive: true, force: true }); }

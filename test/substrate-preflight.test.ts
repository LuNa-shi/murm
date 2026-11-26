import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@murm/core';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
import { substratePeerProfile } from '../src/harnesses/substrate/index.js';
import { createSubstrateService } from '../src/harnesses/substrate/substrate.js';
import { substrateBackendConfiguration } from './fixtures/substrate-configuration.js';
import { createSubstrateUpstream } from './fixtures/substrate-upstream.js';

for (const poolSize of [3, 6]) test(`exact native ${poolSize}-peer Substrate configuration assembles both Runtime validators with zero Agents or model arrivals`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'scalemas-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = await createSubstrateUpstream({ deadlineAt: Date.now() + 5000, poolSize }); t.after(() => upstream.close());
  const substrate = createSubstrateService({ databasePath: join(root, 'content.sqlite'), runId: 'preflight', poolSize }); t.after(() => substrate.close());
  assert.throws(() => substrateBackendConfiguration({ upstreamUrl: 'https://hosted.invalid/v1/responses' }));
  const runtime = await createRuntime({ backend: createPiOpenSandboxBackend(substrateBackendConfiguration({ upstreamUrl: upstream.url })),
    profiles: { peer: substratePeerProfile({ image: 'unused' }) }, services: substrate.services, maxAgents: poolSize, outputDir: root });
  const closed = await runtime.close(); assert.equal(closed.cleanup, 'complete'); assert.deepEqual(closed.agents, []);
  assert.equal(upstream.receipt().arrivals, 0);
});

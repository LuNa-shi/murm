import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@swarmenv/core';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { scaleMASPeerProfile } from '../src/environments/scalemas/index.js';
import { createSubstrateService } from '../src/environments/scalemas/substrate.js';
import { scaleMASBackendConfiguration } from './fixtures/scalemas-configuration.js';
import { createScaleMASUpstream } from './fixtures/scalemas-upstream.js';

for (const poolSize of [3, 6]) test(`exact native ${poolSize}-peer scaleMAS configuration assembles both Runtime validators with zero Bots or model arrivals`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'scalemas-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = await createScaleMASUpstream({ deadlineAt: Date.now() + 5000, poolSize }); t.after(() => upstream.close());
  const substrate = createSubstrateService({ databasePath: join(root, 'content.sqlite'), runId: 'preflight', poolSize }); t.after(() => substrate.close());
  assert.throws(() => scaleMASBackendConfiguration({ upstreamUrl: 'https://hosted.invalid/v1/responses' }));
  const runtime = await createRuntime({ backend: createPiOpenSandboxBackend(scaleMASBackendConfiguration({ upstreamUrl: upstream.url })),
    profiles: { peer: scaleMASPeerProfile({ image: 'unused' }) }, services: substrate.services, maxBots: poolSize, outputDir: root });
  const closed = await runtime.close(); assert.equal(closed.cleanup, 'complete'); assert.deepEqual(closed.bots, []);
  assert.equal(upstream.receipt().arrivals, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runScaleMAS } from '../src/environments/scalemas/index.js';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { createScaleMASUpstream, sourceContent } from './fixtures/scalemas-upstream.js';
import { scaleMASBackendConfiguration } from './fixtures/scalemas-configuration.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';

const execute = promisify(execFile);
test('native fixed three-peer substrate adopts immutable producer content after stop with two same-Session turns each', {
  skip: process.env.SWARMENV_SCALEMAS_REAL_TEST !== '1' && 'Two independent exact source/image reviews required before any native launch', timeout: 210_000,
}, async () => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE; assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const directory = join(process.cwd(), 'experiments', `scalemas-${Date.now()}`); await mkdir(directory, { recursive: true, mode: 0o700 });
  const deadlineAt = Date.now() + 120_000, controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now()));
  const sessions = {}, proof = { failure: true, image, limits: { bots: 3, inputs: 6, requests: 12, outputTokens: 128, workMs: 120_000, cleanupMs: 30_000 }, hosted: null };
  const command = (name, args, options = {}) => {
    const timeout = Math.min(options.timeout ?? 5000, deadlineAt - Date.now()); assert.ok(timeout > 0);
    return execute(name, args, { ...options, timeout, signal: controller.signal });
  };
  const runtimeSummary = async () => {
    const ids = (await readdir(directory)).filter(id => /^[a-f0-9-]{36}$/.test(id)); assert.equal(ids.length, 1);
    return JSON.parse(await readFile(join(directory, ids[0], 'runtime.json'), 'utf8'));
  };
  const containerFor = async (runtimeId, botId) => {
    const key = (prefix, id) => `${prefix}-${createHash('sha256').update(id).digest('hex').slice(0, 48)}`;
    const row = await command('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=runtime_key=${key('r', runtimeId)}`, '--filter', `label=bot_key=${key('b', botId)}`]);
    return row.stdout.trim().split('\n').filter(Boolean);
  };
  let upstream, report;
  try {
    upstream = await createScaleMASUpstream({ deadlineAt, onFailure: () => controller.abort(), observe: async ({ phase, peer, previous, row }) => {
      const summary = await runtimeSummary();
      const botId = previous?.published.author ?? row.published.author;
      const containers = await containerFor(summary.runtimeId, botId); assert.equal(containers.length, 1);
      const observed = { container: containers[0], ...await sessionEvidence(containers[0], command) };
      if (phase === 'before') sessions[peer] = observed;
      else { assert.deepEqual(observed, sessions[peer]); assert.equal(observed.sessionId, row.sessionId); }
      if (phase === 'before' && peer === 1) {
        const producer = upstream.receipt().evidence.find(value => value.peer === 0 && value.cycle === 0).published.author;
        while (true) {
          controller.signal.throwIfAborted(); assert.ok(Date.now() < deadlineAt);
          const evidence = (await readFile(summary.evidence.path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
          if (evidence.some(value => value.type === 'stop' && value.botId === producer && value.state === 'observed' && value.receipt.cleanup === 'complete')) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.deepEqual(await containerFor(summary.runtimeId, producer), []);
        proof.producerDeletedBeforeReaderContinuation = true;
      }
    } });
    const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
    const backend = createPiOpenSandboxBackend(scaleMASBackendConfiguration({ host, upstreamUrl: upstream.url,
      lifecycleUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY }));
    report = await runScaleMAS({ backend, runId: `native-${Date.now()}`, image, outputDir: directory, question: 'Verify the fixed ARITHMETIC_SEED contribution through publish, search, visit and adoption.', maxRounds: 2,
      workTimeoutMs: Math.max(1, deadlineAt - Date.now()), turnTimeoutMs: 40_000, closeTimeoutMs: 30_000 }, controller.signal);
    clearTimeout(timer);
    assert.equal(report.businessFailure, null); assert.equal(report.cleanupFailure, null); assert.equal(report.reportSaveFailure, null);
    assert.equal(report.cleanup.cleanup, 'complete'); assert.equal(report.cleanup.bots.length, 3);
    assert.ok(report.peers.every(peer => peer.turns.length === 2 && peer.turns.every(turn => turn.outcome === 'completed')));
    assert.equal(new Set(Object.values(sessions).map(row => row.sessionId)).size, 3);
    assert.equal(proof.producerDeletedBeforeReaderContinuation, true);
    assert.equal(report.substrate.contents.length, 6);
    const producer = upstream.receipt().evidence.find(row => row.peer === 0 && row.cycle === 0).published;
    assert.equal(producer.content, sourceContent); assert.deepEqual(report.substrate.contents.find(row => row.address === producer.address), producer);
    for (const peer of report.peers) {
      const files = report.cleanup.bots.find(bot => bot.botId === peer.botId).artifacts.find(path => path.endsWith('/artifacts/files'));
      for (let cycle = 0; cycle < 2; cycle++) {
        const artifact = JSON.parse(await readFile(join(files, `result-${cycle}.json`), 'utf8'));
        assert.deepEqual(artifact, upstream.receipt().evidence.find(row => row.peer === peer.index && row.cycle === cycle));
      }
    }
    assert.equal(upstream.receipt().arrivals, 12); assert.equal(upstream.receipt().accepted, 12); assert.equal(upstream.receipt().failure, undefined);
    proof.failure = false;
  } finally {
    clearTimeout(timer);
    proof.report = report; proof.sessions = sessions; proof.upstream = upstream?.receipt();
    const ids = (await readdir(directory)).filter(id => /^[a-f0-9-]{36}$/.test(id));
    proof.resources = {};
    for (const id of ids) {
      try {
        const timeout = Math.min(5000, deadlineAt + 30_000 - Date.now()); assert.ok(timeout > 0);
        const key = createHash('sha256').update(id).digest('hex').slice(0, 48);
        const result = await execute('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=runtime_key=r-${key}`], { timeout });
        proof.resources[id] = { empty: result.stdout.trim() === '' };
      } catch { proof.resources[id] = { empty: false, state: 'unknown' }; }
    }
    proof.failure ||= !report || ids.length !== 1 || Object.values(proof.resources).some(row => !row.empty);
    await upstream?.close();
    await writeFile(join(directory, 'acceptance.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
  }
  assert.equal(proof.failure, false);
});

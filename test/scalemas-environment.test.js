import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
import { createHash } from 'node:crypto';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';

const bytes = Buffer.from('FIXED_PEER_ARTIFACT\n');
const records = [ { type: 'file', path: 'result.txt', mode: 0o644, bytes: bytes.length },
  { type: 'chunk', data: bytes.toString('base64') }, { type: 'fileEnd', sha256: createHash('sha256').update(bytes).digest('hex') },
  { type: 'end', totalBytes: bytes.length, fileCount: 1, directoryCount: 0 } ];
async function fixture(t, onPrompt, hooks = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scalemas-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const starts = [], prompts = [];
  const provider = await createLifecycleProvider(t, { onStart(body) { starts.push(body); }, onCollect: () => ({ records }),
    async onRpc(message) {
      if (message.type !== 'prompt') return { response: { id: message.id, success: true, command: message.type }, records: [] };
      prompts.push(message);
      const match = /^scaleMAS peer=(\d) cycle=(\d)/.exec(message.message); assert.ok(match);
      const peer = Number(match[1]), cycle = Number(match[2]);
      const outcome = await onPrompt?.({ message, peer, cycle, starts });
      if (outcome === 'unknown') return { response: { id: message.id, command: 'prompt', success: true } };
      return { response: { id: message.id, success: true, command: 'prompt', data: { disposition: 'started' } }, records: [
        { worker_sequence: cycle * 3 + 1, type: 'agent_start' },
        { worker_sequence: cycle * 3 + 2, type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'FIXED_DONE' }], stopReason: outcome === 'failed' ? 'error' : 'stop', ...(outcome === 'failed' ? { errorMessage: 'FIXED_PEER_FAILURE' } : {}) } },
        { worker_sequence: cycle * 3 + 3, type: 'agent_settled' },
      ] };
    }, ...hooks }); provider.allowDeletion();
  const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
  const backend = createPiOpenSandboxBackend({ sandbox: { lifecycleBaseUrl: provider.url },
    bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' }, modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } } });
  return { directory, starts, prompts, provider, backend };
}

test('scaleMAS fixed three-peer pool uses serial fresh inputs on each same Core Bot and saves exact artifacts with independent cleanup', async t => {
  const f = await fixture(t);
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const report = await runScaleMAS({ backend: f.backend, runId: 'fixed', image: 'fixture', outputDir: f.directory, question: 'Fixed source question', maxRounds: 2, workTimeoutMs: 5000, turnTimeoutMs: 1000, closeTimeoutMs: 1000 });
  assert.equal(report.businessFailure, null); assert.equal(report.cleanupFailure, null); assert.equal(report.reportSaveFailure, null);
  assert.equal(report.cleanup.cleanup, 'complete'); assert.equal(report.cleanup.bots.length, 3);
  assert.equal(f.provider.allocations(), 3); assert.equal(f.starts.length, 3); assert.equal(f.prompts.length, 6);
  assert.ok(f.starts.every(row => row.agent_mode === 'core' || row.command === 'pi'));
  assert.equal(new Set(report.peers.map(peer => peer.botId)).size, 3);
  assert.ok(report.peers.every(peer => peer.turns.length === 2 && new Set(peer.turns.map(turn => turn.requestId)).size === 2));
  for (const bot of report.cleanup.bots) {
    assert.equal(bot.cleanup, 'complete');
    assert.equal(await readFile(join(bot.artifacts.find(path => path.endsWith('/artifacts/files')), 'result.txt'), 'utf8'), bytes.toString());
  }
  assert.deepEqual(JSON.parse(await readFile(report.reportPath, 'utf8')).substrate, report.substrate);
});

test('a six-peer scaleMAS pool is fully ready before work and each peer completes two rounds', async t => {
  const readyCounts = [];
  const f = await fixture(t, ({ starts }) => { readyCounts.push(starts.length); });
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const report = await runScaleMAS({ backend: f.backend, runId: 'six-peers', image: 'fixture', outputDir: f.directory,
    question: 'Fixed source question', poolSize: 6, workTimeoutMs: 10_000, turnTimeoutMs: 2000, closeTimeoutMs: 2000 });
  assert.equal(report.businessFailure, null);
  assert.equal(report.policy.poolSize, 6);
  assert.equal(f.provider.allocations(), 6);
  assert.equal(f.prompts.length, 12);
  assert.deepEqual(readyCounts, Array(12).fill(6));
  assert.deepEqual(report.peers.map(peer => peer.index), [0, 1, 2, 3, 4, 5]);
  const peers = new Set(report.peers.map(peer => peer.botId));
  assert.equal(peers.size, 6);
  for (const peer of report.peers) {
    assert.deepEqual(peer.turns.map(turn => turn.round), [0, 1]);
    assert.ok(peer.turns.every(turn => turn.outcome === 'completed'));
    assert.equal(new Set(peer.turns.map(turn => turn.inputId)).size, 2);
  }
  assert.equal(report.cleanup.cleanup, 'complete');
  assert.deepEqual(new Set(report.cleanup.bots.map(bot => bot.botId)), peers);
});

test('scaleMAS rejects unsupported pool sizes before allocating Bots', async t => {
  const f = await fixture(t);
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  for (const poolSize of [2, 9, 4.5, '6', null]) {
    await assert.rejects(runScaleMAS({ backend: f.backend, runId: 'bad-pool', image: 'fixture', outputDir: f.directory,
      question: 'Fixed source question', poolSize }), { name: 'TypeError', message: /pool size/i });
  }
  assert.equal(f.provider.allocations(), 0);
});

test('actual CLI handoff adopts immutable producer content after producer stop; a failed peer is stopped without replacement', async t => {
  const published = Promise.withResolvers(), stopped = Promise.withResolvers();
  let publication; let adopted; let followup; const rows = [];
  async function cli(start, operation, input, requestId) {
    const path = join(f.directory, `input-${requestId}.json`);
    const { writeFile } = await import('node:fs/promises'); await writeFile(path, JSON.stringify(input));
    const url = new URL(start.env.SWARMENV_BRIDGE_URL); url.hostname = '127.0.0.1';
    const result = await execute(process.execPath, ['scripts/swarm.mjs', 'substrate', operation, '--input', path, '--request-id', requestId], {
      cwd: process.cwd(), env: { ...process.env, ...start.env, ...start.secret_env, SWARMENV_BRIDGE_URL: url.href }, timeout: 5000,
    }); return JSON.parse(result.stdout);
  }
  const f = await fixture(t, async ({ peer, cycle, starts }) => {
    rows.push([peer, cycle]);
    if (peer === 0) {
      if (cycle === 0) { publication = await cli(starts[0], 'publish', { content: 'A fixed algebra contribution\n', references: [] }, 'producer'); published.resolve(); }
    } else if (peer === 1) {
      await published.promise;
      await stopped.promise;
      const result = await cli(starts[1], 'search', { query: 'algebra', limit: 1 }, `search-${cycle}`);
      const original = await cli(starts[1], 'visit', { address: publication.address }, `visit-${cycle}`);
      assert.deepEqual(original, publication); assert.equal(result.results[0].address, publication.address);
      if (cycle === 0) adopted = await cli(starts[1], 'publish', { content: `B uses: ${original.content}`, references: [original.address] }, 'adopt');
      else { followup = await cli(starts[1], 'visit', { address: adopted.address }, 'read-successor'); assert.deepEqual(followup, adopted); }
    } else {
      if (cycle === 0) await cli(starts[2], 'publish', { content: 'Failed peer contribution survives', references: [] }, 'before-failure');
      else { await stopped.promise; return 'failed'; }
    }
  }, { onStop() { stopped.resolve(); return { stopped: true }; } });
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const report = await runScaleMAS({ backend: f.backend, runId: 'handoff', image: 'fixture', outputDir: f.directory, question: 'Fixed algebra source', maxRounds: 2, workTimeoutMs: 8000, turnTimeoutMs: 5000, closeTimeoutMs: 1000 });
  assert.equal(report.businessFailure.code, 'SCALEMAS_PEERS_FAILED'); assert.equal(report.cleanupFailure, null);
  assert.equal(report.peers[2].failure.code, 'input_failed'); assert.equal(report.peers[2].stop.execution, 'stopped');
  assert.ok(report.peers.slice(0, 2).every(peer => peer.failure === null && peer.turns.length === 2));
  assert.equal(f.provider.allocations(), 3); assert.equal(rows.length, 6);
  assert.deepEqual(report.substrate.contents.find(row => row.address === publication.address), publication);
  assert.deepEqual(report.substrate.contents.find(row => row.address === adopted.address), adopted);
  assert.equal(report.substrate.contents.length, 3);
  assert.equal(report.substrate.reads.filter(row => row.operation === 'visit' && row.author === report.peers[1].botId).length, 3);
  assert.equal(report.cleanup.cleanup, 'complete');
});

test('unknown submission stops only its peer and never retries or replaces it while other peers finish', async t => {
  const f = await fixture(t, ({ peer }) => peer === 2 ? 'unknown' : undefined);
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const report = await runScaleMAS({ backend: f.backend, runId: 'unknown', image: 'fixture', outputDir: f.directory, question: 'Fixed question', maxRounds: 2, workTimeoutMs: 5000, turnTimeoutMs: 1000, closeTimeoutMs: 1000 });
  assert.equal(report.peers[2].failure.code, 'input_unknown'); assert.equal(report.peers[2].turns.length, 1);
  assert.equal(report.peers[2].failure.receipt.status, 'unknown'); assert.ok(report.peers[2].failure.receipt.inputId);
  assert.ok(report.peers.slice(0, 2).every(peer => peer.turns.length === 2 && peer.failure === null));
  assert.equal(f.provider.allocations(), 3); assert.equal(f.prompts.length, 5); assert.equal(report.cleanup.cleanup, 'complete');
});

test('required artifact failure reports pending ownership independently from successful peer work and retains public data', async t => {
  const f = await fixture(t, undefined, { onCollect: () => ({ error: { code: 'INVALID_CONTRACT', error: 'Fixed export blocker' } }) });
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const report = await runScaleMAS({ backend: f.backend, runId: 'pending', image: 'fixture', outputDir: f.directory, question: 'Fixed question', maxRounds: 2, workTimeoutMs: 5000, turnTimeoutMs: 1000, closeTimeoutMs: 1000 });
  assert.equal(report.businessFailure, null); assert.equal(report.cleanupFailure.code, 'CLEANUP_PENDING');
  assert.equal(report.cleanup.cleanup, 'pending');
  assert.ok(report.cleanup.bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'pending'));
  assert.equal(report.substrate.runId, 'pending'); assert.ok(report.databasePath);
  assert.ok(report.reportPath); assert.equal(f.provider.allocations(), 3);
});

test('host cancellation fences further inputs and uses an independent cleanup window', async t => {
  const controller = new AbortController();
  const f = await fixture(t, () => { controller.abort(); });
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const report = await runScaleMAS({ backend: f.backend, runId: 'cancelled', image: 'fixture', outputDir: f.directory, question: 'Fixed question', maxRounds: 2, workTimeoutMs: 5000, turnTimeoutMs: 1000, closeTimeoutMs: 1000 }, controller.signal);
  assert.equal(report.businessFailure.code, 'SCALEMAS_WORK_ABORTED');
  assert.equal(report.cleanup.cleanup, 'complete'); assert.equal(report.cleanupFailure, null);
  assert.ok(f.prompts.length <= 3); assert.ok(report.peers.every(peer => peer.turns.length === 1));
  assert.equal(f.provider.allocations(), 3);
});

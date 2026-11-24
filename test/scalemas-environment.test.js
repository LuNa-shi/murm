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
  const starts = [], prompts = [], sequences = new Map();
  const provider = await createLifecycleProvider(t, { onStart(body) { starts.push(body); }, onCollect: () => ({ records }),
    async onRpc(message) {
      if (message.type !== 'prompt') return { response: { id: message.id, success: true, command: message.type }, records: [] };
      prompts.push(message);
      const match = /^scaleMAS peer=(\d) cycle=(\d)/.exec(message.message); assert.ok(match);
      const peer = Number(match[1]), cycle = Number(match[2]);
      const outcome = await onPrompt?.({ message, peer, cycle, starts });
      const sequence = sequences.get(peer) ?? 0; sequences.set(peer, sequence + 3);
      if (outcome === 'unknown') return { response: { id: message.id, command: 'prompt', success: true } };
      return { response: { id: message.id, success: true, command: 'prompt', data: { disposition: 'started' } }, records: [
        { worker_sequence: sequence + 1, type: 'agent_start' },
        { worker_sequence: sequence + 2, type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'FIXED_DONE' }], stopReason: outcome === 'failed' ? 'error' : 'stop', ...(outcome === 'failed' ? { errorMessage: 'FIXED_PEER_FAILURE' } : {}) } },
        { worker_sequence: sequence + 3, type: 'agent_settled' },
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

test('host cycle scheduling delays one peer while other peers complete their serial rounds', { timeout: 20_000 }, async t => {
  const held = Promise.withResolvers(), release = Promise.withResolvers(), othersDone = Promise.withResolvers();
  const completedPeers = new Set();
  const f = await fixture(t, ({ peer, cycle }) => {
    if (peer !== 0 && cycle === 1) completedPeers.add(peer);
    if (completedPeers.size === 2) othersDone.resolve();
  });
  const scheduled = [];
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const work = runScaleMAS({ backend: f.backend, runId: 'scheduled', image: 'fixture', outputDir: f.directory,
    question: 'Fixed source question', workTimeoutMs: 8000, turnTimeoutMs: 1000, closeTimeoutMs: 1000,
    async beforeCycle(context) {
      scheduled.push(context);
      if (context.peerIndex === 0 && context.round === 1) { held.resolve(); await release.promise; }
    } });
  let report;
  try {
    await Promise.race([Promise.all([held.promise, othersDone.promise]), work.then(() => assert.fail('Run ended before host scheduling held the next cycle'))]);
    assert.equal(f.prompts.filter(row => /^scaleMAS peer=0 cycle=1\n/.test(row.message)).length, 0);
    assert.equal(f.prompts.length, 5);
  } finally { release.resolve(); report = await work; }
  assert.equal(report.businessFailure, null); assert.equal(report.cleanupFailure, null);
  assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(scheduled.length, 6);
  for (const peer of report.peers) {
    assert.deepEqual(scheduled.filter(row => row.peerIndex === peer.index).map(row => row.round), [0, 1]);
    assert.ok(scheduled.filter(row => row.peerIndex === peer.index).every(row => row.botId === peer.botId && row.signal instanceof AbortSignal));
    assert.deepEqual(peer.turns.map(turn => turn.round), [0, 1]);
  }
});

test('cancellation during host cycle waiting cleans every peer without admitting an input', { timeout: 20_000 }, async t => {
  const entered = Promise.withResolvers(), never = new Promise(() => {});
  const controller = new AbortController(), signals = [];
  const f = await fixture(t);
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const work = runScaleMAS({ backend: f.backend, runId: 'cancel-schedule', image: 'fixture', outputDir: f.directory,
    question: 'Fixed source question', workTimeoutMs: 8000, turnTimeoutMs: 1000, closeTimeoutMs: 1000,
    beforeCycle({ signal }) {
      signals.push(signal);
      if (signals.length === 3) entered.resolve();
      return never;
    } }, controller.signal);
  let report;
  try {
    await Promise.race([entered.promise, work.then(() => assert.fail('Run ended before host cycle waiting'))]);
    assert.equal(f.prompts.length, 0);
  } finally { controller.abort(); report = await work; }
  assert.equal(report.businessFailure.code, 'SCALEMAS_WORK_ABORTED');
  assert.equal(report.cleanupFailure, null); assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(f.provider.allocations(), 3); assert.equal(f.prompts.length, 0);
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok(report.peers.every(peer => peer.turns.length === 0 && peer.failure.code === 'SCALEMAS_WORK_ABORTED' && peer.stop.execution === 'stopped'));
});

test('a rejected host cycle schedule stops its peer while other peers finish', async t => {
  const f = await fixture(t);
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const report = await runScaleMAS({ backend: f.backend, runId: 'bad-schedule', image: 'fixture', outputDir: f.directory,
    question: 'Fixed source question', workTimeoutMs: 5000, turnTimeoutMs: 1000, closeTimeoutMs: 1000,
    beforeCycle({ peerIndex }) { if (peerIndex === 0) throw Object.assign(new Error('Fixed schedule rejection'), { code: 'HOST_SCHEDULE_REJECTED' }); } });
  assert.equal(report.businessFailure.code, 'SCALEMAS_PEERS_FAILED');
  assert.equal(report.peers[0].failure.code, 'HOST_SCHEDULE_REJECTED'); assert.equal(report.peers[0].turns.length, 0);
  assert.ok(report.peers.slice(1).every(peer => peer.failure === null && peer.turns.length === 2));
  assert.equal(f.provider.allocations(), 3); assert.equal(f.prompts.length, 4);
  assert.equal(report.cleanupFailure, null); assert.equal(report.cleanup.cleanup, 'complete');
});

test('invalid host cycle scheduling is rejected before allocating Bots or creating content data', async t => {
  const f = await fixture(t);
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const { readdir } = await import('node:fs/promises');
  for (const beforeCycle of [null, false, 1, 'wait', {}]) {
    await assert.rejects(runScaleMAS({ backend: f.backend, runId: 'invalid-schedule', image: 'fixture', outputDir: f.directory,
      question: 'Fixed source question', beforeCycle }), { name: 'TypeError' });
  }
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(f.provider.allocations(), 0);
});

test('actual CLI handoff adopts immutable producer content after producer stop; a failed peer is stopped without replacement', async t => {
  const published = Promise.withResolvers(), stopped = Promise.withResolvers();
  let publication; let adopted; let followup; let producerStopped = false; const rows = [];
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
      assert.equal(producerStopped, true);
      const result = await cli(starts[1], 'search', { query: 'algebra', limit: 1 }, `search-${cycle}`);
      const original = await cli(starts[1], 'visit', { address: publication.address }, `visit-${cycle}`);
      assert.deepEqual(original, publication); assert.equal(result.results[0].address, publication.address);
      if (cycle === 0) adopted = await cli(starts[1], 'publish', { content: `B uses: ${original.content}`, references: [original.address] }, 'adopt');
      else { followup = await cli(starts[1], 'visit', { address: adopted.address }, 'read-successor'); assert.deepEqual(followup, adopted); }
    } else {
      if (cycle === 0) await cli(starts[2], 'publish', { content: 'Failed peer contribution survives', references: [] }, 'before-failure');
      else { await stopped.promise; return 'failed'; }
    }
  }, { onStop() { producerStopped = true; stopped.resolve(); return { stopped: true }; } });
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const report = await runScaleMAS({ backend: f.backend, runId: 'handoff', image: 'fixture', outputDir: f.directory, question: 'Fixed algebra source', maxRounds: 2, workTimeoutMs: 8000, turnTimeoutMs: 5000, closeTimeoutMs: 1000,
    beforeCycle: ({ peerIndex }) => peerIndex === 1 ? stopped.promise : undefined });
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

test('host observes real six-peer ready, started turns and owned stop receipts', async t => {
  const f = await fixture(t);const seen=[];let identity;
  const { runScaleMAS }=await import('../src/environments/scalemas/index.js');
  const report=await runScaleMAS({backend:f.backend,runId:'host-observed',image:'fixture',outputDir:f.directory,question:'Fixed question',poolSize:6,maxRounds:2,workTimeoutMs:10000,turnTimeoutMs:1000,closeTimeoutMs:1000,
    async onReady({runtime,peerIds}) {identity=runtime.id;assert.equal(peerIds.length,6);assert.equal(f.prompts.length,0);for(const id of peerIds)assert.equal((await runtime.get(id)).status,'idle');seen.push('ready');},
    onCycle({botId,result,snapshot}) {assert.equal(seen[0],'ready');assert.equal(result.receipt.disposition,'started');assert.equal(result.settled.botId,botId);assert.equal(snapshot.runtimeId,identity);seen.push('turn');},
    onPeerStop({botId,receipt,snapshot}) {assert.equal(receipt.botId,botId);assert.equal(receipt.execution,'stopped');assert.equal(snapshot.runtimeId,identity);seen.push('stop');},
  });
  assert.equal(report.businessFailure,null);assert.equal(seen.filter(x=>x==='turn').length,12);assert.equal(seen.filter(x=>x==='stop').length,6);
});

for (const scenario of ['capped', 'natural', 'correction', 'publisher-correction', 'exit', 'fatal']) test(`hour scaleMAS ${scenario === 'exit' || scenario === 'fatal' ? `rejects a terminal survivor ${scenario}` : `uses actual six-Bot CLI publication and post-stop adoption in ${scenario} mode`}`, { timeout: 60_000 }, async t => {
  const natural = ['natural', 'correction', 'publisher-correction'].includes(scenario), failAtEnd = ['exit','fatal'].includes(scenario) ? scenario : false;
  const { createScaleMASArithmeticWorkload } = await import('../src/environments/endurance/scalemas-workload.js');
  const { controlledHourQuota } = await import('./fixtures/hour-quota-owner.js');
  const { writeFile } = await import('node:fs/promises');
  let original, now = 0, activeInputs = 0, peakInputs = 0, injectingExit = false, observeExit;
  const exitSeen = Promise.withResolvers(); const waiting = [], verifiedPrograms = [];
  const budgets = { setupMs: 40_000, workMs: 3_900_000, turnMs: 20_000, cleanupMs: 5000, recoveryMs: 1000, marginMs: 100 };
  const timeReceipt = { profile: 'time_only', deadlineAt: Date.now() + budgets.workMs + budgets.setupMs,
    forwarded: 36, active: 0, closed: false, inputBytes: 99999, actualInputTokens: 10001, actualOutputTokens: 39999, unknownRequests: 1 };
  const quota = natural ? { receipt: () => ({ ...timeReceipt }), async close() { timeReceipt.closed = true; } } : controlledHourQuota(budgets);
  async function cli(start, operation, input, requestId) {
    const path = join(f.directory, `hour-${requestId}.json`); await writeFile(path, JSON.stringify(input));
    const url = new URL(start.env.SWARMENV_BRIDGE_URL); url.hostname = '127.0.0.1';
    const result = await execute(process.execPath, ['scripts/swarm.mjs', 'substrate', operation, '--input', path, '--request-id', requestId], {
      cwd: process.cwd(), env: { ...process.env, ...start.env, ...start.secret_env, SWARMENV_BRIDGE_URL: url.href }, timeout: 5000,
    }); return JSON.parse(result.stdout);
  }
  const f = await fixture(t, async ({ peer, cycle, starts, message }) => {
    activeInputs++; peakInputs = Math.max(peakInputs, activeInputs);
    try {
    assert.ok(message.message.includes(`Controlled private CLI task ${peer}:${cycle}`));
    const attempt = Number(/CORRECTION_ATTEMPT_(\d+)/.exec(message.message)?.[1] ?? 0);
    const n = 17 * (peer + 1) + cycle;
    const value = { peer, phase: cycle, n, square: n * n, programming: { answer: ((scenario === 'correction' && peer === 2 && cycle === 3) || (scenario === 'publisher-correction' && peer === 0 && cycle === 5)) && attempt === 0 ? 'genuine-wrong' : `${peer}:${cycle}` } }, references = [];
    if (peer === 0 && cycle === 5) value.tag = attempt ? `hourproducerfinalretry${attempt}` : 'hourproducerfinal';
    if (peer !== 0 && cycle >= 4) {
      const found = await cli(starts[peer], 'search', { query: JSON.parse(original.content).tag, limit: 8 }, `search-${peer}-${cycle}`);
      assert.ok(found.results.some(row => row.address === original.address));
      const visited = await cli(starts[peer], 'visit', { address: original.address }, `visit-${peer}-${cycle}`);
      value.adoptedSquare = JSON.parse(visited.content).square; value.sum = value.square + value.adoptedSquare;
      references.push(visited.address);
    }
    const published = await cli(starts[peer], 'publish', { content: JSON.stringify(value), references }, `publish-${peer}-${cycle}-${attempt}`);
    if (peer === 0 && cycle === 5) original = published;
    } finally { activeInputs--; }
  });
  const { runScaleMASHour } = await import('../src/environments/endurance/scalemas.js');
  const report = await runScaleMASHour({ options: { backend: f.backend, runId: 'hour-controlled', image: 'fixture', outputDir: f.directory },
    budgets, quota, workload: createScaleMASArithmeticWorkload({ programming: {
      prompt: ({peer,stage}) => `Controlled private CLI task ${peer}:${stage}`,
      verify: ({peer,stage,submission}) => { if(submission.answer !== `${peer}:${stage}`) return false; verifiedPrograms.push([peer,stage]); return true; },
    } }), clock: () => now,
    admit: async ({ runtime, workMs }) => {if(!observeExit)observeExit=runtime.onEvent(event=>{if(injectingExit&&(event.type==='exit'||(event.type==='error'&&event.fatal)))exitSeen.resolve();});return { runtimeId: runtime.id, workDeadlineAtMs: now + workMs + 100 };},
    async waitForMs(ms) {
      const target = now + ms, pending = Promise.withResolvers(); waiting.push({ target, ...pending });
      const count = target <= 2_700_000 ? 6 : 5;
      if (waiting.length === count) { const rows = waiting.splice(0); assert.ok(rows.every(row => row.target === target)); now = target;
        if(failAtEnd&&target===3600000){injectingExit=true;if(failAtEnd==='fatal')f.provider.publish({type:'worker_error',message:'Controlled fatal'});else f.provider.unexpectedExit();let timer;try{await Promise.race([exitSeen.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Missing actual Core exit')),2000);})]);}finally{clearTimeout(timer);}}
        for (const row of rows) row.resolve(); }
      return pending.promise;
    },
  });
  observeExit?.();
  if(failAtEnd){assert.ok(report.businessFailure);assert.equal(report.result,undefined);assert.equal(report.accepted,false);assert.equal(report.cleanup.cleanup,'complete');assert.equal(report.quota.closed,true);assert.equal(report.quota.forwarded,1);return;}
  assert.equal(report.businessFailure ?? null, null);
  assert.equal(report.accepted, false); assert.equal(report.result.state, 'controlled');
  assert.equal(report.result.durationMs, 3_600_000); assert.equal(report.result.windows.length, 4);
  assert.ok(report.result.windows.every(window => window.botIds.length >= 4));
  assert.equal(report.result.handoff.kind, 'durable-collaboration-handoff');
  assert.equal(report.cleanup.bots.length, 6); assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(peakInputs, natural ? 6 : 2); assert.equal(verifiedPrograms.length, 36); assert.equal(f.prompts.length, ['correction','publisher-correction'].includes(scenario) ? 37 : 36); assert.equal(f.provider.allocations(), 6);
  if (natural) assert.equal(report.quota.unknownRequests, 1);
  if (['correction','publisher-correction'].includes(scenario)) {
    assert.equal(report.result.publications.accepted.length, 36); assert.equal(report.result.publications.rejected.length, 1);
    const rejected = report.result.publications.rejected[0];
    assert.equal(rejected.peer, scenario === 'correction' ? 2 : 0); assert.equal(rejected.phase, scenario === 'correction' ? 3 : 5); assert.equal(rejected.attempt, 0);
    const corrected = report.result.publications.accepted.find(row => row.peer === rejected.peer && row.phase === rejected.phase);
    assert.equal(corrected.botId, rejected.botId); assert.equal(corrected.attempt, 1);
    assert.equal(typeof corrected.requestId, 'string'); assert.ok(Number.isSafeInteger(corrected.settledSeq)); assert.ok(corrected.settledSeq > rejected.settledSeq); assert.notEqual(corrected.requestId, rejected.requestId);
    assert.notEqual(corrected.address, rejected.address); assert.notEqual(corrected.inputId, rejected.inputId);
    const saved = JSON.parse(await readFile(join(f.directory, report.runtimeId, 'environment-report.json')));
    assert.equal(saved.substrate.contents.length, 37);
    assert.ok(saved.substrate.contents.some(row => row.address === rejected.address && JSON.parse(row.content).programming.answer === 'genuine-wrong'));
  }
});

for (const mode of ['deadline', 'cancel', 'unknown']) test(`explicit same-Bot correction respects original ${mode} boundary`, async t => {
  const controller = new AbortController(); let callbacks = 0;
  const f = await fixture(t, ({ peer }) => mode === 'unknown' && peer === 0 ? 'unknown' : undefined);
  const { runScaleMAS } = await import('../src/environments/scalemas/index.js');
  const report = await runScaleMAS({ backend: f.backend, runId: `correction-${mode}`, image: 'fixture', outputDir: f.directory,
    question: 'Fixed task; independently verify before accepting', maxRounds: 2, workTimeoutMs: 3000, turnTimeoutMs: 100, closeTimeoutMs: 1000,
    async onCycle({ peerIndex, round }) {
      if(peerIndex !== 0 || round !== 0) return;
      callbacks++;
      if(mode === 'deadline') await new Promise(resolve => setTimeout(resolve, 120));
      if(mode === 'cancel') controller.abort();
      return { correction: 'Recheck the complete task input and correct your own result. No reference answer supplied.', timeoutMs: 1000,
        rejected: { reference: 'controlled', sha256: 'a'.repeat(64), code: 'CONTROLLED_REJECTION' } };
    },
  }, controller.signal);
  assert.equal(f.provider.allocations(), 3); assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(f.prompts.filter(row => /^scaleMAS peer=0 /.test(row.message)).length, 1);
  assert.equal(callbacks, mode === 'unknown' ? 0 : 1);
  assert.ok(report.businessFailure);
  if(mode === 'deadline') assert.equal(report.peers[0].failure.code, 'SCALEMAS_CORRECTION_WINDOW_CLOSED');
  if(mode === 'unknown') assert.equal(report.peers[0].failure.code, 'input_unknown');
});

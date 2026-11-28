import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';
import { verifySubstrateCollaboration } from '../examples/substrate/harness/collaboration-evidence.js';
const execute = promisify(execFile);

test('host checkpoints verify durable search, visit, citation and reads after confirmed publisher stop', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'scalemas-evidence-'));
  let runtime;
  let substrate;
  t.after(async () => {
    if (runtime) assert.equal((await runtime.close({ timeoutMs: 1000 })).cleanup, 'complete');
    substrate?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const starts = [];
  const provider = await createLifecycleProvider(t, { onStart: body => starts.push(body) }); provider.allowDeletion();
  const { createRuntime } = await import('@luna-shi/murm');
  const { createSubstrateService } = await import('../examples/substrate/services/substrate.js');
  substrate = createSubstrateService({ databasePath: join(directory, 'substrate.sqlite'), runId: 'evidence' });

  const backend = runtimeSettings({ sandbox: { lifecycleBaseUrl: provider.url, apiKey: provider.apiKey, egressMode: 'dns+nft' },
    bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' }, modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'api' } });
  runtime = await createRuntime({ ...backend, outputDir: directory, maxAgents: 2, services: substrate.services,
    profiles: { peer: { image: 'fixture', model: 'default', prompt: 'Fixed peer', writable: true, services: { substrate: ['publish', 'search', 'visit'] } } } });
  substrate.bindRuntime(runtime.id);
  const publisher = await runtime.spawn({ requestId: 'publisher', profile: 'peer' }); substrate.bindPeer(publisher.id);
  const consumer = await runtime.spawn({ requestId: 'consumer', profile: 'peer' }); substrate.bindPeer(consumer.id);
  let request = 0;
  const call = async (author, operation, input) => {
    const start = starts[author === 'publisher' ? 0 : 1]; const requestId = `request-${++request}`;
    const inputPath = join(directory, `${requestId}.json`); await writeFile(inputPath, JSON.stringify(input));
    const url = new URL(start.env.MURM_BRIDGE_URL); url.hostname = '127.0.0.1';
    const result = await execute(process.execPath, ['dist/scripts/swarm.js', 'substrate', operation, '--input', inputPath, '--request-id', requestId], {
      cwd: process.cwd(), env: { ...process.env, ...start.env, ...start.secret_env, MURM_BRIDGE_URL: url.href }, timeout: 5000,
    }); return JSON.parse(result.stdout);
  };
  const original = await call('publisher', 'publish', { content: 'fixed algebra source' });
  const publisherStop = await runtime.stop(publisher.id, { timeoutMs: 1000 });
  assert.equal(publisherStop.execution, 'stopped'); assert.equal(publisherStop.cleanup, 'complete');
  substrate.retirePeer(publisher.id);
  const afterStop = substrate.snapshot();
  await call('consumer', 'search', { query: 'algebra', limit: 1 });
  await call('consumer', 'visit', { address: original.address });
  const beforeSuccessor = substrate.snapshot();
  const successor = await call('consumer', 'publish', { content: 'successor uses fixed algebra source', references: [original.address] });
  const evidence = { publisherStop, afterStop, beforeSuccessor, finalSnapshot: substrate.snapshot(), consumerId: consumer.id, originalAddress: original.address, successorAddress: successor.address };
  const verified = verifySubstrateCollaboration(evidence);
  assert.equal(verified.accepted, true);
  assert.equal(verified.publisherCleanup, 'complete');
  assert.equal(verifySubstrateCollaboration({ ...evidence, publisherStop: { ...publisherStop, cleanup: 'pending' } }).publisherCleanup, 'pending');
  assert.equal(verified.originalAddress, original.address);
  assert.equal(verified.successorAddress, successor.address);
  assert.equal(verified.searchReadIndex, 0); assert.equal(verified.visitReadIndex, 1);
  for (const change of [
    { publisherStop: undefined },
    { publisherStop: { ...publisherStop, execution: 'unknown' } },
    { publisherStop: { ...publisherStop, agentId: consumer.id } },
    { afterStop: beforeSuccessor },
    { consumerId: publisher.id },
    { successorAddress: original.address },
    { beforeSuccessor: { ...beforeSuccessor, reads: beforeSuccessor.reads.slice(0, 1) } },
    { finalSnapshot: { ...evidence.finalSnapshot, contents: evidence.finalSnapshot.contents.map(row => row.address === successor.address ? { ...row, references: [] } : row) } },
    { beforeSuccessor: evidence.finalSnapshot },
    { finalSnapshot: { ...evidence.finalSnapshot, runId: 'other' } },
    { beforeSuccessor: { ...beforeSuccessor, reads: beforeSuccessor.reads.slice(1) } },
    { finalSnapshot: { ...evidence.finalSnapshot, contents: evidence.finalSnapshot.contents.map(row => row.address === original.address ? { ...row, content: 'changed' } : row) } },
  ]) assert.throws(() => verifySubstrateCollaboration({ ...evidence, ...change }), { code: 'COLLABORATION_EVIDENCE_INVALID' });
  assert.deepEqual(substrate.snapshot(), evidence.finalSnapshot);
});

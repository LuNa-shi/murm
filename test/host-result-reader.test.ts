import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '@luna-shi/murm';
import { ServiceRegistry } from '@luna-shi/murm';

import { runWithReport } from '../src/harnesses/shared/run-report.js';

async function recordedRun(t, run = async () => ({ accepted: true, privateOutput: 'DO_NOT_PRINT_RESULT' })) {
  const outputDir = await mkdtemp(join(tmpdir(), 'host-result-reader-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const report = await runWithReport({ outputDir, createRuntime: () => createRuntime({
    outputDir, maxAgents: 1, profiles: { worker: { prompt: 'Unused profile', model: 'default', image: 'unused', writable: true, services: {} } }, services: new ServiceRegistry(),
    ...runtimeSettings({
      sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' },
      bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
      modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: { Authorization: 'PRIVATE_CONFIG_SECRET' } } } },
      isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
    }),
  }), run: runtime => run(runtime, outputDir) });
  return { report, runDirectory: join(outputDir, report.runtimeId), runtimeId: report.runtimeId };
}

test('reads actual Core and Environment reports without turning a returned accepted flag into business acceptance', async t => {
  const { readHarnessResult } = await import('../src/harnesses/shared/read-result.js');
  const input = await recordedRun(t);
  const result = await readHarnessResult(input);
  assert.equal(result.runtimeId, input.runtimeId);
  assert.equal(result.harness.state, 'read');
  assert.equal(result.harness.business, 'returned');
  assert.equal(result.harness.acceptance, 'not-interpreted');
  assert.equal(result.harness.resultLocation.path, input.report.reportPath);
  assert.equal(result.harness.resultLocation.field, 'result');
  assert.equal(result.core.recordedStatus, 'closed');
  assert.equal(result.core.cleanup, 'complete');
  assert.deepEqual(result.core.agents, []);
  assert.equal(result.liveStatus, 'not-observed');
  assert.equal(JSON.stringify(result).includes('DO_NOT_PRINT_RESULT'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_CONFIG_SECRET'), false);
  assert.equal('config' in result.core, false);
});

test('retains real pending cleanup independently of business failure and later Core reconciliation', async t => {
  const { readHarnessResult } = await import('../src/harnesses/shared/read-result.js');
  let runtime;
  const input = await recordedRun(t, async (owned, outputDir) => {
    runtime = owned;
    const path = join(outputDir, owned.id, 'runtime.json');
    await rm(path);
    await mkdir(path);
    throw Object.assign(new Error('PRIVATE_BUSINESS_MESSAGE'), { code: 'FIXTURE_BUSINESS_FAILED' });
  });
  const pending = await readHarnessResult(input);
  assert.equal(pending.harness.business, 'failed');
  assert.equal(pending.harness.businessFailureCode, 'FIXTURE_BUSINESS_FAILED');
  assert.equal(pending.harness.cleanup, 'pending');
  assert.equal(pending.harness.cleanupFailureCode, 'CLEANUP_PENDING');
  assert.equal(pending.core.state, 'unreadable');
  assert.equal(JSON.stringify(pending).includes('PRIVATE_BUSINESS_MESSAGE'), false);
  await rm(join(input.runDirectory, 'runtime.json'), { recursive: true });
  await runtime.close();
  const reconciled = await readHarnessResult(input);
  assert.equal(reconciled.core.cleanup, 'complete');
  assert.equal(reconciled.harness.cleanup, 'pending');
  assert.equal(reconciled.harness.business, 'failed');
});

test('rejects foreign or corrupt saved identities without exposing their results and does not invent missing state', async t => {
  const { readHarnessResult } = await import('../src/harnesses/shared/read-result.js');
  const input = await recordedRun(t);
  const foreign = await readHarnessResult({ ...input, runtimeId: 'another-runtime' });
  assert.equal(foreign.harness.state, 'identity-mismatch');
  assert.equal(foreign.core.state, 'identity-mismatch');
  assert.equal(foreign.harness.business, 'unknown');
  assert.deepEqual(foreign.artifacts, []);
  await writeFile(input.report.reportPath, '{broken');
  const invalid = await readHarnessResult(input);
  assert.equal(invalid.harness.state, 'invalid');
  assert.equal(invalid.core.cleanup, 'complete');
  await writeFile(input.report.reportPath, JSON.stringify({ runtimeId: input.runtimeId, result: 'PRIVATE', businessFailure: null, cleanup: { agents: [null] }, cleanupFailure: null, reportSaveFailure: null }));
  assert.equal((await readHarnessResult(input)).harness.state, 'invalid');
  await rm(input.report.reportPath);
  assert.equal((await readHarnessResult(input)).harness.state, 'missing');
  await writeFile(join(input.runDirectory, 'runtime.json'), JSON.stringify({ runtimeId: input.runtimeId, status: 'open', agents: [null] }));
  assert.equal((await readHarnessResult(input)).core.state, 'invalid');
  await writeFile(join(input.runDirectory, 'runtime.json'), JSON.stringify({ runtimeId: input.runtimeId, status: 'starting' }));
  const starting = await readHarnessResult(input);
  assert.equal(starting.core.recordedStatus, 'starting');
  assert.equal(starting.core.cleanup, 'unknown');
  assert.equal(starting.core.agents, null);
  assert.equal(starting.core.pending, null);
  await writeFile(join(input.runDirectory, 'runtime.json'), JSON.stringify({ runtimeId: input.runtimeId, status: 'closing', cleanup: 'pending', pending: [null] }));
  assert.equal((await readHarnessResult(input)).core.state, 'invalid');
  await writeFile(join(input.runDirectory, 'runtime.json'), JSON.stringify({ runtimeId: input.runtimeId, status: 'closed', cleanup: 'complete', agents: [{ agentId: 'b', execution: 'unknown', cleanup: 'pending' }], pending: [] }));
  assert.equal((await readHarnessResult(input)).core.state, 'invalid');
  await writeFile(join(input.runDirectory, 'runtime.json'), JSON.stringify({ runtimeId: input.runtimeId, status: 'closed', cleanup: 'complete', agents: [], pending: [{ kind: 'backend' }] }));
  assert.equal((await readHarnessResult(input)).core.state, 'invalid');
});

test('reads an Environment-only factory failure and checks recorded artifact locations without dumping error details', async t => {
  const { readHarnessResult } = await import('../src/harnesses/shared/read-result.js');
  const root = await mkdtemp(join(tmpdir(), 'environment-only-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runWithReport({ outputDir: root,
    createRuntime: async () => { throw Object.assign(new Error('PRIVATE_STARTUP_DETAIL'), { runtimeId: 'failed-factory', code: 'START_FAILED', cleanup: 'pending', details: ['PRIVATE_EVIDENCE'] }); },
    run: async () => { throw new Error('must not run'); },
  });
  const result = await readHarnessResult({ runDirectory: join(root, report.runtimeId), runtimeId: report.runtimeId });
  assert.equal(result.harness.business, 'failed');
  assert.equal(result.harness.businessFailureCode, 'START_FAILED');
  assert.equal(result.harness.cleanupFailureCode, 'FACTORY_CLEANUP_PENDING');
  assert.equal(result.core.state, 'missing');
  assert.equal(result.core.cleanup, 'unknown');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  const artifact = join(root, 'review.md');
  await writeFile(artifact, 'PRIVATE_ARTIFACT_CONTENT');
  const saved = await runWithReport({ outputDir: root,
    createRuntime: async () => ({ id: 'artifact-fixture', close: async () => ({ cleanup: 'pending', agents: [
      { agentId: 'fixture-agent', execution: 'stopped', cleanup: 'pending', artifacts: [artifact, join(root, 'absent.md')] },
    ] }) }), run: async () => ({ publicResult: 'PRIVATE_RESULT_CONTENT' }),
  });
  const artifacts = await readHarnessResult({ runDirectory: join(root, saved.runtimeId), runtimeId: saved.runtimeId });
  assert.deepEqual(artifacts.artifacts.map(row => row.availability), ['file', 'missing']);
  assert.equal(artifacts.harness.cleanup, 'pending');
  assert.equal(artifacts.harness.agents[0].execution, 'stopped');
  assert.equal(JSON.stringify(artifacts).includes('PRIVATE_'), false);
});

test('host result CLI returns the same projection with explicit identity and reports usage or unreadable records separately', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { readHarnessResult } = await import('../src/harnesses/shared/read-result.js');
  const execute = promisify(execFile);
  const cli = fileURLToPath(new URL('../scripts/read-harness-result.js', import.meta.url));
  const input = await recordedRun(t);
  const { stdout } = await execute(process.execPath, [cli, '--run-directory', input.runDirectory, '--runtime-id', input.runtimeId]);
  assert.deepEqual(JSON.parse(stdout), await readHarnessResult(input));
  await assert.rejects(execute(process.execPath, [cli, '--run-directory', input.runDirectory]), error => {
    assert.equal(error.code, 2);
    assert.equal(JSON.parse(error.stderr).code, 'INVALID_RESULT_ARGUMENTS'); return true;
  });
  await assert.rejects(execute(process.execPath, [cli, '--run-directory', input.runDirectory, '--runtime-id', 'foreign']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).core.state, 'identity-mismatch'); return true;
  });
});

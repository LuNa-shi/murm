import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '@swarmenv/core';
import { ServiceRegistry } from '@swarmenv/core/services';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { runWithReport } from '../src/environments/shared/run-report.js';

async function recordedRun(t, run = async () => ({ accepted: true, privateOutput: 'DO_NOT_PRINT_RESULT' })) {
  const outputDir = await mkdtemp(join(tmpdir(), 'host-result-reader-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const report = await runWithReport({ outputDir, createRuntime: () => createRuntime({
    outputDir, maxBots: 1, profiles: { worker: { prompt: 'Unused profile', model: 'default', image: 'unused', writable: true, services: {} } }, services: new ServiceRegistry(),
    backend: createPiOpenSandboxBackend({
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
  const { readEnvironmentResult } = await import('../src/environments/shared/read-result.js');
  const input = await recordedRun(t);
  const result = await readEnvironmentResult(input);
  assert.equal(result.runtimeId, input.runtimeId);
  assert.equal(result.environment.state, 'read');
  assert.equal(result.environment.business, 'returned');
  assert.equal(result.environment.acceptance, 'not-interpreted');
  assert.equal(result.environment.resultLocation.path, input.report.reportPath);
  assert.equal(result.environment.resultLocation.field, 'result');
  assert.equal(result.core.recordedStatus, 'closed');
  assert.equal(result.core.cleanup, 'complete');
  assert.deepEqual(result.core.bots, []);
  assert.equal(result.liveStatus, 'not-observed');
  assert.equal(JSON.stringify(result).includes('DO_NOT_PRINT_RESULT'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_CONFIG_SECRET'), false);
  assert.equal('config' in result.core, false);
});

test('retains real pending cleanup independently of business failure and later Core reconciliation', async t => {
  const { readEnvironmentResult } = await import('../src/environments/shared/read-result.js');
  let runtime;
  const input = await recordedRun(t, async (owned, outputDir) => {
    runtime = owned;
    const path = join(outputDir, owned.id, 'runtime.json');
    await rm(path);
    await mkdir(path);
    throw Object.assign(new Error('PRIVATE_BUSINESS_MESSAGE'), { code: 'FIXTURE_BUSINESS_FAILED' });
  });
  const pending = await readEnvironmentResult(input);
  assert.equal(pending.environment.business, 'failed');
  assert.equal(pending.environment.businessFailureCode, 'FIXTURE_BUSINESS_FAILED');
  assert.equal(pending.environment.cleanup, 'pending');
  assert.equal(pending.environment.cleanupFailureCode, 'CLEANUP_PENDING');
  assert.equal(pending.core.state, 'unreadable');
  assert.equal(JSON.stringify(pending).includes('PRIVATE_BUSINESS_MESSAGE'), false);
  await rm(join(input.runDirectory, 'runtime.json'), { recursive: true });
  await runtime.close();
  const reconciled = await readEnvironmentResult(input);
  assert.equal(reconciled.core.cleanup, 'complete');
  assert.equal(reconciled.environment.cleanup, 'pending');
  assert.equal(reconciled.environment.business, 'failed');
});

test('rejects foreign or corrupt saved identities without exposing their results and does not invent missing state', async t => {
  const { readEnvironmentResult } = await import('../src/environments/shared/read-result.js');
  const input = await recordedRun(t);
  const foreign = await readEnvironmentResult({ ...input, runtimeId: 'another-runtime' });
  assert.equal(foreign.environment.state, 'identity-mismatch');
  assert.equal(foreign.core.state, 'identity-mismatch');
  assert.equal(foreign.environment.business, 'unknown');
  assert.deepEqual(foreign.artifacts, []);
  await writeFile(input.report.reportPath, '{broken');
  const invalid = await readEnvironmentResult(input);
  assert.equal(invalid.environment.state, 'invalid');
  assert.equal(invalid.core.cleanup, 'complete');
  await writeFile(input.report.reportPath, JSON.stringify({ runtimeId: input.runtimeId, result: 'PRIVATE', businessFailure: null, cleanup: { bots: [null] }, cleanupFailure: null, reportSaveFailure: null }));
  assert.equal((await readEnvironmentResult(input)).environment.state, 'invalid');
  await rm(input.report.reportPath);
  assert.equal((await readEnvironmentResult(input)).environment.state, 'missing');
  await writeFile(join(input.runDirectory, 'runtime.json'), JSON.stringify({ runtimeId: input.runtimeId, status: 'open', bots: [null] }));
  assert.equal((await readEnvironmentResult(input)).core.state, 'invalid');
  await writeFile(join(input.runDirectory, 'runtime.json'), JSON.stringify({ runtimeId: input.runtimeId, status: 'starting' }));
  const starting = await readEnvironmentResult(input);
  assert.equal(starting.core.recordedStatus, 'starting');
  assert.equal(starting.core.cleanup, 'unknown');
  assert.equal(starting.core.bots, null);
  assert.equal(starting.core.pending, null);
  await writeFile(join(input.runDirectory, 'runtime.json'), JSON.stringify({ runtimeId: input.runtimeId, status: 'closing', cleanup: 'pending', pending: [null] }));
  assert.equal((await readEnvironmentResult(input)).core.state, 'invalid');
  await writeFile(join(input.runDirectory, 'runtime.json'), JSON.stringify({ runtimeId: input.runtimeId, status: 'closed', cleanup: 'complete', bots: [{ botId: 'b', execution: 'unknown', cleanup: 'pending' }], pending: [] }));
  assert.equal((await readEnvironmentResult(input)).core.state, 'invalid');
  await writeFile(join(input.runDirectory, 'runtime.json'), JSON.stringify({ runtimeId: input.runtimeId, status: 'closed', cleanup: 'complete', bots: [], pending: [{ kind: 'backend' }] }));
  assert.equal((await readEnvironmentResult(input)).core.state, 'invalid');
});

test('reads an Environment-only factory failure and checks recorded artifact locations without dumping error details', async t => {
  const { readEnvironmentResult } = await import('../src/environments/shared/read-result.js');
  const root = await mkdtemp(join(tmpdir(), 'environment-only-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runWithReport({ outputDir: root,
    createRuntime: async () => { throw Object.assign(new Error('PRIVATE_STARTUP_DETAIL'), { runtimeId: 'failed-factory', code: 'START_FAILED', cleanup: 'pending', details: ['PRIVATE_EVIDENCE'] }); },
    run: async () => { throw new Error('must not run'); },
  });
  const result = await readEnvironmentResult({ runDirectory: join(root, report.runtimeId), runtimeId: report.runtimeId });
  assert.equal(result.environment.business, 'failed');
  assert.equal(result.environment.businessFailureCode, 'START_FAILED');
  assert.equal(result.environment.cleanupFailureCode, 'FACTORY_CLEANUP_PENDING');
  assert.equal(result.core.state, 'missing');
  assert.equal(result.core.cleanup, 'unknown');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  const artifact = join(root, 'review.md');
  await writeFile(artifact, 'PRIVATE_ARTIFACT_CONTENT');
  const saved = await runWithReport({ outputDir: root,
    createRuntime: async () => ({ id: 'artifact-fixture', close: async () => ({ cleanup: 'pending', bots: [
      { botId: 'fixture-bot', execution: 'stopped', cleanup: 'pending', artifacts: [artifact, join(root, 'absent.md')] },
    ] }) }), run: async () => ({ publicResult: 'PRIVATE_RESULT_CONTENT' }),
  });
  const artifacts = await readEnvironmentResult({ runDirectory: join(root, saved.runtimeId), runtimeId: saved.runtimeId });
  assert.deepEqual(artifacts.artifacts.map(row => row.availability), ['file', 'missing']);
  assert.equal(artifacts.environment.cleanup, 'pending');
  assert.equal(artifacts.environment.bots[0].execution, 'stopped');
  assert.equal(JSON.stringify(artifacts).includes('PRIVATE_'), false);
});

test('host result CLI returns the same projection with explicit identity and reports usage or unreadable records separately', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { readEnvironmentResult } = await import('../src/environments/shared/read-result.js');
  const execute = promisify(execFile);
  const cli = fileURLToPath(new URL('../scripts/read-environment-result.js', import.meta.url));
  const input = await recordedRun(t);
  const { stdout } = await execute(process.execPath, [cli, '--run-directory', input.runDirectory, '--runtime-id', input.runtimeId]);
  assert.deepEqual(JSON.parse(stdout), await readEnvironmentResult(input));
  await assert.rejects(execute(process.execPath, [cli, '--run-directory', input.runDirectory]), error => {
    assert.equal(error.code, 2);
    assert.equal(JSON.parse(error.stderr).code, 'INVALID_RESULT_ARGUMENTS'); return true;
  });
  await assert.rejects(execute(process.execPath, [cli, '--run-directory', input.runDirectory, '--runtime-id', 'foreign']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).core.state, 'identity-mismatch'); return true;
  });
});

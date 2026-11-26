import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createNativeEvidenceDirectory, installNativeNotesExample } from './fixtures/notes-installed-package.js';
import { createLocalPeerMeshStack } from './fixtures/peermesh-local-stack.js';
import { createCleanupBudget } from './fixtures/peermesh-deadline.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createDynamicLeadWorkerUpstream } from './fixtures/lead-worker-dynamic-upstream.js';
import { generatedService } from './fixtures/lead-worker-dynamic-orders.js';

const execute = promisify(execFile);

test('dynamic Lead-Worker runs via the installed package with native Pi, Gitea and an isolated checking Service', {
  skip: process.env.MURM_LEAD_WORKER_DYNAMIC_NATIVE_TEST !== '1',
  timeout: 650_000,
}, async () => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  const serviceImage = process.env.MURM_LEAD_WORKER_SERVICE_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(serviceImage ?? '', /^sha256:[a-f0-9]{64}$/);
  const directory = await createNativeEvidenceDirectory('lead-worker-dynamic');
  const runId = `dyn-${randomBytes(6).toString('hex')}`;
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const outputDir = join(directory, 'output');
  const candidatePath = join(directory, 'candidate.json');
  await mkdir(outputDir);
  const installed = await installNativeNotesExample();
  const packageDir = join(installed.directory, 'node_modules/@murm/core/dist/examples/lead-worker');
  const stack = await createLocalPeerMeshStack({ directory: join(directory, 'facilities'), advertiseHost: host, giteaOnly: true });
  const cleanup = createCleanupBudget(80_000);
  const proof: Record<string, any> = { runId, image, serviceImage, installed: installed.metadata, configuration: {
    provider: 'scripted-responses', model: 'k3', agents: 4, serviceContainers: 1,
    toolRequestLimit: 64, workMs: 240_000, turnMs: 150_000, cleanupMs: 80_000,
  } };
  let upstream;
  let report;
  let resources;
  let failure: unknown;
  try {
    const facility = await stack.start();
    resources = facility;
    upstream = await createDynamicLeadWorkerUpstream();
    const configuration = { runId, image, outputDir, gitea: facility.gitea, turnTimeoutMs: 150_000, workTimeoutMs: 240_000,
      closeTimeoutMs: 55_000, exportLimit: 16 * 1024 ** 2, dynamic: { variant: 'orders-a', serviceImage, candidatePath },
      backend: {
        sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
          endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
        modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 25_000, maxOutputTokens: 512 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
        isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
      },
    };
    const configPath = join(directory, 'config.mjs');
    await writeFile(configPath, `const config=${JSON.stringify(configuration)};config.backend.sandbox.apiKey=process.env.MURM_CORE_TEST_API_KEY;export default config;\n`, { mode: 0o600 });
    let exit = 0;
    try {
      const result = await execute(process.execPath, [join(packageDir, 'main.js'), configPath], {
        cwd: installed.directory, env: installed.env, timeout: 330_000, killSignal: 'SIGTERM', maxBuffer: 8 * 1024 ** 2,
      });
      report = JSON.parse(result.stdout);
    } catch (error: any) {
      if (error.stdout) report = JSON.parse(error.stdout);
      exit = error.code ?? 1;
    }
    proof.report = report;
    assert.equal(exit, 0, JSON.stringify({ failure: report?.businessFailure?.code,
      cleanup: report?.cleanupFailure?.code, upstream: upstream.receipt().failure }));
    assert.equal(report.businessFailure, null);
    assert.equal(report.cleanupFailure, null);
    assert.equal(report.reportSaveFailure, null);
    assert.equal(report.cleanup.cleanup, 'complete');
    const state = report.result.harness.board;
    const identities = Object.values(state.team);
    assert.equal(new Set(identities).size, 4);
    assert.ok(report.cleanup.agents.every(row => row.execution === 'stopped' && row.cleanup === 'complete'));
    const resourcesReceipt = report.cleanup.harness.resources;
    const container = resourcesReceipt.find(row => row.kind === 'checking-container');
    assert.equal(container.state, 'closed');
    assert.equal(resourcesReceipt.filter(row => row.kind === 'gitea-account' && row.state === 'closed').length, 4);
    const list = await execute('docker', ['container', 'ls', '-a', '--filter', `name=^/${container.id}$`, '--format', '{{.Names}}'], { timeout: 5000 });
    assert.equal(list.stdout, '');
    const definition = report.result.harness.dynamic.deployment;
    assert.equal(definition.sourceDigest, createHash('sha256').update(generatedService).digest('hex'));
    assert.deepEqual(definition.verification, { validInput: true, duplicateAndMalformedInput: true });
    const notes = state.notes.filter(row => row.actor === state.team.checker);
    assert.equal(notes.length, 1);
    assert.ok(state.submitted.feedbackIds.includes(notes[0].seq));
    const ready = state.history.find(row => row.type === 'member_ready');
    assert.ok(state.history.filter(row => row.type === 'claim' && [state.team.helper1, state.team.helper2].includes(row.actor))
      .slice(0, 2).every(row => row.seq < ready.seq));
    assert.ok(state.history.find(row => row.type === 'complete' && row.actor === state.team.helper1 && row.subtaskId === 'adopt').seq > notes[0].seq);
    const script = upstream.receipt();
    assert.equal(script.failure, undefined);
    const worker = (script.evidence as any[]).filter(row => row.role === 'helper1');
    assert.deepEqual(worker.filter(row => row.dispatch).map(row => row.dispatch), [403, 200, 403]);
    assert.deepEqual(new Set(worker.map(row => row.agentId)), new Set([state.team.helper1]));
    assert.deepEqual(new Set(worker.map(row => row.branch)).size, 1);
    assert.deepEqual(new Set(worker.map(row => row.directory)), new Set(['/workspace/project']));
    assert.equal(worker[0].session.length, 1);
    assert.ok(worker.every(row => JSON.stringify(row.session) === JSON.stringify(worker[0].session)));
    const calls = (await readFile(join(outputDir, report.runtimeId, 'service-calls.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    const attempts = calls.filter(row => row.phase === 'settled' && row.service === definition.id && row.operation === 'check_orders');
    const probes = attempts.filter(row => row.caller.agentId === state.team.helper1 && row.operation_id.startsWith('direct-'));
    assert.deepEqual(probes.map(row => [row.operation_id, row.accessVersion, row.error?.code ?? 'ok']),
      [['direct-before', 0, 'NOT_ALLOWED'], ['direct-granted', 1, 'ok'], ['direct-revoked', 2, 'NOT_ALLOWED']]);
    assert.equal(attempts.filter(row => row.caller.agentId === state.team.checker && !row.error).length, 2);
    const offline = await execute(process.execPath, [join(packageDir, 'verify-orders.js'), report.reportPath, candidatePath], {
      cwd: installed.directory, env: installed.env, timeout: 60_000,
    });
    proof.offline = JSON.parse(offline.stdout);
    assert.equal(proof.offline.ok, true);
  } catch (error) {
    failure = error;
    proof.failure = true;
  } finally {
    cleanup.start();
    if (upstream) {
      proof.upstream = upstream.receipt();
      await cleanup.step(() => upstream.close()).catch(() => {});
    }
    proof.remainingWorkerContainers = {};
    for (const id of (await readdir(outputDir)).filter(value => /^[a-f0-9-]{36}$/.test(value))) {
      proof.remainingWorkerContainers[id] = await cleanup.step(({ signal, timeoutMs }) => ownedContainers(id, { signal, timeoutMs })).catch(() => null);
    }
    const absence = Object.values(proof.remainingWorkerContainers).every(value => Array.isArray(value) && value.length === 0);
    proof.facilityCleanup = absence ? await stack.close(cleanup).catch(() => ({ cleanup: 'pending' })) : { cleanup: 'pending' };
    cleanup.dispose();
    let json = JSON.stringify(proof, null, 2);
    for (const secret of [...stack.secrets, resources?.gitea?.adminToken, process.env.MURM_CORE_TEST_API_KEY].filter(Boolean)) {
      json = json.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    }
    await writeFile(join(directory, 'acceptance.json'), json, { mode: 0o600 });
    await installed.close();
    if (!failure) {
      assert.equal(absence, true);
      assert.equal(proof.facilityCleanup.cleanup, 'complete');
    }
  }
  if (failure) throw failure;
});

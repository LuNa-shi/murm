import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createNativeEvidenceDirectory, installNativeNotesExample, stageInstalledBenchmark } from './fixtures/notes-installed-package.js';
import { createLocalPeerMeshStack } from './fixtures/peermesh-local-stack.js';
import { createCleanupBudget } from './fixtures/peermesh-deadline.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { auditCheckerAdoption } from './fixtures/lead-worker-collaboration.js';

const execute = promisify(execFile);
const imageId = /^sha256:[a-f0-9]{64}$/;
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function inspectRun({ outputDir, report, candidate, model, gitea, runId, serviceImage }) {
  assert.equal(report.businessFailure, null);
  assert.equal(report.cleanupFailure, null);
  assert.equal(report.reportSaveFailure, null);
  assert.equal(report.cleanup.cleanup, 'complete');
  const { board, dynamic } = report.result.harness;
  const { lead, helper1, helper2 } = board.team;
  const original = [helper1, helper2];
  const checker = dynamic.member?.agentId;
  const authorization = dynamic.deployment;
  assert.equal(new Set([lead, ...original, checker]).size, 4);
  assert.ok(board.members[checker]?.ready);
  assert.equal(report.cleanup.agents.length, 4);
  assert.ok(report.cleanup.agents.every(row => row.execution === 'stopped' && row.cleanup === 'complete'));
  assert.deepEqual(authorization.verification, { validInput: true, duplicateAndMalformedInput: true });
  const a = report.cleanup.harness.resources.find(row => row.kind === 'checking-container');
  assert.equal(a?.state, 'closed');
  assert.match(a.id, /^murm-orders-[a-f0-9]{32}$/);
  const { stdout } = await execute('docker', ['container', 'ls', '-a', '--filter', `name=^/${a.id}$`, '--format', '{{.Names}}'], { timeout: 5000 });
  assert.equal(stdout, '');
  assert.equal(report.cleanup.harness.resources.filter(row => row.kind === 'gitea-account' && row.state === 'closed').length, 4);

  const root = join(outputDir, report.runtimeId);
  const calls = (await readFile(join(root, 'service-calls.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const settled = calls.filter(row => row.phase === 'settled');
  const accepted = settled.filter(row => !row.error);
  const by = (list, agentId, service, operation) => list.filter(row =>
    row.caller.agentId === agentId && row.service === service && row.operation === operation);
  const deploy = by(accepted, lead, 'manage', 'service_deploy')[0];
  const profile = by(accepted, lead, 'manage', 'profile_register')[0];
  const member = by(accepted, lead, 'team', 'spawn_member').find(row => row.output?.agentId === checker);
  assert.ok(deploy.seq < profile.seq && profile.seq < member.seq);
  for (const agentId of original) {
    assert.ok(by(accepted, agentId, 'board', 'claim').some(row => row.seq < deploy.seq));
    assert.ok(board.subtasks.some(row => row.owner === agentId && row.state === 'complete' && row.delivery?.verified));
  }
  const changes = by(accepted, lead, 'agent', 'grant').filter(row => row.input.service_id === authorization.id);
  const changed = changes.find(row => original.includes(row.input.agent_id));
  assert.ok(changed);
  const worker = changed.input.agent_id;
  const revoked = by(accepted, lead, 'agent', 'revoke').find(row => row.input.agent_id === worker && row.input.service_id === authorization.id && row.seq > changed.seq);
  assert.ok(revoked);
  const denial = by(settled, worker, authorization.id, 'get_service_metadata').filter(row => row.error?.code === 'NOT_ALLOWED');
  assert.ok(denial.some(row => row.seq < changed.seq) && denial.some(row => row.seq > revoked.seq));
  const workerCall = by(accepted, worker, authorization.id, 'check_orders').find(row => changed.seq < row.seq && row.seq < revoked.seq);
  assert.ok(workerCall && Number.isSafeInteger(workerCall.accessVersion));
  const checkCalls = by(accepted, checker, authorization.id, 'check_orders');
  const legal = checkCalls.find(row => row.output?.valid?.length && row.output?.errors?.length === 0);
  const bad = checkCalls.find(row => row.output?.errors?.some(error => ['INVALID_JSON', 'DUPLICATE_ID'].includes(error.code)));
  assert.ok(legal && bad && checkCalls.some(row => row.seq > revoked.seq));
  const adoption = await auditCheckerAdoption({ gitea, runId, report, candidate, calls, worker, serviceImage });
  assert.ok(board.reads.some(row => row.actor === lead && row.notesThrough >= adoption.feedbackSeq && row.seq < board.submitted.seq));
  assert.ok(report.result.verdict.ok && report.result.verdict.results.every(row => row.ok));

  const attempts = [];
  const modelRoot = join(root, 'model-trace');
  for (const id of await readdir(modelRoot)) {
    const request = await readJson(join(modelRoot, id, 'request.json'));
    const result = await readJson(join(modelRoot, id, 'result.json'));
    assert.equal(request.after.model, model.model);
    assert.equal(request.provider, model.provider);
    if (result.terminalStatus === 'completed' && result.upstreamStatus === 200) attempts.push({
      agent: request.agentId, context: request.before.prompt_cache_key, at: Date.parse(request.startedAt), usage: result.usage,
    });
  }
  assert.ok(attempts.length > 0);
  if (model.requestsPerRun !== undefined) assert.ok(attempts.length <= model.requestsPerRun);
  for (const id of [lead, ...original, checker]) assert.ok(attempts.some(row => row.agent === id), 'Every member must receive a real model completion');
  const continuity = attempts.filter(row => row.agent === worker);
  const keys = new Set(continuity.map(row => row.context));
  assert.equal(keys.size, 1);
  assert.ok([...keys][0]);
  assert.ok(continuity.some(row => row.at < Date.parse(changed.startedAt)));
  assert.ok(continuity.some(row => row.at > Date.parse(revoked.startedAt)));
  return { worker, checker, ...adoption, finalCommit: candidate.commit,
    modelContextSha256: hash([...keys][0]), completedRequests: attempts.length };
}

test('two clean installed-package Lead-Worker Runs against the approved real provider', {
  skip: process.env.MURM_LEAD_WORKER_DYNAMIC_MODEL_TEST !== '1',
  timeout: 2_700_000,
}, async t => {
  const model = await readJson(process.env.MURM_LEAD_WORKER_DYNAMIC_MODEL_CONFIG);
  const modelToken = process.env.MURM_LEAD_WORKER_MODEL_TOKEN;
  assert.ok(modelToken && model.provider && model.model && model.providerAllowance && model.authorization);
  const url = new URL(model.url);
  assert.ok(['https:', 'http:'].includes(url.protocol));
  assert.equal(url.pathname, '/v1/responses');
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  if (model.requestsPerRun !== undefined) {
    assert.ok(Number.isSafeInteger(model.requestsPerRun) && model.requestsPerRun >= 1 && model.requestsPerRun <= 1000);
  }
  for (const [value, min, max] of [[model.maxOutputTokens, 16, 32768], [model.workMs, 1000, 900000]]) {
    assert.ok(Number.isSafeInteger(value) && value >= min && value <= max);
  }
  const image = process.env.MURM_CORE_TEST_IMAGE, serviceImage = process.env.MURM_LEAD_WORKER_SERVICE_IMAGE;
  assert.match(image ?? '', imageId);
  assert.match(serviceImage ?? '', imageId);
  const installed = await installNativeNotesExample();
  t.after(installed.close);
  const packageDir = await stageInstalledBenchmark(installed.directory, 'lead-worker-orders');
  const packagedFiles = join(installed.directory, 'node_modules/@luna-shi/murm');
  const [oracle, specification, rolePrompts] = await Promise.all([
    readFile(join(packageDir, 'fixtures/oracle.mjs')),
    readFile(join(packageDir, 'fixtures/spec.md')),
    readFile(join(packagedFiles, 'dist/examples/lead-worker/harness/prompts.js')),
  ]);
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';

  for (const variant of ['orders-a', 'orders-b']) await t.test(variant, async () => {
    const directory = await createNativeEvidenceDirectory('lead-worker-model');
    const runId = `orders-${randomBytes(7).toString('hex')}`;
    const outputDir = join(directory, 'output'), candidatePath = join(directory, 'candidate.json');
    await mkdir(outputDir);
    const stack = await createLocalPeerMeshStack({ directory: join(directory, 'facilities'), advertiseHost: host, giteaOnly: true });
    const cleanup = createCleanupBudget(80_000);
    const pin = { runId, variant, package: installed.metadata, workerImage: image, serviceImage,
      oracleSha256: hash(oracle), specificationSha256: hash(specification), rolePromptsSha256: hash(rolePrompts),
      provider: model.provider, model: model.model, authorization: model.authorization, providerAllowance: model.providerAllowance,
      maxRequests: model.requestsPerRun ?? null, attemptLimit: 2, maxOutputTokens: model.maxOutputTokens, workMs: model.workMs,
      agentLimit: 4, serviceLimit: 1, perAgentCpu: 1, perAgentMemoryMiB: 1024, diskBytes: 64 * 1024 ** 2, cleanupMs: 80_000 };
    const receipt: Record<string, any> = { pin, passed: false };
    await writeFile(join(directory, 'pin.json'), JSON.stringify(pin), { mode: 0o600 });
    try {
      const { gitea } = await stack.start();
      const configuration = { runId, outputDir, image, gitea, turnTimeoutMs: Math.min(model.workMs, 300_000),
        workTimeoutMs: model.workMs, closeTimeoutMs: 55_000, dynamic: { variant, candidatePath, serviceImage },
        sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
          endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', resourceLimits: { cpu: '1', memory: '1Gi' },
          isolation: { disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } },
        connection: { bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
          modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 90_000,
            maxOutputTokens: model.maxOutputTokens, maxRequests: model.requestsPerRun } },
        models: { default: { provider: model.provider, model: model.model, upstream: { url: model.url, headers: {} } } } };
      const configPath = join(directory, 'config.mjs');
      await writeFile(configPath, `const config=${JSON.stringify(configuration)};config.sandbox.apiKey=process.env.MURM_CORE_TEST_API_KEY;config.models.default.upstream.headers.authorization='Bearer '+process.env.MURM_LEAD_WORKER_MODEL_TOKEN;export default config;\n`, { mode: 0o600 });
      const child = await execute(process.execPath, [join(packageDir, 'main.js'), configPath], {
        cwd: installed.directory, env: installed.env, timeout: model.workMs + 180_000, maxBuffer: 8 * 1024 ** 2,
      }).catch(error => ({ stdout: error.stdout, exit: error.code ?? 'MODEL_RUN_FAILED' }));
      const report = JSON.parse(child.stdout);
      receipt.reportPath = report.reportPath;
      receipt.runtimeId = report.runtimeId;
      receipt.businessFailure = report.businessFailure?.code ?? null;
      receipt.cleanupFailure = report.cleanupFailure?.code ?? null;
      assert.ok(!('exit' in child), 'The installed example reported a Run failure');
      receipt.collaboration = await inspectRun({ outputDir, report, candidate: await readJson(candidatePath), model, gitea, runId, serviceImage });
      const repeated = await execute(process.execPath, [join(packageDir, 'verify-orders.js'), report.reportPath, candidatePath],
        { cwd: installed.directory, env: installed.env, timeout: 60_000 });
      receipt.offline = JSON.parse(repeated.stdout);
      assert.ok(receipt.offline.ok);
      receipt.passed = true;
    } finally {
      cleanup.start();
      const remaining = await Promise.all((await readdir(outputDir)).filter(id => /^[a-f0-9-]{36}$/.test(id))
        .map(id => cleanup.step(({ signal, timeoutMs }) => ownedContainers(id, { signal, timeoutMs })).catch(() => null)));
      const empty = remaining.every(ids => Array.isArray(ids) && !ids.length);
      receipt.remainingWorkerContainers = remaining;
      receipt.facility = empty ? await stack.close(cleanup).catch(() => ({ cleanup: 'pending' })) : { cleanup: 'pending' };
      receipt.passed &&= empty && receipt.facility.cleanup === 'complete';
      cleanup.dispose();
      await writeFile(join(directory, 'acceptance.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    }
    assert.equal(receipt.passed, true);
  });
});

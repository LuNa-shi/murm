import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createNativeEvidenceDirectory, installNativeNotesExample } from './fixtures/notes-installed-package.js';
import { createLocalPeerMeshStack } from './fixtures/peermesh-local-stack.js';
import { createCleanupBudget } from './fixtures/peermesh-deadline.js';
import { createLeadWorkerUpstream, adjustedDirection } from './fixtures/lead-worker-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
import { httpClient } from '../src/harnesses/peermesh/http.js';
const execute = promisify(execFile);

test('installed native lead plus two helpers claim exclusively, push verified Git artifacts and adopt mediated direction', {
  skip: process.env.MURM_LEAD_WORKER_REAL_TEST !== '1' && 'Two independent exact-pin reviews required before any facilities, sandbox or model start', timeout: 600_000,
}, async () => {
  const image = process.env.MURM_CORE_TEST_IMAGE; assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const directory = await createNativeEvidenceDirectory('lead-worker');
  const installed = await installNativeNotesExample();
  const runId = `lead-${randomBytes(6).toString('hex')}`; const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const outputDir = join(directory, 'output'); await mkdir(outputDir);
  const stack = await createLocalPeerMeshStack({ directory: join(directory, 'facilities'), advertiseHost: host, giteaOnly: true, setupMs: 180_000 });
  const cleanup = createCleanupBudget(80_000); let upstream; let child; let sessions; let report; let config; let failure; let expired = false; let stdout = ''; let stderrBytes = 0;
  const proof = { schemaVersion: 1, failure: true, package: installed.metadata, image, externalDirectory: installed.directory,
    limits: { agents: 3, inputs: 6, arrivals: 16, setupMs: 180_000, workMs: 120_000, cleanupMs: 80_000, perAgentCpu: 1, perAgentMemoryMiB: 1024, diskBytes: 64 * 1024 ** 2, inodes: 4096, outputTokensPerRequest: 512 }, partialWork: ['An exclusive-claim probe remains intentionally unfinished under its original winner'] };
  const ids = async () => (await readdir(outputDir)).filter(id => /^[a-f0-9-]{36}$/.test(id));
  try {
    config = await stack.start();
    upstream = await createLeadWorkerUpstream({ onFailure: () => { cleanup.start(); child?.kill('SIGTERM'); }, observeSessions: async (phase, evidence) => {
      const runtimeIds = await ids(); assert.equal(runtimeIds.length, 1); const containers = (await ownedContainers(runtimeIds[0])).sort(); assert.equal(containers.length, 3);
      const current = await Promise.all(containers.map(async container => ({ container, ...await sessionEvidence(container, execute) })));
      assert.equal(new Set(current.map(row => row.sessionId)).size, 3);
      if (phase === 'before-adjust') sessions = current;
      else { assert.deepEqual(current, sessions); const continued = evidence.filter(row => row.sessionFile); assert.equal(continued.length, 3); assert.deepEqual(new Set(continued.map(row => row.sessionFile)), new Set(current.map(row => row.sessionFile))); }
    } });
    const configuration = { runId, image, outputDir, goal: 'Build complementary input validation and caller authentication reports with actual evidence.', supplement: adjustedDirection,
      gitea: config.gitea, turnTimeoutMs: 30_000, workTimeoutMs: 120_000, closeTimeoutMs: 25_000, exportLimit: 8 * 1024 ** 2,
      backend: { sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 25_000, maxOutputTokens: 512 }, models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } }, isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } } };
    const configPath = join(directory, 'lead-worker-config.mjs'); await writeFile(configPath, `const config=${JSON.stringify(configuration)};config.backend.sandbox.apiKey=process.env.MURM_CORE_TEST_API_KEY;export default config;\n`, { mode: 0o600 });
    const main = join(installed.directory, 'node_modules/@murm/core/dist/examples/lead-worker/main.js');
    const outcome = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [main, configPath], { cwd: installed.directory, env: installed.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const workTimer = setTimeout(() => { expired = true; cleanup.start(); child.kill('SIGTERM'); }, 120_000);
      const hardTimer = setTimeout(() => { expired = true; cleanup.start(); child.kill('SIGKILL'); }, 150_000);
      child.stdout.on('data', data => { if (Buffer.byteLength(stdout) + data.length > 8 * 1024 ** 2) { expired = true; cleanup.start(); child.kill('SIGTERM'); } else stdout += data; });
      child.stderr.on('data', data => { stderrBytes += data.length; });
      child.once('error', error => { clearTimeout(workTimer); clearTimeout(hardTimer); cleanup.start(); reject(error); });
      child.once('close', code => { clearTimeout(workTimer); clearTimeout(hardTimer); cleanup.start(); resolve(code); });
    });
    report = JSON.parse(stdout.trim()); proof.report = report;
    assert.equal(outcome, 0, `Child exited with ${stderrBytes} diagnostic bytes`); assert.equal(expired, false);
    assert.equal(report.businessFailure, null); assert.equal(report.cleanupFailure, null); assert.equal(report.reportSaveFailure, null);
    assert.equal(report.cleanup.cleanup, 'complete'); assert.equal(report.cleanup.agents.length, 3); assert.ok(report.cleanup.agents.every(row => row.execution === 'stopped' && row.cleanup === 'complete'));
    const runtimeIds = await ids(); assert.deepEqual(runtimeIds, [report.runtimeId]);
    assert.deepEqual(await cleanup.step(({ timeoutMs, signal }) => ownedContainers(report.runtimeId, { timeoutMs, signal })), []);
    const events = (await cleanup.step(() => readFile(report.cleanup.evidence.path, 'utf8'))).trim().split('\n').map(line => JSON.parse(line));
    const inputs = events.filter(row => row.type === 'input' && row.state === 'registered'); assert.equal(inputs.length, 6);
    const statePath = report.result.harness.boardPath; const database = new DatabaseSync(statePath, { readOnly: true });
    let state; try { state = JSON.parse(database.prepare('SELECT body FROM board_state WHERE id=1').get().body); } finally { database.close(); }
    assert.equal(state.runtimeId, report.runtimeId); assert.equal(new Set(Object.values(state.team)).size, 3); assert.equal(state.fenced, true);
    const original = report.result.originalDirection; const changed = report.result.adjustedDirection; assert.equal(changed.text, adjustedDirection); assert.equal(changed.user_input_id, 'lead-adjust'); assert.ok(changed.seq > original.seq);
    assert.equal(changed.feedback_ids.length, 2); assert.ok(state.history.some(row => row.type === 'read' && row.actor === state.team.lead && row.notesThrough >= Math.max(...changed.feedback_ids) && row.seq < changed.seq));
    const completed = state.subtasks.filter(row => row.state === 'complete'); assert.equal(completed.length, 4);
    const probe = state.subtasks.find(row => row.id === 'atomic-probe'); assert.equal(probe.state, 'claimed'); assert.ok([state.team.helper1, state.team.helper2].includes(probe.owner)); assert.equal(probe.revision, 1);
    assert.equal(state.history.filter(row => row.type === 'claim' && row.subtaskId === probe.id).length, 1); assert.equal(state.subtasks.some(row => row.id === 'forged'), false); assert.equal(state.history.some(row => row.type === 'update_subtask'), false);
    const receipt = upstream.receipt(); assert.equal(receipt.failure, undefined); assert.equal(receipt.arrivals, 12); assert.equal(receipt.accepted, 12); assert.equal(receipt.evidence.length, 6);
    assert.ok(receipt.evidence.every(row => row.agentId === state.team[row.role]));
    assert.deepEqual(new Set(changed.feedback_ids.map(seq => state.notes.find(note => note.seq === seq)?.actor)), new Set([state.team.helper1, state.team.helper2]));
    const initialHelpers = receipt.evidence.filter(row => row.kind === 'helper-initial'); assert.equal(initialHelpers.filter(row => row.probeWon).length, 1); assert.ok(initialHelpers.every(row => row.probeOwner === probe.owner));
    const git = httpClient(config.gitea.origin, `token ${config.gitea.adminToken}`); const scope = `/api/v1/repos/${config.gitea.owner}/lead-worker-${runId}`;
    for (const task of completed) {
      assert.equal(task.delivery.verified, true);
      const file = await cleanup.step(({ signal }) => git('GET', `${scope}/contents/${task.path}?ref=${task.delivery.commit}`, undefined, { signal }));
      const bytes = Buffer.from(file.content, 'base64'); assert.equal(bytes.length, task.delivery.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), task.delivery.sha256);
      if (task.id.endsWith('-next')) { assert.equal(task.directionId, changed.seq); assert.ok(bytes.toString().includes(changed.text)); assert.equal(task.delivery.directionEvidence.textSha256, createHash('sha256').update(changed.text).digest('hex')); }
      const core = report.cleanup.agents.find(row => row.agentId === task.owner); const files = core.artifacts.find(path => path.endsWith('/artifacts/files')); assert.ok(files);
      const archived = await cleanup.step(() => readFile(join(files, task.path))); assert.deepEqual(archived, bytes);
    }
    assert.equal(report.result.harness.unfinished.length, 1); assert.equal(report.result.harness.unfinished[0].owner, probe.owner);
    proof.board = state; proof.sessions = sessions; proof.failure = false;
  } catch (error) { failure = error; proof.failureCode = error.code ?? 'LEAD_WORKER_ACCEPTANCE_FAILED'; }
  finally {
    cleanup.start(); child?.kill('SIGTERM');
    if (upstream) { proof.upstream = upstream.receipt(); await cleanup.step(() => upstream.close()).catch(() => {}); }
    proof.runtimeResources = {};
    const runtimeIds = await ids().catch(() => []);
    for (const id of runtimeIds) {
      try { proof.runtimeResources[id] = { containers: await cleanup.step(({ timeoutMs, signal }) => ownedContainers(id, { timeoutMs, signal })) }; }
      catch { proof.runtimeResources[id] = { containers: null }; }
    }
    const empty = (runtimeIds.length === 1 || !child?.pid && runtimeIds.length === 0) && Object.values(proof.runtimeResources).every(row => Array.isArray(row.containers) && row.containers.length === 0);
    // Preserve Git dependencies whenever Core ownership/execution is uncertain.
    proof.facilityCleanup = empty ? await stack.close(cleanup).catch(() => ({ cleanup: 'pending' })) : { cleanup: 'pending', reason: 'CORE_OWNERSHIP_OR_EXECUTION_UNKNOWN' };
    proof.facilities = stack.receipt(); proof.cleanupBudget = cleanup.receipt(); proof.expired = expired;
    proof.failure ||= Boolean(failure) || expired || !empty || proof.facilityCleanup.cleanup !== 'complete';
    let body = JSON.stringify(proof, null, 2); for (const secret of [...stack.secrets, config?.gitea?.adminToken, process.env.MURM_CORE_TEST_API_KEY].filter(Boolean)) body = body.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    await writeFile(join(directory, 'acceptance.json'), body, { mode: 0o600 }); cleanup.dispose();
    if (!proof.failure) await installed.close();
  }
  if (failure) throw failure;
  assert.equal(proof.failure, false);
});

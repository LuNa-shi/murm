import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createNativeEvidenceDirectory, installNativeNotesExample } from './fixtures/notes-installed-package.js';
import { createNotesHarnessUpstream } from './fixtures/notes-harness-upstream.js';

for (const executor of ['pi', 'codex']) {
test(`installed Notes ${executor} exchanges a native fact and retains the reader Session through its second turn`, {
  skip: (executor === 'codex' ? process.env.MURM_CODEX_NOTES_REAL_TEST : process.env.MURM_NOTES_HARNESS_REAL_TEST) !== '1' && 'Two independent exact reviews and explicit local opt-in required',
  timeout: 340_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const evidenceDir = await createNativeEvidenceDirectory('notes-' + executor);
  const installed = await installNativeNotesExample();
  // Retain the external consumer on uncertainty; durable inputs and outputs stay in evidenceDir.
  let child;
  let nativeSessions;
  const upstream = await createNotesHarnessUpstream({ executor, verifyStartup: true, onFailure: () => child?.kill('SIGTERM'),
    observeSessions: async (phase, row) => {
      const ids = (await readdir(outputDir)).filter(id => /^[a-f0-9-]{36}$/.test(id));
      assert.equal(ids.length, 1);
      const containers = (await ownedContainers(ids[0])).sort(); assert.equal(containers.length, 2);
      const observed = await Promise.all(containers.map(async container => ({ container,
        ...await sessionEvidence(container, promisify(execFile), executor) })));
      assert.equal(new Set(observed.map(item => item.sessionId)).size, 2);
      if (phase === 'before-followup') nativeSessions = observed;
      else { assert.deepEqual(observed, nativeSessions); assert.ok(observed.some(item => item.sessionId === row.sessionId)); }
    } });
  t.after(() => upstream.close());
  const outputDir = join(evidenceDir, 'output');
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const config = {
    image, outputDir, turnTimeoutMs: 35_000, closeTimeoutMs: 25_000,
    executor,
    sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000,
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } },
    connection: {
      bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
      modelGateway: { host: '0.0.0.0', advertiseHost: host, maxOutputTokens: executor === 'codex' ? null : 128, requestTimeoutMs: 30_000 },
    },
    models: { default: { provider: executor === 'codex' ? 'openai' : 'kimi_proxy', model: executor === 'codex' ? 'gpt-5.4' : 'k3', upstream: { url: upstream.url, headers: {} } } },
  };
  await writeFile(join(evidenceDir, 'config.mjs'), `const config = ${JSON.stringify(config)};
config.sandbox.apiKey = process.env.MURM_CORE_TEST_API_KEY;
export default config;\n`, { mode: 0o600 });
  const proof = { package: installed.metadata, externalDirectory: installed.directory, image, executor, failure: true };
  let stdout = ''; let stderr = ''; let expired = false;
  t.after(async () => {
    const runtimeIds = (await readdir(outputDir).catch(() => [])).filter(id => /^[a-f0-9-]{36}$/.test(id));
    proof.resources = {};
    for (const id of runtimeIds) proof.resources[id] = { empty: (await ownedContainers(id)).length === 0 };
    proof.nativeSessions = nativeSessions; proof.upstream = upstream.receipt(); proof.deadlineExceeded = expired;
    proof.failure ||= expired || Boolean(proof.upstream.failure) || proof.upstream.arrivals !== 6 || proof.upstream.accepted !== 6 ||
      runtimeIds.length !== 1 || Object.values(proof.resources).some(resource => !resource.empty);
    await writeFile(join(evidenceDir, 'acceptance.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
    assert.equal(proof.failure, false);
    await installed.close();
  });
  const outcome = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['main.mjs', join(evidenceDir, 'config.mjs')], { cwd: installed.directory, env: installed.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, 120_000);
    const hardTimer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 150_000);
    child.stdout.on('data', data => {
      if (stdout.length + data.length > 8 * 1024 ** 2) { expired = true; child.kill('SIGTERM'); }
      else stdout += data;
    });
    child.stderr.on('data', data => { if (stderr.length < 64 * 1024) stderr += data; });
    child.once('error', error => { clearTimeout(timer); clearTimeout(hardTimer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(hardTimer); resolve({ code, signal }); });
  });
  const report = JSON.parse(stdout.trim()); proof.report = report;
  assert.equal(outcome.code, 0, `Environment child failed (${outcome.signal ?? outcome.code}); diagnostic bytes=${stderr.length}`);
  assert.equal(report.businessFailure, null); assert.equal(report.cleanupFailure, null); assert.equal(report.reportSaveFailure, null);
  assert.equal(report.cleanup.cleanup, 'complete'); assert.equal(report.cleanup.agents.length, 2);
  assert.ok(report.cleanup.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete'));
  assert.equal(report.turns.length, 3);
  assert.deepEqual(report.turns.map(turn => turn.agentId), [report.result.writerId, report.result.readerId, report.result.readerId]);
  assert.equal(new Set(report.turns.map(turn => turn.inputId)).size, 3);
  assert.ok(report.turns.every(turn => turn.outcome === 'completed'));
  assert.equal(report.serviceState.length, 1);
  assert.equal(report.serviceState[0].author, report.result.writerId);
  assert.ok(report.reads.some(read => read.agentId === report.result.readerId && read.found));
  const fact = JSON.parse(report.serviceState[0].text);
  assert.deepEqual(fact, { baseline: 'fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e', source: 'src/agent/services-bridge.js',
    finding: 'Bridge identity and TaskPool Task/Execution authorization have separate responsibilities.' });
  const files = report.result.artifacts.find(path => path.endsWith('/artifacts/files'));
  const expected = '# Source review\n\nBaseline: fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e\nSource: src/agent/services-bridge.js\nFinding: Bridge identity and TaskPool Task/Execution authorization have separate responsibilities.\n';
  for (const file of ['review.md', 'followup.md']) assert.equal(await readFile(join(files, file), 'utf8'), expected);
  const [writer, reader, followup] = upstream.receipt().evidence;
  assert.equal(writer.author, report.result.writerId);
  assert.equal(reader.author, report.result.writerId); assert.deepEqual(reader.process, followup.process);
  assert.equal(nativeSessions.length, 2);
  assert.deepEqual(JSON.parse(await readFile(report.reportPath, 'utf8')).result, report.result);
  proof.failure = false;
});

}

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { installNativeNotesExample } from './fixtures/notes-installed-package.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
import { createSubagentsUpstream } from './fixtures/subagents-upstream.js';

test('installed subagents parent delegates natively and adopts two child results plus a continued child round', {
  skip: process.env.SWARMENV_SUBAGENTS_REAL_TEST !== '1' && 'Requires two independent exact-pin reviews and local opt-in', timeout: 340_000,
}, async t => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE; assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const installed = await installNativeNotesExample();
  for (const name of ['main', 'controller', 'prompts']) await copyFile(join(installed.directory, 'node_modules/@swarmenv/core/examples/subagents-environment', `${name}.mjs`), join(installed.directory, `${name}.mjs`));
  const outputDir = join(installed.directory, 'output'); let child; let sessions;
  const upstream = await createSubagentsUpstream({ onFailure: () => child?.kill('SIGTERM'), observeSessions: async (phase, native) => {
    const ids = (await readdir(outputDir)).filter(id => /^[a-f0-9-]{36}$/.test(id)); assert.equal(ids.length, 1);
    const containers = (await ownedContainers(ids[0])).sort(); assert.equal(containers.length, 3);
    const current = await Promise.all(containers.map(async container => ({ container, ...await sessionEvidence(container, promisify(execFile)) })));
    assert.equal(new Set(current.map(row => row.sessionId)).size, 3);
    if (phase === 'before-followup') sessions = current;
    else { assert.deepEqual(current, sessions); assert.ok(current.some(row => row.sessionFile === native.find(row => row.turn === 4).sessionFile)); }
  } }); t.after(() => upstream.close());
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const config = { image, outputDir, goal: 'SUBAGENTS_PARENT', workTimeoutMs: 120_000, closeTimeoutMs: 25_000,
    backend: { sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
      bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, maxOutputTokens: 512, requestTimeoutMs: 30_000 },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } }, isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } } };
  await writeFile(join(installed.directory, 'config.mjs'), `const config=${JSON.stringify(config)};config.backend.sandbox.apiKey=process.env.SWARMENV_CORE_TEST_API_KEY;export default config;\n`, { mode: 0o600 });
  const evidenceDir = join(process.cwd(), 'experiments', `subagents-${Date.now()}`); await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const proof = { package: installed.metadata, image, externalDirectory: installed.directory, failure: true };
  let stdout = ''; let stderrBytes = 0; let expired = false;
  t.after(async () => {
    const ids = (await readdir(outputDir).catch(() => [])).filter(id => /^[a-f0-9-]{36}$/.test(id)); proof.resources = {};
    for (const id of ids) proof.resources[id] = { empty: (await ownedContainers(id)).length === 0 };
    proof.upstream = upstream.receipt(); proof.sessions = sessions; proof.expired = expired;
    proof.failure ||= expired || ids.length !== 1 || Object.values(proof.resources).some(row => !row.empty) || Boolean(proof.upstream.failure) || proof.upstream.arrivals > 16 || proof.upstream.accepted !== proof.upstream.arrivals;
    await writeFile(join(evidenceDir, 'acceptance.json'), JSON.stringify(proof, null, 2), { mode: 0o600 }); assert.equal(proof.failure, false);
  });
  const outcome = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['main.mjs', 'config.mjs'], { cwd: installed.directory, env: installed.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, 120_000);
    const hardTimer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 150_000);
    child.stdout.on('data', data => { if (stdout.length + data.length > 8 * 1024 ** 2) { expired = true; child.kill('SIGTERM'); } else stdout += data; });
    child.stderr.on('data', data => { stderrBytes += data.length; });
    child.once('error', error => { clearTimeout(timer); clearTimeout(hardTimer); reject(error); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(hardTimer); resolve(code); });
  });
  const report = JSON.parse(stdout.trim()); proof.report = report;
  assert.equal(outcome, 0, `Child exit with ${stderrBytes} diagnostic bytes`); assert.equal(report.businessFailure, null); assert.equal(report.cleanupFailure, null); assert.equal(report.reportSaveFailure, null);
  assert.equal(report.cleanup.cleanup, 'complete'); assert.equal(report.cleanup.bots.length, 3);
  assert.ok(report.cleanup.bots.every(row => row.execution === 'stopped' && row.cleanup === 'complete'));
  const rows = (await readFile(report.cleanup.evidence.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.type === 'input' && row.state === 'registered').length, 7);
  assert.equal(report.routing.childIds.length, 2); assert.equal(report.routing.pendingJobs, 0);
  assert.equal(report.result.delivery.conclusions.length, 3); assert.equal(new Set(report.result.delivery.conclusions.map(row => row.childId)).size, 2);
  assert.deepEqual(report.result.delivery.conclusions, upstream.receipt().finalResults.map(row => ({ childId: row.childId, eventSeq: row.eventSeq, quote: row.output })));
  assert.equal(upstream.receipt().results.length, 3); assert.equal(upstream.receipt().native.length, 3); assert.equal(sessions.length, 3);
  assert.deepEqual(JSON.parse(await readFile(report.reportPath, 'utf8')).result, report.result); proof.failure = false;
});

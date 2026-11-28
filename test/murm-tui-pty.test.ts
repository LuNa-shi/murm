import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createHarnessSessionUpstream } from './fixtures/harness-session-upstream.js';
import { createNativeEvidenceDirectory, installNativeNotesExample, installNotesExample } from './fixtures/notes-installed-package.js';

const run = promisify(execFile);
const isLinux = process.platform === 'linux';

async function installTui(t: TestContext, native = false) {
  const installed = await (native ? installNativeNotesExample() : installNotesExample());
  t.after(installed.close);
  installed.env.PATH = join(installed.directory, 'node_modules', '.bin') + delimiter + installed.env.PATH;
  const evidence = native ? await createNativeEvidenceDirectory('murm-installed-tui') : installed.directory;
  if (native) {
    t.diagnostic('Private evidence: ' + evidence);
    await writeFile(join(evidence, 'package-evidence.json'), JSON.stringify(installed.metadata), { mode: 0o600 });
  }
  return { installation: installed.directory, evidence, env: installed.env };
}

test('an installed murm executable operates a foreground Run in a real Linux terminal', {
  skip: !isLinux && 'Linux PTY acceptance',
  timeout: 240_000,
}, async t => {
  const { installation, env } = await installTui(t);
  const fixture = fileURLToPath(new URL('./fixtures/murm-tui-installed.py', import.meta.url));
  await run('python3', [fixture, installation], { env, timeout: 110_000, maxBuffer: 1024 * 1024 });
});

for (const scenario of ['interactive', 'export-fault']) test('the installed terminal on a native Pi Worker handles Subagents ' + scenario, {
  skip: (!isLinux || process.env.MURM_TUI_NATIVE_TEST !== '1') && 'Requires the isolated local OpenSandbox and the exact installed candidate',
  timeout: 250_000,
}, async t => {
  const { evidence, env, installation } = await installTui(t, true);
  assert.ok(env.MURM_TEST_PACKAGE_ARCHIVE && env.MURM_TEST_PACKAGE_SHA256 && env.MURM_CORE_TEST_IMAGE && env.MURM_HARNESS_SESSION_SANDBOX_CONFIG);
  const { lifecycleBaseUrl, endpoint, apiKey, advertiseHost } = JSON.parse(await readFile(env.MURM_HARNESS_SESSION_SANDBOX_CONFIG, 'utf8'));
  const lifecycle = new URL(lifecycleBaseUrl ?? endpoint);
  assert.ok(['localhost', '127.0.0.1'].includes(lifecycle.hostname) && apiKey && advertiseHost);
  const snapshotSandboxes = async () => {
    const url = lifecycle.href.replace(/\/$/, '') + '/sandboxes?page=1&pageSize=100';
    const response = await fetch(url, { headers: { 'OPEN-SANDBOX-API-KEY': apiKey }, signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok);
    const body = await response.json();
    assert.ok(Array.isArray(body.items));
    return body.items.map((item: { id: string }) => item.id).sort() as string[];
  };
  const ownedBefore = await snapshotSandboxes();
  const exactWorkers = async () => (await run('docker', ['ps', '--all', '--quiet', '--no-trunc',
    '--filter', 'ancestor=' + env.MURM_CORE_TEST_IMAGE], { timeout: 5_000 })).stdout.trim().split('\n').filter(Boolean).sort();
  const workersBefore = await exactWorkers();
  t.after(async () => {
    const ownedAfter = await snapshotSandboxes();
    const workersAfter = await exactWorkers();
    await writeFile(join(evidence, 'lifecycle-evidence.json'), JSON.stringify({ ownedBefore, ownedAfter, workersBefore, workersAfter }), { mode: 0o600 });
    assert.deepEqual(workersAfter.filter(worker => !workersBefore.includes(worker)), [], 'no Worker from the exact candidate remains');
  });
  const cwd = join(evidence, 'project');
  await mkdir(cwd);
  await run('git', ['init', '--quiet', cwd]);
  const seed = 'MURM_TUI_PTY_DIRTY_SEED_2fb71e53';
  await writeFile(join(cwd, 'seed.txt'), 'Committed seed');
  await run('git', ['-C', cwd, 'add', 'seed.txt']);
  await run('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=terminal@example.com', 'commit', '-qm', 'Initial seed']);
  await writeFile(join(cwd, 'seed.txt'), seed + '\n');
  await writeFile(join(cwd, 'untracked.txt'), 'untracked project snapshot\n');
  const before = await run('git', ['-C', cwd, 'status', '--porcelain=v1']);
  const upstream = await createHarnessSessionUpstream(seed, undefined, true);
  t.after(async () => {
    await upstream.close();
    await writeFile(join(evidence, 'upstream-evidence.json'), JSON.stringify({ requests: upstream.requests, failure: upstream.failure }), { mode: 0o600 });
  });
  const config = {
    image: env.MURM_CORE_TEST_IMAGE,
    executor: { kind: 'pi', version: env.MURM_CORE_TEST_PI_VERSION ?? '1.3.0' },
    sandbox: { lifecycleBaseUrl: lifecycle.href, apiKey, commandTimeoutMs: 20_000, isolation: { network: 'api' } },
    connection: { advertiseHost, modelGateway: { requestTimeoutMs: 30_000, maxRequests: 48 } },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
    rootSession: { compaction: { enabled: false }, retry: { enabled: false } },
    maxAgents: 3, workTimeoutMs: 120_000, closeTimeoutMs: 20_000, questionTimeoutMs: 45_000,
  };
  await writeFile(join(evidence, 'configuration.mjs'), 'export default ' + JSON.stringify(config) + ';\n', { mode: 0o600 });
  delete env.MURM_MODEL_URL;
  delete env.MURM_SUBAGENTS_MODEL_URL;
  env.XDG_CONFIG_HOME = join(evidence, 'preferences');
  env.XDG_STATE_HOME = join(evidence, 'state');
  env.MURM_TUI_TEST_TRANSCRIPT = join(evidence, 'terminal.raw');
  env.MURM_TUI_CONTROL_URL = new URL('/terminal-control/', upstream.url).href;
  if (scenario === 'export-fault') {
    const builtInUrl = pathToFileURL(join(installation, 'node_modules/@luna-shi/murm/dist/examples/subagents/project.js')).href;
    await copyFile(new URL('./fixtures/murm-tui-export-owner.js', import.meta.url), join(evidence, 'murm-tui-export-owner.mjs'));
    await writeFile(join(evidence, 'fault-harness.mjs'), `import subagents from ${JSON.stringify(builtInUrl)};
import { retainOriginalOwner } from './murm-tui-export-owner.mjs';
export default retainOriginalOwner(subagents, ${JSON.stringify(evidence)});
`, { mode: 0o600 });
  }
  const fixture = fileURLToPath(new URL('./fixtures/murm-tui-subagents.py', import.meta.url));
  await run('python3', [fixture, evidence, scenario], { env, timeout: 175_000, maxBuffer: 1024 * 1024 });
  assert.equal(upstream.failure, undefined);
  const root = join(env.XDG_STATE_HOME, 'murm', 'runs');
  const [only, ...extra] = await readdir(root);
  assert.equal(extra.length, 0);
  const report = JSON.parse(await readFile(join(root, only, 'project-run.json'), 'utf8'));
  assert.deepEqual(await ownedContainers(report.result.runtimeId), []);
  assert.ok(report.artifacts.some((artifact: { kind?: string }) => artifact.kind === 'session-archive'));
  assert.equal((await run('git', ['-C', cwd, 'status', '--porcelain=v1'])).stdout, before.stdout);
  assert.equal(await readFile(join(cwd, 'seed.txt'), 'utf8'), seed + '\n');
  if (scenario === 'export-fault') {
    assert.equal(report.export.status, 'pending');
    assert.equal(report.cleanup.status, 'pending');
    assert.ok(report.cleanup.pending.some((resource: { action: string }) => resource.action === 'collect-artifacts'));
    assert.equal(await readFile(join(evidence, 'owner-repaired'), 'utf8'), 'complete');
    return;
  }
  const stage = (name: string) => upstream.requests.filter(item => item.stage === name).length;
  for (const name of ['seed-read', 'seed-artifact', 'seed-result', 'busy-steer', 'busy-follow', 'second', 'context-steer', 'root-wait', 'resume', 'root-answer', 'child-answer', 'new-answer']) {
    assert.equal(stage(name), 1, name);
  }
  assert.equal(report.cleanup.status, 'complete');
  const rootAgentId = report.result.detail.members.find((member: { path: string }) => member.path === '/root').agentId;
  const rootCollection = report.cleanup.receipt.agents.find((agent: { agentId: string }) => agent.agentId === rootAgentId);
  const delivered = rootCollection?.artifacts.find((path: string) => path.endsWith('/files'));
  assert.ok(delivered, 'the original owner saved required workspace files');
  assert.equal(await readFile(join(delivered, 'terminal-artifact.txt'), 'utf8'), seed + '\n');
  assert.ok(report.questions.some((question: { status: string }) => question.status === 'cancelled'));
});

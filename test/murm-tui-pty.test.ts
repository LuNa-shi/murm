import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHarnessSessionUpstream } from './fixtures/harness-session-upstream.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const isLinux = process.platform === 'linux';

async function installTui(t: TestContext, evidenceRoot?: string) {
  if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(evidenceRoot ?? tmpdir(), 'murm-installed-tui-'));
  if (evidenceRoot) t.diagnostic('Private evidence: ' + directory);
  else t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  let archive = env.MURM_TEST_PACKAGE_ARCHIVE;
  if (!archive) {
    const pack = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
      { cwd: root, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    archive = join(directory, JSON.parse(pack.stdout)[0].filename);
  }
  assert.ok(isAbsolute(archive), 'use the exact candidate tarball');
  const installation = join(directory, 'consumer');
  await mkdir(installation);
  await writeFile(join(installation, 'package.json'), '{"name":"foreground-terminal-acceptance","private":true}\n');
  await run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', archive],
    { cwd: installation, env, timeout: 60_000 });
  env.PATH = join(installation, 'node_modules', '.bin') + delimiter + env.PATH;
  return { installation, env };
}

test('an installed murm executable operates a foreground Run in a real Linux terminal', {
  skip: !isLinux && 'Linux PTY acceptance',
  timeout: 240_000,
}, async t => {
  const { installation, env } = await installTui(t);
  const fixture = fileURLToPath(new URL('./fixtures/murm-tui-installed.py', import.meta.url));
  await run('python3', [fixture, installation], { env, timeout: 110_000, maxBuffer: 1024 * 1024 });
});

test('the installed bare terminal runs an interactive Subagents session on a native Pi Worker', {
  skip: (!isLinux || process.env.MURM_TUI_NATIVE_TEST !== '1') && 'Requires the isolated local OpenSandbox and the exact installed candidate',
  timeout: 250_000,
}, async t => {
  const { installation, env } = await installTui(t, join(process.cwd(), 'experiments'));
  assert.ok(env.MURM_TEST_PACKAGE_ARCHIVE && env.MURM_CORE_TEST_IMAGE && env.MURM_HARNESS_SESSION_SANDBOX_CONFIG);
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
  assert.deepEqual(ownedBefore, [], 'use an isolated provider');
  t.after(async () => {
    const ownedAfter = await snapshotSandboxes();
    await writeFile(join(installation, 'lifecycle-evidence.json'), JSON.stringify({ ownedBefore, ownedAfter }), { mode: 0o600 });
    assert.deepEqual(ownedAfter, [], 'the harness released its owned Sandboxes');
  });
  const cwd = join(installation, 'project');
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
  t.after(() => upstream.close());
  const config = {
    image: env.MURM_CORE_TEST_IMAGE,
    executor: { kind: 'pi', version: env.MURM_CORE_TEST_PI_VERSION ?? '1.3.0' },
    sandbox: { lifecycleBaseUrl: lifecycle.href, apiKey, commandTimeoutMs: 20_000, isolation: { network: 'api' } },
    connection: { advertiseHost, modelGateway: { requestTimeoutMs: 30_000, maxRequests: 48 } },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
    rootSession: { compaction: { enabled: false }, retry: { enabled: false } },
    maxAgents: 3, workTimeoutMs: 120_000, closeTimeoutMs: 20_000, questionTimeoutMs: 45_000,
  };
  await writeFile(join(installation, 'configuration.mjs'), 'export default ' + JSON.stringify(config) + ';\n', { mode: 0o600 });
  delete env.MURM_MODEL_URL;
  delete env.MURM_SUBAGENTS_MODEL_URL;
  env.XDG_CONFIG_HOME = join(installation, 'preferences');
  env.XDG_STATE_HOME = join(installation, 'state');
  env.MURM_TUI_TEST_TRANSCRIPT = join(installation, 'terminal.raw');
  env.MURM_TUI_CONTROL_URL = new URL('/terminal-control/', upstream.url).href;
  const fixture = fileURLToPath(new URL('./fixtures/murm-tui-subagents.py', import.meta.url));
  await run('python3', [fixture, installation], { env, timeout: 175_000, maxBuffer: 1024 * 1024 });
  assert.equal(upstream.failure, undefined);
  const stage = (name: string) => upstream.requests.filter(item => item.stage === name).length;
  for (const name of ['seed-read', 'seed-result', 'second', 'context-steer', 'root-wait', 'resume', 'root-answer', 'child-answer', 'new-answer']) {
    assert.equal(stage(name), 1, name);
  }
  const root = join(env.XDG_STATE_HOME, 'murm', 'runs');
  const [only, ...extra] = await readdir(root);
  assert.equal(extra.length, 0);
  const report = JSON.parse(await readFile(join(root, only, 'project-run.json'), 'utf8'));
  assert.equal(report.cleanup.status, 'complete');
  assert.ok(report.artifacts.some((artifact: { kind?: string }) => artifact.kind === 'session-archive'));
  assert.ok(report.questions.some((question: { status: string }) => question.status === 'cancelled'));
  assert.equal((await run('git', ['-C', cwd, 'status', '--porcelain=v1'])).stdout, before.stdout);
  assert.equal(await readFile(join(cwd, 'seed.txt'), 'utf8'), seed + '\n');
});

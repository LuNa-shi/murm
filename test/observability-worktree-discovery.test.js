import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ObservationStore } from '../src/observability/observation-store.js';

async function startServer(root) {
  const child = spawn(process.execPath, [
    'dist/scripts/serve-observability.mjs',
    '--root', join(root, 'experiments'),
    '--port', '0',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const startup = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const onOutput = (chunk) => {
      output += chunk;
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        try {
          resolve(JSON.parse(line));
          return;
        } catch {
          // Wait for the complete JSON line.
        }
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`observability server exited with ${code}: ${errors}`)));
  });
  return { child, startup };
}

test('persistent observability discovers repository .worktrees and .worktree experiment stores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-worktree-discovery-'));
  const primaryDatabase = join(root, 'experiments', '.observability', 'observability.sqlite');
  const pluralDatabase = join(root, '.worktrees', 'feature-plural', 'experiments', 'run-plural', '.observability', 'observability.sqlite');
  const deepDatabase = join(root, '.worktrees', 'feature-plural', 'experiments', 'group', 'run-deep', '.observability', 'observability.sqlite');
  await Promise.all([
    mkdir(join(root, 'experiments', '.observability'), { recursive: true }),
    mkdir(join(root, '.worktrees', 'feature-plural', 'experiments', 'run-plural', '.observability'), { recursive: true }),
    mkdir(join(root, '.worktrees', 'feature-plural', 'experiments', 'group', 'run-deep', '.observability'), { recursive: true }),
  ]);
  for (const [database, experimentId] of [
    [primaryDatabase, 'run-primary'],
    [pluralDatabase, 'run-plural'],
    [deepDatabase, 'run-deep'],
  ]) {
    const store = new ObservationStore(database);
    store.registerExperiment({ experimentId, status: 'RUNNING' });
    store.close();
  }
  const { child, startup } = await startServer(root);
  try {
    const registry = await fetch(`${startup.url}/api/experiments`).then((response) => response.json());
    assert.deepEqual(
      registry.experiments.map((experiment) => experiment.experiment_id).sort(),
      ['run-deep', 'run-plural', 'run-primary'],
    );
    assert.ok(startup.scan_roots.includes(join(root, '.worktrees')));
    assert.ok(startup.scan_roots.includes(join(root, '.worktree')));

    const reused = spawnSync(process.execPath, [
      'dist/scripts/serve-observability.mjs', '--root', join(root, 'experiments'), '--port', '0',
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
    assert.equal(reused.status, 0, reused.stderr);
    const reusedStartup = JSON.parse(reused.stdout);
    assert.equal(reusedStartup.reused, true);
    assert.equal(reusedStartup.pid, child.pid);
    assert.equal(reusedStartup.url, startup.url);
    const reusedRegistry = await fetch(`${startup.url}/api/experiments`).then(response => response.json());
    assert.deepEqual(reusedRegistry, registry);
    for (const record of [startup, reusedStartup]) {
      for (const field of ['report_path', 'imported_events', 'raw_event_count']) {
        assert.equal(Object.hasOwn(record, field), false);
      }
    }

    const waitForChanges = async (revision) => {
      const pendingChanges = fetch(`${startup.url}/api/experiments/changes?since=${encodeURIComponent(revision)}`)
      .then((response) => response.json());
      let timeout;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('worktree registry did not refresh')), 8_000);
        });
        return await Promise.race([pendingChanges, timeoutPromise]);
      } finally {
        clearTimeout(timeout);
      }
    };

    const singularDatabase = join(root, '.worktree', 'feature-singular', 'experiments', '.observability', 'observability.sqlite');
    await mkdir(join(root, '.worktree', 'feature-singular', 'experiments', '.observability'), { recursive: true });
    const singularStore = new ObservationStore(singularDatabase);
    singularStore.registerExperiment({ experimentId: 'run-singular', status: 'RUNNING' });
    singularStore.close();
    const singularChanges = await waitForChanges(registry.revision);
    assert.equal(singularChanges.changed, true);
    assert.ok(singularChanges.experiments.some((experiment) => experiment.experiment_id === 'run-singular'));

    const lateDatabase = join(root, '.worktrees', 'feature-late', 'experiments', 'run-late', '.observability', 'observability.sqlite');
    await mkdir(join(root, '.worktrees', 'feature-late', 'experiments', 'run-late', '.observability'), { recursive: true });
    const lateStore = new ObservationStore(lateDatabase);
    lateStore.registerExperiment({ experimentId: 'run-late', status: 'RUNNING' });
    lateStore.close();
    const lateChanges = await waitForChanges(singularChanges.revision);
    assert.equal(lateChanges.changed, true);
    assert.ok(lateChanges.experiments.some((experiment) => experiment.experiment_id === 'run-late'));
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('standalone Observer fails before side effects when remote auth is omitted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-observer-auth-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.SWARMENV_OBSERVABILITY_OPERATOR_PASSWORD;
  const rejected = spawnSync(process.execPath, [
    'dist/scripts/serve-observability.mjs', '--root', join(root, 'experiments'), '--host', '0.0.0.0', '--port', '0',
  ], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5000 });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /requires explicit operator authentication/);
});


test('standalone Observer rejects retired report import options before creating state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-observer-retired-options-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const option of ['--report=missing.json', '--experiment-dir=missing', '--no-raw-logs']) {
    const runRoot = join(root, option.split('=')[0].slice(2));
    const rejected = spawnSync(process.execPath, [
      'dist/scripts/serve-observability.mjs', '--root', runRoot, '--host', '0.0.0.0', '--port', '0', option,
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /unknown option:/);
    await assert.rejects(access(runRoot), { code: 'ENOENT' });
  }
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ObservationStore } from '../src/observability/observation-store.js';

async function startServer(root) {
  const child = spawn(process.execPath, [
    'scripts/serve-observability.mjs',
    '--root', join(root, 'experiments'),
    '--host', '127.0.0.1',
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

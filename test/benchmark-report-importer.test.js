import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { ObservationStore } from '../src/observability/observation-store.js';
import { importBenchmarkReport } from '../src/observability/benchmark-report-importer.js';
import { FileWorkspaceProvider } from '../src/observability/workspace-provider.js';

test('benchmark report importer creates the same timeline and Workspace query shape as live observations', async () => {
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp('/tmp/swarmenv-report-import-'));
  const experimentRoot = join(root, 'experiment');
  const reportRoot = join(root, 'reports', 'problem');
  const workspaceRef = join(experimentRoot, 'workspaces', 'exec-1');
  await mkdir(join(workspaceRef, '.swarm', 'revisions', '1', 'files'), { recursive: true });
  await writeFile(join(workspaceRef, '.swarm', 'workspace.json'), JSON.stringify({
    execution_id: 'exec-1', workspace_ref: workspaceRef, fencing_version: 1, workspace_revision: 1,
    content_hash: 'workspace-hash', files: { 'README.md': { content_hash: 'file-hash', bytes: 4 } },
    checkpoint_ref: null, checkpoint_hash: null, created_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-20T00:00:00.000Z',
  }));
  await writeFile(join(workspaceRef, '.swarm', 'revisions', '1.json'), JSON.stringify({ workspace_ref: workspaceRef, workspace_revision: 1, content_hash: 'workspace-hash', changed_files: ['README.md'] }));
  const report = {
    schema_version: 1,
    protocol: { core_count: 1, repository_commit: 'commit' },
    project: {
      problem_id: 'demo', run_id: 'run-import', database_path: join(experimentRoot, 'state', 'projects', 'demo', 'project.sqlite'),
      task_tree: [{ task_id: 'root-task', parent_id: null, task_type: 'proof', state: 'OPEN' }],
      execution_history: [{ execution_id: 'exec-1', task_id: 'root-task', state: 'RUNNING', workspace_revision: 1 }],
    },
    parallelism: {
      core_count: 1,
      core_state_intervals: [{ core: 1, state: 'RUNNING', task_id: 'root-task', execution_id: 'exec-1', reason: 'execution_started', start_ms: Date.parse('2026-10-20T00:00:01.000Z'), end_ms: Date.parse('2026-10-20T00:00:03.000Z') }],
      agent_turn_intervals: [],
    },
    run: {
      started_at: '2026-10-20T00:00:00.000Z', ended_at: '2026-10-20T00:00:04.000Z', elapsed_ms: 4, solved: false, protocol_valid: true, made_progress: true,
      lifecycle_events: [],
    },
    cores: [{ core: 1, task_id: 'root-task', execution_id: 'exec-1', task_state: 'OPEN', execution_state: 'RUNNING', workspace_ref: workspaceRef, claims: [{ task_id: 'root-task', execution_id: 'exec-1', workspace_revision_start: 1, workspace_revision_end: 1 }], workspace_writes: [], checks: [] }],
    audit: {},
  };
  await mkdir(reportRoot, { recursive: true });
  const reportPath = join(reportRoot, 'report.json');
  await writeFile(reportPath, JSON.stringify(report));
  const store = new ObservationStore();
  const imported = await importBenchmarkReport({ observationStore: store, reportPath, experimentDir: experimentRoot, includeRawLogs: false });
  assert.equal(imported.experiment.experiment_id, 'run-import');
  assert.equal(store.getExperiment('run-import').status, 'FINISHED');
  assert.ok(store.listEvents({ experimentId: 'run-import', kinds: ['core_state_changed'] }).events.length === 1);
  const provider = new FileWorkspaceProvider({ observationStore: store });
  const projection = await provider.get({ experimentId: 'run-import', executionId: 'exec-1' });
  assert.equal(projection.workspace.workspace_revision, 1);
  assert.equal(projection.files[0].path, 'README.md');
  store.close();
  await rm(root, { recursive: true, force: true });
});

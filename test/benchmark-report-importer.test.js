import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importBenchmarkReport } from '../src/observability/benchmark-report-importer.js';
import { ObservationStore } from '../src/observability/observation-store.js';

test('benchmark report imports do not create a synthetic Task root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-benchmark-import-'));
  const observationStore = new ObservationStore();
  t.after(async () => { observationStore.close(); await rm(directory, { recursive: true }); });
  for (const [runId, protocol, taskListKey] of [
    ['current-explicit', {}, 'tasks'],
    ['mission', { mission_id: 'M' }, 'tasks'],
    ['historical', {}, 'task_tree'],
  ]) {
    const reportPath = join(directory, `${runId}.json`);
    await writeFile(reportPath, JSON.stringify({ protocol, project: { run_id: runId, [taskListKey]: [
      { task_id: 'first' }, { task_id: 'other' },
    ] }, run: { started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z' } }));
    const imported = await importBenchmarkReport({ observationStore, reportPath, experimentDir: directory });
    assert.equal(Object.hasOwn(imported.experiment, 'root_task_id'), false);
  }
});

test('a failed preflight imports without an experiment start', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-preflight-import-'));
  const observationStore = new ObservationStore();
  t.after(async () => { observationStore.close(); await rm(directory, { recursive: true }); });
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify({ project: { run_id: 'preflight' },
    run: { started_at: null, ended_at: '2026-01-01T00:01:00Z', setup_elapsed_ms: 60000 } }));
  const { experiment } = await importBenchmarkReport({ observationStore, reportPath, experimentDir: directory });
  assert.equal(experiment.status, 'FAILED');
  assert.equal(experiment.started_at, null);
  assert.equal(experiment.metadata.setup_elapsed_ms, 60000);
  const { events } = observationStore.listEvents({ experimentId: 'preflight' });
  assert.deepEqual(events.map(event => event.kind), ['experiment_finished']);
});

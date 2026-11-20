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

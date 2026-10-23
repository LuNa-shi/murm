import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeProject } from '../src/benchmark/run-analysis.js';

const startedAt = '2026-10-22T00:00:00.000Z';

function createFixtureDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT, root_id TEXT, parent_id TEXT, task_type TEXT, state TEXT,
      state_version INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE executions (
      execution_id TEXT, task_id TEXT, owner_ref TEXT, state TEXT,
      attempt_no INTEGER, workspace_revision INTEGER, candidate_material_id TEXT,
      wait_condition_json TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE materials (
      material_id TEXT, kind TEXT, scope TEXT, evidence_state TEXT,
      content_ref TEXT, content_hash TEXT, version INTEGER, source_task TEXT,
      source_execution TEXT, supersedes TEXT, provenance_json TEXT, created_at TEXT
    );
    CREATE TABLE check_results (
      check_result_id TEXT, request_key TEXT, candidate_material_id TEXT,
      target_task_id TEXT, execution_id TEXT, status TEXT, verdict TEXT,
      applied_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE operations (
      operation_id TEXT, operation TEXT, result_json TEXT, created_at TEXT
    );
  `);
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('root', 'root', null, 'proof', 'SATISFIED', 2, startedAt, '2026-10-22T00:00:05.000Z');
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('child', 'root', 'root', 'research', 'SATISFIED', 2, startedAt, '2026-10-22T00:00:04.000Z');
  db.prepare('INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('e-root', 'root', 'agent:root', 'SUCCEEDED', 1, 2, 'm-root', null, startedAt, '2026-10-22T00:00:05.000Z');
  db.prepare('INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('e-child', 'child', 'agent:child', 'SUCCEEDED', 1, 1, null, null, startedAt, '2026-10-22T00:00:04.000Z');
  db.prepare('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('m-child', 'fact', 'proof_relevant', 'observed', 'sqlite://material/m-child', 'hash-child', 1, 'child', 'e-child', null, JSON.stringify({ actor_ref: 'agent:child' }), '2026-10-22T00:00:01.000Z');
  db.prepare('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('m-root', 'artifact', 'proof_relevant', 'observed', 'sqlite://material/m-root', 'hash-root', 1, 'root', 'e-root', null, JSON.stringify({ actor_ref: 'agent:root' }), '2026-10-22T00:00:04.500Z');
  db.prepare('INSERT INTO check_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('check-1', 'request-1', 'm-root', 'root', 'e-root', 'APPLIED', 'PASS', '2026-10-22T00:00:05.000Z', '2026-10-22T00:00:04.700Z', '2026-10-22T00:00:05.000Z');
  db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?)').run('op-accept', 'accept_task', JSON.stringify({ task: { task_id: 'child' } }), '2026-10-22T00:00:04.000Z');
  db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?)').run('op-submit', 'submit_candidate', JSON.stringify({ execution: { execution_id: 'e-root', task_id: 'root', workspace_revision: 2, candidate_material_id: 'm-root' } }), '2026-10-22T00:00:04.700Z');
  db.close();
}

function dispatch(operation, timestamp, envelope, result) {
  return [
    JSON.stringify({ timestamp, event: 'dispatch.start', service: operation === 'read_materials' ? 'context' : 'task', operation, envelope }),
    JSON.stringify({ timestamp, event: 'dispatch.complete', service: operation === 'read_materials' ? 'context' : 'task', operation, ok: true, result }),
  ].join('\n') + '\n';
}

test('run analysis counts verified progress and parent-converted handoffs without exporting content', async () => {
  const root = await mkdtemp('/tmp/swarmenv-run-analysis-');
  const runtimeRoot = join(root, 'run');
  const projectId = 'putnam_fixture';
  const dbPath = join(runtimeRoot, 'state', 'projects', projectId, 'project.sqlite');
  const serviceRoot = join(runtimeRoot, 'logs', 'projects', projectId, 'services');
  try {
    await mkdir(join(runtimeRoot, 'state', 'projects', projectId), { recursive: true });
    await mkdir(serviceRoot, { recursive: true });
    createFixtureDatabase(dbPath);
    await writeFile(join(serviceRoot, 'context-service.ndjson'), dispatch(
      'read_materials',
      '2026-10-22T00:00:03.000Z',
      { operation_id: 'read-1', actor_ref: 'agent:root', task_id: 'root', execution_id: 'e-root' },
      [{ material_id: 'm-child' }],
    ));
    await writeFile(join(serviceRoot, 'task-service.ndjson'), dispatch(
      'accept_task',
      '2026-10-22T00:00:04.000Z',
      { operation_id: 'accept-1', actor_ref: 'agent:root', task_id: 'root', execution_id: 'e-root' },
      { task: { task_id: 'child' } },
    ));
    const report = {
      protocol: { repository_commit: 'fixture', repository_worktree_dirty: false, core_count: 4 },
      project: {
        problem_id: projectId,
        run_id: 'fixture-run',
        database_path: dbPath,
        task_tree: [
          { task_id: 'root', parent_id: null, state: 'SATISFIED' },
          { task_id: 'child', parent_id: 'root', state: 'SATISFIED' },
        ],
      },
      run: { started_at: startedAt, elapsed_ms: 5_000, solved: true, made_progress: true, protocol_valid: true },
      parallelism: {
        ready_work_ms: 1_000,
        ready_unassigned_ms: 1_000,
        ready_unassigned_reason_ms: { available_core_dispatch: 1_000 },
        ready_samples: [{ at_ms: Date.parse(startedAt), ready_count: 1, idle_core_count: 1, eligible_work_count: 1, unassigned_reason: null }],
      },
      audit: { invalid: false, invalid_reasons: [] },
    };
    const analysis = await analyzeProject({ report, reportPath: 'fixture/report.json', dbPath, runtimeRoot, projectId });
    assert.equal(analysis.outcome.root_pass, true);
    assert.equal(analysis.progress.accepted_child_results, 1);
    assert.equal(analysis.progress.new_judge_evidence, 1);
    assert.equal(analysis.progress.root_path_revision_count, 1);
    assert.equal(analysis.information_flow.handoff_delivery_count, 1);
    assert.equal(analysis.information_flow.handoff_consumption_count, 1);
    assert.equal(analysis.information_flow.converted_handoff_count, 1);
    assert.equal(analysis.scheduling.ready_unassigned_classification_coverage, 1);
    assert.doesNotMatch(JSON.stringify(analysis), /formal_source|proof_text|raw_transcript/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

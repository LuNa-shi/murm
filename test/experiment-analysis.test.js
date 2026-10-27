import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { analyzeExperiment, resolveExperiment } from '../src/analysis/experiment-analysis.js';
import { ObservationStore } from '../src/observability/observation-store.js';

const START = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';
const T3 = '2026-01-01T00:00:03.000Z';
const T4 = '2026-01-01T00:00:04.000Z';
const END = '2026-01-01T00:00:05.000Z';
const TASK = 'task-root';
const EXECUTION = 'execution-1';
const MATERIAL = 'material-1';
const CHECK = 'check-1';

function line(value) { return `${JSON.stringify(value)}\n`; }

async function writeNdjson(path, records) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((record) => typeof record === 'string' ? `${record}\n` : line(record)).join(''));
}

async function createProjectDatabase(path) {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    create table tasks (
      task_id text primary key, root_id text, parent_id text, owner_ref text, task_type text,
      state text, state_version integer, goal text, block_reason text, created_at text, updated_at text
    );
    create table executions (
      execution_id text primary key, task_id text, owner_ref text, state text, state_version integer,
      attempt_no integer, fencing_version integer, runtime_generation integer, workspace_ref text,
      workspace_revision integer, candidate_material_id text, wait_condition_json text,
      wait_deadline text, created_at text, updated_at text
    );
    create table materials (
      material_id text primary key, kind text, scope text, evidence_state text,
      source_task text, source_execution text, version integer, created_at text
    );
    create table check_results (
      check_result_id text primary key, request_key text, candidate_material_id text,
      target_task_id text, target_spec_version integer, execution_id text, status text,
      verdict text, checker_ref text, checker_version text, environment_ref text,
      created_at text, updated_at text
    );
    create table operations (
      operation_id text primary key, operation text, result_json text, created_at text
    );
  `);
  db.prepare('insert into tasks values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    TASK, TASK, null, 'owner:test', 'proof', 'WAITING', 3, 'Test goal', null, START, END,
  );
  db.prepare('insert into executions values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    EXECUTION, TASK, 'agent:core-1', 'WAITING', 4, 1, 1, 1,
    'workspace://task/task-root', 2, MATERIAL, JSON.stringify({ type: 'check_result_arrived' }), END, T1, END,
  );
  db.prepare('insert into materials values (?, ?, ?, ?, ?, ?, ?, ?)').run(
    MATERIAL, 'artifact', 'proof_relevant', 'proposed', TASK, EXECUTION, 1, T2,
  );
  db.prepare('insert into check_results values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    CHECK, 'request-1', MATERIAL, TASK, 1, EXECUTION, 'APPLIED', 'FAIL', 'fixture', '1', 'fixture-env', T3, T4,
  );
  db.prepare('insert into operations values (?, ?, ?, ?)').run(
    'wait-1', 'request_wait', JSON.stringify({ execution: { execution_id: EXECUTION, task_id: TASK, state: 'WAITING' } }), T4,
  );
  db.close();
}

async function createFixture({ agent = true, service = true, workspace = true, malformed = false, unknown = false, errors = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-analysis-fixture-'));
  const project = 'demo';
  await mkdir(join(root, 'metadata'), { recursive: true });
  await writeFile(join(root, 'metadata', 'experiment.json'), JSON.stringify({
    schema_version: 1, experiment_id: 'fixture-run', started_at: START, ended_at: END,
    status: 'completed', result: { project_count: 1, solved_count: 0 },
    protocol: { problem_count: 1, core_count: 1, provider: 'fixture', model: 'fixture', timebox_ms: 5_000 },
  }));
  await mkdir(join(root, 'logs', 'projects', project), { recursive: true });
  await mkdir(join(root, 'state', 'projects', project), { recursive: true });
  await createProjectDatabase(join(root, 'state', 'projects', project, 'project.sqlite'));

  if (agent) await writeNdjson(join(root, 'logs', 'projects', project, 'agents', 'core-1.ndjson'), [
    { timestamp: T1, scope: 'agent:core-1', type: 'rpc_record', record: { type: 'tool_call', toolName: 'swarmenv_task_claim', args: { task_id: TASK } } },
    { timestamp: T2, scope: 'agent:core-1', type: 'rpc_record', record: { type: 'tool_result', toolName: 'swarmenv_task_claim', result: { secret: 'must-not-be-copied' }, isError: false } },
  ]);
  await writeNdjson(join(root, 'logs', 'projects', project, 'runtime', 'core-1.ndjson'), [
    { timestamp: T1, scope: 'runtime:core-1', event: 'runtime.bind_execution', execution_id: EXECUTION },
    { timestamp: T2, scope: 'runtime:core-1', event: 'runtime.heartbeat', execution_id: EXECUTION },
    { timestamp: T4, scope: 'runtime:core-1', event: 'runtime.request_wait', execution_id: EXECUTION, wait_condition: { type: 'check_result_arrived' }, deadline: END },
  ]);
  if (service) {
    await writeNdjson(join(root, 'logs', 'projects', project, 'services', 'task-service.ndjson'), [
      { timestamp: T1, scope: 'task-service', event: 'dispatch.start', service: 'task', operation: 'claim', envelope: { operation_id: 'op-claim', task_id: TASK, execution_id: EXECUTION } },
      { timestamp: T1, scope: 'task-service', event: 'dispatch.complete', service: 'task', operation: 'claim', ok: true, result: { task: { task_id: TASK, state: 'RUNNING' }, execution: { execution_id: EXECUTION, task_id: TASK, state: 'RUNNING' } } },
      ...(errors ? [{ timestamp: T2, scope: 'task-service', event: 'dispatch.complete', service: 'task', operation: 'claim', ok: false, error: { code: 'CONFLICT', message: 'Task has reached its active Execution quota' } }] : []),
      ...(malformed ? ['{"broken":'] : []),
      { timestamp: T3, scope: 'task-service', event: 'dispatch.start', service: 'task', operation: 'submit_candidate', envelope: { operation_id: 'op-submit', task_id: TASK, execution_id: EXECUTION } },
      { timestamp: T3, scope: 'task-service', event: 'dispatch.complete', service: 'task', operation: 'submit_candidate', ok: true, result: { execution: { execution_id: EXECUTION, task_id: TASK, state: 'WAITING', candidate_material_id: MATERIAL } } },
    ]);
    await writeNdjson(join(root, 'logs', 'projects', project, 'services', 'context-service.ndjson'), [
      { timestamp: T2, scope: 'context-service', event: 'dispatch.start', service: 'context', operation: 'publish_material', envelope: { operation_id: 'op-publish', task_id: TASK, execution_id: EXECUTION } },
      { timestamp: T2, scope: 'context-service', event: 'dispatch.complete', service: 'context', operation: 'publish_material', ok: true, result: { material: { material_id: MATERIAL, kind: 'artifact', evidence_state: 'proposed', source_task: TASK, source_execution: EXECUTION } } },
      { timestamp: T3, scope: 'context-service', event: 'dispatch.start', service: 'context', operation: 'read_materials', envelope: { operation_id: 'op-read', task_id: TASK, execution_id: EXECUTION } },
      { timestamp: T3, scope: 'context-service', event: 'dispatch.complete', service: 'context', operation: 'read_materials', ok: true, result: [{ material_id: MATERIAL }] },
    ]);
    if (errors) {
      await writeNdjson(join(root, 'logs', 'projects', project, 'services', 'service-router.ndjson'), [
        { timestamp: T2, scope: 'service-router', event: 'dispatch.start', service: 'task', operation: 'claim', envelope: { operation_id: 'op-conflict', task_id: TASK, execution_id: EXECUTION } },
        { timestamp: T2, scope: 'service-router', event: 'dispatch.complete', service: 'task', operation: 'claim', ok: false, error: { code: 'CONFLICT', message: 'Task has reached its active Execution quota' } },
      ]);
    }
    await writeNdjson(join(root, 'logs', 'projects', project, 'services', 'judge-service.ndjson'), [
      { timestamp: T3, scope: 'judge-service', event: 'judge.start', service: 'judge', operation_id: 'op-judge', target_task_id: TASK, candidate_material_id: MATERIAL },
      { timestamp: T4, scope: 'judge-service', event: 'judge.complete', service: 'judge', operation_id: 'op-judge', ok: true, verdict: 'FAIL', check_result_id: CHECK, candidate_material_id: MATERIAL },
    ]);
    await writeNdjson(join(root, 'logs', 'projects', project, 'bridge', 'core-1.ndjson'), [
      { timestamp: T1, scope: 'bridge:core-1', event: 'bridge.start', operation: 'claim', task_id: TASK, execution_id: EXECUTION, payload: {} },
      { timestamp: T1, scope: 'bridge:core-1', event: 'bridge.complete', operation: 'claim', ok: true, result: {} },
    ]);
    await writeNdjson(join(root, 'logs', 'projects', project, 'judge', 'lean-checker.ndjson'), [
      { timestamp: T4, scope: 'judge:lean-checker', event: 'checker.complete', verdict: 'FAIL', evidence: { target_task_id: TASK, diagnostic: 'proof error' } },
    ]);
  }
  if (unknown) await writeNdjson(join(root, 'logs', 'projects', project, 'runtime', 'core-1.ndjson'), [
    { timestamp: END, scope: 'runtime:core-1', event: 'runtime.stop_execution', execution_id: 'unknown-execution', terminal_state: 'FAILED' },
  ]);
  if (workspace) {
    const workspace = join(root, 'workspaces', 'projects', project, EXECUTION);
    await mkdir(join(workspace, '.swarm', 'revisions'), { recursive: true });
    await writeFile(join(workspace, 'workspace-manifest.json'), JSON.stringify({ execution_id: EXECUTION, workspace_revision: 1, content_hash: 'hash', updated_at: T2 }));
    await writeFile(join(workspace, '.swarm', 'revisions', '1.json'), JSON.stringify({ workspace_revision: 1, changed_files: ['README.md'], created_at: T2 }));
  }
  return root;
}

async function cleanup(root) { await rm(root, { recursive: true, force: true }); }

test('analyzes a complete fixture into stable per-Execution windows without copying sensitive values', async () => {
  const root = await createFixture();
  const firstPath = join(root, 'analysis', 'first.md');
  const secondPath = join(root, 'analysis', 'second.md');
  try {
    const first = await analyzeExperiment(root, { outputPath: firstPath });
    const second = await analyzeExperiment(root, { outputPath: secondPath });
    assert.equal(first.inventory.evidence.find((entry) => entry.class === 'agent').status, 'present');
    assert.equal(first.inventory.evidence.find((entry) => entry.class === 'workspace').status, 'present');
    assert.equal(first.executions.length, 1);
    assert.ok(first.executions[0].windows.length >= 1);
    assert.ok(first.executions[0].windows.some((window) => window.observed_intent === 'claim a Task'));
    assert.ok(first.report.includes('### Execution `execution-1`'));
    assert.ok(first.report.includes('Judge FAIL'));
    assert.ok(first.report.includes('## Error analysis'));
    assert.ok(first.report.includes('## Optimization recommendations'));
    assert.ok(first.report.includes('## Candidate/Judge review'));
    assert.ok(first.report.includes('## Coordination layer'));
    assert.ok(first.report.includes('## Tool layer'));
    assert.ok(first.report.includes('## System efficiency and health'));
    assert.ok(first.report.includes('tactic_no_progress') || first.report.includes('No diagnostic class repeated'));
    assert.ok(first.report.includes('Material'));
    assert.ok(!first.report.includes('must-not-be-copied'));
    assert.ok(!first.report.includes(root));
    assert.equal(first.facts.map((fact) => fact.id).join(','), second.facts.map((fact) => fact.id).join(','));
    assert.equal(first.report, await readFile(firstPath, 'utf8'));
    assert.equal(first.report, second.report);
  } finally { await cleanup(root); }
});

test('deduplicates cross-service error echoes and preserves supporting evidence count', async () => {
  const root = await createFixture({ errors: true });
  try {
    const analysis = await analyzeExperiment(root);
    const conflict = analysis.errors.find((error) => error.category === 'claim_active_execution_quota');
    assert.ok(conflict);
    assert.equal(conflict.occurrence_count, 1);
    assert.ok(conflict.supporting_record_count >= 2);
    assert.match(analysis.report, /claim_active_execution_quota/);
    assert.match(analysis.report, /Supporting records/);
  } finally { await cleanup(root); }
});

test('marks missing Agent, Service, and Workspace evidence instead of reporting zero activity', async () => {
  const root = await createFixture({ agent: false, service: false, workspace: false });
  try {
    const analysis = await analyzeExperiment(root);
    assert.equal(analysis.inventory.evidence.find((entry) => entry.class === 'agent').status, 'missing');
    assert.equal(analysis.inventory.evidence.find((entry) => entry.class === 'service').status, 'missing');
    assert.equal(analysis.inventory.evidence.find((entry) => entry.class === 'workspace').status, 'missing');
    assert.match(analysis.report, /incomplete or malformed/);
    assert.match(analysis.report, /agent, bridge|agent/);
  } finally { await cleanup(root); }
});

test('records malformed NDJSON and unknown Execution references as explicit limitations', async () => {
  const root = await createFixture({ malformed: true, unknown: true });
  try {
    const analysis = await analyzeExperiment(root);
    assert.equal(analysis.inventory.evidence.find((entry) => entry.class === 'service').status, 'malformed');
    assert.ok(analysis.inventory.errors.some((error) => error.line));
    assert.ok(analysis.warnings.some((warning) => warning.type === 'unknown_execution' && warning.execution_id === 'unknown-execution'));
    assert.match(analysis.report, /unknown-execution/);
    assert.match(analysis.report, /### Execution `unknown-execution`/);
  } finally { await cleanup(root); }
});

test('sanitized mode keeps structural evidence but does not parse raw Agent operations', async () => {
  const root = await createFixture({ malformed: true });
  try {
    const analysis = await analyzeExperiment(root, { mode: 'sanitized' });
    assert.equal(analysis.inventory.evidenceMode, 'sanitized export mode');
    assert.equal(analysis.facts.some((fact) => fact.kind === 'tool_call'), false);
    assert.equal(analysis.inventory.evidence.find((entry) => entry.class === 'service').status, 'present');
    assert.match(analysis.report, /sanitized/);
  } finally { await cleanup(root); }
});

test('sanitized analysis joins bounded Material consumer and downstream observations', async () => {
  const root = await createFixture();
  const observation = new ObservationStore(join(root, 'observability.sqlite'));
  observation.registerExperiment({ experimentId: 'fixture-run', rootTaskId: TASK, status: 'RUNNING' });
  observation.append({
    experimentId: 'fixture-run', source: 'context-service', kind: 'material_published',
    taskId: TASK, executionId: EXECUTION, payload: {
      material_id: MATERIAL, kind: 'artifact', scope: 'proof_relevant',
      source_task: TASK, source_execution: EXECUTION,
    },
  });
  observation.append({
    experimentId: 'fixture-run', source: 'context-service', kind: 'material_consumed',
    taskId: TASK, executionId: EXECUTION, payload: {
      material_ids: [MATERIAL], source_task_ids: [TASK], count: 1,
      content: 'must never be copied into a sanitized report',
    },
  });
  observation.append({
    experimentId: 'fixture-run', source: 'workspace', kind: 'workspace_revision_saved',
    taskId: TASK, executionId: EXECUTION, payload: { workspace_revision: 3 },
  });
  observation.finishExperiment('fixture-run');
  observation.close();
  try {
    const analysis = await analyzeExperiment(root, { mode: 'sanitized', outputPath: join(root, 'analysis', 'sanitized.md') });
    const row = analysis.collaboration.find((candidate) => candidate.material_id === MATERIAL);
    assert.ok(row);
    assert.equal(row.consumers.length, 1);
    assert.equal(row.consumers[0].execution_id, EXECUTION);
    assert.ok(row.downstream_effects.some((effect) => effect.kind === 'workspace_revision'));
    assert.doesNotMatch(analysis.report, /must never be copied/);
  } finally {
    await cleanup(root);
  }
});

test('resolves an experiment ID under an explicit experiments root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-experiment-root-'));
  const experiment = join(root, 'by-id');
  await mkdir(experiment, { recursive: true });
  try {
    assert.equal(await resolveExperiment('by-id', { experimentsRoot: root }), experiment);
    await assert.rejects(() => resolveExperiment('..', { experimentsRoot: root }), /experiment not found|escapes/);
  } finally { await cleanup(root); }
});

test('keeps durable Execution identity explicit and uses bounded semantic windows', async () => {
  const root = await createFixture();
  const dbPath = join(root, 'state', 'projects', 'demo', 'project.sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare('insert into executions values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'execution-2', TASK, 'agent:core-2', 'RUNNING', 1, 2, 2, 2,
    'workspace://task/task-root/rework-2', 1, null, null, null, T4, END,
  );
  db.close();
  try {
    const analysis = await analyzeExperiment(root);
    const first = analysis.executions.find((item) => item.execution.execution_id === EXECUTION);
    const second = analysis.executions.find((item) => item.execution.execution_id === 'execution-2');
    assert.equal(analysis.windowSizeMinutes, 5);
    assert.equal(first.successor_execution_id, null);
    assert.equal(second.predecessor_execution_id, null);
    assert.equal(second.lifecycle_role, 'initial or only Execution');
    assert.ok(first.windows.every((window) => !window.operations.some((operation) => operation.includes('[F-'))));
    assert.ok(first.windows.every((window) => 'semantic_summary' in window));
  } finally { await cleanup(root); }
});

test('classifies repeated pre-checker failures as one infrastructure cause with unassessed mathematics', async () => {
  const root = await createFixture();
  const dbPath = join(root, 'state', 'projects', 'demo', 'project.sqlite');
  const db = new DatabaseSync(dbPath);
  for (const [name, definition] of [
    ['judge_operation_status', "text default 'persisted'"],
    ['checker_process_status', "text default 'not_started'"],
    ['result_class', "text default 'unassessed'"],
    ['retryable', 'integer default 1'],
    ['diagnostic_code', 'text'],
  ]) db.exec(`alter table check_results add column ${name} ${definition}`);
  db.exec("update check_results set judge_operation_status = 'persisted', checker_process_status = 'not_started', result_class = 'infrastructure_failure', retryable = 0, diagnostic_code = 'checker_unavailable'");
  const insert = db.prepare(`insert into check_results (
    check_result_id, request_key, candidate_material_id, target_task_id, target_spec_version, execution_id, status, verdict,
    checker_ref, checker_version, environment_ref, judge_operation_status, checker_process_status, result_class, retryable, diagnostic_code, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let index = 2; index <= 8; index += 1) {
    insert.run(`check-${index}`, `request-${index}`, `material-${index}`, TASK, 1, EXECUTION, 'APPLIED', 'ERROR', 'fixture', '1', 'fixture-env', 'persisted', 'not_started', 'infrastructure_failure', 0, 'checker_unavailable', T3, T4);
  }
  db.close();
  try {
    const analysis = await analyzeExperiment(root);
    assert.equal(analysis.candidates.infrastructure_failure_count, 8);
    assert.equal(analysis.candidates.unassessed_count, 8);
    assert.equal(analysis.candidates.fail_count, 0);
    assert.equal(analysis.candidates.repeated_diagnostics.length, 0, 'infrastructure repeats must not be reported as mathematical route non-convergence');
    const finding = analysis.systemFindings.find((item) => item.category === 'checker_unavailable');
    assert.ok(finding);
    assert.match(finding.interpretation, /mathematically unassessed/);
    assert.match(analysis.report, /Checker infrastructure failed before a mathematical result was produced/);
    assert.match(analysis.report, /Mathematical outcomes unassessed/);
  } finally { await cleanup(root); }
});

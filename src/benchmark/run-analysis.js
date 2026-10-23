import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join, relative, resolve } from 'node:path';

const READY_REASONS = Object.freeze([
  'discovery_latency',
  'long_agent_turn',
  'available_core_dispatch',
  'missing_wake_resume',
  'stale_list_or_claim_conflict',
  'insufficient_decomposition',
  'unclassified',
]);

function parseJson(value, fallback = null) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function timestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function durationStats(values) {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (finite.length === 0) return { count: 0, mean_ms: null, median_ms: null, p95_ms: null, max_ms: null };
  return {
    count: finite.length,
    mean_ms: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    median_ms: median(finite),
    p95_ms: percentile(finite, 0.95),
    max_ms: Math.max(...finite),
  };
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function openDatabase(path) {
  try {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}

function rows(db, sql, params = []) {
  if (!db) return [];
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function one(db, sql, params = []) {
  if (!db) return null;
  try { return db.prepare(sql).get(...params) ?? null; } catch { return null; }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function listFiles(root, predicate) {
  const result = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (!predicate || predicate(path, entry.name)) result.push(path);
    }
  }
  await walk(root);
  return result.sort();
}

async function readNdjson(path) {
  try {
    const content = await readFile(path, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function resultTaskId(result) {
  return result?.task?.task_id ?? result?.execution?.task_id ?? result?.check_result?.target_task_id ?? result?.target_task_id ?? null;
}

function resultExecutionId(result) {
  return result?.execution?.execution_id ?? result?.check_result?.execution_id ?? result?.execution_id ?? null;
}

function operationMaterialId(result) {
  return result?.material?.material_id ?? result?.execution?.candidate_material_id ?? result?.candidate_material_id ?? null;
}

function operationAt(operation) {
  return timestamp(operation.created_at) ?? operation.at_ms ?? null;
}

function operationFacts(db) {
  const facts = rows(db, 'SELECT operation_id, operation, result_json, created_at FROM operations ORDER BY created_at, operation_id')
    .map((row) => ({
      operation_id: row.operation_id,
      operation: row.operation,
      result: parseJson(row.result_json, {}),
      created_at: row.created_at,
      at_ms: operationAt(row),
    }));
  const operationCounts = {};
  for (const fact of facts) increment(operationCounts, fact.operation);
  return { facts, operation_counts: operationCounts };
}

function taskStateMaps(db) {
  const tasks = rows(db, 'SELECT task_id, root_id, parent_id, task_type, state, state_version, created_at, updated_at FROM tasks ORDER BY created_at');
  const executions = rows(db, 'SELECT execution_id, task_id, owner_ref, state, attempt_no, workspace_revision, candidate_material_id, wait_condition_json, created_at, updated_at FROM executions ORDER BY created_at')
    .map((execution) => ({ ...execution, wait_condition: parseJson(execution.wait_condition_json) }));
  return {
    tasks,
    executions,
    taskById: new Map(tasks.map((task) => [task.task_id, task])),
    executionById: new Map(executions.map((execution) => [execution.execution_id, execution])),
  };
}

function materialRows(db) {
  return rows(db, 'SELECT material_id, kind, scope, evidence_state, content_ref, content_hash, version, source_task, source_execution, supersedes, provenance_json, created_at FROM materials ORDER BY created_at')
    .map((material) => ({ ...material, provenance: parseJson(material.provenance_json, {}) }));
}

function checkRows(db) {
  return rows(db, 'SELECT check_result_id, request_key, candidate_material_id, target_task_id, execution_id, status, verdict, applied_at, created_at, updated_at FROM check_results ORDER BY created_at');
}

function projectLogRoot(runtimeRoot, projectId) {
  return join(runtimeRoot, 'logs', 'projects', projectId);
}

async function dispatchFacts(runtimeRoot, projectId) {
  const serviceRoot = join(projectLogRoot(runtimeRoot, projectId), 'services');
  const files = await listFiles(serviceRoot, (_path, name) => name.endsWith('.ndjson'));
  const facts = [];
  for (const file of files) {
    const serviceEvents = await readNdjson(file);
    const pending = new Map();
    for (const event of serviceEvents) {
      const operation = event.operation;
      if (!operation) continue;
      if (event.event === 'dispatch.start') {
        const queue = pending.get(operation) ?? [];
        queue.push({
          operation,
          operation_id: event.envelope?.operation_id ?? null,
          actor_ref: event.envelope?.actor_ref ?? null,
          task_id: event.envelope?.task_id ?? null,
          execution_id: event.envelope?.execution_id ?? null,
          at_ms: timestamp(event.timestamp),
        });
        pending.set(operation, queue);
        continue;
      }
      if (event.event !== 'dispatch.complete') continue;
      const queue = pending.get(operation) ?? [];
      const start = queue.shift() ?? { operation, at_ms: null };
      pending.set(operation, queue);
      facts.push({
        ...start,
        completed_at_ms: timestamp(event.timestamp),
        ok: event.ok === true,
        result: event.ok === true ? event.result : null,
        error_code: event.error?.code ?? null,
        service: basename(file, '.ndjson'),
      });
    }
  }
  return facts.sort((left, right) => (left.completed_at_ms ?? Infinity) - (right.completed_at_ms ?? Infinity));
}

async function agentLifecycleFacts(runtimeRoot, projectId) {
  const agentRoot = join(projectLogRoot(runtimeRoot, projectId), 'agents');
  const files = await listFiles(agentRoot, (_path, name) => name.endsWith('.ndjson'));
  const facts = [];
  for (const file of files) {
    for (const event of await readNdjson(file)) {
      if (event.type !== 'session_closed') continue;
      facts.push({
        at_ms: timestamp(event.timestamp),
        expected_stop: event.expected_stop === true,
        code: event.code ?? null,
        signal: event.signal ?? null,
      });
    }
  }
  return facts;
}

function stateCounts(items, key = 'state') {
  const result = {};
  for (const item of items) increment(result, item[key]);
  return result;
}

function rootTaskId(taskFacts, report) {
  return report?.project?.task_tree?.find((task) => task.parent_id === null)?.task_id
    ?? taskFacts.tasks.find((task) => task.parent_id === null)?.task_id
    ?? null;
}

function rootPassInfo(checks, rootId) {
  const passes = checks.filter((check) => check.target_task_id === rootId && check.verdict === 'PASS' && check.status === 'APPLIED');
  const first = passes
    .map((check) => timestamp(check.applied_at) ?? timestamp(check.updated_at) ?? timestamp(check.created_at))
    .filter((value) => value !== null)
    .sort((left, right) => left - right)[0] ?? null;
  return { pass_count: passes.length, first_pass_at_ms: first };
}

function reportStartAt(report, experiment) {
  return timestamp(report?.run?.started_at) ?? timestamp(experiment?.started_at) ?? null;
}

function readyMetrics(report, dispatches, taskFacts) {
  const parallelism = report?.parallelism ?? {};
  const samples = Array.isArray(parallelism.ready_samples) ? parallelism.ready_samples : [];
  const listEvents = dispatches.filter((event) => event.service === 'task-service' && event.operation === 'list_tasks' && event.ok && Array.isArray(event.result));
  const claimEvents = dispatches.filter((event) => event.service === 'task-service' && event.operation === 'claim' && event.ok);
  const firstSeen = new Map();
  for (const event of listEvents) {
    for (const task of event.result) {
      if (!task?.task_id || firstSeen.has(task.task_id)) continue;
      firstSeen.set(task.task_id, event.completed_at_ms);
    }
  }
  const assigned = [];
  for (const event of claimEvents) {
    const taskId = resultTaskId(event.result);
    const listedAt = firstSeen.get(taskId);
    if (!taskId || listedAt === undefined || listedAt === null || event.completed_at_ms === null) continue;
    const sample = samples.filter((candidate) => candidate.at_ms <= listedAt).at(-1) ?? null;
    if (sample && sample.idle_core_count > 0) assigned.push(event.completed_at_ms - listedAt);
  }
  const reasonMs = parallelism.ready_unassigned_reason_ms
    ? { ...parallelism.ready_unassigned_reason_ms }
    : (numberOrNull(parallelism.ready_unassigned_ms) ?? 0) > 0
      ? { unclassified: parallelism.ready_unassigned_ms }
      : {};
  const classifiedMs = Object.entries(reasonMs)
    .filter(([reason]) => reason !== 'unclassified')
    .reduce((sum, [, value]) => sum + Number(value || 0), 0);
  const readyUnassignedMs = numberOrNull(parallelism.ready_unassigned_ms) ?? 0;
  const reasonCoverage = readyUnassignedMs === 0 ? (samples.length > 0 ? 1 : null) : classifiedMs / readyUnassignedMs;
  return {
    ready_work_ms: numberOrNull(parallelism.ready_work_ms),
    ready_unassigned_ms: numberOrNull(parallelism.ready_unassigned_ms),
    ready_unassigned_reason_ms: Object.fromEntries(READY_REASONS
      .filter((reason) => reasonMs[reason] !== undefined)
      .map((reason) => [reason, Number(reasonMs[reason])])),
    ready_unassigned_classification_coverage: reasonCoverage,
    ready_sample_count: samples.length,
    ready_to_assigned_ms: durationStats(assigned),
    ready_to_assigned_opportunity_count: assigned.length,
    classification_source: samples.length > 0 ? 'runner_samples' : 'report_total_only',
    observed_ready_tasks: taskFacts.tasks.filter((task) => task.state === 'OPEN').length,
  };
}

function lifecycleMetrics(report, executions, dispatches, agentEvents) {
  const waits = dispatches.filter((event) => event.operation === 'request_wait' && event.ok);
  const wakes = dispatches.filter((event) => event.operation === 'wake_execution' && event.ok);
  const waitByExecution = new Map();
  for (const wait of waits) {
    const executionId = resultExecutionId(wait.result);
    if (executionId) waitByExecution.set(executionId, wait.completed_at_ms);
  }
  const waitToWake = [];
  for (const wake of wakes) {
    const executionId = resultExecutionId(wake.result) ?? wake.execution_id;
    const requestedAt = waitByExecution.get(executionId);
    if (requestedAt !== undefined && requestedAt !== null && wake.completed_at_ms !== null) waitToWake.push(wake.completed_at_ms - requestedAt);
  }
  const unexpectedExits = agentEvents.filter((event) => !event.expected_stop).length;
  const reportRun = report?.run ?? {};
  const reportAudit = report?.audit ?? {};
  return {
    request_wait_count: waits.length,
    wake_execution_count: wakes.length,
    wait_to_wake_ms: durationStats(waitToWake),
    unexpected_process_exit_count: unexpectedExits,
    turn_timeout_count: report ? (report.cores ?? []).reduce((sum, core) => sum + Number(core.turn_timeout_count ?? 0), 0) : null,
    tool_error_count: numberOrNull(reportRun.tool_error_count),
    tool_protocol_error_count: numberOrNull(reportRun.tool_protocol_error_count),
    invalid_wait_attempt_count: numberOrNull(reportRun.invalid_wait_attempt_count),
    claim_conflict_count: numberOrNull(report?.parallelism?.claim_conflict_count) ?? dispatches.filter((event) => event.operation === 'claim' && !event.ok && event.error_code === 'CONFLICT').length,
    protocol_valid: report ? reportRun.protocol_valid === true && reportAudit.invalid !== true : null,
    invalid_reasons: Array.isArray(reportAudit.invalid_reasons) ? reportAudit.invalid_reasons : [],
    unresolved_waiting_execution_count: executions.filter((execution) => execution.state === 'WAITING').length,
  };
}

function operationTaskId(fact) {
  return resultTaskId(fact.result) ?? fact.task_id ?? null;
}

function handoffMetrics({ materials, tasks, facts, dispatches }) {
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const childMaterials = materials.filter((material) =>
    taskById.get(material.source_task)?.parent_id !== null && material.source_task &&
    material.kind !== 'check_result' && !String(material.provenance?.actor_ref ?? '').startsWith('judge:'));
  const materialById = new Map(materials.map((material) => [material.material_id, material]));
  const reads = dispatches.filter((event) => event.service === 'context-service' && event.operation === 'read_materials' && event.ok && Array.isArray(event.result))
    .flatMap((event) => event.result.map((material) => ({
      material_id: material?.material_id,
      consumer_task_id: event.task_id,
      consumer_execution_id: event.execution_id,
      at_ms: event.completed_at_ms,
    })))
    .filter((read) => read.material_id);
  const validReads = reads.filter((read) => {
    const material = materialById.get(read.material_id);
    const source = taskById.get(material?.source_task);
    const consumer = taskById.get(read.consumer_task_id);
    return material && source?.parent_id !== null && consumer && source.parent_id === consumer.task_id;
  });
  const reviewedTaskIds = new Set();
  const reviewEvents = facts.filter((fact) => ['accept_task', 'request_rework'].includes(fact.operation));
  for (const fact of reviewEvents) {
    const target = fact.result?.task?.task_id ?? fact.result?.target_task_id;
    if (target && taskById.get(target)?.parent_id !== null) reviewedTaskIds.add(target);
  }
  const actionFacts = facts.filter((fact) => ['accept_task', 'request_rework', 'submit_candidate', 'save_workspace_revision'].includes(fact.operation));
  const convertedMaterialIds = new Set();
  for (const read of validReads) {
    const material = materialById.get(read.material_id);
    const source = taskById.get(material.source_task);
    const actionAfterRead = actionFacts.some((action) => {
      if (action.at_ms === null || read.at_ms === null || action.at_ms < read.at_ms) return false;
      const actionTaskId = operationTaskId(action);
      if (['accept_task', 'request_rework'].includes(action.operation)) {
        return (action.result?.task?.task_id ?? action.result?.target_task_id) === material.source_task;
      }
      return actionTaskId === source.parent_id;
    });
    if (actionAfterRead) convertedMaterialIds.add(material.material_id);
  }
  const deliveryTaskIds = new Set(childMaterials.map((material) => material.source_task));
  const usefulTaskIds = new Set([...reviewedTaskIds]);
  for (const materialId of convertedMaterialIds) usefulTaskIds.add(materialById.get(materialId)?.source_task);
  return {
    handoff_delivery_count: new Set(childMaterials.map((material) => material.material_id)).size,
    handoff_consumption_count: new Set(validReads.map((read) => `${read.consumer_task_id}:${read.material_id}`)).size,
    converted_handoff_count: convertedMaterialIds.size,
    handoff_conversion_rate: childMaterials.length === 0 ? null : convertedMaterialIds.size / childMaterials.length,
    parent_review_count: reviewEvents.length,
    parent_review_rate: deliveryTaskIds.size === 0 ? null : reviewedTaskIds.size / deliveryTaskIds.size,
    useful_child_rate: deliveryTaskIds.size === 0 ? null : [...deliveryTaskIds].filter((taskId) => usefulTaskIds.has(taskId)).length / deliveryTaskIds.size,
    delivery_task_count: deliveryTaskIds.size,
    consumed_task_count: new Set(validReads.map((read) => materialById.get(read.material_id)?.source_task)).size,
    delivery_to_consumption_ms: durationStats(validReads.map((read) => {
      const material = materialById.get(read.material_id);
      const deliveredAt = timestamp(material?.created_at);
      return deliveredAt === null || read.at_ms === null ? null : read.at_ms - deliveredAt;
    })),
  };
}

function progressMetrics({ rootId, tasks, materials, checks, facts }) {
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const childIds = new Set(tasks.filter((task) => task.parent_id !== null).map((task) => task.task_id));
  const acceptedChildIds = new Set();
  for (const fact of facts.filter((fact) => fact.operation === 'accept_task')) {
    const target = fact.result?.task?.task_id ?? fact.result?.target_task_id;
    if (childIds.has(target)) acceptedChildIds.add(target);
  }
  const appliedChecks = new Set(checks.filter((check) => ['APPLIED', 'RECEIVED'].includes(check.status)).map((check) => check.check_result_id));
  const failedChecks = checks.filter((check) => ['FAIL', 'ERROR', 'INCONCLUSIVE'].includes(check.verdict));
  const candidateIdsAfterFailure = new Set();
  let routeChangeCount = 0;
  for (const failed of failedChecks) {
    const failedAt = timestamp(failed.applied_at) ?? timestamp(failed.created_at);
    const routeChanged = facts.some((fact) => {
      if (fact.at_ms === null || failedAt === null || fact.at_ms <= failedAt) return false;
      if (['create_child_task', 'request_rework'].includes(fact.operation)) return true;
      if (fact.operation === 'submit_candidate') {
        const candidateId = operationMaterialId(fact.result);
        if (candidateId && candidateId !== failed.candidate_material_id) candidateIdsAfterFailure.add(candidateId);
        return Boolean(candidateId && candidateId !== failed.candidate_material_id);
      }
      return false;
    });
    if (routeChanged) routeChangeCount += 1;
  }
  const repeatedFailedSnapshots = failedChecks.length - new Set(failedChecks.map((check) => check.candidate_material_id)).size;
  const rootRevisionIds = new Set(facts.filter((fact) => fact.operation === 'submit_candidate' && operationTaskId(fact) === rootId)
    .map((fact) => `${resultExecutionId(fact.result)}:${fact.result?.execution?.workspace_revision ?? ''}`));
  return {
    accepted_child_results: acceptedChildIds.size,
    new_judge_evidence: appliedChecks.size,
    failed_check_count: failedChecks.length,
    route_change_after_failure_count: routeChangeCount,
    repeated_failed_snapshot_count: Math.max(0, repeatedFailedSnapshots),
    root_path_revision_count: rootRevisionIds.size,
    child_task_count: childIds.size,
    candidate_material_count: new Set(checks.map((check) => check.candidate_material_id)).size,
    parent_review_target_count: [...acceptedChildIds].filter((taskId) => taskById.get(taskId)?.parent_id !== null).length,
  };
}

function resourceMetrics(report) {
  const parallelism = report?.parallelism ?? {};
  return {
    agent_time_ms: numberOrNull(parallelism.agent_time_ms),
    agent_time_utilization_v0: numberOrNull(parallelism.agent_time_utilization_v0),
    eligible_window_ms: numberOrNull(parallelism.eligible_window_ms),
    eligible_mean_active_core_count: numberOrNull(parallelism.eligible_mean_active_core_count),
    waiting_ms_by_core: parallelism.waiting_ms_by_core ?? null,
    idle_ms_by_core: parallelism.idle_ms_by_core ?? null,
    judge_time_ms: numberOrNull(parallelism.judge_time_ms),
    scheduler_poll_ms: numberOrNull(parallelism.scheduler_poll_ms),
    turn_occupancy_ms: numberOrNull(parallelism.turn_occupancy_ms),
    state_time_ms: parallelism.state_time_ms ?? null,
  };
}

export async function analyzeProject({ report = null, reportPath = null, dbPath, runtimeRoot, projectId, observationStore = null }) {
  const db = openDatabase(dbPath);
  const facts = operationFacts(db);
  const taskFacts = taskStateMaps(db);
  const materials = materialRows(db);
  const checks = checkRows(db);
  const dispatches = await dispatchFacts(runtimeRoot, projectId);
  const agentEvents = await agentLifecycleFacts(runtimeRoot, projectId);
  const experiment = observationStore ? one(observationStore, 'SELECT started_at,status,ended_at FROM experiments WHERE experiment_id=?', [report?.project?.run_id ?? null]) : null;
  const rootId = rootTaskId(taskFacts, report);
  const rootTask = taskFacts.taskById.get(rootId) ?? null;
  const rootPass = rootPassInfo(checks, rootId);
  const startedAt = reportStartAt(report, experiment);
  const elapsedMs = numberOrNull(report?.run?.elapsed_ms) ?? (startedAt === null ? null : Date.now() - startedAt);
  const rootPassMs = rootPass.first_pass_at_ms === null || startedAt === null ? null : Math.max(0, rootPass.first_pass_at_ms - startedAt);
  const progress = progressMetrics({ rootId, tasks: taskFacts.tasks, materials, checks, facts: facts.facts });
  const handoffs = handoffMetrics({ materials, tasks: taskFacts.tasks, facts: facts.facts, dispatches });
  const lifecycle = lifecycleMetrics(report, taskFacts.executions, dispatches, agentEvents);
  const ready = readyMetrics(report, dispatches, taskFacts);
  const finalTaskStates = stateCounts(taskFacts.tasks);
  const finalExecutionStates = stateCounts(taskFacts.executions);
  const completed = Boolean(report?.run);
  const protocolValid = report ? report.run?.protocol_valid === true && report.audit?.invalid !== true : null;
  const rootPassObserved = rootPass.pass_count > 0;
  const analysis = {
    problem_id: projectId,
    status: completed ? 'complete' : 'live_or_partial',
    report_present: Boolean(report),
    report_path: reportPath,
    database_present: Boolean(db),
    started_at: startedAt === null ? null : new Date(startedAt).toISOString(),
    elapsed_ms: elapsedMs,
    protocol: report ? {
      repository_commit: report.protocol?.repository_commit ?? null,
      repository_worktree_dirty: report.protocol?.repository_worktree_dirty ?? null,
      core_count: report.protocol?.core_count ?? null,
      collaboration_mode: report.protocol?.collaboration_mode ?? null,
    } : null,
    outcome: {
      root_pass: rootPassObserved,
      root_pass_count: rootPass.pass_count,
      root_completion: rootTask?.state === 'SATISFIED' || report?.run?.solved === true,
      time_to_root_pass_ms: rootPassMs,
      solved: report?.run?.solved === true,
      made_progress: report?.run?.made_progress ?? (progress.child_task_count > 0 || progress.new_judge_evidence > 0 || progress.root_path_revision_count > 0),
      protocol_valid: protocolValid,
    },
    progress,
    information_flow: handoffs,
    scheduling: ready,
    resources: resourceMetrics(report),
    reliability: lifecycle,
    state: {
      root_task_id: rootId,
      root_task_state: rootTask?.state ?? null,
      task_states: finalTaskStates,
      execution_states: finalExecutionStates,
      material_count: materials.length,
      check_count: checks.length,
      dispatch_count: dispatches.length,
      agent_session_close_count: agentEvents.length,
    },
  };
  db?.close();
  return analysis;
}

function aggregateProjects(projects) {
  const completed = projects.filter((project) => project.status === 'complete');
  const valid = completed.filter((project) => project.outcome.protocol_valid === true);
  const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
  const rootPasses = valid.filter((project) => project.outcome.root_pass).length;
  const completions = valid.filter((project) => project.outcome.root_completion).length;
  const classifiable = projects.filter((project) => project.scheduling.ready_unassigned_classification_coverage !== null);
  const unassigned = projects.reduce((sum, project) => sum + (project.scheduling.ready_unassigned_ms ?? 0), 0);
  const classified = projects.reduce((sum, project) => Object.entries(project.scheduling.ready_unassigned_reason_ms ?? {})
    .filter(([reason]) => reason !== 'unclassified')
    .reduce((subtotal, [, value]) => subtotal + Number(value || 0), sum), 0);
  return {
    problem_count: projects.length,
    completed_problem_count: completed.length,
    live_or_partial_problem_count: projects.length - completed.length,
    valid_run_count: valid.length,
    valid_run_rate: ratio(valid.length, completed.length),
    root_pass_count: rootPasses,
    root_pass_rate: ratio(rootPasses, valid.length),
    root_completion_count: completions,
    root_completion_rate: ratio(completions, valid.length),
    median_time_to_root_pass_ms: median(valid.map((project) => project.outcome.time_to_root_pass_ms).filter((value) => value !== null)),
    total_new_judge_evidence: projects.reduce((sum, project) => sum + project.progress.new_judge_evidence, 0),
    total_converted_handoffs: projects.reduce((sum, project) => sum + project.information_flow.converted_handoff_count, 0),
    mean_handoff_conversion_rate: ratio(
      projects.reduce((sum, project) => sum + project.information_flow.converted_handoff_count, 0),
      projects.reduce((sum, project) => sum + project.information_flow.handoff_delivery_count, 0),
    ),
    total_ready_unassigned_ms: unassigned,
    classified_ready_unassigned_ms: classified,
    ready_unassigned_classification_coverage: unassigned === 0 ? (classifiable.length > 0 ? 1 : null) : classified / unassigned,
  };
}

export async function analyzeRun({ experimentRoot, reportDir, observationDbPath = null } = {}) {
  const root = resolve(experimentRoot);
  const runtimeRoot = await readJson(join(root, 'metadata', 'experiment.json')) ? root : join(root, 'run');
  const reportRoot = resolve(reportDir ?? join(root, 'reports'));
  const metadata = await readJson(join(runtimeRoot, 'metadata', 'experiment.json'));
  const reportPaths = await listFiles(reportRoot, (_path, name) => name === 'report.json');
  const reports = new Map();
  for (const path of reportPaths) {
    const report = await readJson(path);
    const id = report?.project?.problem_id;
    if (id) reports.set(id, { report, path });
  }
  const dbPaths = await listFiles(join(runtimeRoot, 'state', 'projects'), (_path, name) => name === 'project.sqlite');
  const projects = new Map();
  for (const path of dbPaths) projects.set(basename(dirname(path)), { dbPath: path });
  for (const [id, value] of reports) projects.set(id, { ...projects.get(id), ...value });
  const observationDb = openDatabase(observationDbPath ?? join(root, '.observability', 'observability.sqlite'));
  const analyses = [];
  for (const [projectId, project] of [...projects.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const dbPath = project.dbPath ?? project.report?.project?.database_path;
    analyses.push(await analyzeProject({
      report: project.report ?? null,
      reportPath: project.path ? relative(reportRoot, project.path) : null,
      dbPath,
      runtimeRoot,
      projectId,
      observationStore: observationDb,
    }));
  }
  if (observationDb) observationDb.close();
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    experiment: {
      experiment_root: root,
      runtime_root: runtimeRoot,
      metadata: metadata ? {
        experiment_id: metadata.experiment_id ?? null,
        started_at: metadata.started_at ?? null,
        repository_commit: metadata.repository_commit ?? null,
        repository_worktree_dirty: metadata.repository_worktree_dirty ?? null,
        problem_count: metadata.protocol?.problem_count ?? null,
        core_count: metadata.protocol?.core_count ?? null,
        project_parallelism: metadata.protocol?.project_parallelism ?? null,
        timebox_ms: metadata.protocol?.timebox_ms ?? null,
        provider: metadata.protocol?.provider ?? null,
        model: metadata.protocol?.model ?? null,
        collaboration_mode: metadata.protocol?.collaboration_mode ?? null,
      } : null,
    },
    aggregate: aggregateProjects(analyses),
    projects: analyses,
    improvement_criteria: {
      primary: 'At fixed problem, model, toolchain, timebox, and resource budget, improve root_pass_rate or time_to_root_pass_ms without reducing valid_run_rate.',
      collaboration: 'Increase converted_handoff_count and handoff_conversion_rate; child creation, raw turns, and materials alone are insufficient.',
      scheduling: 'Reduce opportunity-conditioned ready_to_assigned_ms and wait_to_wake_ms without increasing claim conflicts or lifecycle failures.',
      cost: 'Treat Agent, Judge, waiting, dispatch, and coordination time as separate costs; utilization without verified progress is diagnostic only.',
    },
  };
}

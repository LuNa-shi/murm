import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ObservationStore } from './observation-store.js';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function isFile(path) {
  try {
    return (await import('node:fs/promises')).stat(path).then((info) => info.isFile());
  } catch {
    return false;
  }
}

async function resolveReportPath(input) {
  const candidate = resolve(input);
  if (await isFile(candidate)) return candidate;
  const entries = await readdir(candidate, { withFileTypes: true });
  const report = entries.find((entry) => entry.isDirectory());
  if (!report) throw new Error(`no project report found under ${candidate}`);
  return join(candidate, report.name, 'report.json');
}

function experimentRootFromReport(report, reportPath, experimentDir = null) {
  if (experimentDir) return resolve(experimentDir);
  const databasePath = report.project?.database_path;
  if (databasePath) return dirname(dirname(dirname(dirname(databasePath))));
  return dirname(dirname(dirname(reportPath)));
}

function coreSummary(report, core) {
  const task = report.project?.task_tree?.find((candidate) => candidate.task_id === core.task_id);
  return {
    task_id: core.task_id,
    execution_id: core.execution_id,
    task_state: core.task_state,
    execution_state: core.execution_state,
    workspace_ref: core.workspace_ref,
    workspace_revision: core.claims?.at(-1)?.workspace_revision_end ?? null,
    workspace_writes: core.workspace_writes?.length ?? 0,
    task_type: task?.task_type ?? null,
  };
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function appendStatic(store, base, event) {
  const sequence = base.sequence;
  store.append({ ...base, ...event, eventId: `static:${base.experimentId}:${sequence}`, sequence });
  base.sequence += 1;
}

async function importRawLogs(store, experimentId, experimentRoot, report) {
  const problemId = report.project?.problem_id;
  if (!problemId) return 0;
  const logRoot = join(experimentRoot, 'logs', 'projects', problemId, 'agents');
  let files;
  try {
    files = (await readdir(logRoot)).filter((name) => /^core-\d+\.ndjson$/.test(name)).sort();
  } catch {
    return 0;
  }
  const coreById = new Map((report.cores ?? []).map((core) => [`core-${core.core}`, core]));
  const base = { experimentId, sequence: store.countEvents(experimentId) + 1 };
  let count = 0;
  for (const file of files) {
    const coreId = basename(file, '.ndjson');
    const core = coreById.get(coreId);
    const lines = (await readFile(join(logRoot, file), 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      appendStatic(store, base, {
        source: 'agent',
        kind: record.type ?? record.event ?? 'raw_agent_record',
        coreId,
        taskId: core?.task_id ?? null,
        executionId: core?.execution_id ?? null,
        occurredAt: record.timestamp ?? report.run?.started_at,
        visibility: 'private',
        payload: record,
      });
      count += 1;
    }
  }
  return count;
}

/**
 * Import one sanitized benchmark report plus its private local evidence into
 * the same Observation Store used by live experiments. Re-importing an
 * already populated Experiment is idempotent by returning its existing data.
 */
export async function importBenchmarkReport({ observationStore, reportPath, experimentDir = null, includeRawLogs = true } = {}) {
  if (!(observationStore instanceof ObservationStore)) throw new TypeError('observationStore must be an ObservationStore');
  const resolvedReportPath = await resolveReportPath(reportPath);
  const report = await readJson(resolvedReportPath);
  const experimentRoot = experimentRootFromReport(report, resolvedReportPath, experimentDir);
  const experimentId = report.project?.run_id ?? basename(experimentRoot);
  const rootTaskId = report.project?.task_tree?.find((task) => task.parent_id === null)?.task_id ?? null;
  const existing = observationStore.getExperiment(experimentId);
  if (existing && observationStore.countEvents(experimentId) > 0) return { experiment: existing, report, imported_events: 0, report_path: resolvedReportPath };
  const metadata = {
    source: 'benchmark_report',
    report_path: resolvedReportPath,
    experiment_root: experimentRoot,
    problem_id: report.project?.problem_id ?? null,
    repository_commit: report.protocol?.repository_commit ?? null,
    core_count: report.parallelism?.core_count ?? report.protocol?.core_count ?? null,
    elapsed_ms: report.run?.elapsed_ms ?? null,
    solved: report.run?.solved ?? false,
    protocol_valid: report.run?.protocol_valid ?? null,
    made_progress: report.run?.made_progress ?? null,
    parallelism: report.parallelism ?? null,
  };
  observationStore.registerExperiment({ experimentId, rootTaskId, status: 'RUNNING', startedAt: report.run?.started_at, metadata });
  const base = { experimentId, sequence: 1 };
  appendStatic(observationStore, base, {
    source: 'runtime', kind: 'experiment_started', taskId: rootTaskId,
    occurredAt: report.run?.started_at, visibility: 'operator', payload: { source: 'benchmark_report', problem_id: report.project?.problem_id },
  });
  const intervals = report.parallelism?.core_state_intervals ?? [];
  for (const interval of intervals) {
    appendStatic(observationStore, base, {
      source: 'runtime', kind: 'core_state_changed', coreId: `core-${interval.core}`,
      taskId: interval.task_id ?? null, executionId: interval.execution_id ?? null,
      occurredAt: iso(interval.start_ms), visibility: 'operator',
      payload: { state: interval.state, reason: interval.reason, started_at_ms: interval.start_ms, ended_at_ms: interval.end_ms },
    });
  }
  for (const interval of report.parallelism?.agent_turn_intervals ?? []) {
    appendStatic(observationStore, base, {
      source: 'agent', kind: 'agent_turn_started', coreId: `core-${interval.core}`,
      taskId: interval.task_id ?? null, executionId: interval.execution_id ?? null,
      occurredAt: iso(interval.start_ms), visibility: 'operator',
      payload: { state: interval.state, reason: interval.reason, ended_at_ms: interval.end_ms, reason_end: interval.reason_end },
    });
    appendStatic(observationStore, base, {
      source: 'agent', kind: 'agent_turn_finished', coreId: `core-${interval.core}`,
      taskId: interval.task_id ?? null, executionId: interval.execution_id ?? null,
      occurredAt: iso(interval.end_ms), visibility: 'operator',
      payload: { state: interval.state, reason_end: interval.reason_end, started_at_ms: interval.start_ms },
    });
  }
  for (const core of report.cores ?? []) {
    const coreId = `core-${core.core}`;
    const summary = coreSummary(report, core);
    for (const claim of core.claims ?? []) {
      appendStatic(observationStore, base, {
        source: 'runtime', kind: 'execution_assigned', coreId, taskId: claim.task_id, executionId: claim.execution_id,
        occurredAt: report.run?.started_at, visibility: 'operator',
        payload: { workspace_ref: core.workspace_ref, workspace_revision: claim.workspace_revision_start, state: 'RUNNING' },
      });
    }
    appendStatic(observationStore, base, {
      source: 'runtime', kind: 'execution_observed', coreId, taskId: core.task_id, executionId: core.execution_id,
      occurredAt: report.run?.ended_at ?? report.run?.started_at, visibility: 'operator', payload: summary,
    });
    for (const write of core.workspace_writes ?? []) {
      appendStatic(observationStore, base, {
        source: 'workspace', kind: 'workspace_revision_saved', coreId, taskId: write.task_id, executionId: write.execution_id,
        occurredAt: report.run?.started_at, visibility: 'operator',
        payload: { ...write, workspace_ref: core.workspace_ref },
      });
    }
    for (const check of core.checks ?? []) {
      appendStatic(observationStore, base, {
        source: 'judge', kind: 'judge_check_finished', coreId, taskId: core.task_id, executionId: core.execution_id,
        occurredAt: report.run?.ended_at ?? report.run?.started_at, visibility: 'operator', payload: check,
      });
    }
  }
  for (const lifecycle of report.run?.lifecycle_events ?? []) {
    appendStatic(observationStore, base, {
      source: 'runtime', kind: `execution_${lifecycle.operation.replace(/^(request_|wake_)/, '')}`,
      taskId: lifecycle.task_id, executionId: lifecycle.execution_id, occurredAt: lifecycle.created_at,
      visibility: 'operator', payload: lifecycle,
    });
  }
  const rawCount = includeRawLogs ? await importRawLogs(observationStore, experimentId, experimentRoot, report) : 0;
  base.sequence = observationStore.countEvents(experimentId) + 1;
  appendStatic(observationStore, base, {
    source: 'runtime', kind: 'experiment_finished', taskId: rootTaskId,
    occurredAt: report.run?.ended_at, visibility: 'operator',
    payload: { solved: report.run?.solved ?? false, protocol_valid: report.run?.protocol_valid ?? null, made_progress: report.run?.made_progress ?? null },
  });
  const status = report.run?.solved ? 'SUCCEEDED' : 'FINISHED';
  const experiment = observationStore.finishExperiment(experimentId, { status, endedAt: report.run?.ended_at });
  return { experiment, report, imported_events: base.sequence - 1, raw_event_count: rawCount, report_path: resolvedReportPath, experiment_root: experimentRoot };
}

export { resolveReportPath };

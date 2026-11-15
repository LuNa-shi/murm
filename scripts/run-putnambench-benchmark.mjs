#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';
import { loadBenchmarkConfig, runBenchmarkBatch, runBenchmarkProject } from '../src/benchmark/putnam-runner.js';
import { ObservationStore } from '../src/observability/observation-store.js';
import { beginPrivateAudit } from '../src/observability/private-audit-retention.js';

import { OBSERVABILITY_AUTH_VERSION, observabilityAccessMode } from '../src/observability/observability-server.js';
const execFileAsync = promisify(execFile);

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function readServerMetadata(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function healthCheck(metadata) {
  if (!metadata?.port || !metadata?.host) return false;
  const healthHost = metadata.host === '0.0.0.0' || metadata.host === '::' ? '127.0.0.1' : metadata.host;
  try {
    const response = await fetch(`http://${healthHost.includes(':') ? `[${healthHost}]` : healthHost}:${metadata.port}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const health = await response.json();
    return health.auth_version === OBSERVABILITY_AUTH_VERSION && health.access_mode === metadata.access_mode;
  } catch {
    return false;
  }
}

function isWithin(root, child) {
  const childRelative = relative(root, child);
  return childRelative !== '' && childRelative !== '..' && !childRelative.startsWith(`..${sep}`) && !childRelative.startsWith(sep);
}

async function ensureObservabilityServer(options) {
  const experimentRoot = resolve(options.experimentRoot);
  const databasePath = join(experimentRoot, '.observability', 'observability.sqlite');
  const configuredMetadataPath = options.observabilityMetadataPath ?? process.env.SWARMENV_OBSERVABILITY_METADATA ?? null;
  const metadataPaths = configuredMetadataPath
    ? [resolve(configuredMetadataPath)]
    : [
      join(experimentRoot, '.observability', 'public-server.json'),
      join(experimentRoot, '.observability', 'server.json'),
    ];
  const metadataPath = metadataPaths[0];
  const accessMode = configuredMetadataPath ? null : observabilityAccessMode({
    host: options.observabilityHost, operatorPassword: process.env.SWARMENV_OBSERVABILITY_OPERATOR_PASSWORD ?? null,
  });
  const compatible = metadata => configuredMetadataPath ||
    (metadata.host === options.observabilityHost && metadata.access_mode === accessMode);
  for (const candidatePath of metadataPaths) {
    const existing = await readServerMetadata(candidatePath);
    if (existing && compatible(existing) && (configuredMetadataPath || resolve(existing.database_path ?? '') === databasePath) && await healthCheck(existing)) return existing;
  }
  if (configuredMetadataPath) {
    throw new Error(`configured persistent observability service is unavailable; inspect ${metadataPath}`);
  }

  const advertiseHost = options.observabilityAdvertiseHost;
  const scriptPath = fileURLToPath(new URL('./serve-observability.mjs', import.meta.url));
  const args = [
    scriptPath,
    '--root', experimentRoot,
    '--db', databasePath,
    '--metadata', metadataPath,
    '--host', options.observabilityHost,
    '--port', String(options.observabilityPort),
  ];
  if (advertiseHost) args.push('--advertise-host', advertiseHost);
  const daemon = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  daemon.unref();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const metadata = await readServerMetadata(metadataPath);
    if (metadata && compatible(metadata) && resolve(metadata.database_path ?? '') === databasePath && await healthCheck(metadata)) return metadata;
    await sleep(250);
  }
  throw new Error(`observability daemon did not become healthy; inspect ${metadataPath}`);
}

async function loadDotEnv(path = '.env') {
  try {
    const content = await readFile(path, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await loadDotEnv();

async function loadPiProviderSettings(provider) {
  const configuredDir = process.env.PI_CODING_AGENT_DIR
    ?? (process.env.HOME ? join(process.env.HOME, '.pi', 'agent') : null);
  if (!configuredDir) return {};
  try {
    const catalog = JSON.parse(await readFile(join(configuredDir, 'models.json'), 'utf8'));
    const settings = catalog?.providers?.[provider];
    if (!settings || typeof settings !== 'object') return {};
    return {
      baseUrl: typeof settings.baseUrl === 'string' ? settings.baseUrl : null,
      apiKey: typeof settings.apiKey === 'string' ? settings.apiKey : null,
      headers: settings.headers && typeof settings.headers === 'object' ? settings.headers : {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
    return {};
  }
}

function optionsFromArgs(argv) {
  const runId = Date.now();
  const options = {
    configPath: null,
    putnamBenchRoot: null,
    experimentRoot: 'experiments',
    experimentDir: `experiments/putnambench-runs/run-${runId}`,
    reportDir: `reports/putnambench-runs/run-${runId}`,
    problemId: null,
    cores: 4,
    projectParallelism: 1,
    timeboxMs: 60 * 60_000,
    turnTimeoutMs: 9 * 60_000,
    observabilityPort: 8787,
    observabilityHost: '127.0.0.1',
    observabilityAdvertiseHost: null,
    observabilityMetadataPath: process.env.SWARMENV_OBSERVABILITY_METADATA ?? null,
    model: process.env.PI_MODEL ?? process.env.NUROUTER_PI_MODEL ?? 'gpt-6.1-sol',
    provider: process.env.PI_PROVIDER ?? process.env.NUROUTER_PI_PROVIDER ?? 'gpt_proxy',
    sandbox: {
      enabled: process.env.SWARMENV_SANDBOX_ENABLED === 'true',
      provider: process.env.SWARMENV_SANDBOX_PROVIDER ?? 'opensandbox',
      image: process.env.SWARMENV_SANDBOX_IMAGE,
      lifecycleBaseUrl: process.env.SWARMENV_OPENSANDBOX_URL,
      endpointHost: process.env.SWARMENV_OPENSANDBOX_ENDPOINT_HOST ?? null,
      bridgeHost: process.env.SWARMENV_BRIDGE_HOST ?? null,
      bridgeUrl: process.env.SWARMENV_BRIDGE_PUBLIC_URL ?? null,
      agentEnvironment: {},
      secretEnvironment: {},
    },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const [key, inline] = arg.split('=', 2);
    const fields = {
      '--problems': 'configPath',
      '--putnambench-root': 'putnamBenchRoot',
      '--experiment-root': 'experimentRoot',
      '--experiment-dir': 'experimentDir',
      '--report-dir': 'reportDir',
      '--problem': 'problemId',
      '--cores': 'cores',
      '--project-parallelism': 'projectParallelism',
      '--timebox-ms': 'timeboxMs',
      '--bot-max-ms': 'botMaxMs',
      '--selection-timeout-ms': 'selectionTimeoutMs',
      '--execution-timeout-ms': 'executionTimeoutMs',
      '--turn-timeout-ms': 'turnTimeoutMs',
      '--observability-port': 'observabilityPort',
      '--observability-host': 'observabilityHost',
      '--observability-advertise-host': 'observabilityAdvertiseHost',
      '--observability-metadata': 'observabilityMetadataPath',
      '--model': 'model',
      '--provider': 'provider',
    };
    if (key === '--parallel-mode') throw new Error('--parallel-mode has been retired; omit it to use four independent Core loops');
    if (!fields[key]) throw new Error(`unknown option: ${arg}`);
    const value = inline ?? argv[++index];
    options[fields[key]] = ['cores', 'projectParallelism', 'timeboxMs', 'botMaxMs', 'selectionTimeoutMs', 'executionTimeoutMs', 'turnTimeoutMs', 'observabilityPort'].includes(fields[key])
      ? Number(value)
      : value;
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/run-putnambench-benchmark.mjs',
    '    --problems config/putnambench-12.json',
    '    --putnambench-root /path/to/PutnamBench',
    '    --cores 4',
    '    --project-parallelism 3',
    '    --timebox-ms 1800000',
    '    --bot-max-ms 600000 --selection-timeout-ms 120000',
    '    --execution-timeout-ms 600000',
    '    --experiment-root experiments',
    '    --experiment-dir experiments/putnambench-runs/run-<id>',
    '    --report-dir reports/putnambench-runs/run-<id>',
    '    --observability-host 127.0.0.1',
    '    --observability-port 8787',
    '    --observability-metadata /path/to/experiments/.observability/public-server.json',
    '',
    'Use --problem <id> to run one configured project as a pilot.',
    '',
  ].join('\n');
}

const options = optionsFromArgs(process.argv.slice(2));
// Issue 119's benchmark entrypoint is provider-backed by contract. Library
// callers may still use deterministic compatibility fixtures explicitly, but
// the production CLI must never silently fall back to the old local backend.
options.requireThirdPartySandbox = true;
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}
if (!options.configPath || !options.putnamBenchRoot) throw new Error(usage() + '--problems and --putnambench-root are required');
if (options.cores !== 4) throw new Error('--cores must be 4 for this benchmark protocol');
if (!Number.isInteger(options.projectParallelism) || options.projectParallelism < 1) throw new Error('--project-parallelism must be a positive integer');
if (!Number.isFinite(options.timeboxMs) || options.timeboxMs < 1) throw new Error('--timebox-ms must be positive');
options.botMaxMs ??= options.timeboxMs;
options.selectionTimeoutMs ??= Math.min(300_000, options.botMaxMs);
options.executionTimeoutMs ??= options.botMaxMs;
for (const [field, flag] of [['botMaxMs', '--bot-max-ms'], ['selectionTimeoutMs', '--selection-timeout-ms'], ['executionTimeoutMs', '--execution-timeout-ms']]) {
  if (!Number.isInteger(options[field]) || options[field] < 2 || options[field] > 2_147_483_647) throw new Error(`${flag} must be a timer-safe integer of at least 2 milliseconds`);
}
if (!options.provider) throw new Error('PI_PROVIDER is required; set it in .env or the environment');
if (!options.model) throw new Error('PI_MODEL is required; set it in .env or the environment');

const operatorStop = new AbortController();
options.signal = operatorStop.signal;
const onOperatorSignal = signal => {
  if (operatorStop.signal.aborted) return;
  operatorStop.abort(signal);
  process.stderr.write(JSON.stringify({ status: 'stop_requested', reason: 'operator_stop', signal }) + '\n');
};
process.on('SIGINT', onOperatorSignal);
process.on('SIGTERM', onOperatorSignal);

// Resolve the selected upstream on the host. The sandbox receives a separate
// per-Bot credential from the local gateway, never this provider key.
const piProviderSettings = await loadPiProviderSettings(options.provider);
const piProviderEnvPrefix = `PI_${options.provider.toUpperCase().replaceAll('-', '_')}`;
const upstreamBase = process.env[`${piProviderEnvPrefix}_BASE_URL`] ?? piProviderSettings.baseUrl;
const upstreamKey = process.env[`${piProviderEnvPrefix}_API_KEY`] ?? piProviderSettings.apiKey;
if (!upstreamBase || !upstreamKey) throw new Error('The selected provider requires a host-side endpoint and credential');
options.modelUpstream = {
  url: `${upstreamBase.replace(/\/$/, '')}/responses`,
  headers: { authorization: `Bearer ${upstreamKey}`, ...(piProviderSettings.headers ?? {}) },
};
options.sandbox.agentEnvironment = {};
options.sandbox.secretEnvironment = {};

options.experimentRoot = resolve(options.experimentRoot);
options.experimentDir = resolve(options.experimentDir);
if (!isWithin(options.experimentRoot, options.experimentDir)) {
  throw new Error(`--experiment-dir must be under --experiment-root: ${options.experimentDir}`);
}

const config = await loadBenchmarkConfig(options.configPath, {
  putnamBenchRoot: options.putnamBenchRoot,
  verifyPinnedCheckout: true,
});
const problems = options.problemId
  ? config.problems.filter((problem) => problem.id === options.problemId)
  : config.problems;
if (problems.length === 0) throw new Error(`problem is not in the locked configuration: ${options.problemId}`);

const repositoryCommit = (await execFileAsync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
const repositoryStatus = (await execFileAsync('git', ['-C', process.cwd(), 'status', '--porcelain'], { encoding: 'utf8' })).stdout.trim();
options.repositoryCommit = repositoryCommit;
options.repositoryWorktreeDirty = repositoryStatus.length > 0;
const metadataPath = resolve(options.experimentDir, 'metadata', 'experiment.json');
const metadata = {
  schema_version: 1,
  experiment_id: resolve(options.experimentDir).split('/').at(-1),
  started_at: new Date().toISOString(),
  repository_commit: repositoryCommit,
  repository_worktree_dirty: repositoryStatus.length > 0,
  putnambench_commit: config.putnambench_commit,
  environment: {
    putnambench_root: config.putnam_bench_root,
    lean_project_root: config.lean_project_root,
    lean_toolchain: config.lean_toolchain,
    mathlib_version: config.mathlib_version,
    checker_ref: config.checker_ref,
    checker_version: config.checker_version,
    environment_ref: config.environment_ref,
  },
  protocol: {
    problem_count: problems.length,
    core_count: options.cores,
    project_parallelism: options.projectParallelism,
    timebox_ms: options.timeboxMs,
    bot_max_ms: options.botMaxMs,
    selection_timeout_ms: options.selectionTimeoutMs,
    execution_timeout_ms: options.executionTimeoutMs,
    task_model: 'flat',
    workspace_model: 'mission_workspace_public_revisions',
    candidate_model: 'workspace_file_ref',
    initial_task_count: null,
    turn_timeout_ms: options.turnTimeoutMs,
    provider: options.provider,
    model: options.model,
    input_policy: 'pinned formalization in Task-owned Workspace; no candidate or solution input',
    raw_evidence_layout: 'logs/, state/, workspaces/',
    report_layout: resolve(options.reportDir),
  },
};
process.umask(0o077);
const audit = await beginPrivateAudit({ root: options.experimentRoot, directory: options.experimentDir });
options.privateAudit = audit;
metadata.protocol.private_audit_retention_ms = audit.retentionMs;
let observationStore;
const pendingCleanup = [];
options.onCleanupPending = promise => pendingCleanup.push(promise);
try {
  await mkdir(resolve(options.reportDir), { recursive: true });
  await mkdir(resolve(options.experimentDir, 'metadata'), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  const observationAddress = await ensureObservabilityServer(options);
  const observationDatabasePath = resolve(observationAddress.database_path ?? join(options.experimentRoot, '.observability', 'observability.sqlite'));
  observationStore = new ObservationStore(observationDatabasePath);
  options.observationStore = observationStore;
  await writeFile(resolve(options.experimentDir, 'metadata', 'observability.json'), JSON.stringify({
    experiment_dir: options.experimentDir,
    experiment_root: options.experimentRoot,
    database_path: observationDatabasePath,
    server_metadata_path: resolve(observationAddress.metadata_path ?? options.observabilityMetadataPath ?? resolve(options.experimentRoot, '.observability', 'public-server.json')),
    persistent: true,
    url: observationAddress.url,
    host: observationAddress.host,
    advertise_host: observationAddress.advertise_host ?? null,
    port: observationAddress.port,
    started_at: new Date().toISOString(),
  }, null, 2));
  process.stdout.write(JSON.stringify({ observability_url: observationAddress.url }) + '\n');

  const reports = options.problemId
    ? [await runBenchmarkProject(problems[0], config, options)]
    : await runBenchmarkBatch(problems, config, options);
  const aggregate = {
    schema_version: 1,
    protocol: {
      problem_count: reports.length,
      core_count: options.cores,
      project_parallelism: options.projectParallelism,
      timebox_ms: options.timeboxMs,
      bot_max_ms: options.botMaxMs,
      selection_timeout_ms: options.selectionTimeoutMs,
      execution_timeout_ms: options.executionTimeoutMs,
      experiment_dir: resolve(options.experimentDir),
      report_dir: resolve(options.reportDir),
      repository_commit: repositoryCommit,
      repository_worktree_dirty: repositoryStatus.length > 0,
      raw_transcript_exported: false,
      proof_contents_exported: false,
    },
    projects: reports.map((report) => ({
      problem_id: report.project?.problem_id ?? null,
      solved: report.run?.solved ?? false,
      elapsed_ms: report.run?.elapsed_ms ?? null,
      candidate_count: report.run?.candidate_count ?? null,
      invalid: report.audit?.invalid ?? true,
      invalid_reasons: report.audit?.invalid_reasons ?? [],
      stop_reason: report.run?.stop_reason ?? null,
      repository_commit: report.protocol?.repository_commit ?? null,
      repository_worktree_dirty: report.protocol?.repository_worktree_dirty ?? null,
      agent_time_utilization_v0: report.parallelism?.agent_time_utilization_v0 ?? null,
      ready_work_ms: report.parallelism?.ready_work_ms ?? null,
      ready_unassigned_ms: report.parallelism?.ready_unassigned_ms ?? null,
      proposed_task_count: report.run?.progress_evidence?.proposed_task_count ?? null,
      take_count: report.run?.take_count ?? null,
      task_model: 'flat',
      initial_task_count: null,
      dynamic_task_count: report.run?.dynamic_task_count ?? 0,
      mean_active_core_count: report.parallelism?.mean_active_core_count ?? null,
      eligible_mean_active_core_count: report.parallelism?.eligible_mean_active_core_count ?? null,
    })),
  };
  const aggregatePath = resolve(options.reportDir, 'aggregate-report.json');
  await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2));
  const invalidCount = aggregate.projects.filter((project) => project.invalid).length;
  const solvedCount = aggregate.projects.filter((project) => project.solved).length;
  await writeFile(metadataPath, JSON.stringify({
    ...metadata,
    ended_at: new Date().toISOString(),
    status: operatorStop.signal.aborted ? 'operator_stopped' : 'completed',
    ...(operatorStop.signal.aborted ? { stop_reason: 'operator_stop', stop_signal: operatorStop.signal.reason } : {}),
    valid_for_analysis: !operatorStop.signal.aborted && invalidCount === 0,
    result: {
      project_count: aggregate.projects.length,
      solved_count: solvedCount,
      invalid_count: invalidCount,
    },
    report_path: aggregatePath,
  }, null, 2));
  process.stdout.write(JSON.stringify({
    aggregate_path: aggregatePath,
    project_count: reports.length,
    solved_count: solvedCount,
    invalid_count: invalidCount,
  }) + '\\n');
} finally {
  if (pendingCleanup.length > 0) {
    process.stderr.write(JSON.stringify({ status: 'cleanup_pending', projects: pendingCleanup.length }) + '\n');
    // Keep the writer alive even when an adapter is waiting without an active
    // Node handle. Reports retain their original timebox and cleanup status.
    const keepAlive = setInterval(() => {}, 30_000);
    try { await Promise.allSettled(pendingCleanup); }
    finally { clearInterval(keepAlive); }
  }
  try { observationStore?.close(); }
  finally {
    try { await audit.close(); }
    finally {
      process.off('SIGINT', onOperatorSignal);
      process.off('SIGTERM', onOperatorSignal);
      if (operatorStop.signal.aborted) process.exitCode = operatorStop.signal.reason === 'SIGINT' ? 130 : 143;
    }
  }
}

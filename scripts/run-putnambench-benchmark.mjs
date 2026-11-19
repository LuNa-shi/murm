#!/usr/bin/env node
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';
import { loadBenchmarkConfig, runBenchmarkBatch, runBenchmarkProject } from '../src/benchmark/putnam-runner.js';
import { runPassK } from '../src/benchmark/pass-k.js';
import { ObservationStore } from '../src/observability/observation-store.js';
import { beginPrivateAudit } from '../src/observability/private-audit-retention.js';
import { parseReplayTime } from '../src/replay/resume-experiment.js';

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
    if (options.signal?.aborted) return null;
    const existing = await readServerMetadata(candidatePath);
    if (existing && compatible(existing) && (configuredMetadataPath || resolve(existing.database_path ?? '') === databasePath) && await healthCheck(existing)) return existing;
  }
  if (options.signal?.aborted) return null;
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
    if (options.signal?.aborted) return null;
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
    initialBotStaggerMs: 60_000,
    turnTimeoutMs: 9 * 60_000,
    observability: false,
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
    if (arg === '--observability') {
      options.observability = true;
      continue;
    }
    const [key, inline] = arg.split('=', 2);
    const fields = {
      '--problems': 'configPath',
      '--putnambench-root': 'putnamBenchRoot',
      '--benchmark-root': 'putnamBenchRoot',
      '--experiment-root': 'experimentRoot',
      '--experiment-dir': 'experimentDir',
      '--report-dir': 'reportDir',
      '--resume-from': 'resumeFrom',
      '--at': 'resumeAt',
      '--problem': 'problemId',
      '--cores': 'cores',
      '--pass-k': 'k',
      '--project-parallelism': 'projectParallelism',
      '--timebox-ms': 'timeboxMs',
      '--bot-max-ms': 'botMaxMs',
      '--initial-bot-stagger-ms': 'initialBotStaggerMs',
      '--selection-timeout-ms': 'selectionTimeoutMs',
      '--execution-timeout-ms': 'executionTimeoutMs',
      '--turn-timeout-ms': 'turnTimeoutMs',
      '--checker-timeout-ms': 'checkerTimeoutMs',
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
    options[fields[key]] = ['k', 'cores', 'projectParallelism', 'timeboxMs', 'botMaxMs', 'initialBotStaggerMs', 'selectionTimeoutMs', 'executionTimeoutMs', 'turnTimeoutMs', 'checkerTimeoutMs', 'observabilityPort'].includes(fields[key])
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
    '    --pass-k 1|4                 Independent complete Mission attempts on one --problem; default remains Swarm',
    '    --project-parallelism 3',
    '    --timebox-ms 1800000',
    '    --bot-max-ms 600000 --selection-timeout-ms 120000',
    '    --initial-bot-stagger-ms 60000',
    '    --execution-timeout-ms 600000',
    '    --checker-timeout-ms 180000',
    '    --experiment-root experiments',
    '    --experiment-dir experiments/putnambench-runs/run-<id>',
    '    --report-dir reports/putnambench-runs/run-<id>',
    '    --resume-from experiments/<finished-run> --at 2026-11-19T12:30:00Z --problem <id>',
    '    --observability             Opt in to the persistent observer server; disabled by default',
    '    --observability-host 127.0.0.1',
    '    --observability-port 8787',
    '    --observability-metadata /path/to/experiments/.observability/public-server.json',
    '',
    'Use --problem <id> to run one configured project as a pilot.',
    'Historical resume reconstructs service history at --at and starts four fresh Cores in a new --experiment-dir.',
    'Choose the historical time after the source experiment ends; no manual snapshot is required.',
    'Initial Bots start 60000 ms apart by default; replacement Bots do not repeat this stagger.',
    'The source diagnostic timeout defaults to 120000 ms and is capped by the locked checker timeout.',
    'Set the final-tree timeout in the trusted final_tree_checker configuration and regenerate its artifact lock.',
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
if (Boolean(options.resumeFrom) !== Boolean(options.resumeAt)) throw new Error('--resume-from and --at must be supplied together');
if (options.resumeFrom) {
  if (!options.problemId || options.k !== undefined) throw new Error('Historical resume requires one --problem and four fresh Cores; --pass-k is unavailable');
  options.resumeFrom = resolve(options.resumeFrom);
  options.resumeAt = parseReplayTime(options.resumeAt);
}
if (options.k !== undefined) {
  if (!Number.isSafeInteger(options.k) || options.k < 1 || options.k > 4 || !options.problemId) throw new Error('--pass-k requires K from 1 to 4 and one --problem');
  options.initialBotStaggerMs = 0;
  options.botMaxMs = options.timeboxMs;
  options.executionTimeoutMs = options.timeboxMs;
} else if (options.cores !== 4) throw new Error('--cores must be 4 for this benchmark protocol');
if (!Number.isInteger(options.projectParallelism) || options.projectParallelism < 1) throw new Error('--project-parallelism must be a positive integer');
if (!Number.isFinite(options.timeboxMs) || options.timeboxMs < 1) throw new Error('--timebox-ms must be positive');
if (!Number.isSafeInteger(options.initialBotStaggerMs) || options.initialBotStaggerMs < 0 || options.initialBotStaggerMs > Math.floor(2_147_483_647 / 3)) {
  throw new Error('--initial-bot-stagger-ms must be a nonnegative timer-safe integer for four Core starts');
}
options.botMaxMs ??= options.timeboxMs;
options.selectionTimeoutMs ??= Math.min(300_000, options.botMaxMs);
options.executionTimeoutMs ??= options.botMaxMs;
for (const [field, flag] of [['botMaxMs', '--bot-max-ms'], ['selectionTimeoutMs', '--selection-timeout-ms'], ['executionTimeoutMs', '--execution-timeout-ms']]) {
  if (!Number.isInteger(options[field]) || options[field] < 2 || options[field] > 2_147_483_647) throw new Error(`${flag} must be a timer-safe integer of at least 2 milliseconds`);
}
if (options.checkerTimeoutMs !== undefined && (!Number.isInteger(options.checkerTimeoutMs) || options.checkerTimeoutMs < 1 || options.checkerTimeoutMs > 2_147_483_647)) {
  throw new Error('--checker-timeout-ms must be a timer-safe positive integer');
}
options.experimentRoot = resolve(options.experimentRoot);
options.experimentDir = resolve(options.experimentDir);
if (!isWithin(options.experimentRoot, options.experimentDir)) {
  throw new Error(`--experiment-dir must be under --experiment-root: ${options.experimentDir}`);
}

function existingExperimentDirectory(cause) {
  return new Error(`--experiment-dir already exists: ${options.experimentDir}. Choose a fresh experiment ID and store launch inputs outside the experiment directory.`, { cause });
}

const experimentDirectoryExists = await lstat(options.experimentDir).then(
  () => true,
  (error) => { if (error.code !== 'ENOENT') throw error; return false; },
);
if (experimentDirectoryExists) throw existingExperimentDirectory();

if (!options.provider) throw new Error('PI_PROVIDER is required; set it in .env or the environment');
if (!options.model) throw new Error('PI_MODEL is required; set it in .env or the environment');

const operatorStop = new AbortController();
options.signal = operatorStop.signal;
let projectOutcomesKnown = false;
let stoppedByOperator = false;
const onOperatorSignal = signal => {
  if (projectOutcomesKnown || operatorStop.signal.aborted) return;
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
const finalTreeTimeoutMs = config.final_tree_checker ? config.final_tree_checker.timeoutMs ?? 120_000 : null;
const sourceCheckerTimeoutMs = Math.min(options.checkerTimeoutMs ?? 120_000, finalTreeTimeoutMs ?? Infinity);
const metadata = {
  schema_version: 1,
  experiment_id: resolve(options.experimentDir).split('/').at(-1),
  started_at: new Date().toISOString(),
  repository_commit: repositoryCommit,
  repository_worktree_dirty: repositoryStatus.length > 0,
  ...(options.resumeFrom ? { resume: { source_experiment: options.resumeFrom, requested_at: options.resumeAt } } : {}),
  putnambench_commit: config.putnambench_commit,
  benchmark: config.benchmark ?? 'putnambench',
  fixture_commit: config.fixture_commit ?? config.putnambench_commit,
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
    core_count: options.k ?? options.cores,
    ...(options.k ? { execution_mode: 'pass_k', k: options.k, cores_per_mission: 1 } : {}),
    project_parallelism: options.projectParallelism,
    timebox_ms: options.timeboxMs,
    bot_max_ms: options.botMaxMs,
    initial_bot_stagger_ms: options.initialBotStaggerMs,
    selection_timeout_ms: options.selectionTimeoutMs,
    execution_timeout_ms: options.executionTimeoutMs,
    source_checker_timeout_ms: sourceCheckerTimeoutMs,
    final_tree_checker_timeout_ms: finalTreeTimeoutMs,
    task_model: 'flat',
    workspace_model: 'mission_workspace_public_revisions',
    candidate_model: 'workspace_file_ref',
    initial_task_count: null,
    turn_timeout_ms: options.turnTimeoutMs,
    provider: options.provider,
    model: options.model,
    observability_enabled: options.observability,
    input_policy: options.resumeFrom ? 'original pinned formalization and public research state reconstructed at the requested historical time' : 'pinned formalization in Task-owned Workspace; no candidate or solution input',
    raw_evidence_layout: 'logs/, state/, workspaces/',
    report_layout: resolve(options.reportDir),
  },
};
process.umask(0o077);
const audit = await beginPrivateAudit({ root: options.experimentRoot, directory: options.experimentDir }).catch((error) => {
  if (error.code === 'EEXIST') throw existingExperimentDirectory(error);
  throw error;
});
options.privateAudit = audit;
metadata.protocol.private_audit_retention_ms = audit.retentionMs;
let observationStore;
const pendingCleanup = [];
options.onCleanupPending = promise => pendingCleanup.push(promise);
try {
  await mkdir(resolve(options.reportDir), { recursive: true });
  await mkdir(resolve(options.experimentDir, 'metadata'), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  const observationAddress = options.observability ? await ensureObservabilityServer(options).catch(error => {
    if (operatorStop.signal.aborted) return null;
    throw error;
  }) : null;
  if (observationAddress && !operatorStop.signal.aborted) {
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
  }

  const passK = options.k ? await runPassK(problems[0], config, options) : null;
  const reports = passK ? passK.reports : options.problemId
    ? [await runBenchmarkProject(problems[0], config, options)]
    : await runBenchmarkBatch(problems, config, options);
  projectOutcomesKnown = true;
  stoppedByOperator = reports.some(report => report.run?.stop_reason === 'operator_stop');
  const aggregate = {
    schema_version: 1,
    protocol: {
      problem_count: reports.length,
      core_count: options.k ?? options.cores,
    ...(options.k ? { execution_mode: 'pass_k', k: options.k, cores_per_mission: 1 } : {}),
      project_parallelism: options.projectParallelism,
      timebox_ms: options.timeboxMs,
      bot_max_ms: options.botMaxMs,
      initial_bot_stagger_ms: options.initialBotStaggerMs,
      selection_timeout_ms: options.selectionTimeoutMs,
      execution_timeout_ms: options.executionTimeoutMs,
      source_checker_timeout_ms: sourceCheckerTimeoutMs,
      final_tree_checker_timeout_ms: finalTreeTimeoutMs,
      experiment_dir: resolve(options.experimentDir),
      report_dir: resolve(options.reportDir),
      repository_commit: repositoryCommit,
      repository_worktree_dirty: repositoryStatus.length > 0,
      raw_transcript_exported: false,
      proof_contents_exported: false,
    },
    ...(passK ? { pass_k: passK.summary } : {}),
    projects: reports.map((report, index) => ({
      ...(passK ? { attempt_index: index + 1 } : {}),
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
  const startupFailed = aggregate.projects.some((project) => project.stop_reason === 'bot_startup_contract');
  if (startupFailed && !stoppedByOperator) {
    process.exitCode = 1;
    process.stderr.write(JSON.stringify({
      status: 'startup_failed',
      reason: 'bot_startup_contract',
      action: 'Verify the pinned Bot image with the worker contract and disk quota probes before retrying.',
    }) + '\n');
  }
  await writeFile(metadataPath, JSON.stringify({
    ...metadata,
    ended_at: new Date().toISOString(),
    status: stoppedByOperator ? 'operator_stopped' : startupFailed ? 'startup_failed' : 'completed',
    ...(stoppedByOperator ? { stop_reason: 'operator_stop', stop_signal: operatorStop.signal.reason } : startupFailed ? { stop_reason: 'bot_startup_contract' } : {}),
    valid_for_analysis: invalidCount === 0,
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
      if (stoppedByOperator) process.exitCode = operatorStop.signal.reason === 'SIGINT' ? 130 : 143;
    }
  }
}

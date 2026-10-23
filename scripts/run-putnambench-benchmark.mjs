#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { join, relative, resolve, sep } from 'node:path';
import { loadBenchmarkConfig, runBenchmarkBatch, runBenchmarkProject } from '../src/benchmark/putnam-runner.js';
import { ObservationStore } from '../src/observability/observation-store.js';

const execFileAsync = promisify(execFile);

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function detectTailscaleIPv4() {
  try {
    const result = await execFileAsync('tailscale', ['ip', '-4'], { encoding: 'utf8' });
    const address = result.stdout.trim().split(/\s+/)[0];
    return isIP(address) === 4 ? address : null;
  } catch {
    return null;
  }
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
    const response = await fetch(`http://${healthHost}:${metadata.port}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
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
  const metadataPath = join(experimentRoot, '.observability', 'server.json');
  const existing = await readServerMetadata(metadataPath);
  if (existing && resolve(existing.database_path ?? '') === databasePath && await healthCheck(existing)) return existing;

  const advertiseHost = options.observabilityAdvertiseHost ?? await detectTailscaleIPv4();
  const scriptPath = fileURLToPath(new URL('./serve-observability.mjs', import.meta.url));
  const args = [
    scriptPath,
    '--root', experimentRoot,
    '--db', databasePath,
    '--host', options.observabilityHost,
    '--port', String(options.observabilityPort),
  ];
  if (advertiseHost) args.push('--advertise-host', advertiseHost);
  const daemon = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  daemon.unref();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const metadata = await readServerMetadata(metadataPath);
    if (metadata && resolve(metadata.database_path ?? '') === databasePath && await healthCheck(metadata)) return metadata;
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
    collaborationMode: 'swarm',
    observabilityPort: 8787,
    observabilityHost: '0.0.0.0',
    observabilityAdvertiseHost: null,
    model: process.env.NUROUTER_PI_MODEL,
    provider: process.env.NUROUTER_PI_PROVIDER,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const [key, inline] = arg.split('=', 2);
    const value = inline ?? argv[++index];
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
      '--turn-timeout-ms': 'turnTimeoutMs',
      '--collaboration-mode': 'collaborationMode',
      '--observability-port': 'observabilityPort',
      '--observability-host': 'observabilityHost',
      '--observability-advertise-host': 'observabilityAdvertiseHost',
      '--model': 'model',
      '--provider': 'provider',
    };
    if (!fields[key]) throw new Error(`unknown option: ${arg}`);
    options[fields[key]] = ['cores', 'projectParallelism', 'timeboxMs', 'turnTimeoutMs', 'observabilityPort'].includes(fields[key])
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
    '    --timebox-ms 3600000',
    '    --collaboration-mode swarm|root-only',
    '    --experiment-root experiments',
    '    --experiment-dir experiments/putnambench-runs/run-<id>',
    '    --report-dir reports/putnambench-runs/run-<id>',
    '    --observability-host 0.0.0.0',
    '    --observability-port 8787',
    '',
    'Use --problem <id> to run one configured project as a pilot.',
    '',
  ].join('\n');
}

const options = optionsFromArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}
if (!options.configPath || !options.putnamBenchRoot) throw new Error(usage() + '--problems and --putnambench-root are required');
if (options.cores !== 4) throw new Error('--cores must be 4 for this benchmark protocol');
if (!['swarm', 'root-only'].includes(options.collaborationMode)) throw new Error('--collaboration-mode must be swarm or root-only');
if (!Number.isInteger(options.projectParallelism) || options.projectParallelism < 1) throw new Error('--project-parallelism must be a positive integer');
if (!Number.isFinite(options.timeboxMs) || options.timeboxMs < 1) throw new Error('--timebox-ms must be positive');
if (!options.provider) throw new Error('NUROUTER_PI_PROVIDER is required; set it in .env or the environment');
if (!options.model) throw new Error('NUROUTER_PI_MODEL is required; set it in .env or the environment');

options.experimentRoot = resolve(options.experimentRoot);
options.experimentDir = resolve(options.experimentDir);
if (!isWithin(options.experimentRoot, options.experimentDir)) {
  throw new Error(`--experiment-dir must be under --experiment-root: ${options.experimentDir}`);
}

await mkdir(options.experimentDir, { recursive: true });
await mkdir(resolve(options.reportDir), { recursive: true });
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
    turn_timeout_ms: options.turnTimeoutMs,
    collaboration_mode: options.collaborationMode,
    provider: options.provider,
    model: options.model,
    input_policy: 'pinned formalization in Task-owned Workspace; no candidate or solution input',
    raw_evidence_layout: 'logs/, state/, workspaces/',
    report_layout: resolve(options.reportDir),
  },
};
await mkdir(resolve(options.experimentDir, 'metadata'), { recursive: true });
await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

const observationAddress = await ensureObservabilityServer(options);
const observationDatabasePath = join(options.experimentRoot, '.observability', 'observability.sqlite');
const observationStore = new ObservationStore(observationDatabasePath);
options.observationStore = observationStore;
await writeFile(resolve(options.experimentDir, 'metadata', 'observability.json'), JSON.stringify({
  experiment_dir: options.experimentDir,
  experiment_root: options.experimentRoot,
  database_path: observationDatabasePath,
  persistent: true,
  url: observationAddress.url,
  host: observationAddress.host,
  advertise_host: observationAddress.advertise_host ?? null,
  port: observationAddress.port,
  started_at: new Date().toISOString(),
}, null, 2));
process.stdout.write(JSON.stringify({ observability_url: observationAddress.url }) + '\n');

let reports;
try {
  reports = options.problemId
    ? [await runBenchmarkProject(problems[0], config, options)]
    : await runBenchmarkBatch(problems, config, options);
} finally {
  observationStore.close();
}
const aggregate = {
  schema_version: 1,
  protocol: {
    problem_count: reports.length,
    core_count: options.cores,
    project_parallelism: options.projectParallelism,
    timebox_ms: options.timeboxMs,
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
    repository_commit: report.protocol?.repository_commit ?? null,
    repository_worktree_dirty: report.protocol?.repository_worktree_dirty ?? null,
    agent_time_utilization_v0: report.parallelism?.agent_time_utilization_v0 ?? null,
    ready_work_ms: report.parallelism?.ready_work_ms ?? null,
    ready_unassigned_ms: report.parallelism?.ready_unassigned_ms ?? null,
    child_task_count: report.run?.progress_evidence?.child_task_count ?? null,
    child_claim_count: report.run?.child_claim_count ?? null,
  })),
};
const aggregatePath = resolve(options.reportDir, 'aggregate-report.json');
await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2));
const invalidCount = aggregate.projects.filter((project) => project.invalid).length;
const solvedCount = aggregate.projects.filter((project) => project.solved).length;
await writeFile(metadataPath, JSON.stringify({
  ...metadata,
  ended_at: new Date().toISOString(),
  status: 'completed',
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

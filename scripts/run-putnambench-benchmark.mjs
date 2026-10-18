#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { loadBenchmarkConfig, runBenchmarkBatch, runBenchmarkProject } from '../src/benchmark/putnam-runner.js';

function optionsFromArgs(argv) {
  const runId = Date.now();
  const options = {
    configPath: null,
    putnamBenchRoot: null,
    experimentDir: `experiments/putnambench-runs/run-${runId}`,
    reportDir: `reports/putnambench-runs/run-${runId}`,
    problemId: null,
    cores: 4,
    projectParallelism: 1,
    timeboxMs: 60 * 60_000,
    turnTimeoutMs: 9 * 60_000,
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
      '--experiment-dir': 'experimentDir',
      '--report-dir': 'reportDir',
      '--problem': 'problemId',
      '--cores': 'cores',
      '--project-parallelism': 'projectParallelism',
      '--timebox-ms': 'timeboxMs',
      '--turn-timeout-ms': 'turnTimeoutMs',
      '--model': 'model',
      '--provider': 'provider',
    };
    if (!fields[key]) throw new Error(`unknown option: ${arg}`);
    options[fields[key]] = ['cores', 'projectParallelism', 'timeboxMs', 'turnTimeoutMs'].includes(fields[key])
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
    '    --experiment-dir experiments/putnambench-runs/run-<id>',
    '    --report-dir reports/putnambench-runs/run-<id>',
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
if (!Number.isInteger(options.projectParallelism) || options.projectParallelism < 1) throw new Error('--project-parallelism must be a positive integer');
if (!Number.isFinite(options.timeboxMs) || options.timeboxMs < 1) throw new Error('--timebox-ms must be positive');
if (!options.provider) throw new Error('NUROUTER_PI_PROVIDER is required; copy .env.example to .env and load it');
if (!options.model) throw new Error('NUROUTER_PI_MODEL is required; copy .env.example to .env and load it');

await mkdir(resolve(options.experimentDir), { recursive: true });
await mkdir(resolve(options.reportDir), { recursive: true });
const config = await loadBenchmarkConfig(options.configPath, {
  putnamBenchRoot: options.putnamBenchRoot,
  verifyPinnedCheckout: true,
});
const problems = options.problemId
  ? config.problems.filter((problem) => problem.id === options.problemId)
  : config.problems;
if (problems.length === 0) throw new Error(`problem is not in the locked configuration: ${options.problemId}`);

const execFileAsync = promisify(execFile);
const repositoryCommit = (await execFileAsync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
const repositoryStatus = (await execFileAsync('git', ['-C', process.cwd(), 'status', '--porcelain'], { encoding: 'utf8' })).stdout.trim();
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
    provider: options.provider,
    model: options.model,
    input_policy: 'pinned formalization in Task-owned Workspace; no candidate or solution input',
    raw_evidence_layout: 'logs/, state/, workspaces/',
    report_layout: resolve(options.reportDir),
  },
};
await mkdir(resolve(options.experimentDir, 'metadata'), { recursive: true });
await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

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
    experiment_dir: resolve(options.experimentDir),
    report_dir: resolve(options.reportDir),
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

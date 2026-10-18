#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadBenchmarkConfig, runBenchmarkBatch, runBenchmarkProject } from '../src/benchmark/putnam-runner.js';

function optionsFromArgs(argv) {
  const options = {
    configPath: null,
    putnamBenchRoot: null,
    reportDir: `/tmp/swarmenv-putnambench-reports/run-${Date.now()}`,
    problemId: null,
    cores: 4,
    projectParallelism: 1,
    timeboxMs: 60 * 60_000,
    turnTimeoutMs: 9 * 60_000,
    model: process.env.NUROUTER_PI_MODEL,
    provider: process.env.NUROUTER_PI_PROVIDER ?? 'openai',
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
    '    --report-dir /path/to/private-report-dir',
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

await mkdir(resolve(options.reportDir), { recursive: true });
const config = await loadBenchmarkConfig(options.configPath, { putnamBenchRoot: options.putnamBenchRoot });
const problems = options.problemId
  ? config.problems.filter((problem) => problem.id === options.problemId)
  : config.problems;
if (problems.length === 0) throw new Error(`problem is not in the locked configuration: ${options.problemId}`);

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
process.stdout.write(JSON.stringify({
  aggregate_path: aggregatePath,
  project_count: reports.length,
  solved_count: aggregate.projects.filter((project) => project.solved).length,
  invalid_count: aggregate.projects.filter((project) => project.invalid).length,
}) + '\\n');

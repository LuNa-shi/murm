#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { analyzeRun } from '../src/benchmark/run-analysis.js';

function optionsFromArgs(argv) {
  const options = { experimentRoot: null, reportDir: null, output: null, markdown: null, observationDb: null };
  for (let index = 0; index < argv.length; index += 1) {
    const [key, inline] = argv[index].split('=', 2);
    const value = inline ?? argv[++index];
    const fields = {
      '--experiment-root': 'experimentRoot',
      '--report-dir': 'reportDir',
      '--output': 'output',
      '--markdown': 'markdown',
      '--observation-db': 'observationDb',
    };
    if (key === '--help' || key === '-h') return { help: true };
    if (!fields[key]) throw new Error(`unknown option: ${key}`);
    options[fields[key]] = value;
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/analyze-putnambench-run.mjs',
    '    --experiment-root experiments/putnambench-runs/run-<id>',
    '    --report-dir reports/putnambench-runs/run-<id>',
    '    --output reports/putnambench-runs/run-<id>/analysis.json',
    '    --markdown reports/putnambench-runs/run-<id>/analysis.md',
    '',
    'The analyzer reads sanitized reports plus local SQLite/observability facts.',
    'It writes aggregate and per-problem metrics without exporting transcripts or proof contents.',
  ].join('\n');
}

function format(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  return String(value);
}

function markdown(analysis) {
  const aggregate = analysis.aggregate;
  const lines = [
    '# PutnamBench run analysis',
    '',
    `Generated: ${analysis.generated_at}`,
    '',
    'The primary endpoint is verified Root Task progress under a fixed problem, model, toolchain, timebox, and resource budget. Activity, child count, and utilization remain diagnostic signals.',
    '',
    '## Aggregate',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Problems | ${format(aggregate.problem_count)} |`,
    `| Completed | ${format(aggregate.completed_problem_count)} |`,
    `| Valid run rate | ${format(aggregate.valid_run_rate)} |`,
    `| Root pass rate among valid runs | ${format(aggregate.root_pass_rate)} |`,
    `| Root completion rate among valid runs | ${format(aggregate.root_completion_rate)} |`,
    `| Median time to Root PASS (ms) | ${format(aggregate.median_time_to_root_pass_ms)} |`,
    `| New Judge evidence | ${format(aggregate.total_new_judge_evidence)} |`,
    `| Converted Handoffs | ${format(aggregate.total_converted_handoffs)} |`,
    `| Handoff conversion rate | ${format(aggregate.mean_handoff_conversion_rate)} |`,
    `| Ready-unassigned classification coverage | ${format(aggregate.ready_unassigned_classification_coverage)} |`,
    '',
    '## Per problem',
    '',
    '| Problem | Status | Root PASS | Root state | Children | Judge evidence | Converted Handoffs | Ready-unassigned ms | Classification coverage |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const project of analysis.projects) {
    lines.push(`| ${project.problem_id} | ${project.status} | ${project.outcome.root_pass ? 'yes' : 'no'} | ${format(project.state.root_task_state)} | ${format(project.progress.child_task_count)} | ${format(project.progress.new_judge_evidence)} | ${format(project.information_flow.converted_handoff_count)} | ${format(project.scheduling.ready_unassigned_ms)} | ${format(project.scheduling.ready_unassigned_classification_coverage)} |`);
  }
  lines.push('', '## Improvement criteria', '');
  for (const [name, criterion] of Object.entries(analysis.improvement_criteria)) lines.push(`- **${name}:** ${criterion}`);
  lines.push('', '## Ready-work classification', '');
  for (const project of analysis.projects) {
    const reasons = Object.entries(project.scheduling.ready_unassigned_reason_ms ?? {})
      .map(([reason, value]) => `${reason}=${format(value)}ms`).join(', ') || '—';
    lines.push(`- **${project.problem_id}:** ${reasons}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = optionsFromArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.experimentRoot) throw new Error(`${usage()}\n--experiment-root is required`);
  const analysis = await analyzeRun({
    experimentRoot: resolve(options.experimentRoot),
    reportDir: options.reportDir ? resolve(options.reportDir) : null,
    observationDbPath: options.observationDb ? resolve(options.observationDb) : null,
  });
  const output = resolve(options.output ?? `${options.reportDir ?? options.experimentRoot}/analysis.json`);
  const markdownPath = resolve(options.markdown ?? `${options.reportDir ?? options.experimentRoot}/analysis.md`);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(output, `${JSON.stringify(analysis, null, 2)}\n`);
  await writeFile(markdownPath, markdown(analysis));
  process.stdout.write(`${JSON.stringify({ output, markdown: markdownPath, aggregate: analysis.aggregate })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}

export { markdown, optionsFromArgs };

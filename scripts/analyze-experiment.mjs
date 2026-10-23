#!/usr/bin/env node
import { analyzeExperiment } from '../src/analysis/experiment-analysis.js';

function usage() {
  return `Usage: node scripts/analyze-experiment.mjs <experiment-directory-or-id> [options]

Options:
  --mode full|sanitized       Read private local traces (default: full) or exported evidence only.
  --experiments-root <path>   Root used to resolve an experiment ID (default: ./experiments).
  --output <path>              Override the report path (default: <experiment>/analysis/experiment-analysis.md).
  --help                       Show this help.
`;
}

function parseArgs(argv) {
  const options = { mode: 'full' };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--experiments-root') options.experimentsRoot = argv[++index];
    else if (arg === '--output') options.outputPath = argv[++index];
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { input: positional[0], options };
}

try {
  const { input, options } = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); process.exit(0); }
  if (!input) throw new Error('an experiment directory or ID is required');
  const analysis = await analyzeExperiment(input, options);
  console.log(`Wrote ${analysis.reportPath}`);
  console.log(`Evidence: ${analysis.inventory.evidenceMode}; Executions: ${analysis.executions.length}; warnings: ${analysis.warnings.length}`);
} catch (error) {
  console.error(`experiment analysis failed: ${error.message}`);
  console.error(usage());
  process.exitCode = 1;
}

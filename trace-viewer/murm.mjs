#!/usr/bin/env node
import { runTraceCommand, traceUsage } from './command.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(traceUsage);
  } else {
    if (command !== 'trace') throw new Error('Unknown command: ' + command);
    const viewer = await runTraceCommand(args);
    if (viewer) {
      process.once('SIGINT', viewer.close);
      process.once('SIGTERM', viewer.close);
    }
  }
} catch (error) {
  console.error('murm:', error.message);
  console.error(traceUsage);
  process.exitCode = 1;
}

#!/usr/bin/env node
import { parseArgs } from 'node:util';

const usage = 'Usage: murm trace --root <runs-dir> [--port 8787]';

async function main([command, ...args]) {
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (command !== 'trace') throw new Error('Unknown command: ' + command);
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string' },
      port: { type: 'string', default: '8787' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.root) throw new Error('--root is required');
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  const { startTraceServer } = await import('./server.mjs');
  const viewer = await startTraceServer({ root: values.root, port });
  process.once('SIGINT', viewer.close);
  process.once('SIGTERM', viewer.close);
  console.log('murm Trace Viewer listening at ' + viewer.url);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error('murm:', error.message);
  console.error(usage);
  process.exitCode = 1;
}

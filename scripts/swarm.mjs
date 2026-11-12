#!/usr/bin/env node

import { runSwarmCli } from '../src/cli/swarm-cli.js';

try {
  process.exitCode = await runSwarmCli();
} catch (error) {
  const payload = { code: error.code ?? 'CLI_ERROR', message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  const providerFailure = error.code?.startsWith('HTTP_') || ['SERVICE_TIMEOUT', 'SERVICE_UNAVAILABLE', 'SERVICE_NOT_READY'].includes(error.code);
  process.exitCode = providerFailure ? 1 : 2;
}

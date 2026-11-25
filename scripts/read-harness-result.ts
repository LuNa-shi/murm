#!/usr/bin/env node
import { readHarnessResult } from '../src/harnesses/shared/read-result.js';

const usage = 'node dist/scripts/read-harness-result.js --run-directory <directory> --runtime-id <expected-id>';
const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${usage}\nReads saved reports; does not observe a live Runtime or certify business acceptance.\n`);
  } else {
    const options: Record<string, any> = {};
    const names = { '--run-directory': 'runDirectory', '--runtime-id': 'runtimeId' };
    for (let index = 0; index < args.length; index += 2) {
      const key = (names as Record<string, any>)[args[index]];
      if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw Object.assign(new Error('Invalid result reader arguments'), { code: 'INVALID_RESULT_ARGUMENTS' });
      }
      options[key] = args[index + 1];
    }
    const result = await readHarnessResult(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    // This is inspection success, independent of the recorded business outcome.
    process.exitCode = result.environment.state === 'read' && result.core.state === 'read' ? 0 : 1;
  }
} catch (error: any) {
  const invalid = error.code === 'INVALID_RESULT_ARGUMENTS';
  process.stderr.write(`${JSON.stringify({ code: invalid ? error.code : 'RESULT_READ_FAILED', message: invalid ? usage : 'Result records could not be read' })}\n`);
  process.exitCode = invalid ? 2 : 1;
}

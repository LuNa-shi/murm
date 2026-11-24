import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runHourMatrix } from '../../src/environments/endurance/matrix.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') {
  process.stderr.write('Usage: node examples/hour-matrix/main.mjs --config /absolute/frozen-config.mjs\n');
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const configuration = (await import(pathToFileURL(resolve(args[1])).href)).default;
    const directory = resolve('experiments', `hour-matrix-${randomUUID()}`);
    // Raw owner paths and private provider observations remain ignored locally.
    if (relative(resolve('experiments'), directory).startsWith('..')) throw new Error('Invalid private output');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const report = await runHourMatrix({ ...configuration, signal: controller.signal });
    await writeFile(join(directory, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ accepted: report.accepted, modes: report.results.map(row => ({ mode: row.mode,
      state: row.result?.state ?? 'incomplete', failure: row.preflightFailure?.code ?? row.businessFailure?.code,
      cleanup: row.cleanup?.cleanup, durationMs: row.result?.durationMs })) })}\n`);
    process.exitCode = report.accepted ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : 'HOUR_MATRIX_FAILED' })}\n`);
    process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

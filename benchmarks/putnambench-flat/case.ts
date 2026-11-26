import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const putnamModels = {
  k3: { provider: 'kimi_proxy', model: 'k3' },
  'gpt-6.1-sol': { provider: 'gpt_proxy', model: 'gpt-6.1-sol' },
} as const;

export const putnamB1 = Object.freeze({
  id: 'putnam_2025_b1',
  declaration_name: 'putnam_2025_b1',
  putnambench_commit: 'a635813f5edf297d928f9bd5ef8324a26bdde09c',
  problem_file: 'lean4/src/putnam_2025_b1.lean',
  source_hash: '80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7',
  lean_toolchain: 'leanprover/lean4:v4.33.1',
  mathlib_version: '0df444a360eaa60ab8c11dca51a86af692955474',
  ...putnamModels.k3,
  capacity: 4,
  durationMs: 3_600_000,
});

export function putnamModel(selection: string = putnamB1.model) {
  if (!Object.hasOwn(putnamModels, selection)) throw new Error('Putnam model must be k3 or gpt-6.1-sol');
  return putnamModels[selection as keyof typeof putnamModels];
}

function boundedWindowMs(seconds: string, limitMs: number, window: string) {
  const durationMs = Number(seconds) * 1000;
  if (!/^\d+$/.test(seconds) || !Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > limitMs) {
    throw new Error(`Putnam ${window} window must be between 1 and ${Math.floor(limitMs / 1000)} whole seconds`);
  }
  return durationMs;
}

export function putnamWindowMs(seconds?: string) {
  return seconds === undefined ? putnamB1.durationMs : boundedWindowMs(seconds, putnamB1.durationMs, 'research');
}

export function putnamSelectionMs(durationMs: number, seconds?: string) {
  return seconds === undefined ? Math.min(300_000, durationMs) : boundedWindowMs(seconds, durationMs, 'selection');
}

export async function loadPutnamB1(directory: string, model = putnamModel()) {
  const projectRoot = await realpath(directory);
  const sourcePath = join(projectRoot, putnamB1.problem_file);
  const source = await readFile(sourcePath);
  if (await realpath(sourcePath) !== sourcePath ||
      createHash('sha256').update(source).digest('hex') !== putnamB1.source_hash) {
    throw new Error('Expected the original PutnamBench 2025 B1 source');
  }
  const head = await execute('/usr/bin/git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { env: {}, timeout: 5_000 });
  if (head.stdout.trim() !== putnamB1.putnambench_commit) {
    throw new Error('PutnamBench checkout differs from the pinned revision');
  }
  return { ...putnamB1, ...model, projectRoot, source };
}

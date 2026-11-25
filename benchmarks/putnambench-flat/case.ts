import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export const putnamB1 = Object.freeze({
  id: 'putnam_2025_b1',
  declaration_name: 'putnam_2025_b1',
  putnambench_commit: 'a635813f5edf297d928f9bd5ef8324a26bdde09c',
  problem_file: 'lean4/src/putnam_2025_b1.lean',
  source_hash: '80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7',
  lean_toolchain: 'leanprover/lean4:v4.33.1',
  mathlib_version: '0df444a360eaa60ab8c11dca51a86af692955474',
  provider: 'kimi_proxy',
  model: 'k3',
  capacity: 4,
  durationMs: 3_600_000,
});

export async function loadPutnamB1(directory: string) {
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
  return { ...putnamB1, projectRoot, source };
}

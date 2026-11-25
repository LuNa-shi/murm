import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { createRunWindow } from '../shared/run-window.ts';

const packer = fileURLToPath(new URL('./pack-submission.py', import.meta.url));

const exec = promisify(execFile);

interface CheckpointSource {
  window: Awaited<ReturnType<typeof createRunWindow>>;
  outputDir: string;
  sourceRevision: string;
  sourceTree?: string;
  files?: Record<string, string | Buffer>;
  assertAuthorized?: () => void;
}

export async function checkpointSource({ window, outputDir, sourceRevision, sourceTree, files, assertAuthorized = () => {} }: CheckpointSource) {
  const staging = await mkdtemp(join(outputDir, 'checkpoint-'));
  try {
    if (files) {
      if (sourceTree) throw new Error('Choose one checkpoint source');
      sourceTree = join(staging, 'source');
      for (const [name, text] of Object.entries(files)) {
        if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) ||
            name.split('/').some(component => ['.', '..', '.git', '__pycache__'].includes(component)) ||
            name === 'executable' || (typeof text !== 'string' && !Buffer.isBuffer(text))) throw new Error('Invalid submission file');
        const path = join(sourceTree, name);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, text, { flag: 'wx', mode: 0o600 });
      }
    }
    const output = join(staging, 'packed');
    const { stdout } = await exec('python3', [packer, sourceTree, output], { timeout: 10_000 });
    const { instance } = JSON.parse(stdout);
    const archive = await readFile(join(output, instance, 'submission.tar.gz'));
    assertAuthorized();
    return await window.checkpoint({ archive, sourceRevision });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

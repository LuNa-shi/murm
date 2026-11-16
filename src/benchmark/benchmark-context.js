import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

function safePath(path) {
  return typeof path === 'string' && !/[\\:\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');
}

async function readPinned(root, path, expectedHash, limit) {
  if (!safePath(path)) throw new TypeError('unsafe benchmark context path');
  const target = join(root, path);
  if (await realpath(target) !== target) throw new TypeError('benchmark context must not traverse symlinks');
  const entry = await stat(target);
  if (!entry.isFile() || entry.size > limit) throw new TypeError('benchmark context file exceeds bounds');
  const bytes = await readFile(target);
  if (bytes.length > limit || createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    throw new TypeError('benchmark context digest mismatch');
  }
  return bytes;
}

/** Host-provided public benchmark references, verified before Workspace creation. */
export async function readBenchmarkContext(problem, config) {
  if (config.benchmark !== 'flt10' && problem.context_manifest == null) return {};
  if (!config.benchmark_context_root || !problem.context_manifest) throw new TypeError('FLT10 requires pinned public context');
  const root = await realpath(config.benchmark_context_root);
  const manifest = JSON.parse(await readPinned(root, problem.context_manifest, problem.context_sha256, 2 * 1024 * 1024));
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 1000) throw new TypeError('invalid benchmark context manifest');
  const files = {};
  let total = 0;
  for (const file of manifest.files) {
    if (!safePath(file.path) || !file.path.startsWith('benchmark/') || file.path.endsWith('.lean') || Object.hasOwn(files, file.path)) {
      throw new TypeError('unsafe or duplicate benchmark context destination');
    }
    const bytes = await readPinned(root, file.source_path, file.sha256, 2 * 1024 * 1024);
    total += bytes.length;
    if (total > 14 * 1024 * 1024) throw new TypeError('benchmark context exceeds reserved Workspace capacity');
    files[file.path] = bytes;
  }
  return files;
}

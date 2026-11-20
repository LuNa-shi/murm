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

/** Resolve the selected OpenAI Math arm before creating services or contacting a model. */
export async function selectOpenAiMathContext(config, selected, mode) {
  if (mode === 'none') return { config, problems: selected };
  if (mode !== 'paper') throw new TypeError('OpenAI Math paper mode must be none or paper');
  const paperConfig = { ...config, benchmark_context_root: join(config.putnam_bench_root, config.embedded_fixture_root, 'papers') };
  const problems = [];
  for (const problem of selected) {
    if (!problem.paper) throw new TypeError(`no pinned paper for ${problem.id}`);
    const entry = { ...problem, context_manifest: problem.paper.manifest, context_sha256: problem.paper.sha256 };
    const files = await readBenchmarkContext(entry, paperConfig);
    if (Object.keys(files).length !== 2 || !files['benchmark/paper.pdf'] || !files['benchmark/paper.txt']) {
      throw new TypeError(`invalid paper package for ${problem.id}`);
    }
    problems.push(entry);
  }
  return { config: paperConfig, problems };
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

/** An operator receipt is separate from public inputs and required before paid work. */
export async function assertBenchmarkReady(problem, config, checkerConfiguration) {
  if (config.validation_required !== true) return;
  if (!config.benchmark_validation_root || !problem.validation_manifest || !problem.validation_sha256 || !checkerConfiguration?.artifactLock) {
    throw new TypeError('Benchmark is not ready: complete-target witness and visibility validation are required');
  }
  const root = await realpath(config.benchmark_validation_root);
  const receipt = JSON.parse(await readPinned(root, problem.validation_manifest, problem.validation_sha256, 1024 * 1024));
  const lock = typeof checkerConfiguration.artifactLock === 'string'
    ? JSON.parse(await readFile(checkerConfiguration.artifactLock, 'utf8')) : checkerConfiguration.artifactLock;
  if (receipt.verdict !== 'PASS' || receipt.scope !== 'complete-target' || receipt.initial_compilation !== true ||
      receipt.statement_identity !== true || receipt.visibility_audit !== true ||
      receipt.target_sha256 !== problem.source_hash || receipt.context_sha256 !== problem.context_sha256 ||
      !/^[a-f0-9]{64}$/.test(receipt.checker_lock_sha256 ?? '') || receipt.checker_lock_sha256 !== lock.sha256 ||
      !/^[a-f0-9]{64}$/.test(receipt.witness_tree_sha256 ?? '') ||
      receipt.check_result?.verdict !== 'PASS' || receipt.check_result?.checked_tree !== `sha256:${receipt.witness_tree_sha256}` ||
      !/^treecheck:[a-f0-9-]{36}$/.test(receipt.check_result?.check_result_id ?? '')) {
    throw new TypeError('Benchmark is not ready: validation does not attest this complete target, context and checker');
  }
}

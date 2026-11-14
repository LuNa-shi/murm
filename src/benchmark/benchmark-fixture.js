import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function assertFullCommit(commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new TypeError('PutnamBench fixture requires a full lowercase 40-hex Git commit');
  }
}

async function git(root, ...args) {
  const { stdout } = await execFileAsync('git', ['--no-replace-objects', '--literal-pathspecs', '-C', root, ...args], {
    encoding: 'buffer',
  });
  return stdout;
}

export async function verifyBenchmarkFixtureCheckout({ root, commit }) {
  assertFullCommit(commit);
  const [head, checkout] = await Promise.all([
    git(root, 'rev-parse', '--verify', 'HEAD^{commit}'),
    git(root, 'rev-parse', '--show-toplevel'),
  ]);
  if (head.toString('ascii').trimEnd() !== commit || checkout.toString('utf8').replace(/\n$/, '') !== await realpath(root)) {
    throw new TypeError(`PutnamBench checkout does not match pinned commit ${commit} at its repository root`);
  }
}

export async function readBenchmarkFixture({ root, path, commit = null }) {
  if (typeof path !== 'string' || /[\\:\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new TypeError(`unsafe repository-relative PutnamBench fixture path: ${path}`);
  }
  if (commit !== null) assertFullCommit(commit);
  const canonicalRoot = await realpath(root);
  const sourcePath = resolve(root, path);
  const canonicalPath = join(canonicalRoot, path);
  if (await realpath(sourcePath) !== canonicalPath || !(await stat(canonicalPath)).isFile()) {
    throw new TypeError(`PutnamBench fixture must be a regular file at its configured path: ${path}`);
  }
  const worktree = await readFile(canonicalPath);
  let bytes = worktree;
  if (commit !== null) {
    const entry = await git(canonicalRoot, 'ls-tree', '-z', commit, '--', path);
    const match = /^100(?:644|755) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(entry.toString('utf8'));
    if (!match || match[2] !== path) throw new TypeError(`PutnamBench fixture is not a regular file in the pinned commit: ${path}`);
    bytes = await git(canonicalRoot, 'cat-file', 'blob', match[1]);
    if (!bytes.equals(worktree)) throw new TypeError(`PutnamBench fixture does not match the pinned blob: ${path}`);
  }
  return { sourcePath, source: utf8.decode(bytes), sourceHash: createHash('sha256').update(bytes).digest('hex') };
}

/** Verify the selected fixture again at the timed-run entry point. */
export async function verifyBenchmarkRunFixture({ root, commit, problem }) {
  const { problem_file: path, source, source_hash: sourceHash, source_path: sourcePath } = problem;
  await verifyBenchmarkFixtureCheckout({ root, commit });
  const verified = await readBenchmarkFixture({ root, path, commit });
  if (source !== verified.source || sourceHash !== verified.sourceHash || sourcePath !== verified.sourcePath) {
    throw new TypeError('Prepared benchmark problem does not match the pinned Git fixture');
  }
  return verified;
}

// Formal runs use only the pinned local service composition. Readiness alone
// is not a finite billing or lifecycle contract for an arbitrary plugin.
export function assertTimedServiceComposition(options, environment = process.env) {
  if ((options.timeboxMs ?? 60 * 60_000) <= 0) return;
  const externalBuiltin = options.serviceEndpoints == null
    ? ['TASK', 'CONTEXT', 'JUDGE', 'CATALOG'].some(id => environment[`SWARMENV_${id}_SERVICE_URL`])
    : Object.values(options.serviceEndpoints ?? {}).some(Boolean);
  if (externalBuiltin || options.serviceRegistry || options.customServices?.length || options.serviceBundles?.length ||
      (options.mathlibSearchUrl ?? environment.SWARMENV_MATHLIB_SEARCH_URL)) {
    throw new TypeError('Timed benchmarks require the pinned local Services; arbitrary remote or custom Services lack a verified finite resource contract');
  }
}

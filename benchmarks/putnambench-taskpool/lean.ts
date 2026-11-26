import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLockedFinalTreeVerifier } from '../../dist/src/judge/final-tree-deployment.js';
import { LeanChecker } from '../../dist/src/judge/lean-adapter.js';
import { MathlibSearchService } from '../../dist/src/services/mathlib-search-service.js';
import type { loadPutnamB1 } from './case.ts';

const execute = promisify(execFile);
const git = (root: string, args: string[]) => execute('/usr/bin/git', ['-C', root, ...args],
  { env: {}, timeout: 10_000, maxBuffer: 8 * 1024 ** 2 });

export async function preparePutnamChecks(configurationPath: string, problem: Awaited<ReturnType<typeof loadPutnamB1>>) {
  const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
  if (configuration.projectChecks !== true || !configuration.artifactLock) {
    throw new Error('Putnam requires project checking and a trusted artifact lock');
  }
  const lock = typeof configuration.artifactLock === 'string'
    ? JSON.parse(await readFile(configuration.artifactLock, 'utf8')) : configuration.artifactLock;
  const { adapter, evidence } = await createLockedFinalTreeVerifier({ configuration, problem });
  const mathlib = await realpath(lock.sourceRoots.mathlib);
  const [head, change, tracked] = await Promise.all([
    git(mathlib, ['rev-parse', 'HEAD']),
    git(mathlib, ['status', '--porcelain', '--untracked-files=all', '--', 'Mathlib']),
    git(mathlib, ['ls-files', '-z', '--', 'Mathlib']),
  ]);
  if (head.stdout.trim() !== problem.mathlib_version || change.stdout ||
      !configuration.libraryRoots.includes(join(mathlib, '.lake/build/lib/lean'))) {
    throw new Error('Mathlib search sources differ from the pinned checker library');
  }
  const allowedModules = tracked.stdout.split('\0').filter(path => path.endsWith('.lean'))
    .map(path => path.slice(0, -5).replaceAll('/', '.'));
  if (!allowedModules.length) throw new Error('Missing tracked Mathlib source modules');
  const mathlibSearch = new MathlibSearchService({
    upstreamUrl: null, sourceRoot: join(mathlib, 'Mathlib'), projectRoot: null, allowedModules,
    mathlibRevision: problem.mathlib_version, leanVersion: problem.lean_toolchain,
  });
  const projectCheck = adapter.checkProject.bind(adapter);
  const projectIdentity = {
    ...adapter.identity,
    checker_ref: 'lean-project',
    environment_ref: `putnam-project:sha256:${evidence.artifact_lock_sha256}`,
  };
  const fixture = {
    ...projectIdentity, fixture_id: problem.id, putnambench_commit: problem.putnambench_commit,
    problem_file: problem.problem_file, problem_file_hash: problem.source_hash,
    project_root: problem.projectRoot, lean_toolchain: problem.lean_toolchain, mathlib_version: problem.mathlib_version,
  };
  const judgeChecker = new LeanChecker({
    timeoutMs: adapter.timeoutMs, checkerRef: projectIdentity.checker_ref, checkerVersion: projectIdentity.checker_version,
    runner: adapter.runSourceDiagnostic.bind(adapter), projectChecker: projectCheck,
  });
  const mergeChecker = {
    identity: projectIdentity, timeoutMs: adapter.timeoutMs,
    async check(plan: { files: Record<string, Buffer>; tree: string; signal: AbortSignal; deadline: number }) {
      const result = await projectCheck(plan);
      if (result.checked_tree !== plan.tree) return { verdict: 'ERROR', diagnostic: 'Combined Workspace tree was not checked' };
      return { ...result, check_mode: 'lean-project', check_result_id: `projectcheck:${randomUUID()}` };
    },
  };
  return { verifier: adapter, mathlibSearch, fixture, judgeChecker, mergeChecker, evidence };
}

/** Check the original incomplete source with both policies before opening research. */
export async function checkPutnamSeed(problem: Awaited<ReturnType<typeof loadPutnamB1>>, checker: Awaited<ReturnType<typeof preparePutnamChecks>>['verifier']) {
  const input = {
    files: { [problem.problem_file]: problem.source },
    tree: createHash('sha256').update(problem.source).digest('hex'),
  };
  const project = await checker.checkProject(input);
  if (project.verdict !== 'PASS') throw new Error(`Putnam seed did not compile: ${project.diagnostic}`);
  const final = await checker.check(input);
  if (final.verdict !== 'FAIL') throw new Error(`Locked Putnam seed was not correctly rejected: ${final.verdict} ${final.diagnostic}`);
  return { project, final };
}

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { leanSourcePolicyFinding } from '../../src/judge/lean-source-policy.js';

const execFile = promisify(execFileCallback);
const MAX_PROOF_BYTES = 128 * 1024;
export const fatePins = Object.freeze({
  fixtureCommit: '4eb33c8ccd0ff058b461cd763cc406509129743f',
  datasetSha256: '39c13a39f82bb2f39fc42d0a0efb41c6b0ef16b8194c8c8e0ae281c5cf0276fb',
  lockSha256: 'e6efb741f70db112585a49e84e3d04272a6dcf22549b97af072e0c90b08082b0',
  leanVersion: '4.28.0',
  leanCommit: '7e01a1bf5c70fc6167d49c345d3bf80596e9a79b',
  mathlibRevision: '8f9d9cff6bd728b17a24e163c9402775d9e6a365',
  problemId: 1,
  theorem: 'prod_card_eq_card_pow',
});
const placeholder = /:= by\s+sorry\s*$/u;
const targetDeclaration = new RegExp(`^theorem ${fatePins.theorem}(?=\\s)`, 'mu');
const guardPath = fileURLToPath(new URL('./FateProofGuard.lean', import.meta.url));
const verifierPath = fileURLToPath(new URL('./VerifyFateProof.lean', import.meta.url));
const policyWords = /\b(?:sorry|sorryAx|admit|axiom|unsafe|run_tac|run_elab)\b/u;
const axiomPrefix = 'namespace FateExpected';

export function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

type ProjectOptions = { projectRoot: string; leanRoot: string; signal?: AbortSignal };
type LockedPackage = { name: string; rev: string };

export async function loadFateProject({ projectRoot, leanRoot, signal }: ProjectOptions) {
  signal?.throwIfAborted();
  const root = await realpath(resolve(projectRoot));
  const toolchain = await realpath(resolve(leanRoot));
  const [data, lock, version] = await Promise.all([
    readFile(join(root, 'FATE-M.json'), { signal }), readFile(join(root, 'lake-manifest.json'), { signal }),
    readFile(join(root, 'lean-toolchain'), { encoding: 'utf8', signal }),
  ]);
  if (sha256(data) !== fatePins.datasetSha256 || sha256(lock) !== fatePins.lockSha256 ||
      version.trim() !== `leanprover/lean4:v${fatePins.leanVersion}`) {
    throw new Error('FATE-M files differ from the frozen upstream fixture');
  }
  const { stdout } = await execFile(join(toolchain, 'bin', 'lean'), ['--version'], { timeout: 10_000, signal });
  if (!stdout.includes(`version ${fatePins.leanVersion},`) || !stdout.includes(`commit ${fatePins.leanCommit},`)) {
    throw new Error('Lean binary does not match the pinned FATE-M version and commit');
  }
  const row: { id: number; formal_statement: string; informal_statement: string } = JSON.parse(data.toString())[0];
  if (row.id !== fatePins.problemId || !targetDeclaration.test(row.formal_statement) || !placeholder.test(row.formal_statement) ||
      !row.formal_statement.startsWith('import Mathlib\n')) throw new Error('Unexpected pinned problem declaration');
  const packages: LockedPackage[] = JSON.parse(lock.toString()).packages;
  if (packages.find(pkg => pkg.name === 'mathlib')?.rev !== fatePins.mathlibRevision) throw new Error('Mathlib revision differs from the FATE-M pins');
  const libraryPaths = await Promise.all(packages.map(async ({ name, rev }) => {
    const path = join(root, '.lake', 'packages', name);
    const [head, status] = await Promise.all([
      execFile('git', ['-C', path, 'rev-parse', 'HEAD'], { timeout: 10_000, signal }),
      execFile('git', ['-C', path, 'status', '--porcelain', '--untracked-files=all'], { timeout: 10_000, signal }),
    ]);
    if (head.stdout.trim() !== rev || status.stdout.trim()) throw new Error(`FATE-M dependency ${name} is dirty or has the wrong revision`);
    const library = join(path, '.lake', 'build', 'lib', 'lean');
    if (name === 'mathlib') await stat(join(library, 'Mathlib.olean'));
    return (await stat(library).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }))?.isDirectory() ? library : null;
  }));
  return Object.freeze({
    leanRoot: toolchain, libraries: Object.freeze(libraryPaths.filter(path => path !== null)),
    mathlibRoot: join(root, '.lake', 'packages', 'mathlib', 'Mathlib'),
    formal: row.formal_statement, informal: row.informal_statement, problemSha256: sha256(row.formal_statement),
  });
}

export type FateProject = Awaited<ReturnType<typeof loadFateProject>>;
export type FateVerdict = {
  status: 'passed' | 'rejected' | 'timeout' | 'checker_error' | 'aborted';
  code: string; diagnostic?: string; elapsedMs: number;
};

type Mount = { path: string; at: string; writable?: boolean; library?: boolean };

async function isolatedLean(project: FateProject, mounts: Mount[], args: string[], options: { timeoutMs: number; signal?: AbortSignal }) {
  const system = ['/usr/lib', '/usr/lib64'].flatMap(path => ['--ro-bind', path, path]);
  const libraryMounts = project.libraries.map((path, index) => ({ path, at: `/libraries/${index}`, library: true }));
  const inputs: Mount[] = [...mounts, ...libraryMounts];
  return execFile('/usr/bin/prlimit', ['--as=34359738368:34359738368', '--fsize=67108864:67108864', '--nofile=16384:16384',
    '--', '/usr/bin/bwrap', '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--clearenv',
    ...system, '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', project.leanRoot, '/toolchain', '--proc', '/proc', '--dev', '/dev',
    '--size', '134217728', '--tmpfs', '/tmp', '--chdir', '/tmp',
    '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/toolchain/bin', '--setenv', 'LEAN_ABORT_ON_PANIC', '1',
    '--setenv', 'LEAN_PATH', inputs.filter(mount => mount.library).map(mount => mount.at).join(':'),
    ...inputs.flatMap(mount => [mount.writable ? '--bind' : '--ro-bind', mount.path, mount.at]),
    '--', '/toolchain/bin/lean', '--threads=2', ...args,
  ], { ...options, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, env: {} });
}

function proofFinding(proof: string) {
  if (typeof proof !== 'string' || !proof.trim() || !proof.isWellFormed() || Buffer.byteLength(proof) > MAX_PROOF_BYTES ||
      /[\x00-\x08\x0B\x0C\x0E-\x1F]/u.test(proof)) return 'INVALID_PROOF_TEXT';
  if (leanSourcePolicyFinding(proof, policyWords)) return 'INCOMPLETE_OR_UNSUPPORTED_PROOF';
  return null;
}

export async function createFateChecker(project: FateProject, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const trusted = await mkdtemp(join(tmpdir(), 'fate-trusted-'));
  const guard: Mount = { path: trusted, at: '/trusted', library: true };
  try {
    await writeFile(join(trusted, 'FateProofGuard.lean'), await readFile(guardPath));
    await writeFile(join(trusted, 'VerifyFateProof.lean'), await readFile(verifierPath));
    const original = project.formal.replace('import Mathlib\n', '').replace(targetDeclaration, `axiom ${fatePins.theorem}`).replace(placeholder, '');
    await writeFile(join(trusted, 'FateExpected.lean'), `import Mathlib\n${axiomPrefix}\n${original}\nend FateExpected\n`);
    const writable = { ...guard, writable: true };
    for (const module of ['FateProofGuard', 'FateExpected']) {
      await isolatedLean(project, [writable], ['--root=/trusted', '-o', `/trusted/${module}.olean`, `/trusted/${module}.lean`], { timeoutMs: 120_000, signal });
    }
  } catch (error) {
    await rm(trusted, { recursive: true, force: true });
    throw error;
  }

  return Object.freeze({
    async evaluate(proof: string, { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<FateVerdict> {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new TypeError('FATE checker needs a bounded timeout');
      const start = performance.now();
      const result = (status: FateVerdict['status'], code: string, diagnostic?: string): FateVerdict =>
        ({ status, code, ...(diagnostic ? { diagnostic } : {}), elapsedMs: Math.round(performance.now() - start) });
      const finding = proofFinding(proof);
      if (finding) return result('rejected', finding);
      if (signal?.aborted) return result('aborted', 'CHECK_ABORTED');
      const directory = await mkdtemp(join(tmpdir(), 'fate-candidate-'));
      try {
        const fromFixture = project.formal.replace(placeholder, () => `:= fate_proof ${JSON.stringify(proof)}\n`);
        const source = `import FateProofGuard\n${fromFixture}`;
        await writeFile(join(directory, 'Candidate.lean'), source, { mode: 0o600, flag: 'wx' });
        const candidate = { path: directory, at: '/candidate' };
        const budget = () => Math.max(1, Math.floor(timeoutMs - (performance.now() - start)));
        try {
          await isolatedLean(project, [guard, { ...candidate, writable: true }],
            ['--json', '--root=/candidate', '-o', '/candidate/Candidate.olean', '/candidate/Candidate.lean'],
            { signal, timeoutMs: budget() });
        } catch (caught) {
          const error = caught as { stdout?: string; stderr?: string; killed?: boolean };
          if (signal?.aborted) return result('aborted', 'CHECK_ABORTED');
          if (error.killed) return result('timeout', 'LEAN_TIMEOUT');
          const diagnostics = (error.stdout ?? '').split('\n').flatMap(line => {
            try {
              const record = JSON.parse(line);
              return record.severity === 'error' && typeof record.data === 'string' ? [record.data] : [];
            } catch { return []; }
          }).join('\n').slice(0, 4096);
          return diagnostics ? result('rejected', 'LEAN_REJECTED', diagnostics) :
            result('checker_error', 'LEAN_PROCESS_FAILED', error.stderr?.slice(0, 512));
        }
        if (performance.now() - start >= timeoutMs) return result('timeout', 'LEAN_TIMEOUT');
        try {
          const { stdout } = await isolatedLean(project, [guard, candidate],
            ['--run', '/trusted/VerifyFateProof.lean', fatePins.theorem], { signal, timeoutMs: budget() });
          return stdout.trim() === 'fate-proof-verified' ? result('passed', 'VERIFIED') : result('checker_error', 'VERIFIER_PROTOCOL');
        } catch (caught) {
          const error = caught as { stderr?: string; stdout?: string; killed?: boolean; code?: number };
          if (signal?.aborted) return result('aborted', 'CHECK_ABORTED');
          if (error.killed) return result('timeout', 'LEAN_TIMEOUT');
          const failure = (error.stderr || error.stdout || '').slice(0, 1024);
          if (error.code === 1 && /^uncaught exception: /m.test(failure)) return result('rejected', 'PROOF_REPLAY_REJECTED', failure);
          return result('checker_error', 'VERIFIER_PROCESS_FAILED', failure);
        }
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
    close: () => rm(trusted, { recursive: true, force: true }),
  });
}

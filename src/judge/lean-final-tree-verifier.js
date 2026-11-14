import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheckerProcessLimits } from './checker-process-limits.js';

const verifierSource = fileURLToPath(new URL('./final-tree-proof.lean', import.meta.url));
// Mathlib theorem statements can export hundreds of MiB of transitive declarations.
const exportLimit = 768 * 1024 * 1024;
const inputLimit = 128 * 1024 * 1024;
const diagnosticLimit = 8192;
const sourceFailureStatus = 21;
const resourceDiagnostic = /out of memory|memory (?:consumption|limit|exhausted)|cannot allocate|stack overflow|heartbeats|timed? out|time limit|resource temporarily unavailable|killed/i;

function isSourceDiagnostic(stderr) {
  if (resourceDiagnostic.test(stderr)) return false;
  return stderr.split('\n').some(line => {
    try { return JSON.parse(line)?.severity === 'error'; }
    catch { return false; }
  });
}
const primitives = [
  'Nat.add', 'Nat.sub', 'Nat.mul', 'Nat.pow', 'Nat.gcd', 'Nat.div', 'Nat.mod', 'Nat.beq', 'Nat.ble',
  'Nat.land', 'Nat.lor', 'Nat.xor', 'Nat.shiftLeft', 'Nat.shiftRight', 'String.ofList', 'Char.ofNat',
  'List', 'eagerReduce',
];
const axioms = ['propext', 'Quot.sound', 'Classical.choice'];

function sandboxArgs(leanRoot) {
  return [
    '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--clearenv',
    '--ro-bind', '/usr/lib', '/usr/lib', '--ro-bind', '/usr/lib64', '/usr/lib64',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', join(leanRoot, 'bin'), '/toolchain/bin',
    '--ro-bind', join(leanRoot, 'lib'), '/toolchain/lib', '--proc', '/proc', '--dev', '/dev',
    '--size', '268435456', '--tmpfs', '/tmp', '--setenv', 'HOME', '/tmp',
    '--setenv', 'LEAN_ABORT_ON_PANIC', '1', '--setenv', 'PATH', '/toolchain/bin',
  ];
}

function libraries(roots, prefix, args) {
  return roots.map((root, index) => {
    const destination = `/${prefix}/${index}`;
    args.push('--ro-bind', root, destination);
    return destination;
  });
}

function assertWithinDeadline({ signal, deadline }) {
  if (signal?.aborted) throw new Error('Final-tree checker aborted');
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('Final-tree checker deadline elapsed');
}

async function execute(command, args, { signal, deadline, maxOutput, stdoutPath, resourceLimits }) {
  assertWithinDeadline({ signal, deadline });
  return new Promise((resolve, reject) => {
    const limits = resourceLimits ? createCheckerProcessLimits({ runtimeMs: Math.max(1, deadline - Date.now()) }) : null;
    const child = spawn(limits?.command ?? command, limits?.argsFor(command, args) ?? args,
      { detached: true, env: limits?.environment ?? {}, stdio: ['ignore', 'pipe', 'pipe'] });
    let clientSettled = false;
    let cleanup;
    const stopUnit = () => {
      // The runner bounds outward waits and retains this resource promise.
      cleanup ??= limits.waitForEmpty({ clientSettled: () => clientSettled });
      return cleanup;
    };
    const stdout = [];
    let stdoutBytes = 0;
    const file = stdoutPath ? createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 }) : null;
    let failure = null;
    const stop = reason => {
      if (failure) return;
      failure = reason;
      child.stdout.resume();
      if (limits) {
        void stopUnit().catch(reject);
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') failure = error; }
      }
    };
    const abort = () => stop(new Error('Final-tree checker aborted'));
    const timer = setTimeout(() => stop(new Error('Final-tree checker deadline elapsed')), Math.max(1, deadline - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const fileFinished = file ? finished(file).catch(stop) : Promise.resolve();
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (failure) return;
      if (stdoutBytes > maxOutput) stop(new Error('Final-tree checker output limit exceeded'));
      else if (!file) stdout.push(chunk);
      else if (!file.write(chunk)) {
        child.stdout.pause();
        file.once('drain', () => child.stdout.resume());
      }
    });
    let stderr = '';
    let stderrTruncated = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length + chunk.length > diagnosticLimit) stderrTruncated = true;
      if (stderr.length < diagnosticLimit) stderr += chunk.slice(0, diagnosticLimit - stderr.length);
    });
    child.once('error', error => { failure ??= error; });
    child.once('close', async (code, signalName) => {
      clientSettled = true;
      file?.end();
      await fileFinished;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (limits) {
        try { await stopUnit(); }
        catch (error) { reject(error); return; }
      }
      if (failure) reject(failure);
      else if (signalName) reject(new Error(`Final-tree checker was stopped by ${signalName}`));
      else resolve({ code, stdoutBytes, stderr, stderrTruncated, output: file ? null : Buffer.concat(stdout) });
    });
  });
}

function validModule(name) {
  return /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(name ?? '');
}

function validPath(path) {
  return typeof path === 'string' && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

function pinnedPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Verifier requires absolute trusted paths');
  return path;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function materialize(directory, files, budget) {
  assertWithinDeadline(budget);
  let bytes = 0;
  const entries = Object.entries(files);
  if (entries.length > 10_000) throw new Error('Final tree exceeds file-count limit');
  for (const [path, content] of entries) {
    assertWithinDeadline(budget);
    if (!validPath(path) || (!Buffer.isBuffer(content) && typeof content !== 'string')) {
      throw new Error('Final-tree inputs must be regular files');
    }
    bytes += Buffer.byteLength(content);
    if (bytes > inputLimit) throw new Error('Final tree exceeds input size limit');
    const segments = path.split('/');
    await mkdir(join(directory, ...segments.slice(0, -1)), { recursive: true });
    assertWithinDeadline(budget);
    await writeFile(join(directory, path), content, { flag: 'wx', signal: budget.signal });
  }
}

export class LeanFinalTreeVerifier {
  constructor({
    identity, leanRoot, libraryRoots = [], comparatorLibraryRoots, exporterPath, targetPath,
    declarationName, fixtureSource, fixtureSha256, localModules = [], timeoutMs = 120_000, allowUnboundedDiagnostics = false, bubblewrap = '/usr/bin/bwrap',
  }) {
    if (!identity || !['checker_ref', 'checker_version', 'environment_ref'].every(key => typeof identity[key] === 'string' && identity[key])) {
      throw new TypeError('Final-tree verifier requires a fixed checker identity');
    }
    if (!validPath(targetPath) || !targetPath.endsWith('.lean') || !validModule(declarationName)) {
      throw new TypeError('Final-tree verifier requires a fixed Lean source path and theorem name');
    }
    if ((!Buffer.isBuffer(fixtureSource) && typeof fixtureSource !== 'string') || digest(fixtureSource) !== fixtureSha256) {
      throw new TypeError('Final-tree verifier source differs from the locked fixture hash');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new TypeError('Invalid verifier timeout');
    this.identity = Object.freeze({ ...identity });
    this.leanRoot = pinnedPath(leanRoot);
    this.libraryRoots = Object.freeze(libraryRoots.map(pinnedPath));
    this.comparatorLibraryRoots = Object.freeze(comparatorLibraryRoots.map(pinnedPath));
    this.exporterPath = pinnedPath(exporterPath);
    this.bubblewrap = pinnedPath(bubblewrap);
    if (!Array.isArray(localModules) || localModules.length > 32 ||
        localModules.some(module => !validModule(module?.name) || !validPath(module?.path) || !module.path.endsWith('.lean') ||
          module.name === 'SwarmEnvCandidate' || module.path === targetPath) ||
        new Set(localModules.map(module => module.name)).size !== localModules.length) {
      throw new TypeError('Invalid trusted local Lean module build order');
    }
    this.localModules = Object.freeze(localModules.map(module => Object.freeze({ ...module })));
    this.targetPath = targetPath;
    this.declarationName = declarationName;
    this.fixtureSource = Buffer.from(fixtureSource);
    this.timeoutMs = timeoutMs;
    this.resourceLimits = allowUnboundedDiagnostics !== true;
  }

  async runSourceDiagnostic(_command, invocation, { timeoutMs, maxOutputBytes }) {
    const [entry, tool, source, ...extra] = invocation;
    if (entry !== 'env' || tool !== 'lean' || extra.length || (!isAbsolute(source ?? '') && source !== '--version')) {
      throw new TypeError('Invalid locked Lean diagnostic invocation');
    }
    const version = source === '--version';
    const args = sandboxArgs(this.leanRoot);
    const trustedLibraries = libraries(this.libraryRoots, 'library', args);
    args.push('--setenv', 'LEAN_PATH', trustedLibraries.join(':'), '--chdir', '/tmp');
    if (!version) args.push('--ro-bind', source, '/input/WorkspaceSource.lean');
    args.push('/toolchain/bin/lean', ...(version ? ['--version'] : ['-j1', '-M4096', '/input/WorkspaceSource.lean']));
    try {
      const result = await execute(this.bubblewrap, args, {
        deadline: Date.now() + Math.min(timeoutMs, this.timeoutMs),
        maxOutput: Math.min(maxOutputBytes, 1_000_000), resourceLimits: this.resourceLimits,
      });
      // bwrap can also return 1 on setup failure. Only Lean diagnostics using
      // the locked source path count as an ordinary source failure.
      const stdout = result.output.toString();
      const stderr = result.stderr;
      if (result.code !== 0 && (version || result.code !== 1 || result.stderrTruncated ||
          resourceDiagnostic.test(`${stdout}\n${stderr}`) || !/^\/input\/WorkspaceSource\.lean:\d+:\d+: error(?:\([^\n]*\))?:/m.test(`${stdout}\n${stderr}`))) {
        return { exit_code: null, error: 'Locked Lean diagnostic process did not complete', checker_started: false };
      }
      return { exit_code: result.code, stdout, stderr, stderr_truncated: result.stderrTruncated, checker_started: true };
    } catch (error) {
      const timedOut = /deadline elapsed/.test(error.message);
      return { exit_code: null, ...(timedOut ? { timed_out: true } : { error: 'Locked Lean diagnostic process did not complete' }),
        checker_started: timedOut };
    }
  }

  // Native oleans, including ones created by arbitrary metaprograms, exist only
  // inside this untrusted namespace. The pipe carries untrusted JSONL.
  async #export(input, { signal, deadline, stdoutPath, localModules = [] }) {
    const args = sandboxArgs(this.leanRoot);
    const trustedLibraries = libraries(this.libraryRoots, 'library', args);
    args.push('--ro-bind', '/usr/bin/dash', '/bin/sh', '--ro-bind', '/usr/bin/mkdir', '/bin/mkdir',
      '--ro-bind', this.exporterPath, '/bin/lean4export',
      '--ro-bind', input, '/input', '--size', '268435456', '--tmpfs', '/output',
      '--setenv', 'LEAN_PATH', ['/output', ...trustedLibraries].join(':'),
      '--chdir', '/input', '/bin/sh', '-eu', '-c',
      'ulimit -c 0\n' +
      'compile() {\n' +
      '  /toolchain/bin/lean --json -j1 -M4096 -R /input -o "$1" "$2" >&2 && return 0\n' +
      '  status=$?; if [ "$status" = 1 ]; then exit 21; fi; exit 23\n' +
      '}\n' +
      'while [ "$1" != "--" ]; do\n' +
      '  output="$1"; source="$2"; shift 2\n' +
      '  /bin/mkdir -p "${output%/*}" || exit 23\n' +
      '  compile "$output" "$source"\n' +
      'done\nshift\n' +
      'compile /output/SwarmEnvCandidate.olean "$1"\n' +
      'shift\nexec /bin/lean4export --ignore-missing SwarmEnvCandidate -- "$@"',
      'swarmenv-export', ...localModules.flatMap(module => [
        `/output/${module.name.replaceAll('.', '/')}.olean`, `/input/${module.path}`,
      ]), '--', `/input/${this.targetPath}`, this.declarationName, ...axioms, ...primitives);
    return execute(this.bubblewrap, args, { signal, deadline, maxOutput: exportLimit, stdoutPath, resourceLimits: this.resourceLimits });
  }

  async check({ files, tree, signal, deadline = Date.now() + this.timeoutMs }) {
    deadline = Math.min(deadline, Date.now() + this.timeoutMs);
    const check_result_id = `treecheck:${randomUUID()}`;
    const result = (verdict, diagnostic) => ({ verdict, check_result_id, diagnostic, checked_tree: tree });
    let directory;
    let timer;
    let budget;
    try {
      assertWithinDeadline({ signal, deadline });
      if (!files || !Object.hasOwn(files, this.targetPath)) return result('FAIL', 'Final tree lacks the locked theorem source path');
      if (this.localModules.some(module => !Object.hasOwn(files, module.path))) {
        return result('FAIL', 'Final tree lacks a configured local Lean module source');
      }
      const elapsed = new AbortController();
      timer = setTimeout(() => elapsed.abort(new Error('Final-tree checker deadline elapsed')), deadline - Date.now());
      budget = { signal: signal ? AbortSignal.any([signal, elapsed.signal]) : elapsed.signal, deadline };
      directory = await mkdtemp(join(tmpdir(), 'swarmenv-tree-check-'));
      const originalDirectory = join(directory, 'original');
      const candidateDirectory = join(directory, 'candidate');
      await materialize(originalDirectory, { [this.targetPath]: this.fixtureSource }, budget);
      await materialize(candidateDirectory, files, budget);
      const originalExport = join(directory, 'original.jsonl');
      const candidateExport = join(directory, 'candidate.jsonl');
      const original = await this.#export(originalDirectory, { ...budget, stdoutPath: originalExport });
      if (original.code !== 0 || !original.stdoutBytes) return result('ERROR', 'Locked Lean fixture could not be exported');
      const candidate = await this.#export(candidateDirectory, { ...budget, stdoutPath: candidateExport, localModules: this.localModules });
      if (candidate.code !== 0 || !candidate.stdoutBytes) {
        if (candidate.code === sourceFailureStatus && !candidate.stderrTruncated && isSourceDiagnostic(candidate.stderr)) return result('FAIL', 'Final-tree theorem source did not compile with the locked Lean dependencies');
        return result('ERROR', 'Final-tree proof export did not complete');
      }
      // Only the trusted parser/kernel and inert exports enter this namespace.
      const args = sandboxArgs(this.leanRoot);
      const trustedLibraries = libraries(this.comparatorLibraryRoots, 'comparator', args);
      args.push('--ro-bind', verifierSource, '/verifier/Verify.lean',
        '--ro-bind', originalExport, '/verifier/original.jsonl',
        '--ro-bind', candidateExport, '/verifier/candidate.jsonl',
        '--setenv', 'LEAN_PATH', trustedLibraries.join(':'), '--chdir', '/verifier',
        '/toolchain/bin/lean', '-j1', '-M4096', '--run', '/verifier/Verify.lean',
        this.declarationName, '/verifier/original.jsonl', '/verifier/candidate.jsonl');
      const validation = await execute(this.bubblewrap, args, { ...budget, maxOutput: diagnosticLimit, resourceLimits: this.resourceLimits });
      if (validation.code === 0 && validation.output.toString().trim() === 'SWARMENV_FINAL_TREE_VERIFIED') {
        return result('PASS', null);
      }
      if (validation.code === 42) return result('FAIL', 'Final-tree kernel replay, fixed theorem, or transitive axiom policy rejected the proof');
      return result('ERROR', 'Final-tree verifier did not complete');
    } catch (error) {
      const reason = budget?.signal.aborted ? budget.signal.reason : error;
      return result('ERROR', (reason?.message ?? 'Final-tree verification failed').slice(0, 256));
    } finally {
      clearTimeout(timer);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

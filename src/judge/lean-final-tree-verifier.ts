import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LeanModuleChecker } from './lean-module-checker.js';
import { leanSourcePolicyFinding } from './lean-source-policy.js';
import { checkerResourceProfile, createCheckerProcessLimits } from './checker-process-limits.js';

const verifierSource = fileURLToPath(new URL('./final-tree-proof.lean', import.meta.url));
// Mathlib theorem statements can export hundreds of MiB of transitive declarations.
const exportLimit = 768 * 1024 * 1024;
const inputLimit = 128 * 1024 * 1024;
const diagnosticLimit = 8192;
const sourceFailureStatus = 21;
// Match runtime failure headers, never arbitrary words in source names or goals.
// Lean limits identify source work whose checking remains unassessed.
const infrastructureDiagnostic = /^(?:out of memory\b|excessive memory consumption\b|memory (?:consumption exceeded|limit exceeded|exhausted)\b|cannot allocate memory\b|stack overflow\b|\(kernel\) excessive memory consumption detected\b|resource temporarily unavailable\b|killed\s*$)/i;

const nestedTacticHeader = /^Tactic `[^`\n]+` failed with a nested error:$/;

function leanFailureCode(message: any, kind: any = '') {
  // Lean's structured tag survives tactic wrappers. Plain diagnostic output
  // omits that tag, so unwrap only the known leading tactic-error envelope.
  if (/^(?:nested\.)*runtime\.maxRecDepth$/.test(kind)) return 'lean_resource_limit';
  const lines = message.split('\n', 10);
  let index = 0;
  while (index < 8 && nestedTacticHeader.test(lines[index]?.trim())) index++;
  message = lines[index]?.trimStart() ?? '';
  if (/^(?:\(deterministic\) timeout\b|\(kernel\) deterministic timeout\b|maximum (?:number of heartbeats|recursion depth)\b)/.test(message)) return 'lean_resource_limit';
  if (/^(?:PANIC(?: at)?[:! ]|\(kernel\) panic\b)/i.test(message)) return 'lean_panic';
  return null;
}

function sourceDiagnostics(stderr: any) {
  const errors = stderr.split('\n').flatMap((line: any) => {
    try {
      const diagnostic = JSON.parse(line);
      return diagnostic?.severity === 'error' ? [diagnostic] : [];
    } catch { return []; }
  });
  if (!errors.length) return null;
  const excerpt = (entry: any) => {
    const location = typeof entry.fileName === 'string' && Number.isInteger(entry.pos?.line) && Number.isInteger(entry.pos?.column)
      ? `${entry.fileName}:${entry.pos.line}:${entry.pos.column}: ` : '';
    return `${location}${entry.data}`.slice(0, 320);
  };
  const runtime = errors.find(({ data }: any) => typeof data === 'string' && infrastructureDiagnostic.test(data));
  if (runtime) return { diagnostic_code: /memory/i.test(runtime.data) ? 'checker_memory_limit' : 'checker_runtime_failure', diagnostic: excerpt(runtime) };
  const limited = errors.find(({ data, kind }: any) => typeof data === 'string' && leanFailureCode(data, kind));
  return limited ? { diagnostic_code: leanFailureCode(limited.data, limited.kind), diagnostic: excerpt(limited) } : { diagnostic: errors.slice(0, 8).map(excerpt).join('\n') };
}

function leanFailureResult(failure: any) {
  return { diagnostic_code: failure.diagnostic_code, checker_process_status: 'completed', retryable: false };
}
const primitives = [
  'Nat.add', 'Nat.sub', 'Nat.mul', 'Nat.pow', 'Nat.gcd', 'Nat.div', 'Nat.mod', 'Nat.beq', 'Nat.ble',
  'Nat.land', 'Nat.lor', 'Nat.xor', 'Nat.shiftLeft', 'Nat.shiftRight', 'String.ofList', 'Char.ofNat',
  'List', 'eagerReduce',
];
const axioms = ['propext', 'Quot.sound', 'Classical.choice'];

function findProjectSourcePolicyViolation(files: any) {
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.endsWith('.lean')) continue;
    const finding = leanSourcePolicyFinding(bytes);
    if (finding) return `${path}:${finding.line}:${finding.column}: ${finding.word}`;
  }
  return null;
}

function sandboxArgs(leanRoot: any) {
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

function libraries(roots: any, prefix: any, args: any) {
  return roots.map((root: any, index: any) => {
    const destination = `/${prefix}/${index}`;
    args.push('--ro-bind', root, destination);
    return destination;
  });
}

function assertWithinDeadline({ signal, deadline }: any) {
  if (signal?.aborted) throw new Error('Final-tree checker aborted');
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('Final-tree checker deadline elapsed');
}

async function execute(command: any, args: any, { signal, deadline, maxOutput, stdoutPath, resourceLimits, resources, onStderr }: any) {
  assertWithinDeadline({ signal, deadline });
  return new Promise<any>((resolve: any, reject: any) => {
    const limits: any = resourceLimits ? createCheckerProcessLimits({ runtimeMs: Math.max(1, deadline - Date.now()), resources }) : null;
    const child = spawn(limits?.command ?? command, limits?.argsFor(command, args) ?? args,
      { detached: true, env: limits?.environment ?? {}, stdio: ['ignore', 'pipe', 'pipe'] });
    let clientSettled = false;
    let cleanup;
    const stopUnit = () => {
      // The runner bounds outward waits and retains this resource promise.
      cleanup ??= limits.waitForEmpty({ clientSettled: () => clientSettled });
      return cleanup;
    };
    const stdout: any[] = [];
    let stdoutBytes = 0;
    const file = stdoutPath ? createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 }) : null;
    let failure: any = null;
    const stop = (reason: any) => {
      if (failure) return;
      failure = reason;
      child.stdout.resume();
      if (limits) {
        void stopUnit().catch(reject);
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error: any) { if (error.code !== 'ESRCH') failure = error; }
      }
    };
    const abort = () => stop(new Error('Final-tree checker aborted'));
    const timer = setTimeout(() => stop(new Error('Final-tree checker deadline elapsed')), Math.max(1, deadline - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const fileFinished = file ? finished(file).catch(stop) : Promise.resolve();
    child.stdout.on('data', (chunk: any) => {
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
    child.stderr.on('data', (chunk: any) => {
      onStderr?.(chunk);
      if (stderr.length + chunk.length > diagnosticLimit) stderrTruncated = true;
      if (stderr.length < diagnosticLimit) stderr += chunk.slice(0, diagnosticLimit - stderr.length);
    });
    child.once('error', (error: any) => { failure ??= error; });
    child.once('close', async (code: any, signalName: any) => {
      clientSettled = true;
      file?.end();
      await fileFinished;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (limits) {
        try { await stopUnit(); }
        catch (error: any) { reject(error); return; }
      }
      if (failure) reject(failure);
      else if (signalName) reject(new Error(`Final-tree checker was stopped by ${signalName}`));
      else resolve({ code, stdoutBytes, stderr, stderrTruncated, output: file ? null : Buffer.concat(stdout) });
    });
  });
}

function validModule(name: any) {
  return /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(name ?? '');
}

function validPath(path: any) {
  return typeof path === 'string' && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every((part: any) => part && part !== '.' && part !== '..');
}

function pinnedPath(path: any) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Verifier requires absolute trusted paths');
  return path;
}

function digest(bytes: any) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function materialize(directory: any, files: any, budget: any) {
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

function projectSources(files: any, targetPath: any, reservedModules: any) {
  if (!files || typeof files !== 'object' || !Object.hasOwn(files, targetPath)) {
    throw new TypeError('Workspace project lacks the locked theorem source path');
  }
  const root = posix.dirname(targetPath);
  const prefix = root === '.' ? '' : `${root}/`;
  const sources: any[] = [];
  for (const path of Object.keys(files).sort()) {
    // Candidate Lake configuration is inert. Judge provides its own project.
    if (!path.endsWith('.lean') || path === 'lakefile.lean') continue;
    const module = path.slice(prefix.length, -5).replaceAll('/', '.');
    if (!validPath(path) || !path.startsWith(prefix) || !validModule(module) ||
        module.replaceAll('.', '/') !== path.slice(prefix.length, -5)) {
      throw new TypeError(`Lean source is outside the configured module layout: ${path.slice(0, 160)}`);
    }
    if (reservedModules.has(module.split('.')[0])) throw new TypeError(`Lean source shadows a trusted module: ${path.slice(0, 160)}`);
    sources.push({ path, module, sourcePath: `source/${path.slice(prefix.length)}` });
  }
  if (!sources.some((source: any) => source.path === targetPath)) throw new TypeError('Locked theorem source is not a project module');
  return sources;
}

function projectInput(files: any, sources: any, libraryCount: any, leanMemoryArgument: any) {
  const inputs = Object.fromEntries(sources.map(({ path, sourcePath }: any) => [sourcePath, files[path]]));
  const dependencies = Array.from({ length: libraryCount }, (_: any, i: any) => `dependency${i}`);
  const manifest = (name: any, packages: any) => JSON.stringify({ version: '1.2.0', packagesDir: '.lake/packages',
    name, lakeDir: '.lake', fixedToolchain: true, packages });
  const packages = dependencies.map((name: any) => ({ type: 'path', scope: '', name,
    manifestFile: 'lake-manifest.json', inherited: false, dir: `dependencies/${name}`, configFile: 'lakefile.toml' }));
  inputs['lake-manifest.json'] = manifest('swarmenv_project', packages);
  const roots = [...new Set(sources.map(({ module }: any) => module.split('.')[0]))];
  inputs['lakefile.toml'] = [
    'name = "swarmenv_project"', 'fixedToolchain = true', 'defaultTargets = ["WorkspaceProof"]',
    'srcDir = "source"', '[[lean_lib]]', 'name = "WorkspaceProof"',
    `roots = ${JSON.stringify(roots)}`, `globs = ${JSON.stringify(sources.map(({ module }: any) => module))}`,
    `moreLeanArgs = ${JSON.stringify(['-j1', leanMemoryArgument])}`,
    ...dependencies.flatMap((name: any) => ['[[require]]', `name = "${name}"`, `path = "dependencies/${name}"`]),
  ].join('\n');
  for (const name of dependencies) {
    inputs[`dependencies/${name}/lakefile.toml`] = `name = "${name}"\nfixedToolchain = true\n`;
    inputs[`dependencies/${name}/lake-manifest.json`] = manifest(name, []);
  }
  return inputs;
}

function collectProjectDiagnostics(sources: any) {
  const paths = new Map<any, any>(sources.map(({ path, sourcePath }: any) => [sourcePath, path]));
  const findings: Record<string, string[]> = { warning: [], error: [] };
  let partialLine = '';
  let resourceFailure = false;
  let leanFailure: any = null;
  let infrastructureFailure: any = null;
  let nestedError: any = null;
  function finishLine(line: any) {
    if (nestedError) {
      const diagnosticCode = leanFailureCode(line.trimStart());
      if (diagnosticCode) leanFailure ??= { diagnostic_code: diagnosticCode,
        diagnostic: `${nestedError.location}: ${line.trimStart()}`.slice(0, 320) };
      if (nestedTacticHeader.test(line.trim()) && nestedError.depth < 8) nestedError.depth++;
      else nestedError = null;
    }
    // Lake reports worker exit codes even when its log level hides raw stderr.
    const workerExit = /^error: Lean exited with code (\d+)\s*$/.exec(line);
    if (workerExit && Number(workerExit[1]) !== 1) resourceFailure = true;
    const header = /^(?:warning|error): (?:(?:\/project\/)?source\/[^:]+:\d+:\d+:\s*)?(.*)$/.exec(line);
    if (header && infrastructureDiagnostic.test(header[1])) {
      resourceFailure = true;
      infrastructureFailure = { diagnostic_code: /memory/i.test(header[1]) ? 'checker_memory_limit' : 'checker_runtime_failure', diagnostic: line.slice(0, 320) };
    }
    if (findings.error.length < 8 && /^error: (?:build )?cycle detected:/.test(line)) {
      findings.error.push('Lean project imports contain a cycle');
      return;
    }
    const match = /^(warning|error): (?:\/project\/)?(source\/[^:]+):(\d+:\d+):(.*)$/.exec(line);
    if (!match || !paths.has(match[2])) return;
    if (infrastructureDiagnostic.test(match[4].trimStart())) infrastructureFailure.diagnostic = `${paths.get(match[2])}:${match[3]}:${match[4]}`.slice(0, 320);
    const diagnosticCode = match[1] === 'error' ? leanFailureCode(match[4].trimStart()) : null;
    if (diagnosticCode) leanFailure ??= { diagnostic_code: diagnosticCode, diagnostic: `${paths.get(match[2])}:${match[3]}:${match[4]}`.slice(0, 320) };
    if (match[1] === 'error' && nestedTacticHeader.test(match[4].trim())) {
      nestedError = { location: `${paths.get(match[2])}:${match[3]}`, depth: 1 };
    }
    if (findings[match[1]].length >= 8) return;
    findings[match[1]].push(`${paths.get(match[2])}:${match[3]}:${match[4]}`.slice(0, 320));
  }
  return {
    write(chunk: any) {
      const segments = chunk.split('\n');
      for (let i = 0; i < segments.length; i++) {
        partialLine += segments[i].slice(0, diagnosticLimit - partialLine.length);
        if (i === segments.length - 1) break;
        finishLine(partialLine);
        partialLine = '';
      }
    },
    finish() {
      finishLine(partialLine);
      return { ...findings, resourceFailure, leanFailure, infrastructureFailure };
    },
  };
}

export class LeanFinalTreeVerifier {
  declare resources: any;
  declare projectJobs: any;
  declare identity: any;
  declare leanRoot: any;
  declare libraryRoots: any;
  declare comparatorLibraryRoots: any;
  declare exporterPath: any;
  declare bubblewrap: any;
  declare localModules: any;
  declare projectChecks: any;
  declare requireCompleteProject: any;
  declare targetPath: any;
  declare declarationName: any;
  declare fixtureSource: any;
  declare timeoutMs: any;
  declare resourceLimits: any;
  declare leanMemoryArgument: any;
  declare moduleChecker: any;

  constructor({
    identity, leanRoot, libraryRoots = [], comparatorLibraryRoots, exporterPath, targetPath,
    declarationName, fixtureSource, fixtureSha256, localModules = [], projectChecks = false, projectJobs = 1, resources, requireCompleteProject = false, timeoutMs = 120_000, moduleCacheBytes = 128 * 1024 ** 2, allowUnboundedDiagnostics = false, bubblewrap = '/usr/bin/bwrap',
  }: any) {
    if (!identity || !['checker_ref', 'checker_version', 'environment_ref'].every((key: any) => typeof identity[key] === 'string' && identity[key])) {
      throw new TypeError('Final-tree verifier requires a fixed checker identity');
    }
    if (!validPath(targetPath) || !targetPath.endsWith('.lean') || !validModule(declarationName)) {
      throw new TypeError('Final-tree verifier requires a fixed Lean source path and theorem name');
    }
    if ((!Buffer.isBuffer(fixtureSource) && typeof fixtureSource !== 'string') || digest(fixtureSource) !== fixtureSha256) {
      throw new TypeError('Final-tree verifier source differs from the locked fixture hash');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new TypeError('Invalid verifier timeout');
    if (!Number.isSafeInteger(projectJobs) || projectJobs < 1 || projectJobs > 256) throw new TypeError('Invalid project build concurrency');
    checkerResourceProfile(resources);
    this.resources = resources === undefined ? undefined : Object.freeze({ ...resources });
    this.projectJobs = projectJobs;
    this.identity = Object.freeze({ ...identity });
    this.leanRoot = pinnedPath(leanRoot);
    this.libraryRoots = Object.freeze(libraryRoots.map(pinnedPath));
    this.comparatorLibraryRoots = Object.freeze(comparatorLibraryRoots.map(pinnedPath));
    this.exporterPath = pinnedPath(exporterPath);
    this.bubblewrap = pinnedPath(bubblewrap);
    if (!Array.isArray(localModules) || localModules.length > 32 ||
        localModules.some((module: any) => !validModule(module?.name) || !validPath(module?.path) || !module.path.endsWith('.lean') ||
          module.name === 'SwarmEnvCandidate' || module.path === targetPath) ||
        new Set(localModules.map((module: any) => module.name)).size !== localModules.length) {
      throw new TypeError('Invalid trusted local Lean module build order');
    }
    this.localModules = Object.freeze(localModules.map((module: any) => Object.freeze({ ...module })));
    if (typeof projectChecks !== 'boolean' || (projectChecks && localModules.length)) {
      throw new TypeError('Project checks require automatic module discovery without a manual build order');
    }
    this.projectChecks = projectChecks;
    if (typeof requireCompleteProject !== 'boolean') throw new TypeError('Invalid complete project policy');
    this.requireCompleteProject = requireCompleteProject;
    this.targetPath = targetPath;
    this.declarationName = declarationName;
    this.fixtureSource = Buffer.from(fixtureSource);
    this.timeoutMs = timeoutMs;
    this.resourceLimits = allowUnboundedDiagnostics !== true;
    // The systemd cgroup remains the production memory authority. Lean's
    // separate 4 GiB accounting rejects even a trivial full-Mathlib import
    // below that physical limit. Keep its guard only for opt-in diagnostics
    // that do not use the production cgroup wrapper.
    this.leanMemoryArgument = this.resourceLimits ? '-M0' : '-M4096';
    const libraryPaths = libraryRoots.map((_: any, index: any) => `/library/${index}`);
    this.moduleChecker = new LeanModuleChecker({ cacheBytes: moduleCacheBytes,
      environmentKey: JSON.stringify([identity, leanRoot, libraryRoots, this.leanMemoryArgument, resources, projectJobs]),
      sandbox: () => { const args = sandboxArgs(this.leanRoot); libraries(this.libraryRoots, 'library', args); return args; },
      execute: (args: any, options: any) => execute(this.bubblewrap, args, { ...options, resourceLimits: this.resourceLimits, resources: this.resources }),
      classify: (stderr: any) => sourceDiagnostics(stderr.replaceAll('/input/source/', posix.dirname(this.targetPath) === '.' ? '' : `${posix.dirname(this.targetPath)}/`)),
    });
    this.moduleChecker.libraryPaths = libraryPaths;
    this.moduleChecker.memoryArgument = this.leanMemoryArgument;
  }

  async #projectSources(files: any) {
    // Core names in the pinned toolchain plus namespaces from mounted packages.
    const reserved = new Set(['Init', 'Lean', 'Std', 'Lake', 'LakeMain', 'LeanIR', 'LeanChecker', 'Leanc', 'Mathlib']);
    const namespaces = await Promise.all(this.libraryRoots.map((root: any) => readdir(root, { withFileTypes: true })));
    for (const entries of namespaces) {
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) reserved.add(entry.name);
        if (entry.name.endsWith('.olean')) reserved.add(entry.name.slice(0, -6));
      }
    }
    return projectSources(files, this.targetPath, reserved);
  }

  async #materializeProject(directory: any, files: any, sources: any, budget: any) {
    await materialize(directory, projectInput(files, sources, this.libraryRoots.length, this.leanMemoryArgument), budget);
    await mkdir(join(directory, '.lake'));
    for (let i = 0; i < this.libraryRoots.length; i++) {
      assertWithinDeadline(budget);
      await mkdir(join(directory, 'dependencies', `dependency${i}`, '.lake/build/lib/lean'), { recursive: true });
    }
  }

  async #buildProject(input: any, { signal, deadline, stdoutPath, targetModule, sources, startProcess = (launch: any) => launch() }: any) {
    const args = sandboxArgs(this.leanRoot);
    const dependencyPaths = this.libraryRoots.map((root: any, index: any) => {
      const destination = `/project/dependencies/dependency${index}/.lake/build/lib/lean`;
      return [root, destination];
    });
    args.push('--ro-bind', input, '/project', '--size', '268435456', '--tmpfs', '/project/.lake',
      ...dependencyPaths.flatMap(([root, destination]: any) => ['--ro-bind', root, destination]),
      '--ro-bind', '/usr/bin/dash', '/bin/sh', '--setenv', 'LEAN_NUM_THREADS', String(this.projectJobs), '--chdir', '/project');
    if (targetModule) args.push('--ro-bind', this.exporterPath, '/bin/lean4export', '--setenv', 'LEAN_PATH',
      ['/project/.lake/build/lib/lean', ...dependencyPaths.map(([, dest]: any) => dest)].join(':'));
    args.push('/bin/sh', '-eu', '-c',
      'ulimit -c 0\n' +
      '/toolchain/bin/lake --no-cache --no-ansi --log-level=warning build >&2 || { status=$?; if [ "$status" = 1 ]; then exit 21; fi; exit 23; }\n' +
      'if [ "$#" != 0 ]; then exec /bin/lean4export --ignore-missing "$@"; fi', 'swarmenv-project');
    if (targetModule) args.push(targetModule, '--', this.declarationName, ...axioms, ...primitives);
    const diagnostics = collectProjectDiagnostics(sources);
    const built = await startProcess(() => execute(this.bubblewrap, args, { signal, deadline,
      maxOutput: targetModule ? exportLimit : diagnosticLimit, stdoutPath, resourceLimits: this.resourceLimits, resources: this.resources,
      onStderr: diagnostics.write }));
    return { ...built, diagnostics: diagnostics.finish() };
  }

  async checkProject({ files, tree, path, checkMode = 'lean-project', missionId, signal, deadline = Date.now() + this.timeoutMs, startProcess }: any) {
    if (!this.projectChecks) return { verdict: 'ERROR', diagnostic: 'Workspace project checking is not configured', checked_tree: tree, checked_paths: [] };
    deadline = Math.min(deadline, Date.now() + this.timeoutMs);
    const budget = { signal, deadline };
    const result = (verdict: any, diagnostic: any, extra: any = {}) => ({ verdict, diagnostic, checked_tree: tree, checked_paths: [], ...extra });
    let directory;
    try {
      assertWithinDeadline(budget);
      let sources;
      try { sources = await this.#projectSources(files); }
      catch (error: any) { if (error instanceof TypeError) return result('FAIL', error.message); throw error; }
      if (checkMode === 'lean-module') return await this.moduleChecker.check({ files, sources, path, missionId, tree, budget, startProcess });
      directory = await mkdtemp(join(tmpdir(), 'swarmenv-project-check-'));
      await this.#materializeProject(directory, files, sources, budget);
      const built = await this.#buildProject(directory, { ...budget, sources, startProcess });
      const findings = built.diagnostics;
      if (built.code === 0) return result('PASS', null, { checked_paths: sources.map(({ path }: any) => path), warnings: findings.warning });
      if (built.code === sourceFailureStatus && findings.infrastructureFailure) return result('ERROR', findings.infrastructureFailure.diagnostic, { diagnostic_code: findings.infrastructureFailure.diagnostic_code, retryable: false });
      if (built.code === sourceFailureStatus && !findings.resourceFailure && findings.leanFailure) {
        return result('ERROR', findings.leanFailure.diagnostic, leanFailureResult(findings.leanFailure));
      }
      if (built.code === sourceFailureStatus && !findings.resourceFailure && findings.error.length) {
        return result('FAIL', findings.error.join('\n'), { warnings: findings.warning });
      }
      return result('ERROR', 'Locked Lake project build did not complete');
    } catch (error: any) {
      // The lifecycle guard at process start returns its typed rejection to Judge.
      if (error.code && ['NOT_ALLOWED', 'FENCED', 'STALE_VERSION', 'SERVICE_NOT_READY'].includes(error.code)) throw error;
      if (error instanceof TypeError) return result('FAIL', error.message);
      const timedOut = /deadline elapsed/.test(error.message);
      return result('ERROR', timedOut ? 'Lake project check deadline elapsed' : 'Locked Lake project build did not complete', { timed_out: timedOut });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  async runSourceDiagnostic(_command: any, invocation: any, { timeoutMs, maxOutputBytes }: any) {
    const [entry, tool, source, ...extra] = invocation;
    if (entry !== 'env' || tool !== 'lean' || extra.length || (!isAbsolute(source ?? '') && source !== '--version')) {
      throw new TypeError('Invalid locked Lean diagnostic invocation');
    }
    const version = source === '--version';
    const args = sandboxArgs(this.leanRoot);
    const trustedLibraries = libraries(this.libraryRoots, 'library', args);
    args.push('--setenv', 'LEAN_PATH', trustedLibraries.join(':'), '--chdir', '/tmp');
    if (!version) args.push('--ro-bind', source, '/input/WorkspaceSource.lean');
    args.push('/toolchain/bin/lean', ...(version ? ['--version'] : ['-j1', this.leanMemoryArgument, '/input/WorkspaceSource.lean']));
    try {
      const result = await execute(this.bubblewrap, args, {
        deadline: Date.now() + Math.min(timeoutMs, this.timeoutMs),
        maxOutput: Math.min(maxOutputBytes, 1_000_000), resourceLimits: this.resourceLimits, resources: this.resources,
      });
      // bwrap can also return 1 on setup failure. Only Lean diagnostics using
      // the locked source path count as an ordinary source failure.
      const stdout: any = result.output.toString();
      const stderr = result.stderr;
      const output = `${stdout}\n${stderr}`;
      const sourceHeaders = [...output.matchAll(/^\/input\/WorkspaceSource\.lean:\d+:\d+: error(?:\([^\n]*\))?:[^\S\n]*(.*)$/gm)];
      if (result.code !== 0 && (version || result.code !== 1 || result.stderrTruncated ||
          sourceHeaders.length === 0)) {
        return { exit_code: null, error: 'Locked Lean diagnostic process did not complete', checker_started: false };
      }
      const failure: any = sourceHeaders.map((header: any) => {
        const message = header[1];
        const nested = nestedTacticHeader.test(message.trim())
          ? message + output.slice(header.index + header[0].length, header.index + header[0].length + diagnosticLimit)
          : message;
        return leanFailureCode(nested) ?? (infrastructureDiagnostic.test(message) ? (/memory/i.test(message) ? 'checker_memory_limit' : 'checker_runtime_failure') : null);
      }).find(Boolean);
      return { exit_code: result.code, stdout, stderr, stderr_truncated: result.stderrTruncated, checker_started: true,
        ...(failure ? { diagnostic_code: failure, checker_process_status: 'completed', retryable: false } : {}) };
    } catch (error: any) {
      const timedOut = /deadline elapsed/.test(error.message);
      return { exit_code: null, ...(timedOut ? { timed_out: true } : { error: 'Locked Lean diagnostic process did not complete' }),
        checker_started: timedOut };
    }
  }

  /** Verify that the pinned exporter can read an olean produced by this toolchain. */
  async verifyExportCompatibility() {
    const directory = await mkdtemp(join(tmpdir(), 'swarmenv-export-preflight-'));
    const path = 'Compatibility.lean';
    const name = 'swarmenv_export_preflight';
    const deadline = Date.now() + Math.min(this.timeoutMs, 30_000);
    try {
      await writeFile(join(directory, path), `theorem ${name} : True := True.intro\n`);
      const result = await this.#export(directory, { deadline, path, declarations: [name], strict: true, maxOutput: 4 * 1024 * 1024 });
      if (result.code !== 0 || !result.stdoutBytes) throw new Error('Lean/exporter compatibility preflight failed to export the compiled declaration');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  // Native oleans, including ones created by arbitrary metaprograms, exist only
  // inside this untrusted namespace. The pipe carries untrusted JSONL.
  async #export(input: any, { signal, deadline, stdoutPath, localModules = [], path = this.targetPath,
    declarations = [this.declarationName, ...axioms, ...primitives], strict = false, maxOutput = exportLimit }: any) {
    const args = sandboxArgs(this.leanRoot);
    const trustedLibraries = libraries(this.libraryRoots, 'library', args);
    args.push('--ro-bind', '/usr/bin/dash', '/bin/sh', '--ro-bind', '/usr/bin/mkdir', '/bin/mkdir',
      '--ro-bind', this.exporterPath, '/bin/lean4export',
      '--ro-bind', input, '/input', '--size', '268435456', '--tmpfs', '/output',
      '--setenv', 'LEAN_PATH', ['/output', ...trustedLibraries].join(':'),
      '--chdir', '/input', '/bin/sh', '-eu', '-c',
      'ulimit -c 0\n' +
      'compile() {\n' +
      `  /toolchain/bin/lean --json -j1 ${this.leanMemoryArgument} -R /input -o "$1" "$2" >&2 && return 0\n` +
      '  status=$?; if [ "$status" = 1 ]; then exit 21; fi; exit 23\n' +
      '}\n' +
      'while [ "$1" != "--" ]; do\n' +
      '  output="$1"; source="$2"; shift 2\n' +
      '  /bin/mkdir -p "${output%/*}" || exit 23\n' +
      '  compile "$output" "$source"\n' +
      'done\nshift\n' +
      'compile /output/SwarmEnvCandidate.olean "$1"\n' +
      `shift\nexec /bin/lean4export ${strict ? '' : '--ignore-missing '}SwarmEnvCandidate -- "$@"`,
      'swarmenv-export', ...localModules.flatMap((module: any) => [
        `/output/${module.name.replaceAll('.', '/')}.olean`, `/input/${module.path}`,
      ]), '--', `/input/${path}`, ...declarations);
    return execute(this.bubblewrap, args, { signal, deadline, maxOutput, stdoutPath, resourceLimits: this.resourceLimits, resources: this.resources });
  }

  async check({ files, tree, signal, deadline = Date.now() + this.timeoutMs }: any) {
    deadline = Math.min(deadline, Date.now() + this.timeoutMs);
    const check_result_id = `treecheck:${randomUUID()}`;
    const result = (verdict: any, diagnostic: any, extra: any = {}) => ({ verdict, check_result_id, diagnostic, checked_tree: tree, ...extra });
    let directory;
    let timer;
    let budget;
    try {
      assertWithinDeadline({ signal, deadline });
      if (!files || !Object.hasOwn(files, this.targetPath)) return result('FAIL', 'Final tree lacks the locked theorem source path');
      const incomplete = this.requireCompleteProject && findProjectSourcePolicyViolation(files);
      if (incomplete) {
        return result('FAIL', `${incomplete} — final project contains an incomplete proof or an added axiom`);
      }
      if (this.localModules.some((module: any) => !Object.hasOwn(files, module.path))) {
        return result('FAIL', 'Final tree lacks a configured local Lean module source');
      }
      const elapsed = new AbortController();
      timer = setTimeout(() => elapsed.abort(new Error('Final-tree checker deadline elapsed')), deadline - Date.now());
      budget = { signal: signal ? AbortSignal.any([signal, elapsed.signal]) : elapsed.signal, deadline };
      directory = await mkdtemp(join(tmpdir(), 'swarmenv-tree-check-'));
      const originalDirectory = join(directory, 'original');
      const candidateDirectory = join(directory, 'candidate');
      await materialize(originalDirectory, { [this.targetPath]: this.fixtureSource }, budget);
      let sources;
      if (this.projectChecks) {
        try { sources = await this.#projectSources(files); }
        catch (error: any) { if (error instanceof TypeError) return result('FAIL', error.message); throw error; }
        await this.#materializeProject(candidateDirectory, files, sources, budget);
      } else await materialize(candidateDirectory, files, budget);
      const originalExport = join(directory, 'original.jsonl');
      const candidateExport = join(directory, 'candidate.jsonl');
      const original = await this.#export(originalDirectory, { ...budget, stdoutPath: originalExport });
      if (original.code !== 0 || !original.stdoutBytes) return result('ERROR', 'Locked Lean fixture could not be exported');
      const candidate = sources
        ? await this.#buildProject(candidateDirectory, { ...budget, sources, stdoutPath: candidateExport,
          targetModule: sources.find(({ path }: any) => path === this.targetPath).module })
        : await this.#export(candidateDirectory, { ...budget, stdoutPath: candidateExport, localModules: this.localModules });
      if (candidate.code !== 0 || !candidate.stdoutBytes) {
        if (candidate.code === sourceFailureStatus) {
          if (sources) {
            const { error, resourceFailure, leanFailure, infrastructureFailure } = candidate.diagnostics;
            if (infrastructureFailure) return result('ERROR', infrastructureFailure.diagnostic, { diagnostic_code: infrastructureFailure.diagnostic_code, retryable: false });
            if (!resourceFailure && leanFailure) return result('ERROR', leanFailure.diagnostic, leanFailureResult(leanFailure));
            if (!resourceFailure && error.length) return result('FAIL', error.join('\n'));
          } else if (!candidate.stderrTruncated) {
            const diagnostics = sourceDiagnostics(candidate.stderr);
            if (diagnostics?.diagnostic_code) return result('ERROR', diagnostics.diagnostic, leanFailureResult(diagnostics));
            if (diagnostics) return result('FAIL', 'Final-tree theorem source did not compile with the locked Lean dependencies');
          }
        }
        return result('ERROR', 'Final-tree proof export did not complete');
      }
      // Only the trusted parser/kernel and inert exports enter this namespace.
      const args = sandboxArgs(this.leanRoot);
      const trustedLibraries = libraries(this.comparatorLibraryRoots, 'comparator', args);
      args.push('--ro-bind', verifierSource, '/verifier/Verify.lean',
        '--ro-bind', originalExport, '/verifier/original.jsonl',
        '--ro-bind', candidateExport, '/verifier/candidate.jsonl',
        '--setenv', 'LEAN_PATH', trustedLibraries.join(':'), '--chdir', '/verifier',
        '/toolchain/bin/lean', '-j1', this.leanMemoryArgument, '--run', '/verifier/Verify.lean',
        this.declarationName, '/verifier/original.jsonl', '/verifier/candidate.jsonl');
      const validation = await execute(this.bubblewrap, args, { ...budget, maxOutput: diagnosticLimit, resourceLimits: this.resourceLimits, resources: this.resources });
      if (validation.code === 0 && validation.output.toString().trim() === 'SWARMENV_FINAL_TREE_VERIFIED') {
        return result('PASS', null);
      }
      if (validation.code === 42) return result('FAIL', 'Final-tree kernel replay, fixed theorem, or transitive axiom policy rejected the proof');
      return result('ERROR', 'Final-tree verifier did not complete');
    } catch (error: any) {
      const reason = budget?.signal.aborted ? budget.signal.reason : error;
      return result('ERROR', (reason?.message ?? 'Final-tree verification failed').slice(0, 256));
    } finally {
      clearTimeout(timer);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

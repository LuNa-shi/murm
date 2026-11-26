import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, MurmError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';
import { validateFixtureManifest } from './fixture.js';
import { checkerIdentity, normalizeCheckerResult, normalizePreflight } from './check-result.js';
import { leanSourcePolicyFinding } from './lean-source-policy.js';

function sha256(value: any) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableStringify(value)).digest('hex');
}

function truncate(value: any, maxBytes: any) {
  const buffer = Buffer.from(value ?? '');
  if (buffer.length <= maxBytes) return { value: buffer.toString(), truncated: false };
  return { value: buffer.subarray(0, maxBytes).toString(), truncated: true };
}

function diagnostic(value: any) {
  return truncate(value, 16_000).value;
}

function toolchainVersion(value: any) {
  const match = String(value ?? '').match(/\d+\.\d+\.\d+/);
  return match?.[0] ?? null;
}

async function lockedInputPath(projectRoot: any, problemFile: any) {
  if (isAbsolute(problemFile)) return resolve(problemFile);
  // Manifests may name the problem from the fixture repository root while the
  // Lean project is nested several directories below it. Try the project root
  // first, then each ancestor, preserving the existing one-level fallback.
  let directory = resolve(projectRoot);
  while (true) {
    const candidate = resolve(directory, problemFile);
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return resolve(projectRoot, problemFile);
}

export function runProcess(command: any, args: any, { cwd, env = process.env, timeoutMs = 120_000, maxOutputBytes = 1_000_000 }: any = {}) {
  return new Promise<any>((resolve: any) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: any = null;
    const finish = (result: any) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const out = truncate(stdout, maxOutputBytes);
      const err = truncate(stderr, maxOutputBytes);
      resolve({ ...result, stdout: out.value, stderr: err.value, stdout_truncated: out.truncated, stderr_truncated: err.truncated });
    };
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error: any) {
      finish({ exit_code: null, signal: null, error: error.message, error_code: error.code, checker_started: false });
      return;
    }
    child.stdout.on('data', (chunk: any) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: any) => { stderr += chunk.toString(); });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error: any) => finish({ exit_code: null, signal: null, error: error.message, error_code: error.code, checker_started: false }));
    child.on('close', (code: any, signal: any) => finish({ exit_code: code, signal, timed_out: timedOut, checker_started: true }));
  });
}

export class LeanChecker {
  declare command: any;
  declare checkerRef: any;
  declare checkerVersion: any;
  declare timeoutMs: any;
  declare maxOutputBytes: any;
  declare workRoot: any;
  declare runner: any;
  declare projectChecker: any;
  declare rejectSorry: any;
  declare logger: any;

  constructor({ command = 'lake', checkerRef = 'lean', checkerVersion = 'mvp-1', timeoutMs = 120_000, maxOutputBytes = 1_000_000, workRoot = tmpdir(), runner = runProcess, projectChecker = null, rejectSorry = true, logger = null }: any = {}) {
    this.command = command;
    this.checkerRef = checkerRef;
    this.checkerVersion = checkerVersion;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.workRoot = workRoot;
    this.runner = runner;
    this.projectChecker = projectChecker;
    this.rejectSorry = rejectSorry;
    this.logger = logger;
  }

  async preflight({ fixtureManifest, assertCanStart = () => {}, startProcess = (launch: any) => { assertCanStart(); return launch(); } }: any) {
    validateFixtureManifest(fixtureManifest);
    const identity = checkerIdentity(fixtureManifest);
    const projectRoot = fixtureManifest.project_root;
    this.logger?.append({ event: 'checker.preflight.start', checker_ref: identity.checker_ref, checker_version: identity.checker_version, environment_ref: identity.environment_ref });
    let inputEvidence: Record<string, any> = {};
    try {
      // A locked fixture project root is an input binding.  A scratch
      // directory cannot prove that the checker is evaluating the locked
      // problem, so a manifest without a project root is unavailable before
      // the checker process is started.
      if (!fixtureManifest.project_root) {
        const result = normalizePreflight({
          status: 'unavailable',
          checker_process_status: 'not_started',
          evidence: {
            input_binding_verified: false,
            preflight_verified: false,
            diagnostic_code: 'checker_input_binding_unverified',
            diagnostic: 'fixture manifest does not bind a project_root for the locked problem input',
            checker_started: false,
          },
        }, identity);
        this.logger?.append({ event: 'checker.preflight.complete', status: result.status, checker_process_status: result.checker_process_status, diagnostic_code: result.diagnostic_code });
        return result;
      }
      await access(projectRoot);
      if (!(await stat(projectRoot)).isDirectory()) throw new Error('checker project root is not a directory');
      const inputPath = await lockedInputPath(projectRoot, fixtureManifest.problem_file);
      const input = await readFile(inputPath);
      const inputHash = sha256(input);
      inputEvidence = {
        input_path: inputPath,
        input_hash: inputHash,
        expected_input_hash: fixtureManifest.problem_file_hash,
        input_binding_verified: inputHash === fixtureManifest.problem_file_hash,
      };
      if (inputHash !== fixtureManifest.problem_file_hash) {
        const result = normalizePreflight({
          status: 'unavailable',
          checker_process_status: 'not_started',
          evidence: {
            ...inputEvidence,
            diagnostic_code: 'checker_input_hash_mismatch',
            diagnostic: 'locked problem input hash does not match the fixture manifest',
            checker_started: false,
          },
        }, identity);
        this.logger?.append({ event: 'checker.preflight.complete', status: result.status, checker_process_status: result.checker_process_status, diagnostic_code: result.diagnostic_code });
        return result;
      }
    } catch (error: any) {
      const result = normalizePreflight({
        status: 'unavailable',
        checker_process_status: 'not_started',
        evidence: {
          ...inputEvidence,
          input_binding_verified: false,
          preflight_verified: false,
          diagnostic_code: 'checker_input_binding_unavailable',
          diagnostic: `checker input or working directory unavailable: ${error.message}`,
          error_code: error.code,
          checker_started: false,
        },
      }, identity);
      this.logger?.append({ event: 'checker.preflight.complete', status: result.status, checker_process_status: result.checker_process_status, diagnostic_code: result.diagnostic_code });
      return result;
    }
    let process;
    assertCanStart();
    try {
      // Exercise the same toolchain entrypoint used for a WorkspaceSource.  A bare
      // `lake --version` can succeed while the project toolchain or Mathlib
      // environment is unusable.
      process = await startProcess(() => this.runner(this.command, ['env', 'lean', '--version'], {
        cwd: projectRoot,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      }));
    } catch (error: any) {
      if ([ERROR_CODES.NOT_ALLOWED, ERROR_CODES.FENCED].includes(error.code)) throw error;
      process = { exit_code: null, signal: null, error: error.message, error_code: error.code, checker_started: false };
    }
    const observedVersion = toolchainVersion([process.stdout, process.stderr].filter(Boolean).join('\n'));
    const expectedVersion = toolchainVersion(fixtureManifest.lean_toolchain);
    const versionMismatch = Boolean(expectedVersion && observedVersion && expectedVersion !== observedVersion);
    const versionUnverified = !expectedVersion || !observedVersion;
    const expectedCheckerRef = fixtureManifest.checker_ref;
    const expectedCheckerVersion = fixtureManifest.checker_version;
    const checkerRefVerified = expectedCheckerRef === this.checkerRef;
    const checkerVersionVerified = expectedCheckerVersion === this.checkerVersion;
    const checkerIdentityMismatch = !checkerRefVerified || !checkerVersionVerified;
    const processFailed = Boolean(process.error || process.timed_out || process.exit_code !== 0 || process.signal);
    const versionDiagnosticCode = !processFailed && checkerIdentityMismatch
      ? checkerVersionVerified ? 'checker_identity_mismatch' : 'checker_version_mismatch'
      : !processFailed && versionMismatch
        ? 'checker_toolchain_version_mismatch'
        : !processFailed && versionUnverified
          ? 'checker_version_unverified'
          : undefined;
    const diagnosticText = diagnostic([
      process.stderr,
      process.stdout,
      process.error,
      !checkerRefVerified ? `checker identity mismatch: expected ${expectedCheckerRef}, observed ${this.checkerRef}` : '',
      !checkerVersionVerified ? `checker version mismatch: expected ${expectedCheckerVersion}, observed ${this.checkerVersion ?? 'unknown'}` : '',
      versionMismatch ? `checker version mismatch: expected ${expectedVersion}, observed ${observedVersion}` : '',
      versionUnverified ? `checker toolchain version could not be verified: expected ${expectedVersion ?? 'unknown'}, observed ${observedVersion ?? 'unknown'}` : '',
      process.timed_out ? 'checker timed out' : '',
      ].filter(Boolean).join('\n'));
    const unavailable = process.error || process.timed_out || process.exit_code !== 0 || checkerIdentityMismatch || versionMismatch || versionUnverified;
    const preflightProcessStatus = process.error || process.checker_started === false
      ? 'not_started'
      : process.timed_out
        ? 'timeout'
        : process.signal || process.exit_code === null
          ? 'crashed'
          : 'completed';
    const result = normalizePreflight({
      status: unavailable ? 'unavailable' : 'healthy',
      checker_process_status: preflightProcessStatus,
      evidence: {
        ...inputEvidence,
        expected_toolchain_version: expectedVersion,
        observed_toolchain_version: observedVersion,
        toolchain_version_verified: Boolean(expectedVersion && observedVersion && expectedVersion === observedVersion),
        expected_checker_ref: expectedCheckerRef,
        observed_checker_ref: this.checkerRef,
        checker_ref_verified: checkerRefVerified,
        expected_checker_version: expectedCheckerVersion,
        observed_checker_version: this.checkerVersion,
        checker_version_verified: checkerVersionVerified,
        checker_identity_verified: checkerRefVerified && checkerVersionVerified,
        preflight_verified: Boolean(fixtureManifest.project_root && inputEvidence.input_binding_verified && expectedVersion && observedVersion && expectedVersion === observedVersion && checkerRefVerified && checkerVersionVerified),
        diagnostic_code: versionDiagnosticCode,
        exit_code: process.exit_code ?? null,
        signal: process.signal ?? null,
        timed_out: Boolean(process.timed_out),
        checker_started: Boolean(process.checker_started),
        error_code: process.error_code ?? null,
        diagnostic: diagnosticText || null,
        stdout: process.stdout ?? '',
        stderr: process.stderr ?? '',
        stdout_truncated: Boolean(process.stdout_truncated),
        stderr_truncated: Boolean(process.stderr_truncated),
      },
    }, identity);
    this.logger?.append({ event: 'checker.preflight.complete', status: result.status, checker_process_status: result.checker_process_status, diagnostic_code: result.diagnostic_code, evidence: result.evidence });
    return result;
  }

  async checkProject({ files, tree, path, content, checkMode = 'lean-project', missionId, startProcess }: any) {
    const inputFailure = (diagnostic: any, diagnosticCode: any, started: any = false, evidence: any = {}) => ({
      verdict: 'ERROR', result_class: 'request_failure', checker_process_status: started ? 'completed' : 'not_started', retryable: false,
      evidence: { ...evidence, diagnostic, diagnostic_code: diagnosticCode, checker_started: started },
    });
    const forbidden = checkMode === 'lean-project' && path && leanSourcePolicyFinding(content, /\b(?:sorry|admit|axiom)\b/i);
    if (forbidden) {
      return inputFailure(`${path}:${forbidden.line}:${forbidden.column}: ${forbidden.word} is forbidden in the selected delivery file. Use a project check without --path to diagnose partial work.`,
        'forbidden_placeholder', false, { forbidden_placeholder: true });
    }
    let started = false;
    const result = await this.projectChecker({ files, tree, path, checkMode, missionId, deadline: Date.now() + this.timeoutMs,
      startProcess: (launch: any) => startProcess(() => { started = true; return launch(); }) });
    if (result.verdict === 'FAIL' && !started) return inputFailure(result.diagnostic, 'project_input_invalid');
    const paths = result.checked_paths;
    const leanFiles = Object.keys(files).filter((file: any) => file.endsWith('.lean') && file !== 'lakefile.lean');
    const complete = result.verdict === 'PASS' && started && result.checked_tree === tree &&
      Array.isArray(paths) && paths.length > 0 && (checkMode === 'lean-module' ? result.scope === 'module' && result.requested_path === path && paths.includes(path) : paths.length === leanFiles.length) &&
      new Set(paths).size === paths.length && paths.every((file: any) => typeof file === 'string' && file.endsWith('.lean') &&
        file !== 'lakefile.lean' && Object.hasOwn(files, file));
    if (complete && path && !paths.includes(path)) {
      return inputFailure('Project build did not cover the requested Lean source path.', 'project_path_uncovered', true);
    }
    const verdict = result.verdict === 'PASS' && !complete ? 'ERROR' : result.verdict;
    const diagnosedLeanFailure = ['lean_resource_limit', 'lean_panic', 'checker_memory_limit', 'checker_runtime_failure', 'module_verification_failed'].includes(result.diagnostic_code);
    const processStatus = result.timed_out ? 'timeout' : !started ? 'not_started' : diagnosedLeanFailure ? 'completed' : verdict === 'ERROR' ? 'crashed' : 'completed';
    return {
      verdict, checker_process_status: processStatus,
      ...(diagnosedLeanFailure ? { retryable: false } : {}),
      result_class: verdict === 'PASS' ? 'PASS' : verdict === 'FAIL' ? 'source_failure' : 'infrastructure_failure',
      evidence: { diagnostic: result.verdict === 'PASS' && !complete ? 'Project checker returned incomplete tree coverage.' : result.diagnostic,
        ...(result.verdict === 'PASS' && !complete ? { diagnostic_code: 'project_coverage_incomplete' } : {}),
        ...(diagnosedLeanFailure ? { diagnostic_code: result.diagnostic_code } : {}),
        checker_started: started, timed_out: Boolean(result.timed_out),
        build_scope: checkMode === 'lean-module' ? 'module' : 'project', requested_path: path ?? null,
        ...(result.cache ? { build_cache: result.cache } : {}),
        ...(complete ? { checked_paths: paths, build_warnings: Array.isArray(result.warnings)
          ? result.warnings.filter((warning: any) => typeof warning === 'string').slice(0, 32).map((warning: any) => warning.slice(0, 1024)) : [] } : {}) },
    };
  }

  async check({ workspace_source, targetTask, workspace, fixtureManifest, assertCanStart = () => {}, startProcess = (launch: any) => { assertCanStart(); return launch(); } }: any) {
    validateFixtureManifest(fixtureManifest);
    if (!workspace_source || typeof workspace_source.content !== 'string') throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'workspace_source content is required');
    const workspace_sourceHash = sha256(workspace_source.content);
    if (workspace_source.content_hash && workspace_source.content_hash !== workspace_sourceHash) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'workspace_source content_hash does not match content');
    const inputSnapshotHash = workspace?.input_snapshot_hash ?? workspace?.manifest?.input_snapshot_hash;
    if (!inputSnapshotHash) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Workspace input_snapshot_hash is required');
    await mkdir(this.workRoot, { recursive: true });
    const directory = this.logger
      ? join(this.workRoot, `workspace_source-${workspace_sourceHash}-${randomUUID()}`)
      : await mkdtemp(join(this.workRoot, 'murm-lean-'));
    await mkdir(directory, { recursive: true });
    const workspace_sourcePath = join(directory, 'WorkspaceSource.lean');
    await writeFile(workspace_sourcePath, workspace_source.content, 'utf8');
    this.logger?.append({ event: 'checker.input_prepared', workspace_source_hash: workspace_sourceHash, target_task_id: targetTask?.task_id ?? null, input_snapshot_hash: inputSnapshotHash, workspace_source_path: workspace_sourcePath });
    try {
      assertCanStart();
      if (this.rejectSorry && leanSourcePolicyFinding(workspace_source.content, /\bsorry\b/)) {
        const result = normalizeCheckerResult({
          verdict: 'FAIL',
          result_class: 'request_failure',
          checker_process_status: 'not_started',
          retryable: false,
          evidence: { exit_code: null, stdout: '', stderr: 'workspace_source contains forbidden sorry placeholder', diagnostic: 'sorry is not an accepted proof artifact', forbidden_placeholder: true, workspace_source_hash: workspace_sourceHash, input_snapshot_hash: inputSnapshotHash },
        });
        this.logger?.append({ event: 'checker.complete', verdict: result.verdict, evidence: result.evidence });
        return result;
      }
      // Preflight and workspace_source checking must exercise the same locked
      // project/toolchain cwd.  The per-workspace_source directory only stores the
      // workspace_source file; it is not a substitute for the project root.
      const projectRoot = fixtureManifest.project_root ?? this.workRoot;
      const result = await startProcess(() => this.runner(this.command, ['env', 'lean', workspace_sourcePath], { cwd: projectRoot, timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes }));
      const processStatus = result.error || result.checker_started === false
        ? 'not_started'
        : result.timed_out
          ? 'timeout'
          : result.signal || result.exit_code === null
            ? 'crashed'
            : 'completed';
      const diagnosedLeanFailure = ['lean_resource_limit', 'lean_panic', 'checker_memory_limit', 'checker_runtime_failure'].includes(result.diagnostic_code);
      const verdict = diagnosedLeanFailure || processStatus === 'not_started' || processStatus === 'timeout' || processStatus === 'crashed'
        ? 'ERROR'
        : result.exit_code === 0 ? 'PASS' : 'FAIL';
      const diagnosticText = diagnostic([result.stderr, result.stdout, result.error, result.signal ? `checker terminated by ${result.signal}` : '', result.timed_out ? 'checker timed out' : ''].filter(Boolean).join('\n'));
      const checked = normalizeCheckerResult({
        verdict,
        ...(diagnosedLeanFailure ? { retryable: false } : {}),
        checker_process_status: processStatus,
        evidence: {
          ...(diagnosedLeanFailure ? { diagnostic_code: result.diagnostic_code } : {}),
          exit_code: result.exit_code,
          signal: result.signal,
          timed_out: Boolean(result.timed_out),
          checker_started: result.checker_started ?? processStatus !== 'not_started',
          error_code: result.error_code ?? null,
          stdout: result.stdout,
          stderr: result.stderr,
          stdout_truncated: Boolean(result.stdout_truncated),
          stderr_truncated: Boolean(result.stderr_truncated),
          diagnostic: diagnosticText,
          workspace_source_hash: workspace_sourceHash,
          input_snapshot_hash: inputSnapshotHash,
          target_task_id: targetTask?.task_id ?? null,
          target_spec_version: targetTask?.spec_version ?? null,
        },
      });
      this.logger?.append({ event: 'checker.complete', verdict: checked.verdict, evidence: checked.evidence });
      return checked;
    } finally {
      if (!this.logger) await rm(directory, { recursive: true, force: true });
    }
  }
}

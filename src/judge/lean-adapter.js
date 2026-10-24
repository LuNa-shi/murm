import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';
import { validateFixtureManifest } from './fixture.js';
import { checkerIdentity, normalizeCheckerResult, normalizePreflight } from './check-result.js';

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableStringify(value)).digest('hex');
}

function truncate(value, maxBytes) {
  const buffer = Buffer.from(value ?? '');
  if (buffer.length <= maxBytes) return { value: buffer.toString(), truncated: false };
  return { value: buffer.subarray(0, maxBytes).toString(), truncated: true };
}

function diagnostic(value) {
  return truncate(value, 16_000).value;
}

export function runProcess(command, args, { cwd, env = process.env, timeoutMs = 120_000, maxOutputBytes = 1_000_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    const finish = (result) => {
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
    } catch (error) {
      finish({ exit_code: null, signal: null, error: error.message, error_code: error.code, checker_started: false });
      return;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => finish({ exit_code: null, signal: null, error: error.message, error_code: error.code, checker_started: false }));
    child.on('close', (code, signal) => finish({ exit_code: code, signal, timed_out: timedOut, checker_started: true }));
  });
}

export class LeanChecker {
  constructor({ command = 'lake', timeoutMs = 120_000, maxOutputBytes = 1_000_000, workRoot = tmpdir(), runner = runProcess, rejectSorry = true, logger = null } = {}) {
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.workRoot = workRoot;
    this.runner = runner;
    this.rejectSorry = rejectSorry;
    this.logger = logger;
  }

  async preflight({ fixtureManifest }) {
    validateFixtureManifest(fixtureManifest);
    const identity = checkerIdentity(fixtureManifest);
    const projectRoot = fixtureManifest.project_root ?? this.workRoot;
    this.logger?.append({ event: 'checker.preflight.start', checker_ref: identity.checker_ref, checker_version: identity.checker_version, environment_ref: identity.environment_ref });
    try {
      // A locked fixture project root is an input binding.  Only the default
      // scratch root may be created by the checker; a missing configured root
      // must be reported as an unavailable environment.
      if (!fixtureManifest.project_root) await mkdir(projectRoot, { recursive: true });
      await access(projectRoot);
    } catch (error) {
      const result = normalizePreflight({
        status: 'unavailable',
        checker_process_status: 'not_started',
        evidence: { diagnostic: `checker working directory unavailable: ${error.message}`, error_code: error.code },
      }, identity);
      this.logger?.append({ event: 'checker.preflight.complete', status: result.status, checker_process_status: result.checker_process_status, diagnostic_code: result.diagnostic_code });
      return result;
    }
    let process;
    try {
      // Exercise the same toolchain entrypoint used for a Candidate.  A bare
      // `lake --version` can succeed while the project toolchain or Mathlib
      // environment is unusable.
      process = await this.runner(this.command, ['env', 'lean', '--version'], {
        cwd: projectRoot,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      });
    } catch (error) {
      process = { exit_code: null, signal: null, error: error.message, error_code: error.code, checker_started: false };
    }
    const diagnosticText = diagnostic([process.stderr, process.stdout, process.error, process.timed_out ? 'checker timed out' : ''].filter(Boolean).join('\n'));
    const result = normalizePreflight({
      status: process.error || process.timed_out || process.exit_code !== 0 ? 'unavailable' : 'healthy',
      checker_process_status: process.error ? 'not_started' : process.timed_out ? 'timeout' : process.signal ? 'crashed' : 'completed',
      evidence: {
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

  async check({ candidate, targetTask, workspace, fixtureManifest }) {
    validateFixtureManifest(fixtureManifest);
    if (!candidate || typeof candidate.content !== 'string') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'candidate content is required');
    const candidateHash = sha256(candidate.content);
    if (candidate.content_hash && candidate.content_hash !== candidateHash) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'candidate content_hash does not match content');
    const inputSnapshotHash = workspace?.input_snapshot_hash ?? workspace?.manifest?.input_snapshot_hash;
    if (!inputSnapshotHash) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Workspace input_snapshot_hash is required');
    await mkdir(this.workRoot, { recursive: true });
    const directory = this.logger
      ? join(this.workRoot, `candidate-${candidateHash}-${randomUUID()}`)
      : await mkdtemp(join(this.workRoot, 'swarmenv-lean-'));
    await mkdir(directory, { recursive: true });
    const candidatePath = join(directory, 'Candidate.lean');
    await writeFile(candidatePath, candidate.content, 'utf8');
    this.logger?.append({ event: 'checker.start', candidate_hash: candidateHash, target_task_id: targetTask?.task_id ?? null, input_snapshot_hash: inputSnapshotHash, candidate_path: candidatePath });
    try {
      if (this.rejectSorry && /\bsorry\b/.test(candidate.content)) {
        const result = normalizeCheckerResult({
          verdict: 'FAIL',
          result_class: 'request_failure',
          checker_process_status: 'not_started',
          retryable: false,
          evidence: { exit_code: null, stdout: '', stderr: 'candidate contains forbidden sorry placeholder', diagnostic: 'sorry is not an accepted proof artifact', forbidden_placeholder: true, candidate_hash: candidateHash, input_snapshot_hash: inputSnapshotHash },
        });
        this.logger?.append({ event: 'checker.complete', verdict: result.verdict, evidence: result.evidence });
        return result;
      }
      const projectRoot = fixtureManifest.project_root ?? directory;
      const result = await this.runner(this.command, ['env', 'lean', candidatePath], { cwd: projectRoot, timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes });
      const verdict = result.error || result.timed_out ? 'ERROR' : result.exit_code === 0 ? 'PASS' : 'FAIL';
      const diagnosticText = diagnostic([result.stderr, result.stdout, result.error, result.timed_out ? 'checker timed out' : ''].filter(Boolean).join('\n'));
      const checked = normalizeCheckerResult({
        verdict,
        evidence: {
          exit_code: result.exit_code,
          signal: result.signal,
          timed_out: Boolean(result.timed_out),
          checker_started: result.checker_started,
          error_code: result.error_code ?? null,
          stdout: result.stdout,
          stderr: result.stderr,
          stdout_truncated: Boolean(result.stdout_truncated),
          stderr_truncated: Boolean(result.stderr_truncated),
          diagnostic: diagnosticText,
          candidate_hash: candidateHash,
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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';
import { validateFixtureManifest } from './fixture.js';

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableStringify(value)).digest('hex');
}

function truncate(value, maxBytes) {
  const buffer = Buffer.from(value ?? '');
  if (buffer.length <= maxBytes) return { value: buffer.toString(), truncated: false };
  return { value: buffer.subarray(0, maxBytes).toString(), truncated: true };
}

export function runProcess(command, args, { cwd, env = process.env, timeoutMs = 120_000, maxOutputBytes = 1_000_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout, maxOutputBytes);
      const err = truncate(stderr, maxOutputBytes);
      resolve({ ...result, stdout: out.value, stderr: err.value, stdout_truncated: out.truncated, stderr_truncated: err.truncated });
    };
    child.on('error', (error) => finish({ exit_code: null, signal: null, error: error.message }));
    child.on('close', (code, signal) => finish({ exit_code: code, signal, timed_out: timedOut }));
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

  async check({ candidate, targetTask, initialContext, fixtureManifest }) {
    validateFixtureManifest(fixtureManifest);
    if (!candidate || typeof candidate.content !== 'string') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'candidate content is required');
    const candidateHash = sha256(candidate.content);
    if (candidate.content_hash && candidate.content_hash !== candidateHash) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'candidate content_hash does not match content');
    const inputSnapshotHash = initialContext?.input_snapshot_hash ?? initialContext?.manifest?.input_snapshot_hash;
    if (!inputSnapshotHash) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Initial Context input_snapshot_hash is required');
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
        const result = {
          verdict: 'FAIL',
          evidence: { exit_code: null, stdout: '', stderr: 'candidate contains forbidden sorry placeholder', diagnostic: 'sorry is not an accepted proof artifact', candidate_hash: candidateHash, input_snapshot_hash: inputSnapshotHash },
        };
        this.logger?.append({ event: 'checker.complete', verdict: result.verdict, evidence: result.evidence });
        return result;
      }
      const projectRoot = fixtureManifest.project_root ?? directory;
      const result = await this.runner(this.command, ['env', 'lean', candidatePath], { cwd: projectRoot, timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes });
      const verdict = result.error || result.timed_out ? 'ERROR' : result.exit_code === 0 ? 'PASS' : 'FAIL';
      const diagnostic = [result.stderr, result.stdout, result.error, result.timed_out ? 'checker timed out' : ''].filter(Boolean).join('\n');
      const checked = {
        verdict,
        evidence: {
          exit_code: result.exit_code,
          signal: result.signal,
          timed_out: Boolean(result.timed_out),
          stdout: result.stdout,
          stderr: result.stderr,
          stdout_truncated: Boolean(result.stdout_truncated),
          stderr_truncated: Boolean(result.stderr_truncated),
          diagnostic,
          candidate_hash: candidateHash,
          input_snapshot_hash: inputSnapshotHash,
          target_task_id: targetTask?.task_id ?? null,
          target_spec_version: targetTask?.spec_version ?? null,
        },
      };
      this.logger?.append({ event: 'checker.complete', verdict: checked.verdict, evidence: checked.evidence });
      return checked;
    } finally {
      if (!this.logger) await rm(directory, { recursive: true, force: true });
    }
  }
}

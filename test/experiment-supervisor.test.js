import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const observer = join(root, 'scripts', 'experiment-supervisor.py');

test('experiment observer closes SQLite connections during long polling', () => {
  const output = execFileSync('python3', [observer, '--self-test'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const result = JSON.parse(output.trim());
  assert.equal(result.self_test, 'PASS');
  assert.ok(result.fd_delta <= 8, `unexpected descriptor growth: ${result.fd_delta}`);
});

test('observer-side database and log failures do not signal the runner', () => {
  const runner = spawn('sleep', ['2']);
  const projectDir = mkdtempSync('/tmp/swarmenv-observer-test-');
  writeFileSync(join(projectDir, 'project.sqlite'), 'not a sqlite database');
  try {
    const result = execFileSync('python3', [
      observer,
      '--pid', String(runner.pid),
      '--project-dir', projectDir,
      '--log', '/proc/swarmenv-observer-test-does-not-exist/events.ndjson',
      '--interval-seconds', '0.05',
      '--max-runtime-seconds', '0.2',
    ], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(result, /observer_started/);
    assert.match(result, /observation_error/);
    assert.doesNotThrow(() => process.kill(runner.pid, 0));
  } finally {
    runner.kill('SIGTERM');
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('observer fences an explicitly captured PID identity before polling', () => {
  const runner = spawn('sleep', ['2']);
  try {
    const result = spawnSync('python3', [
      observer,
      '--pid', String(runner.pid),
      '--pid-starttime', '0',
      '--project-dir', '/tmp/swarmenv-observer-test-does-not-exist',
      '--log', '/proc/swarmenv-observer-test-does-not-exist/events.ndjson',
      '--max-runtime-seconds', '1',
    ], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /process_identity_mismatch/);
    assert.doesNotThrow(() => process.kill(runner.pid, 0));
  } finally {
    runner.kill('SIGTERM');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ContainerSandboxManager, ERROR_CODES, SwarmEnvError } from '../src/index.js';

class FakeDocker {
  constructor(respond) {
    this.respond = respond;
    this.calls = [];
  }

  spawn(command, args) {
    this.calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', null);
    const result = this.respond(args, this.calls.length);
    if (result?.pending) return child;
    queueMicrotask(() => {
      child.stdout.end(result?.stdout ?? '');
      child.stderr.end(result?.stderr ?? '');
      child.emit('close', result?.code ?? 0);
    });
    return child;
  }
}

async function fixture({ respond } = {}) {
  const root = await mkdtemp('/tmp/swarmenv-sandbox-');
  const workspaceRoot = join(root, 'workspaces');
  const workspace = join(workspaceRoot, 'execution-1');
  await mkdir(workspace, { recursive: true });
  const docker = new FakeDocker(respond ?? ((args) => {
    if (args[0] === 'image') return { stdout: 'sha256:abc123\n' };
    if (args[0] === 'run') return { stdout: 'container-1\n' };
    if (args[0] === 'exec') return { stdout: 'ok\n' };
    return {};
  }));
  const manager = new ContainerSandboxManager({
    image: 'swarmenv/sandbox:test',
    imageDigest: 'sha256:abc123',
    workspaceRoot,
    network: 'none',
    spawnProcess: docker.spawn.bind(docker),
  });
  return { root, workspace, docker, manager };
}

test('sandbox preflight pins the image digest and refuses an unexpected image', async () => {
  const { root, manager, docker } = await fixture();
  try {
    const preflight = await manager.preflight();
    assert.equal(preflight.ok, true);
    assert.equal(preflight.image_id, 'sha256:abc123');
    assert.deepEqual(docker.calls[0].args.slice(0, 3), ['image', 'inspect', '--format']);

    const mismatch = new ContainerSandboxManager({
      image: 'swarmenv/sandbox:test', imageDigest: 'sha256:other', workspaceRoot: join(root, 'workspaces'),
      spawnProcess: (command, args) => new FakeDocker(() => ({ stdout: 'sha256:abc123\n' })).spawn(command, args),
    });
    await assert.rejects(mismatch.preflight(), (error) => error.code === ERROR_CODES.SERVICE_UNAVAILABLE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox starts one isolated container per Execution and enforces the mount boundary', async () => {
  const { root, workspace, manager, docker } = await fixture();
  try {
    const started = await manager.ensureExecution({ executionId: 'execution-1', workspaceRef: workspace, bindingVersion: 4 });
    assert.equal(started.execution_id, 'execution-1');
    assert.equal(started.workspace, '/workspace');
    const run = docker.calls.find((call) => call.args[0] === 'run').args;
    assert.ok(run.includes('--read-only'));
    assert.ok(run.includes('--network'));
    assert.equal(run[run.indexOf('--network') + 1], 'none');
    assert.equal(run[run.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(run[run.indexOf('--security-opt') + 1], 'no-new-privileges');
    assert.ok(run.some((value) => value.includes(`src=${workspace}`) && value.includes('dst=/workspace')));
    assert.ok(!run.some((value) => value.includes('docker.sock')));
    assert.ok(run.includes('--pids-limit'));
    assert.ok(run.includes('--memory'));
    assert.ok(run.includes('--cpus'));

    await assert.rejects(
      manager.ensureExecution({ executionId: 'execution-2', workspaceRef: '/tmp/outside-workspace' }),
      (error) => error.code === ERROR_CODES.NOT_ALLOWED,
    );
    await assert.rejects(
      manager.ensureExecution({ executionId: 'execution-3', workspaceRef: workspace, readOnlyMounts: [{ source: '/etc' }] }),
      (error) => error.code === ERROR_CODES.NOT_ALLOWED,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox executes bounded commands with a safe environment and /workspace cwd', async () => {
  const { root, workspace, manager, docker } = await fixture();
  try {
    await manager.ensureExecution({ executionId: 'execution-1', workspaceRef: workspace });
    const result = await manager.exec({ executionId: 'execution-1', command: 'rg theorem .', cwd: '/workspace', timeoutMs: 5_000 });
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'ok\n');
    assert.equal(result.execution_id, 'execution-1');
    const exec = docker.calls.find((call) => call.args[0] === 'exec').args;
    assert.ok(exec.includes('--workdir'));
    assert.equal(exec[exec.indexOf('--workdir') + 1], '/workspace');
    assert.ok(exec.includes('HOME=/tmp'));

    await assert.rejects(manager.exec({ executionId: 'execution-1', command: 'ls', cwd: '/etc' }), (error) => error.code === ERROR_CODES.INVALID_CONTRACT);
    await assert.rejects(
      manager.exec({ executionId: 'execution-1', command: 'env', env: { AWS_SECRET_ACCESS_KEY: 'x' } }),
      (error) => error.code === ERROR_CODES.NOT_ALLOWED,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox kills a command on timeout and cancels its process group', async () => {
  let execCalls = 0;
  const { root, workspace, manager, docker } = await fixture({
    respond: (args) => {
      if (args[0] === 'image') return { stdout: 'sha256:abc123\n' };
      if (args[0] === 'run') return { stdout: 'container-1\n' };
      if (args[0] === 'exec') {
        execCalls += 1;
        // The first exec is the long-running command; later execs are the
        // process-group cleanup issued by cancelJob.
        return execCalls === 1 ? { pending: true } : {};
      }
      return {};
    },
  });
  try {
    await manager.ensureExecution({ executionId: 'execution-1', workspaceRef: workspace });
    const result = await manager.exec({ executionId: 'execution-1', command: 'sleep 999', timeoutMs: 20 });
    assert.equal(result.timed_out, true);
    assert.equal(result.exit_code, null);
    assert.ok(docker.calls.some((call) => call.args[0] === 'exec' && call.args.some((value) => String(value).includes('kill -TERM'))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox releases the container and refuses commands for an unbound Execution', async () => {
  const { root, workspace, manager, docker } = await fixture();
  try {
    await manager.ensureExecution({ executionId: 'execution-1', workspaceRef: workspace });
    await manager.stopExecution('execution-1');
    assert.ok(docker.calls.some((call) => call.args[0] === 'rm' && call.args.includes('-f')));
    await assert.rejects(
      manager.exec({ executionId: 'execution-1', command: 'ls' }),
      (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
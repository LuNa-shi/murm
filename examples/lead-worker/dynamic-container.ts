import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttpJsonAdapter } from '@murm/core/services';
import type { DynamicDeploymentRequest } from '../../src/harnesses/lead-worker/dynamic.js';

const localEndpoint = 'http://127.0.0.1:8080';
const ownerLabel = 'org.murm.lead-worker.owner';

export function assertContainerImage(image: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new TypeError('Expected an immutable local Docker image ID');
}

export function docker(args: string[], { signal, input = '', outputLimit = 3 * 1024 ** 2 }: {
  signal?: AbortSignal; input?: string; outputLimit?: number;
} = {}) {
  const deadline = AbortSignal.timeout(15_000);
  const bound = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('docker', args, { signal: bound, stdio: 'pipe', killSignal: 'SIGKILL' });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let error: unknown;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= outputLimit) target.push(chunk);
      else {
        error ??= new Error('Docker command exceeded output limit');
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', (failure: NodeJS.ErrnoException) => { if (failure.code !== 'EPIPE') error ??= failure; });
    child.on('error', failure => { error ??= failure; });
    child.on('close', status => {
      if (error) reject(error);
      else resolve({ status, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
    child.stdin.end(input);
  });
}

async function requireDocker(args: string[], options?: Parameters<typeof docker>[1]) {
  const result = await docker(args, options);
  if (result.status !== 0) throw new Error('Docker command failed');
  return result.stdout;
}

export function isolatedContainer(image: string, directory: string, fixture?: string) {
  assertContainerImage(image);
  const owner = randomBytes(16).toString('hex');
  const name = `murm-orders-${owner}`;
  let creating = false;
  let creationKnown = false;
  async function inspect() {
    const rows = await requireDocker(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
    if (!rows.split('\n').includes(name)) return false;
    const result = await requireDocker(['container', 'inspect', '--format', `{{index .Config.Labels "${ownerLabel}"}}`, name]);
    if (result.trim() !== owner) throw new Error('Container ownership could not be verified');
    return true;
  }
  return {
    name,
    async create(args: string[], signal?: AbortSignal) {
      signal?.throwIfAborted();
      creating = true;
      const result = await docker(['container', 'create', '-i', '--pull', 'never', '--name', name,
        '--label', `${ownerLabel}=${owner}`, '--network', 'none', '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8388608', '--pids-limit', '32', '--user', '65534:65534',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--memory-swap', '128m',
        '--cpus', '.5', '--log-driver', 'none', '--mount', `type=bind,source=${directory},target=/app,readonly`,
        ...(fixture ? ['--mount', `type=bind,source=${fixture},target=/case.jsonl,readonly`] : []),
        '--workdir', '/app', '--entrypoint', 'node', image, ...args]);
      creationKnown = true;
      if (result.status !== 0) throw new Error('Docker create failed');
    },
    async close() {
      if (!creating) return;
      if (await inspect()) {
        await requireDocker(['container', 'rm', '-f', name]);
        creationKnown = true;
      }
      if (await inspect() || !creationKnown) throw new Error('Container cleanup is pending');
      creating = false;
    },
  };
}

// Docker exec carries HTTP on stdin. The Service container has only loopback, so
// it cannot contact the host or another agent, even if its generated code tries.
const relay = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { path, method, headers, body } = JSON.parse(Buffer.concat(chunks).toString());
const response = await fetch('http://127.0.0.1:8080' + path, {
  method, headers, body, redirect: 'error', signal: AbortSignal.timeout(8000)
});
const result = [];
let bytes = 0;
for await (const chunk of response.body) {
  bytes += chunk.length;
  if (bytes > 2097152) throw new Error('Response body limit');
  result.push(chunk);
}
process.stdout.write(JSON.stringify({ status: response.status, body: Buffer.concat(result).toString('base64') }));
`;

export function deployDynamicContainer(image: string, { verify }: {
  verify?(invoke: (jsonl: string) => Promise<unknown>): Promise<unknown>;
} = {}) {
  assertContainerImage(image);
  return async ({ id, manifest, source, signal, resources }: DynamicDeploymentRequest) => {
    const directory = await mkdtemp(join(tmpdir(), 'murm-service-'));
    const sandbox = isolatedContainer(image, directory);
    resources.own({ kind: 'checking-container', id: sandbox.name, close: async () => {
      await sandbox.close();
      await rm(directory, { recursive: true, force: true });
    } });
    try {
      await chmod(directory, 0o755);
      await writeFile(join(directory, 'service.mjs'), source, { mode: 0o444 });
      await sandbox.create(['service.mjs'], signal);
      await requireDocker(['container', 'start', sandbox.name], { signal });
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== localEndpoint || !['/health', '/v2/check_orders'].includes(url.pathname) ||
            url.search || url.hash || url.username || url.password) throw new Error('Unapproved checking endpoint');
        const raw = await requireDocker(['container', 'exec', '-i', sandbox.name, 'node', '--input-type=module', '-e', relay], {
          signal: init?.signal ?? undefined,
          input: JSON.stringify({ path: url.pathname, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body }),
        });
        const response = JSON.parse(raw);
        return new Response([204, 205, 304].includes(response.status) ? null : Buffer.from(response.body, 'base64'), { status: response.status });
      };
      const ready = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      while (true) {
        ready.throwIfAborted();
        try {
          if ((await fetchImpl(localEndpoint + '/health', { signal: ready })).ok) break;
        } catch { ready.throwIfAborted(); }
        await delay(100, undefined, { signal: ready });
      }
      let verification: unknown;
      let probe = 0;
      if (verify) verification = await verify(async jsonl => {
        const operationId = `host-verification-${++probe}`;
        const response = await fetchImpl(localEndpoint + '/v2/check_orders', {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json', 'idempotency-key': operationId },
          body: JSON.stringify({ input: { jsonl }, envelope: { operation_id: operationId }, caller: { role: 'host' } }),
        });
        const body = await response.json();
        if (!response.ok || body.ok !== true) throw new Error('Checking Service probe failed');
        return body.result;
      });
      return { registration: { manifest, adapter: createHttpJsonAdapter({ fetchImpl }) }, deploymentRef: sandbox.name, verification };
    } catch {
      throw Object.assign(new Error(`Checking Service ${id} deployment failed`), { code: 'DEPLOYMENT_FAILED' });
    }
  };
}

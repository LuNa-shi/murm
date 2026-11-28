import { runtimeSettings } from '../fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { availableParallelism, release } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createRuntime } from '@luna-shi/murm';

import { ServiceRegistry } from '@luna-shi/murm';
import { runInput } from '../../src/harness/run-input.js';
import { ownedContainers } from '../fixtures/core-runtime-containers.js';
import { streamResponse } from '../fixtures/core-controlled-upstream.js';

const run = promisify(execFile);
const image = process.env.MURM_CORE_TEST_IMAGE;
const sizes = process.argv.slice(2).map(Number);
const providerContainer = process.env.MURM_CAPACITY_PROVIDER_CONTAINER;
const lifecycle = new URL(process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1');
const memoryPerAgent = 1024 ** 3;
const idleMs = 10_000;
const fileBytes = 4 * 1024 ** 2;
const startConcurrency = 4;
const marker = 'CAPACITY_WORK_CONFIRMED';
const workCommand = 'dd if=/dev/zero of=payload.bin bs=1048576 count=4 status=none && sleep 3 && wc -c <payload.bin';
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/u);
assert.ok(sizes.length && new Set(sizes).size === sizes.length && sizes.every(count => [1, 8, 32].includes(count)), 'Specify distinct tiers of 1, 8 or 32 Agents');
assert.equal(lifecycle.hostname, '127.0.0.1', 'The probe requires a local provider');

const evidenceRoot = join(process.cwd(), 'experiments');
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(evidenceRoot, 'core-capacity-'));
const shutdown = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => shutdown.abort(new Error(name)));
const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(8 * 60_000)]);

// Read only processes belonging to the probe's identified cgroups. Return
// aggregates and role names, never /proc command lines or environments.
const sampleProcesses = `
import json, os, sys
def read(path):
    with open(path) as f: return f.read()
def pss(pid):
    try:
        return next(int(line.split()[1]) * 1024 for line in read(f'/proc/{pid}/smaps_rollup').splitlines() if line.startswith('Pss:'))
    except (OSError, StopIteration):
        return None
def sample(pid):
    path = next(line.split(':', 2)[2] for line in read(f'/proc/{pid}/cgroup').splitlines() if line.startswith('0::'))
    group = '/sys/fs/cgroup' + path
    fields = dict(line.split() for line in read(group + '/memory.stat').splitlines())
    cpu = dict(line.split() for line in read(group + '/cpu.stat').splitlines())
    workspace = os.statvfs(f'/proc/{pid}/root/workspace')
    roles = {}
    for child in read(group + '/cgroup.procs').split():
        try:
            with open(f'/proc/{child}/cmdline','rb') as f: args = f.read().split(b'\\0')
        except OSError: continue
        names = [os.path.basename(arg) for arg in args[:3]]
        role = 'worker' if b'agent-worker.mjs' in names else 'pi' if b'pi' in names else 'other'
        size = pss(child)
        if size is not None: roles[role] = roles.get(role, 0) + size
    return dict(cgroup=path, memory=int(read(group + '/memory.current')), anon=int(fields['anon']),
                file=int(fields['file']), shmem=int(fields['shmem']), kernel=int(fields.get('kernel', 0)),
                cpu_usec=int(cpu['usage_usec']), tmpfs=(workspace.f_blocks-workspace.f_bfree)*workspace.f_frsize,
                pss=roles)
print(json.dumps(dict(sandboxes=[sample(pid) for pid in sys.argv[3:]],
                      dockerdPss=pss(sys.argv[1]), providerPss=pss(sys.argv[2]))))
`;

const terminatePi = `
import os, signal
matches = []
for pid in os.listdir('/proc'):
    if not pid.isdecimal(): continue
    try:
        with open('/proc/'+pid+'/cmdline','rb') as f: args = f.read().split(b'\\0')
    except OSError: continue
    if any(os.path.basename(arg) == b'pi' for arg in args[:3]):
        matches.append(int(pid))
assert len(matches) == 1, 'No unique owned Pi RPC process'
os.kill(matches[0], signal.SIGTERM)
`;

async function inspectPids(ids: string[]) {
  if (!ids.length) return [];
  const { stdout } = await run('docker', ['inspect', '--type', 'container', '--format', '{{.State.Pid}}', ...ids],
    { timeout: 5000, signal });
  const pids = stdout.trim().split('\n');
  assert.equal(pids.length, ids.length);
  assert.ok(pids.every(pid => /^[1-9]\d*$/u.test(pid)));
  return pids;
}
async function availableMemory() {
  const text = await readFile('/proc/meminfo', 'utf8');
  const hostAvailable = Number(/^MemAvailable:\s+(\d+)/mu.exec(text)?.[1]) * 1024;
  const limit = await readFile('/sys/fs/cgroup/memory.max', 'utf8').then(Number).catch(() => NaN);
  const used = await readFile('/sys/fs/cgroup/memory.current', 'utf8').then(Number).catch(() => NaN);
  return Number.isFinite(limit - used) ? Math.min(hostAvailable, limit - used) : hostAvailable;
}
async function sample(pids: string[]) {
  const [dockerd, [provider], free] = await Promise.all([
    readFile('/run/docker.pid', 'utf8'), inspectPids(providerContainer ? [providerContainer] : []), availableMemory(),
  ]);
  assert.ok(free >= 2 * memoryPerAgent, 'Host headroom fell below 2 GiB');
  const { stdout } = await run('sudo', ['-n', '/usr/bin/python3', '-I', '-c', sampleProcesses,
    dockerd.trim(), provider ?? '0', ...pids], { timeout: 5000, signal });
  return { atMs: performance.now(), headroom: free, ...JSON.parse(stdout) };
}
async function measure(count: number) {
  const outputDir = join(directory, String(count));
  const result: Record<string, any> = { count, status: 'pending' };
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let upstreamRequests = 0;
  let upstreamFailure = false;
  const probeServer = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/responses');
      const requestId = ++upstreamRequests;
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'));
      assert.equal(body.model, 'k3');
      const returned = body.input.find(row => row.type === 'function_call_output' && /^capacity-\d+$/u.test(row.call_id));
      if (returned) assert.equal(returned.output.trim(), String(fileBytes));
      const item = returned ? { type: 'message', id: `msg_${requestId}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: marker, annotations: [] }] }
        : { type: 'function_call', id: `fc_${requestId}`, call_id: `capacity-${requestId}`, name: 'bash',
          arguments: JSON.stringify({ command: workCommand, timeout: 15 }) };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse('k3', requestId, item));
    } catch {
      upstreamFailure = true;
      response.writeHead(400).end();
    }
  });
  probeServer.listen(0, '127.0.0.1');
  await once(probeServer, 'listening');
  const originalFetch = globalThis.fetch;
  let polls = 0;
  const starts = new Map<string, number>();
  const startDelays: number[] = [];
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    const message = url.endsWith('/rpc') && typeof options?.body === 'string' ? JSON.parse(options.body).message : undefined;
    if (message?.type === 'get_state' && Number.isFinite(message.since)) polls++;
    if (message?.type === 'prompt') starts.set(url, performance.now());
    const response = await originalFetch(input, options);
    if (message && starts.has(url) && response.ok) {
      const reply = await response.clone().json();
      if (reply.result?.records?.some(record => record.type === 'agent_start') && starts.has(url)) {
        startDelays.push(performance.now() - starts.get(url)!);
        starts.delete(url);
      }
    }
    return response;
  };

  try {
    assert.ok(await availableMemory() > (count + 2) * memoryPerAgent, 'Insufficient headroom for this tier');
    result.hostBaseline = await sample([]);
    const advertiseHost = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
    const backend = runtimeSettings({
      sandbox: { lifecycleBaseUrl: lifecycle.href, resourceLimits: { cpu: '1', memory: '1Gi' } },
      bridge: { host: '0.0.0.0', publicUrl: `http://${advertiseHost}:{port}` },
      modelGateway: { host: '0.0.0.0', advertiseHost, maxOutputTokens: 128 },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
        url: `http://127.0.0.1:${probeServer.address().port}/v1/responses`, headers: {},
      } } },
      isolation: { network: 'api' },
    });
    runtime = await createRuntime({ ...backend, outputDir, services: new ServiceRegistry(), maxAgents: count,
      profiles: { probe: { prompt: 'Complete the controlled local file task.', image, writable: true, model: 'default', services: {} } } });
    result.runtimeId = runtime.id;
    const agents = [];
    const startup = performance.now();
    result.readyMs = [];
    for (let first = 0; first < count; first += startConcurrency) {
      signal.throwIfAborted();
      const batch = await Promise.allSettled(Array.from({ length: Math.min(startConcurrency, count - first) }, async (_, index) => {
        const started = performance.now();
        const agent = await runtime!.spawn({ profile: 'probe', requestId: `spawn-${first + index}` });
        assert.equal(agent.status, 'idle');
        result.readyMs.push(performance.now() - started);
        return agent;
      }));
      for (const item of batch) {
        if (item.status === 'rejected') throw item.reason;
        agents.push(item.value);
      }
    }
    result.allReadyMs = performance.now() - startup;
    const containers = await ownedContainers(runtime.id);
    assert.equal(containers.length, count);
    const pids = await inspectPids(containers);
    await delay(3000, undefined, { signal });
    const idlePolls = polls;
    const idleStart = performance.now();
    result.idle = [await sample(pids)];
    for (let tick = 0; tick < 2; tick++) {
      await delay(idleMs / 2, undefined, { signal });
      result.idle.push(await sample(pids));
    }
    result.idlePollsPerSecond = (polls - idlePolls) / ((performance.now() - idleStart) / 1000);
    assert.equal(upstreamRequests, 0);

    const workStart = performance.now();
    let done = false;
    const work = Promise.allSettled(agents.map(agent => runInput(runtime!, agent.id, 'Run the controlled local file task.',
      { requestId: 'probe-work', timeoutMs: 60_000, signal }))).then(rows => {
      done = true;
      result.workMs = performance.now() - workStart;
      return rows;
    });
    result.execution = [];
    while (!done) {
      result.execution.push(await sample(pids));
      await delay(1000, undefined, { signal });
    }
    const outcomes = await work;
    result.startDelaysMs = startDelays;
    assert.equal(startDelays.length, count, 'Every dispatched turn must have an observed Worker start');
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') throw outcome.reason;
      assert.equal(outcome.value.settled.output, marker);
    }
    assert.equal(upstreamRequests, count * 2);
    assert.equal(upstreamFailure, false);
    result.afterWork = await sample(pids);
    if (count === 1) {
      await delay(2000, undefined, { signal });
      let unsubscribe = () => {};
      const exit = new Promise<number>(resolve => {
        unsubscribe = runtime!.onEvent(event => {
          if (event.agentId === agents[0].id && event.type === 'exit' && !event.expected) resolve(performance.now());
        });
      });
      try {
        const stoppedAt = performance.now();
        await run('docker', ['exec', containers[0], '/usr/bin/python3', '-I', '-c', terminatePi], { timeout: 4000, signal });
        result.unexpectedExitMs = await Promise.race([
          exit.then(at => at - stoppedAt), delay(3000, Infinity, { signal, ref: false }),
        ]);
        assert.ok(Number.isFinite(result.unexpectedExitMs), 'Pi exit was not observed');
      } finally { unsubscribe(); }
    }
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = { code: error?.code ?? error?.name, message: error?.message };
  } finally {
    try {
      if (runtime) {
        const stopping = performance.now();
        const close = await runtime.close({ timeoutMs: 120_000 });
        result.cleanupMs = performance.now() - stopping;
        result.cleanup = close.cleanup;
        result.remainingContainers = (await ownedContainers(runtime.id)).length;
        const groups: string[] = result.idle?.[0].sandboxes.map(sandbox => sandbox.cgroup) ?? [];
        result.remainingCgroups = (await Promise.all(groups.map(async group => {
          try { await access('/sys/fs/cgroup' + group); return true; }
          catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        }))).filter(Boolean).length;
        if (result.cleanup !== 'complete' || result.remainingContainers || result.remainingCgroups) result.status = 'failed';
      }
    } catch (error) {
      result.status = 'failed';
      result.cleanup = 'pending';
      result.cleanupFailure = error?.code ?? error?.name ?? 'CLEANUP_UNCONFIRMED';
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>(resolve => { probeServer.close(() => resolve()); probeServer.closeAllConnections(); });
      await writeFile(join(directory, `tier-${count}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
    }
  }
  return result.status;
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ image, sizes, idleMs, startConcurrency, fileBytes,
  node: process.version, kernel: release(), cpus: availableParallelism(), source: (await run('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  docker: (await run('docker', ['info', '--format', '{{.ServerVersion}} cgroup-v{{.CgroupVersion}}'])).stdout.trim(),
}, null, 2), { mode: 0o600 });
console.log(directory);
for (const count of sizes) {
  const status = await measure(count);
  console.log(count, status);
  if (status !== 'passed') { process.exitCode = 1; break; }
}

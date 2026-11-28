import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { isIPv4 } from 'node:net';
import { mkdir, readFile, writeFile, appendFile, readdir, readlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { ConnectionConfig, SandboxApiException, SandboxManager } from '@alibaba-group/opensandbox';
import { createRuntime, createSandbox, ServiceRegistry, createInProcessAdapter } from '@luna-shi/murm';
import { streamResponse } from '../../scripts/local-setup-upstream.js';
import { checkLedger } from './check-ledger.js';
import { finishCleanup } from './cleanup.js';
import { mockCapacityPlan, runMockCapacity } from './mock-capacity.js';

const tiers = new Map([[2, 0], [8, 900_000]]);
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digestReference = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const nearestRank = (values: number[], fraction: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
const summary = (values: number[], failures: number) => ({ samples: values.length + failures, successes: values.length, failures,
  errorRate: failures / Math.max(1, values.length + failures), p50: nearestRank(values, .5), p95: nearestRank(values, .95), p99: nearestRank(values, .99), maximum: values.length ? values.reduce((maximum, value) => Math.max(maximum, value), 0) : null });
const fail = (message: string) => Object.assign(new Error(message), { code: 'BENCHMARK_BLOCKED' });

function plan(manifest: any) {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(tiers.has(manifest.tier), 'Real cluster tiers are 2 and 8. Tiers of 32 and above require workloadMode mock-api');
  for (const field of ['implementationCommit', 'prerequisiteCommit']) assert.match(manifest[field], /^[a-f0-9]{40}$/);
  assert.match(manifest.workerImage, digestReference);
  assert.equal(manifest.executor, 'pi', 'This fixture exercises actual Pi 1.3.0');
  assert.equal(manifest.executorVersion, '1.3.0');
  assert.equal(manifest.workerProtocol, 'murm-core-v2');
  assert.match(manifest.deploymentId, /^[A-Za-z0-9_.:-]{1,128}$/);
  assert.ok(typeof manifest.seed === 'string' && manifest.seed.length >= 16 && manifest.seed.length <= 256);
  for (const field of ['lifecycleUrl', 'runtimePublicUrl']) {
    const url = new URL(manifest[field]);
    assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
    assert.ok(!['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname), 'Cluster addresses must be reachable across nodes');
  }
  assert.ok(isIPv4(new URL(manifest.runtimePublicUrl).hostname), 'The dns+nft fixture requires the Runtime callback Service IPv4 address');
  assert.ok(['cold', 'warm', 'mixed'].includes(manifest.imageCache));
  for (const key of ['runtimeBindPort', 'maxDurationMs', 'cleanupDeadlineMs', 'maxModelRequests', 'maxRssBytes', 'agentCpuMilli', 'agentMemoryMiB', 'egressCpuMilli', 'egressMemoryMiB', 'createConcurrency', 'workConcurrency', 'exportConcurrency', 'controlTimeoutMs', 'retentionMs']) {
    assert.ok(Number.isSafeInteger(manifest[key]) && manifest[key] > 0, `${key} must be a positive integer`);
  }
  assert.ok(manifest.runtimeBindPort <= 65535 && manifest.createConcurrency <= 32 && manifest.workConcurrency <= 128 && manifest.exportConcurrency <= 32);
  assert.ok(manifest.cleanupDeadlineMs <= 900_000 && manifest.controlTimeoutMs <= 60_000 && manifest.retentionMs <= 3_600_000);
  assert.ok(manifest.maxDurationMs <= 6 * 3_600_000 && manifest.maxRssBytes >= 256 * 1024 ** 2);
  const steadyMs = tiers.get(manifest.tier)!;
  const cadenceMs = 30_000;
  const metricRounds = Math.ceil(200 / manifest.tier) + 2;
  const steadyRounds = Math.max(2, Math.ceil(steadyMs / cadenceMs) + 1);
  const churnWaves = 1;
  const minimumModelRequests = manifest.tier * 2 * (2 + metricRounds + steadyRounds + (churnWaves - 1) * 2);
  assert.ok(manifest.maxModelRequests >= minimumModelRequests, `maxModelRequests must cover at least ${minimumModelRequests} attempts`);
  assert.ok(manifest.maxDurationMs >= steadyMs + manifest.cleanupDeadlineMs + 120_000, 'Duration must include startup, metrics, steady work and independent cleanup');
  const computeHours = manifest.tier * (manifest.agentCpuMilli + manifest.egressCpuMilli) / 1000 * manifest.maxDurationMs / 3_600_000;
  const budget = manifest.budget;
  assert.ok(budget && typeof budget.existingResourceDescription === 'string' && !budget.existingResourceDescription.includes('REPLACE'));
  assert.ok(typeof budget.newResources === 'string' && budget.newResources);
  for (const key of ['maxComputeHours', 'estimatedCostUsd', 'maxCostUsd', 'hourlyCostUsd']) assert.ok(Number.isFinite(budget[key]) && budget[key] >= 0, `budget.${key} must be finite`);
  assert.ok(budget.maxComputeHours >= computeHours && budget.estimatedCostUsd <= budget.maxCostUsd && budget.currency === 'USD');
  assert.ok(budget.hourlyCostUsd * manifest.maxDurationMs / 3_600_000 <= budget.maxCostUsd, 'Approved maximum cost must cover the entire declared duration');
  const { authorization: _authorization, ...parameters } = manifest;
  const manifestSha256 = sha256(JSON.stringify(parameters));
  return { schemaVersion: 1, status: 'not-run', tier: manifest.tier, steadyMs, cadenceMs, metricRounds, steadyRounds, churnWaves,
    minimumModelRequests, declaredMaximumModelRequests: manifest.maxModelRequests, maximumComputeHours: computeHours, manifestSha256,
    execution: 'Requires --execute, an explicit owner approval bound to this hash, and MURM_CLUSTER_EXECUTION_APPROVAL equal to this hash' };
}

async function command(file: string, args: string[], signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, signal });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 ** 2) child.kill(); else chunks.push(chunk); });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(fail(`${file} failed with exit ${code}`)));
  });
}
const kube = async (args: string[], signal?: AbortSignal) => JSON.parse(await command('kubectl', [...args, '-o', 'json'], signal));
const cpuMilli = (value: string) => value.endsWith('m') ? Number(value.slice(0, -1)) : Number(value) * 1000;
function memoryMiB(value: string) {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value);
  assert.ok(match, 'Unsupported observed Kubernetes memory quantity');
  return Number(match[1]) * ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4 }[match[2]] ?? 1) / 1024 ** 2;
}

async function preflight(manifest: any, planned: ReturnType<typeof plan>) {
  assert.equal(manifest.authorization?.approved, true, 'Explicit owner experiment approval is required');
  assert.ok(typeof manifest.authorization.source === 'string' && manifest.authorization.source && !manifest.authorization.source.includes('REPLACE'));
  assert.equal(manifest.authorization.approvedManifestSha256, planned.manifestSha256);
  assert.equal(process.env.MURM_CLUSTER_EXECUTION_APPROVAL, planned.manifestSha256, 'Explicit execution hash must match the reviewed manifest');
  assert.ok(Date.parse(manifest.authorization.expiresAt) >= Date.now() + manifest.maxDurationMs, 'Approval must cover the declared run and cleanup window');
  assert.ok(process.env.OPEN_SANDBOX_API_KEY, 'Resolve the API key through the private environment');
  const [bomBytes, siteBytes, inventoryBytes, vmBytes] = await Promise.all(['bomPath', 'sitePath', 'clusterInventoryPath', 'workerVmEvidencePath'].map(field => readFile(resolve(manifest[field]))));
  const bom = JSON.parse(bomBytes.toString());
  const site = JSON.parse(siteBytes.toString());
  const inventory = JSON.parse(inventoryBytes.toString());
  const vm = JSON.parse(vmBytes.toString());
  assert.equal(bom.opensandbox.sourceCommit, 'db708c218771a8d311356f0e96552c15df6e097a');
  assert.equal(bom.opensandbox.sdk, '@alibaba-group/opensandbox@1.2.1');
  assert.equal(site.workerImage, manifest.workerImage);
  assert.equal(bom.murm.workerProtocol, manifest.workerProtocol);
  assert.equal(bom.murm.piVersion, manifest.executorVersion);
  assert.equal(site.trustedPrivateNetwork, true);
  assert.ok(inventory.nodes?.length >= 2 && inventory.kubernetes && inventory.cni?.length);
  assert.ok(Date.now() - Date.parse(inventory.observedAt) < 24 * 3_600_000, 'Refresh target cluster inventory within 24 hours');
  assert.ok(vm && Array.isArray(vm.instances) && vm.instances.length >= 2 && vm.source && vm.verifiedByOwner === true, 'Independent VM/host-instance evidence is required');
  assert.ok(vm.instances.every((instance: any) => instance.nodeName && instance.instanceId && instance.hostType === 'vm'), 'Evidence must identify real worker VMs');
  assert.ok(new Set(vm.instances.map((instance: any) => instance.instanceId)).size >= 2, 'Distinct worker VM instances are required');
  const revision = (await command('git', ['rev-parse', 'HEAD'])).trim();
  assert.equal(revision, manifest.implementationCommit);
  assert.equal((await command('git', ['status', '--porcelain', '--untracked-files=no'])).trim(), '', 'Pin a clean implementation tree before execution');
  const nodeSelector = Object.entries(site.sandboxNodeSelector).map(([key, value]) => `${key}=${value}`).join(',');
  const nodes = await kube(['get', 'nodes', '-l', nodeSelector]);
  const ready = nodes.items.filter((node: any) => !node.spec.unschedulable && node.status.conditions.some((row: any) => row.type === 'Ready' && row.status === 'True'));
  assert.ok(ready.length >= 2);
  const requiredCpu = manifest.agentCpuMilli + manifest.egressCpuMilli;
  const requiredMemory = manifest.agentMemoryMiB + manifest.egressMemoryMiB;
  const existing = await kube(['get', 'pods', '-A']);
  let capacity = 0;
  for (const node of ready) {
    const evidence = vm.instances.find((instance: any) => instance.nodeName === node.metadata.name);
    assert.ok(evidence, 'Every selected node requires independent VM evidence');
    const active = existing.items.filter((pod: any) => pod.spec.nodeName === node.metadata.name && !['Succeeded', 'Failed'].includes(pod.status.phase));
    let usedCpu = 0, usedMemory = 0;
    for (const pod of active) for (const container of [...pod.spec.containers, ...(pod.spec.initContainers ?? [])]) {
      usedCpu += cpuMilli(container.resources?.requests?.cpu ?? '0');
      usedMemory += memoryMiB(container.resources?.requests?.memory ?? '0');
    }
    const cpu = cpuMilli(node.status.allocatable.cpu) - usedCpu;
    const memory = memoryMiB(node.status.allocatable.memory) - usedMemory;
    capacity += Math.max(0, Math.floor(Math.min(cpu / requiredCpu, memory / requiredMemory)));
  }
  assert.ok(capacity >= manifest.tier, 'Selected nodes have insufficient unreserved CPU/memory for this tier');
  const [runnerBytes, fixtureBytes, cleanupBytes] = await Promise.all([
    readFile(new URL(import.meta.url)), readFile(new URL('../../scripts/local-setup-upstream.js', import.meta.url)),
    readFile(new URL('./cleanup.js', import.meta.url)),
  ]);
  return { site, vm, nodeSelector, hashes: { bom: sha256(bomBytes), site: sha256(siteBytes), inventory: sha256(inventoryBytes), vmEvidence: sha256(vmBytes), executable: sha256(runnerBytes), responsesFixture: sha256(fixtureBytes), cleanup: sha256(cleanupBytes), workdirFixture: sha256('murm-kubernetes-capacity-v1') }, capacity };
}

async function boundedMap<T>(items: T[], concurrency: number, action: (item: T, index: number) => Promise<void>, signal?: AbortSignal) {
  let next = 0;
  const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next++;
      await action(items[index], index);
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

let executionStarted = false;

async function execute(manifest: any, planned: ReturnType<typeof plan>) {
  const verified = await preflight(manifest, planned);
  executionStarted = true;
  const output = resolve(manifest.outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ ...manifest, plan: planned, actualInputHashes: verified.hashes }, null, 2), { mode: 0o600, flag: 'wx' });
  const started = performance.now();
  const shutdown = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => shutdown.abort(fail(name)));
  const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(manifest.maxDurationMs - manifest.cleanupDeadlineMs)]);
  const controls: Record<string, { values: number[]; failures: number }> = Object.fromEntries(['send', 'steer', 'followUp', 'interrupt', 'event'].map(name => [name, { values: [], failures: 0 }]));
  const stages: Record<string, number[]> = { ready: [], inputToSettled: [], close: [], export: [], podObservation: [] };
  const report: any = { schemaVersion: 1, tier: manifest.tier, status: 'running', capacityClaim: false, planned,
    model: { kind: 'controlled Responses fixture', requests: 0, failures: 0 }, controllerSamples: 0, waves: [], lifecycleReconciliation: [],
    faultMatrix: { status: 'not-run', reason: 'Run the separate approved crash, partition and retention protocol before closing #273' },
    costs: { currency: 'USD', estimatedCostUsd: manifest.budget.estimatedCostUsd, maxCostUsd: manifest.budget.maxCostUsd },
    diagnosticsUnavailable: ['Measured Worker/Pi/egress peak usage; declared requests are reservations, not empirical peak evidence'],
    controllerLocation: { nodeName: process.env.MURM_RUNTIME_NODE_NAME ?? null, hostname: process.env.HOSTNAME ?? null },
    metricMethod: { control: 'Public Runtime method return after authoritative Worker acknowledgement, including queueing; unknown and timeout count as failure',
      event: 'Monotonic Runtime probe roundtrip through the ordinary Worker event channel and committed cursor', percentile: 'nearest rank', clock: 'Controller monotonic clock' } };
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let stopSampling = false;
  let samplingFailure: unknown;
  let cleanupDeadline: number | undefined;
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  const sampling = (async () => {
    while (!stopSampling) {
      const memory = process.memoryUsage();
      const descriptors = await readdir('/proc/self/fd');
      let socketDescriptors = 0;
      for (const fd of descriptors) {
        if ((await readlink(`/proc/self/fd/${fd}`).catch(() => '')).startsWith('socket:[')) socketDescriptors++;
      }
      const row = { elapsedMs: performance.now() - started, rss: memory.rss, heapUsed: memory.heapUsed,
        fd: descriptors.length, socketDescriptors, runtime: runtime?.diagnostics() ?? null,
        cpu: process.cpuUsage(), eventLoopLagP99Ms: loop.percentile(99) / 1e6 };
      await appendFile(join(output, 'controller-samples.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
      report.controllerSamples++;
      if (memory.rss > manifest.maxRssBytes) throw fail('Controller RSS exceeded the approved bound');
      await delay(1000);
    }
  })().catch(error => { samplingFailure = error; shutdown.abort(error); });
  const administrativeConnection = new ConnectionConfig({ domain: manifest.lifecycleUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1', apiKey: process.env.OPEN_SANDBOX_API_KEY, disableMetrics: true, requestTimeoutSeconds: 15, wakeRetryEnabled: false }).withTransportIfMissing();
  const lifecycle = SandboxManager.create({ connectionConfig: administrativeConnection });
  const runs: { id: string; directory: string }[] = [];
  let activeDatabase: DatabaseSync | undefined;
  let upstreamServer: ReturnType<typeof createServer> | undefined;
  try {
    await lifecycle.listSandboxInfos({ page: 1, pageSize: 1 });
    for (let wave = 0; wave < planned.churnWaves; wave++) {
      signal.throwIfAborted();
      const waveOutput = join(output, `wave-${wave}`);
      await mkdir(waveOutput, { recursive: true, mode: 0o700 });
      const database = new DatabaseSync(join(waveOutput, 'service.sqlite'));
      activeDatabase = database;
      database.exec('PRAGMA journal_mode=WAL; CREATE TABLE facts (slot INTEGER NOT NULL, round INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(slot,round));');
      const owners = new Map<number, string>();
      const expectedDigest = (slot: number, round: number) => sha256(`${manifest.seed}:${wave}:${slot}:${round}`);
      const services = new ServiceRegistry();
      const schema = { type: 'object', additionalProperties: false, properties: { slot: { type: 'integer', minimum: 0, maximum: manifest.tier - 1 }, round: { type: 'integer', minimum: 0, maximum: 100000 } }, required: ['slot', 'round'] };
      services.registerService({ manifest: { id: 'capacity', title: 'Capacity handoff', purpose: 'Publish and read independently checked file digests', provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' }, capabilities: [
        { name: 'publish', operation: 'publish', description: 'Publish your verified file digest', side_effect: 'write', idempotent: true, help: { when: 'After writing probe.txt' }, input_schema: { ...schema, properties: { ...schema.properties, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['slot', 'round', 'sha256'] }, output_schema: { type: 'object', properties: { sha256: { type: 'string' } }, required: ['sha256'], additionalProperties: false }, errors: [] },
        { name: 'read', operation: 'read', description: 'Read the previous peer digest', side_effect: 'read', idempotent: true, help: { when: 'Verifying another Agent result' }, input_schema: schema, output_schema: { type: 'object', properties: { sha256: { type: 'string' } }, required: ['sha256'], additionalProperties: false }, errors: [] },
      ] }, adapter: createInProcessAdapter({ invoke(request) {
        request.assertAuthorized();
        const input = request.input as any;
        if (request.capability.operation === 'publish') {
          assert.equal(owners.get(input.slot), request.caller.agentId);
          assert.equal(input.sha256, expectedDigest(input.slot, input.round));
          database.prepare('INSERT INTO facts(slot, round, sha256) VALUES(?,?,?) ON CONFLICT(slot,round) DO NOTHING').run(input.slot, input.round, input.sha256);
        }
        const row = database.prepare('SELECT sha256 FROM facts WHERE slot=? AND round=?').get(input.slot, input.round) as { sha256: string } | undefined;
        assert.ok(row, 'Peer must publish before another Agent reads');
        return { sha256: row.sha256 };
      }, exportState() { return { database: 'service.sqlite', facts: Number((database.prepare('SELECT count(*) AS count FROM facts').get() as any).count) }; } }) });
      const rounds = new Map<string, { slot: number; round: number }>();
      let sequence = 0;
      const upstream = createServer(async (request, response) => {
        try {
          signal.throwIfAborted();
          assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
          assert.ok(++report.model.requests <= manifest.maxModelRequests, 'Model attempt budget exceeded');
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
          const body = JSON.parse(Buffer.concat(chunks).toString());
          assert.equal(body.model, 'k3');
          const user = body.input.filter((item: any) => item.role === 'user').at(-1);
          const text = typeof user?.content === 'string' ? user.content : user?.content?.map((part: any) => part.text ?? '').join('');
          const selected = rounds.get(text);
          assert.ok(selected, 'Only the registered immutable workload may execute');
          const { slot, round } = selected;
          const callId = `capacity_${wave}_${slot}_${round}`;
          const returned = body.input.find((item: any) => item.type === 'function_call_output' && item.call_id === callId);
          let item;
          if (!returned) {
            const peer = (slot + manifest.tier - 1) % manifest.tier;
            const code = `import fs from 'node:fs'; import assert from 'node:assert/strict'; import {createHash} from 'node:crypto'; import {execFileSync} from 'node:child_process';
const content = ${JSON.stringify(`${manifest.seed}:${wave}:${slot}:${round}`)};
fs.writeFileSync('probe.txt', content);
const digest = createHash('sha256').update(fs.readFileSync('probe.txt')).digest('hex');
assert.equal(digest, ${JSON.stringify(expectedDigest(slot, round))});
const cli = (operation, input) => { fs.writeFileSync('request.json', JSON.stringify(input)); return JSON.parse(execFileSync('swarm', ['service','invoke','capacity',operation,'--input','request.json','--request-id', ${JSON.stringify(callId)} + '-' + operation], {encoding:'utf8', timeout:15000})); };
assert.equal(cli('publish', {slot:${slot}, round:${round}, sha256:digest}).sha256, digest);
const peerDigest = ${round ? `cli('read', {slot:${peer}, round:${round - 1}}).sha256` : 'null'};
${round ? `assert.equal(peerDigest, ${JSON.stringify(expectedDigest(peer, round - 1))});` : ''}
let pid = process.ppid; let observed = false;
for (let n=0; n<16 && pid>1; n++) { const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8'); const name=stat.slice(stat.indexOf('(')+1,stat.lastIndexOf(')')); const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8'); if (['pi','pi-rpc'].includes(name) || argv.includes('/pi-coding-agent/') || argv.includes('/.bin/pi')) {observed=true; break;} pid=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]); }
assert.ok(observed, 'Actual Pi ancestor must execute the controlled tool');
assert.equal(JSON.parse(fs.readFileSync('/opt/murm/executor/node_modules/@earendil-works/pi-coding-agent/package.json','utf8')).version, '1.3.0');
const proof = {slot:${slot}, round:${round}, digest, peerDigest, executorObserved:observed}; fs.writeFileSync('proof.json', JSON.stringify(proof)); console.log(JSON.stringify(proof));`;
            item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'bash', arguments: JSON.stringify({ command: `node --input-type=module <<'MURM_CAPACITY'\n${code}\nMURM_CAPACITY`, timeout: 25 }) };
          } else {
            const proof = JSON.parse(returned.output.trim());
            assert.equal(proof.slot, slot); assert.equal(proof.round, round); assert.equal(proof.digest, expectedDigest(slot, round)); assert.equal(proof.executorObserved, true);
            if (round) assert.equal(proof.peerDigest, expectedDigest((slot + manifest.tier - 1) % manifest.tier, round - 1));
            item = { type: 'message', id: `msg_${callId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `CAPACITY_OK_${slot}_${round}`, annotations: [] }] };
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' }).end(streamResponse('k3', ++sequence, item));
        } catch {
          report.model.failures++;
          response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'CONTROLLED_CAPACITY_PROTOCOL_FAILED' } }));
        }
      });
      upstreamServer = upstream;
      upstream.requestTimeout = 30_000; upstream.headersTimeout = 10_000;
      upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
      runtime = await createRuntime({ sandbox: createSandbox({ endpoint: manifest.lifecycleUrl, apiKey: process.env.OPEN_SANDBOX_API_KEY, egressMode: 'dns+nft', timeoutSeconds: 300,
        resourceRequests: { cpu: `${manifest.agentCpuMilli}m`, memory: `${manifest.agentMemoryMiB}Mi` }, resourceLimits: { cpu: `${manifest.agentCpuMilli}m`, memory: `${manifest.agentMemoryMiB}Mi` } }),
        executor: 'pi', maxAgents: manifest.tier, outputDir: waveOutput, services,
        persistence: { deploymentId: manifest.deploymentId, contract: 'murm-kubernetes-capacity-v1', retainForMs: manifest.retentionMs },
        operationLimits: { prepare: manifest.createConcurrency, stop: manifest.createConcurrency, transfer: manifest.exportConcurrency, queued: manifest.tier + 32, waitMs: 60_000 },
        connection: { bindHost: manifest.runtimeBindHost, bindPort: manifest.runtimeBindPort, publicUrl: manifest.runtimePublicUrl, modelGateway: { maxRequests: manifest.maxModelRequests, maxOutputTokens: 128, requestTimeoutMs: 30_000 } },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `http://127.0.0.1:${(upstream.address() as any).port}/v1/responses`, headers: {} } } },
        profiles: { probe: { image: manifest.workerImage, writable: true, model: 'default', services: { capacity: ['publish', 'read'] }, prompt: 'Execute the fixed approved capacity work and report its checked result.', network: { allow: [] },
          collect: { paths: ['probe.txt', 'proof.json'], maxBytes: 16 * 1024, includeGit: false, required: true } } },
      });
      runs.push({ id: runtime.id, directory: join(waveOutput, runtime.id) });
      const activeRuntime = runtime;
      const agents: any[] = new Array(manifest.tier);
      await boundedMap(Array.from({ length: manifest.tier }), manifest.createConcurrency, async (_unused, slot) => {
        const at = performance.now();
        const agent = await activeRuntime.spawn({ profile: 'probe', requestId: `wave-${wave}-spawn-${slot}` });
        stages.ready.push(performance.now() - at); agents[slot] = agent; owners.set(slot, agent.id);
      }, signal);
      const waveResult: any = { workCadenceMs: planned.cadenceMs, workConcurrency: manifest.workConcurrency, declaredAgentsWorkedPerRound: manifest.tier, wave, runtimeId: runtime.id, agents: agents.length, rounds: 0, steadyMs: 0, topologySnapshots: [], artifacts: 0 };
      report.waves.push(waveResult);
      const settled = new Map<string, { resolve(value: any): void; reject(error: unknown): void }>();
      const unsubscribe = runtime.onEvent(event => { if ('agentId' in event && event.type === 'settled') settled.get(event.agentId)?.resolve(event); });
      const observePods = async (label: string) => {
        const at = performance.now();
        const runtimeKey = `r-${sha256(runtime!.id).slice(0, 48)}`;
        const pods = await kube(['get', 'pods', '-n', 'opensandbox', '-l', `runtime_key=${runtimeKey}`], signal);
        stages.podObservation.push(performance.now() - at);
        await writeFile(join(waveOutput, `pods-${label}.json`), JSON.stringify(pods), { mode: 0o600, flag: 'wx' });
        assert.equal(pods.items.length, manifest.tier, 'Every live Agent requires its own independently observed Pod');
        const nodes = new Set<string>();
        for (const pod of pods.items) {
          assert.ok(pod.metadata.uid && pod.spec.nodeName && pod.status.phase === 'Running' && !pod.metadata.deletionTimestamp);
          assert.ok(verified.vm.instances.some((item: any) => item.nodeName === pod.spec.nodeName));
          nodes.add(pod.spec.nodeName);
          assert.ok(pod.status.containerStatuses?.every((item: any) => item.ready && item.restartCount === 0 && item.imageID), 'Live containers must be ready with stable image identities');
          const main = pod.spec.containers.find((container: any) => container.image === manifest.workerImage);
          const egress = pod.spec.containers.find((container: any) => /opensandbox\/egress/.test(container.image));
          assert.ok(main && egress);
          for (const [container, cpu, memory] of [[main, manifest.agentCpuMilli, manifest.agentMemoryMiB], [egress, manifest.egressCpuMilli, manifest.egressMemoryMiB]]) {
            assert.ok(cpuMilli(container.resources?.requests?.cpu ?? '0') >= cpu && memoryMiB(container.resources?.requests?.memory ?? '0') >= memory, 'Actual Pod requests must cover the declared resource budget');
            assert.ok(container.resources?.limits?.cpu && container.resources?.limits?.memory, 'Each runtime container must have finite CPU/memory limits');
          }
        }
        assert.ok(nodes.size >= 2, 'Agents must actually occupy at least two distinct worker VMs');
        const identities = pods.items.map((pod: any) => ({ uid: pod.metadata.uid, node: pod.spec.nodeName }));
        waveResult.topologySnapshots.push({ label, digest: sha256(JSON.stringify(identities)), nodes: nodes.size, pods: identities.length });
        return identities;
      };
      const initialPods = await observePods('ready');
      let closeDeadline: number;
      let nextRound = 0;
      const round = async (measured: boolean) => {
        const selectedRound = nextRound++;
        await boundedMap(agents, manifest.workConcurrency, async (agent, slot) => {
          const key = `CAPACITY_${wave}_${slot}_${selectedRound}`;
          rounds.set(key, { slot, round: selectedRound });
          const completion = Promise.withResolvers<any>();
          settled.set(agent.id, completion);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const mode = selectedRound % 2 ? 'followUp' : 'steer';
          const at = performance.now();
          let accepted = false;
          try {
            const receipt = await activeRuntime.send(agent.id, key, { requestId: key, mode });
            const elapsed = performance.now() - at;
            if (receipt.status !== 'accepted') throw fail('Worker input acknowledgement is unknown');
            accepted = true;
            if (measured) { controls.send.values.push(elapsed); controls[mode].values.push(elapsed); }
            const event = await Promise.race([completion.promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(fail('Settled deadline exceeded')), manifest.controlTimeoutMs); })]);
            assert.equal(event.outcome, 'completed'); assert.equal(event.output, `CAPACITY_OK_${slot}_${selectedRound}`);
            stages.inputToSettled.push(performance.now() - at);
          } catch (error) {
            if (measured && !accepted) { controls.send.failures++; controls[mode].failures++; }
            throw error;
          } finally { clearTimeout(timer); settled.delete(agent.id); }
        }, signal);
        waveResult.rounds++;
      };
      try {
        for (let n = 0; n < 2; n++) await round(false);
        if (wave === 0) {
          for (let n = 0; n < planned.metricRounds; n++) await round(true);
          await boundedMap(agents, manifest.workConcurrency, async (agent, slot) => {
            for (let index = slot; index < 100; index += agents.length) {
              const at = performance.now();
              try { const receipt = await activeRuntime.interrupt(agent.id, { requestId: `metric-interrupt-${index}`, timeoutMs: manifest.controlTimeoutMs });
                assert.equal(receipt.status, 'interrupted'); controls.interrupt.values.push(performance.now() - at);
              } catch (error) { controls.interrupt.failures++; throw error; }
            }
          }, signal);
          assert.equal(typeof activeRuntime.probeWorkerEvent, 'function', 'Candidate must implement the normal durable Worker event probe');
          await boundedMap(agents, manifest.workConcurrency, async (agent, slot) => {
            for (let index = slot; index < 1000; index += agents.length) {
              try { const receipt = await activeRuntime.probeWorkerEvent(agent.id, { requestId: `metric-event-${index}`, timeoutMs: manifest.controlTimeoutMs });
                assert.ok(Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0); controls.event.values.push(receipt.elapsedMs);
              } catch (error) { controls.event.failures++; throw error; }
            }
          }, signal);
          const steadyStart = performance.now();
          let nextAt = steadyStart;
          do {
            signal.throwIfAborted();
            const roundStart = performance.now();
            await round(true);
            assert.ok(performance.now() - roundStart < 60_000, 'Each live Agent must complete work within the per-minute cadence');
            waveResult.steadyMs = performance.now() - steadyStart;
            nextAt += planned.cadenceMs;
            if (waveResult.steadyMs < planned.steadyMs) await delay(Math.max(0, nextAt - performance.now()), undefined, { signal });
          } while (performance.now() - steadyStart < planned.steadyMs || waveResult.rounds < 2);
          waveResult.steadyMs = performance.now() - steadyStart;
        }
        const finalPods = await observePods('finished');
        assert.deepEqual(finalPods.sort((a: any, b: any) => a.uid.localeCompare(b.uid)), initialPods.sort((a: any, b: any) => a.uid.localeCompare(b.uid)), 'Warmup, stable work and metrics must use the same Pods');
        closeDeadline = cleanupDeadline = performance.now() + manifest.cleanupDeadlineMs;
        const stopSignal = AbortSignal.timeout(manifest.cleanupDeadlineMs);
        await boundedMap(agents, manifest.exportConcurrency, async (agent, slot) => {
          const at = performance.now();
          const stop = await finishCleanup(timeoutMs => activeRuntime.stop(agent.id, { timeoutMs }), closeDeadline);
          stages.export.push(performance.now() - at);
          assert.equal(stop.execution, 'stopped'); assert.equal(stop.cleanup, 'complete'); assert.ok(stop.sessionArchive && stop.artifacts.length);
          const files = stop.artifacts.find((path: string) => path.endsWith('/artifacts/files'));
          assert.ok(files);
          const proof = JSON.parse(await readFile(join(files, 'proof.json'), 'utf8'));
          assert.equal(proof.digest, expectedDigest(slot, nextRound - 1));
          assert.equal(sha256(await readFile(join(files, 'probe.txt'))), proof.digest);
          waveResult.artifacts++;
        }, stopSignal);
      } finally { unsubscribe(); }
      const at = performance.now();
      const closed = await finishCleanup(timeoutMs => activeRuntime.close({ timeoutMs }), closeDeadline);
      stages.close.push(performance.now() - at);
      assert.equal(closed.cleanup, 'complete');
      runtime = undefined;
      await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }); upstreamServer = undefined;
      database.close(); activeDatabase = undefined;
    }
    if (samplingFailure) throw samplingFailure;
    assert.equal(report.model.failures, 0);
    for (const name of ['send', 'steer', 'followUp', 'interrupt']) {
      const value = summary(controls[name].values, controls[name].failures);
      assert.ok(value.samples >= 100 && value.failures === 0 && value.p95! < 1000, `${name} requires at least 100 successful samples and p95 < 1 second`);
    }
    const events = summary(controls.event.values, controls.event.failures);
    assert.ok(events.samples >= 1000 && events.failures === 0 && events.p95! < 2000, 'Events require at least 1000 successful samples and p95 < 2 seconds');
    report.status = 'passed-workload';
  } catch (error) {
    report.status = 'failed';
    report.error = { code: (error as any)?.code ?? (error as Error)?.name, message: (error as Error)?.message };
  } finally {
    // Cleanup has a separate deadline and is independent of the work cancellation.
    const deadline = cleanupDeadline ?? performance.now() + manifest.cleanupDeadlineMs;
    const cleanupSignal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
    if (runtime) {
      try {
        const closing = runtime;
        const closed = await finishCleanup(timeoutMs => closing.close({ timeoutMs }), deadline);
        report.finalClose = { cleanup: closed.cleanup, pending: closed.pending, errors: closed.errors };
        if (closed.cleanup !== 'complete') report.status = 'failed';
      } catch { report.status = 'failed'; report.finalClose = { cleanup: 'unknown' }; }
    }
    upstreamServer?.closeAllConnections(); upstreamServer?.close(); activeDatabase?.close();
    try {
      for (const { id: runtimeId, directory } of runs) {
        const runtimeKey = `r-${sha256(runtimeId).slice(0, 48)}`;
        const resources: any[] = [];
        for (let page = 1; ; page++) {
          cleanupSignal.throwIfAborted();
          const listed = await lifecycle.listSandboxInfos({ page, pageSize: 100, metadata: { runtime_key: runtimeKey } });
          resources.push(...listed.items);
          if (!listed.pagination?.hasNextPage) break;
        }
        const { sandboxIds, ...ledger } = checkLedger(directory, runtimeId, manifest.tier);
        const selected = ['-n', 'opensandbox', '-l', `runtime_key=${runtimeKey}`];
        let pods, batch;
        do {
          [pods, batch] = await Promise.all([
            kube(['get', 'pods', ...selected], cleanupSignal),
            kube(['get', 'batchsandboxes', ...selected], cleanupSignal),
          ]);
          if (!ledger.complete || !pods.items.length && !batch.items.length) break;
          await delay(500, undefined, { signal: cleanupSignal });
        } while (!cleanupSignal.aborted);
        await writeFile(join(output, `final-${sha256(runtimeId).slice(0, 12)}.json`), JSON.stringify({ runtimeId, resources, pods, batch }), { mode: 0o600, flag: 'wx' });
        let knownSandboxesStillPresent = 0;
        await boundedMap(sandboxIds, manifest.createConcurrency, async sandboxId => {
          try {
            await lifecycle.getSandboxInfo(sandboxId);
            knownSandboxesStillPresent++;
          } catch (error) {
            if (!(error instanceof SandboxApiException && error.statusCode === 404)) throw error;
          }
        }, cleanupSignal);
        const row = { runtimeId, sandboxes: resources.length, pods: pods.items.length, batchSandboxes: batch.items.length,
          knownSandboxesChecked: sandboxIds.length, knownSandboxesStillPresent, ledger };
        report.lifecycleReconciliation.push(row);
        if (!ledger.complete || row.sandboxes || row.pods || row.batchSandboxes || knownSandboxesStillPresent) report.status = 'failed';
      }
    } catch { report.status = 'failed'; report.reconciliation = 'unconfirmed'; }
    await lifecycle.close();
    await administrativeConnection.closeTransport();
    stopSampling = true; await sampling; loop.disable();
    if (samplingFailure) report.status = 'failed';
    report.elapsedMs = performance.now() - started;
    report.metrics = Object.fromEntries(Object.entries(controls).map(([name, data]) => [name, summary(data.values, data.failures)]));
    report.stageMetrics = Object.fromEntries(Object.entries(stages).map(([name, values]) => [name, summary(values, 0)]));
    report.costs.actualComputeHoursUpperBound = manifest.tier * (manifest.agentCpuMilli + manifest.egressCpuMilli) / 1000 * report.elapsedMs / 3_600_000;
    report.costs.actualInfrastructureCostUpperBoundUsd = manifest.budget.hourlyCostUsd * report.elapsedMs / 3_600_000;
    report.costs.actualProviderBill = 'not-queried; reconcile the operator invoice separately';
    report.capacityClaim = false;
    await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ status: report.status, tier: report.tier, elapsedMs: report.elapsedMs, capacityClaim: false, result: join(output, 'result.json') }));
  if (report.status !== 'passed-workload') process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const filename = args[0];
  assert.ok(filename && args.length <= 2 && (args.length === 1 || args[1] === '--execute'), 'Usage: node dist/benchmarks/kubernetes/capacity.js manifest.json [--execute]');
  const manifest = JSON.parse(await readFile(resolve(filename), 'utf8'));
  if (manifest.tier >= 32) {
    const planned = mockCapacityPlan(manifest);
    if (args[1] !== '--execute') { console.log(JSON.stringify(planned, null, 2)); return; }
    executionStarted = true;
    const result = await runMockCapacity(manifest);
    console.log(JSON.stringify({ status: result.status, tier: result.tier, capacityClaim: false,
      result: join(resolve(manifest.outputDirectory), 'mock-result.json') }));
    return;
  }
  const planned = plan(manifest);
  if (args[1] !== '--execute') { console.log(JSON.stringify(planned, null, 2)); return; }
  await execute(manifest, planned);
}
await main().catch(error => { console.error(JSON.stringify({ status: executionStarted ? 'failed' : 'not-run', code: (error as any)?.code ?? 'BENCHMARK_BLOCKED', reason: (error as Error).message })); process.exitCode = 2; });

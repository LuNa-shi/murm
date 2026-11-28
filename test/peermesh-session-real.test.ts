import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as sourceSdk from '@luna-shi/murm';
import sourcePeerMesh from '../examples/peermesh/project.js';
import { preparePeerMeshFacilities } from '../examples/peermesh/harness/provision.js';
import { httpClient } from '../src/harness/http.js';
import { createLocalPeerMeshStack } from './fixtures/peermesh-local-stack.js';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { installNativeNotesExample } from './fixtures/notes-installed-package.js';
const execute = promisify(execFile);

// Same public built-in project consumed by SDK/RPC, with actual facilities,
// native Worker/Pi and bounded local model responses. No external model access.
test('PeerMesh HarnessSession directs native next-batch input and stops one member while its peer continues', {
  skip: process.env.MURM_PEERMESH_SESSION_REAL_TEST !== '1', timeout: 420_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE; assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const installed = process.env.MURM_TEST_PACKAGE_ARCHIVE ? await installNativeNotesExample() : undefined;
  if (installed) t.after(installed.close);
  const sdk = installed ? createRequire(join(installed.directory, 'consumer.mjs'))('@luna-shi/murm') as typeof sourceSdk : sourceSdk;
  const installedModule = installed && join(installed.directory, 'node_modules/@luna-shi/murm/dist/examples/peermesh/project.js');
  const peerMesh: typeof sourcePeerMesh = installedModule ? (await import(pathToFileURL(installedModule).href)).default : sourcePeerMesh;
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const directory = join(process.cwd(), 'experiments', `peermesh-session-${randomBytes(6).toString('hex')}`);
  const cwd = join(directory, 'project'); await mkdir(cwd, { recursive: true, mode: 0o700 });
  const git = (...args: string[]) => execute('git', ['-C', cwd, ...args], { timeout: 10_000 });
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Controlled acceptance'); await git('config', 'user.email', 'controlled@murm.invalid');
  await writeFile(join(cwd, 'seed.txt'), 'H6_NATIVE_PROJECT_SEED\n'); await git('add', '.'); await git('commit', '-m', 'Native project seed');
  const stack = await createLocalPeerMeshStack({ directory: join(directory, 'facilities'), advertiseHost: host });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const batches: any[] = []; const sockets = new Set<any>(); let failure: string | undefined;
  let session: ReturnType<typeof sdk.createHarnessSession> | undefined, facilities: any, runtimeId: string | undefined;
  let result: any, facilityCleanup: any;
  let deadline = Date.now() + 360_000;
  const wait = async (check: () => unknown | Promise<unknown>, label: string) => {
    while (Date.now() < deadline) { if (await check()) return; if (session && (await session.getState()).phase === 'finished') throw new Error(`Run ended before ${label}: ${(await session.completion)?.reason}`); await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Timed out: ${label}`);
  };
  const upstream = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses'); assert.ok(batches.length < 4 && Date.now() < deadline);
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.model, 'k3'); assert.ok(body.max_output_tokens <= 128);
      const current = body.input.filter((row: any) => row.role === 'user').at(-1);
      const text = typeof current.content === 'string' ? current.content : current.content.map((part: any) => part.text ?? '').join('');
      const batch = JSON.parse(text.slice(text.indexOf('\n') + 1)); batches.push(batch);
      if (batch.source === 'kickoff') await held;
      else { assert.equal(batch.source, 'user'); assert.ok(batch.context.includes('H6_LATEST_SHARED_CONTEXT')); }
      const index = batches.indexOf(batch) + 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse('k3', index, { type: 'message', id: `msg_h6_${index}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: `H6_BATCH_${index}_DONE`, annotations: [] }] }));
    } catch (error) { failure ??= String(error); response.writeHead(400); response.end('Controlled PeerMesh fixture failed'); }
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const report: any = { image, package: installed?.metadata ?? null,
    limits: { agents: 2, modelRequests: 4, setupMs: 180_000, workMs: 120_000, cleanupMs: 100_000 } };
  try {
    const config = await stack.start(); deadline = Date.now() + 120_000;
    session = sdk.createHarnessSession(peerMesh, { outputRoot: join(directory, 'runs'), stopTimeoutMs: 90_000, configuration: {
      ...config, image, executor: sdk.createPiExecutor({ version: process.env.MURM_CORE_TEST_PI_VERSION ?? '1.3.0' }), peerKeys: ['a', 'b'], durationMs: 120_000, closeTimeoutMs: 70_000,
      sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: '127.0.0.1', apiKey: process.env.MURM_CORE_TEST_API_KEY,
        resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000, isolation: { network: 'api' } },
      connection: { bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, maxOutputTokens: 128, requestTimeoutMs: 60_000 } },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `http://127.0.0.1:${(upstream.address() as any).port}/v1/responses`, headers: {} } } },
      router: { workTimeoutMs: 120_000, turnTimeoutMs: 60_000, maxBatches: 4, maxNudges: 0 },
      prepare: async (options: any) => { facilities = await preparePeerMeshFacilities(options); return facilities; },
    } });
    const events: any[] = []; session.onEvent(event => { if (event.type === 'snapshot' || event.type === 'state') events.push({ type: event.type, phase: event.state.phase }); }, { initialSnapshot: true });
    assert.equal((await session.describe()).input.supported, true);
    await session.start({ cwd, prompt: 'H6_KICKOFF' }, { requestId: 'h6-start' });
    await wait(() => batches.length === 2, 'both native kickoff requests'); assert.ok(batches.every(batch => batch.source === 'kickoff'));
    const state = await session.getState(); runtimeId = (state.business as any).runtimeId;
    const peers = (state.business as any).detail.peers; assert.equal(peers.length, 2);
    const a = peers.find((peer: any) => peer.key === 'a').agentId, b = peers.find((peer: any) => peer.key === 'b').agentId;
    assert.equal((await session.agents.getState(a)).executor.version, process.env.MURM_CORE_TEST_PI_VERSION ?? '1.3.0');
    const input = { recipient: 'a', input: 'H6_TARGETED_USER_A' };
    const receipt = await session.input(input, { requestId: 'h6-user-a' }); assert.equal(receipt.status, 'accepted'); assert.equal((receipt.result as any).state, 'queued');
    assert.deepEqual(await session.input(input, { requestId: 'h6-user-a' }), receipt);
    await assert.rejects(session.input({ ...input, recipient: 'b' }, { requestId: 'h6-user-a' }), { code: 'REQUEST_ID_CONFLICT' });
    assert.equal(batches.length, 2);
    const board = httpClient(facilities.endpoints.board);
    const note = await board('POST', `/board/${facilities.boardId}/note`, { thread_id: facilities.peers[1].board.workerId, type: 'FACT', content: 'H6_LATEST_SHARED_CONTEXT', detail: null, delegation_id: null });
    assert.equal(note.status, 'admitted'); release();
    await wait(() => batches.length === 3, 'targeted next batch'); assert.equal(batches[2].eventId, 'h6-user-a'); assert.equal(batches[2].text, input.input);
    await wait(async () => (await session!.agents.getState(a)).active === false, 'target idle');
    await wait(async () => ((await session!.getState()).business as any).detail.peers.find((peer: any) => peer.key === 'a').router.batches
      .some((batch: any) => batch.eventId === 'h6-user-a' && batch.state === 'completed'), 'router completion reflected after final Agent event');
    const stopped: any = await session.agents.stop(a, { requestId: 'h6-stop-a' });
    assert.equal(stopped.core.cleanup, 'complete'); assert.deepEqual(stopped.harnessEffects, { status: 'complete', routerStopped: true, sourceStopped: true });
    await wait(async () => (await ownedContainers(runtimeId!)).length === 1, 'one native member removed');
    const unavailable = (await session.describe()).agents[a].stop; assert.equal(unavailable?.available, false);
    await assert.rejects(session.input({ recipient: 'a', input: 'H6_CLOSED_TARGET' }, { requestId: 'h6-closed' }), { code: 'UNKNOWN_RECIPIENT' });
    assert.equal((await session.input({ recipient: 'b', input: 'H6_TARGETED_USER_B' }, { requestId: 'h6-user-b' })).status, 'accepted');
    await wait(() => batches.length === 4, 'surviving peer request');
    await wait(async () => (await session!.agents.getState(b)).active === false, 'surviving peer settles');
    assert.deepEqual(batches.filter(batch => batch.source === 'user').map(batch => batch.eventId), ['h6-user-a', 'h6-user-b']);
    assert.equal(failure, undefined); report.events = events; report.batches = batches; report.stop = stopped;
    await session.stop({ requestId: 'h6-stop-run', reason: 'controlled-complete' }); result = await session.completion;
    assert.equal(result.cleanup.status, 'complete'); assert.equal(result.export.status, 'complete'); assert.deepEqual(await ownedContainers(runtimeId!), []);
  } finally {
    release(); deadline = Date.now() + 100_000;
    if (session && !result) { await session.stop({ requestId: 'h6-finally-stop', reason: 'fixture-cleanup' }); result = await session.completion; }
    if (!session || result?.cleanup.status === 'complete') facilityCleanup = await stack.close();
    else facilityCleanup = { cleanup: 'pending', dependenciesRetained: true };
    for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    report.result = result; report.facilities = stack.receipt(); report.facilityCleanup = facilityCleanup; report.failure = failure;
    let body = JSON.stringify(report, null, 2); for (const secret of stack.secrets) body = body.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    await writeFile(join(directory, 'acceptance.json'), body + '\n', { mode: 0o600 });
  }
  assert.equal(facilityCleanup.cleanup, 'complete');
});

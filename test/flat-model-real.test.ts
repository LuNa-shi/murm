import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '@murm/core';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
import { ServiceRegistry } from '@murm/core/services';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { createTaskPoolModelAccessPolicy } from '../src/harnesses/taskpool/model-access-policy.js';
import { createTaskPoolAgentCoordinator } from '../src/harnesses/taskpool/bot-coordinator.js';
import { createCappedUpstream } from './fixtures/core-capped-upstream.js';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { cleanupRuntimes } from './fixtures/core-runtime-cleanup.js';
import { parsePrivateUpstreamHeaders, createAcceptanceDeadline, acceptanceFailed, promptRevocationVerified } from './fixtures/flat-model-acceptance.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

for (const live of [false, true]) test(`flat readonly selection ${live ? 'live Kimi K3' : 'controlled native Pi'} model authority`, {
  skip: process.env[live ? 'SWARMENV_FLAT_MODEL_LIVE_KIMI_TEST' : 'SWARMENV_FLAT_MODEL_REAL_TEST'] !== '1' && 'Requires two independent reviews on the pinned commit before explicit opt-in',
  timeout: 160_000,
}, async t => {
  const startedAt = Date.now(), deadlineAt = startedAt + 120_000;
  const outputDir = join(process.cwd(), 'experiments', `flat-model-${live ? 'live' : 'local'}-${startedAt}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const tasks = new TaskService();
  tasks.createMission({ mission_id: 'flat:model-acceptance', goal: 'Verify flat selection model authority' }, makeEnvelope({ actorRef: 'trusted-host' }));
  let runtime, proxy, upstream, bot, unsubscribe;
  let localArrivals = 0, localAccepted = 0, heldResolve, heldSocket, heldClosedResolve;
  const heldSocketClosed = new Promise(resolve => { heldClosedResolve = resolve; });
  let domainTransitionMonotonic;
  const held = new Promise(resolve => { heldResolve = resolve; });
  const report = { mode: live ? 'hosted-kimi-k3' : 'fixed-local-k3', model: { provider: 'kimi_proxy', model: 'k3' }, requestCap: live ? 1 : 2,
    maxOutputTokens: live ? 512 : 128, toolPolicy: 'omit-tools-and-choice', deadlineMs: 120_000, resources: {}, failure: true };
  const events = [], waiters = [];
  const settled = () => deadline.expired() ? Promise.resolve({ outcome: 'timeout' }) : new Promise(resolve => { waiters.push(resolve); });
  const deadline = createAcceptanceDeadline(deadlineAt, () => { for (const resolve of waiters.splice(0)) resolve({ outcome: 'timeout' }); void runtime?.close({ timeoutMs: 1 }).catch(() => {}); });
  t.after(async () => {
    report.deadlineExpired = deadline.expired();
    report.workElapsedMs = Date.now() - startedAt;
    deadline.stop(); unsubscribe?.();
    await Promise.allSettled([proxy?.close(), upstream && (async () => {
      upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    })()]);
    try {
      const domainBot = bot && tasks.getBot(bot.id);
      if (domainBot && ['STARTING', 'UNBOUND'].includes(domainBot.state)) tasks.requestBotStop(bot.id, 'acceptance-cleanup');
      report.close = await cleanupRuntimes(runtime ? [runtime] : [], { inspect: ownedContainers, resources: report.resources });
      if (bot && tasks.getBot(bot.id)?.state === 'CLOSING' && report.close[0]?.cleanup === 'complete') tasks.finalizeBotClose(bot.id);
      report.domainState = bot ? tasks.getBot(bot.id)?.state : undefined;
      report.upstream = proxy?.receipt(); report.localArrivals = localArrivals; report.localAccepted = localAccepted;
      report.failure = acceptanceFailed(report, report.deadlineExpired, live);
      report.events = events.map(event => ({ type: event.type, outcome: event.outcome, botId: event.botId }));
    } finally {
      report.upstream = proxy?.receipt(); report.localArrivals = localArrivals; report.localAccepted = localAccepted;
      report.failure = acceptanceFailed(report, report.deadlineExpired, live);
      tasks.close();
      await writeFile(join(outputDir, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    if (report.failure) throw new Error('FLAT_MODEL_ACCEPTANCE_FAILED');
  });
  if (!live) {
    upstream = createServer(async (request, response) => {
      localArrivals++;
      if (localArrivals > 2 || deadline.expired()) { request.resume(); response.writeHead(429); response.end(); return; }
      if (request.method !== 'POST' || request.url !== '/v1/responses') { request.resume(); response.writeHead(400); response.end(); return; }
      let body;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 ** 2) throw new Error(); chunks.push(chunk); }
        body = JSON.parse(Buffer.concat(chunks));
        if (body.model !== 'k3' || !Array.isArray(body.input)) throw new Error();
      } catch { response.writeHead(400); response.end(); return; }
      if (deadline.expired()) { response.writeHead(429); response.end(); return; }
      localAccepted++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (localAccepted === 1) response.end(streamResponse('k3', 1, { type: 'message', id: 'flat_fixed', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'FLAT_SELECTION_OK' }] }));
      else {
        heldSocket = response.socket;
        heldSocket.once('close', () => {
          const evidence = report.revocation ??= {};
          evidence.upstreamSocketClosedAt = Date.now();
          evidence.socketCloseElapsedMs = performance.now() - domainTransitionMonotonic;
          heldClosedResolve();
        });
        response.write(': bounded held response\n\n'); heldResolve();
      }
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  }
  proxy = await createCappedUpstream({ upstreamUrl: live ? process.env.SWARMENV_CORE_LIVE_UPSTREAM_URL : `http://127.0.0.1:${upstream.address().port}/v1/responses`,
    upstreamHeaders: live ? parsePrivateUpstreamHeaders(process.env.SWARMENV_CORE_LIVE_UPSTREAM_HEADERS_JSON) : {}, deadlineAt,
    maxRequests: report.requestCap, maxOutputTokens: report.maxOutputTokens, disableTools: true, filename: 'unused-selection-check', marker: 'FLAT_SELECTION_OK' });
  const image = process.env.SWARMENV_CORE_TEST_IMAGE;
  if (typeof image !== 'string' || !/(?:^sha256:|@sha256:)[a-f0-9]{64}$/.test(image)) throw new Error('FLAT_PINNED_IMAGE_REQUIRED');
  report.image = image;
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const policy = createTaskPoolModelAccessPolicy({ taskService: tasks, missionId: 'flat:model-acceptance', runtimeId: () => runtime?.id, deadline: () => deadlineAt });
  runtime = await createRuntime({ backend: createPiOpenSandboxBackend({ sandbox: {
    lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
    apiKey: process.env.SWARMENV_CORE_TEST_API_KEY, resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 60_000, maxOutputTokens: report.maxOutputTokens },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: proxy.url, headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } }), profiles: {
    readonly: { prompt: 'Reply with exactly FLAT_SELECTION_OK. Do not call tools.', image, model: 'default', writable: false, services: {} } },
    services: new ServiceRegistry(), modelAccessPolicy: policy, maxBots: 1, outputDir });
  report.runtimeId = runtime.id;
  report.resources[runtime.id] = { initialEmpty: (await ownedContainers(runtime.id)).length === 0 };
  const coordinator = createTaskPoolAgentCoordinator({ runtime, taskService: tasks, missionId: 'flat:model-acceptance' });
  bot = await coordinator.spawn({ requestId: 'flat-model-spawn', profile: 'readonly', legacySlotId: 'legacy-slot:acceptance', selectionDeadline: new Date(deadlineAt).toISOString() });
  report.botId = bot.id; report.legacySlotId = tasks.getBot(bot.id).core_id; report.initialDomainState = tasks.getBot(bot.id).state;
  assert.equal(report.initialDomainState, 'UNBOUND'); assert.equal(tasks.getBot(bot.id).sandbox_id, null);
  assert.equal((await ownedContainers(runtime.id)).length, 1);
  unsubscribe = runtime.onEvent(event => { if (event.botId === bot.id) { events.push(event); if (event.type === 'settled') waiters.shift()?.(event); } });
  const first = settled();
  report.input = await runtime.send(bot.id, 'Reply with exactly FLAT_SELECTION_OK. Do not call tools.', { requestId: 'flat-fixed-selection', mode: 'followUp' });
  assert.equal(report.input.status, 'accepted');
  const completed = await first;
  if (completed.outcome !== 'completed' || completed.output?.trim() !== 'FLAT_SELECTION_OK') throw new Error('FLAT_SELECTION_RESULT_INVALID');
  report.selectionCompleted = true;
  const observed = proxy.receipt().requests[0];
  assert.equal(observed.terminal, 'response.completed');
  assert.equal(observed.toolsDisabled, true);
  assert.equal(observed.toolsMode, 'omitted');
  assert.ok(Number.isSafeInteger(observed.usage?.inputTokens) && Number.isSafeInteger(observed.usage?.outputTokens));
  report.usageObserved = true;
  if (!live) {
    const interrupted = settled();
    const heldInputStartedMonotonic = performance.now();
    report.revocation = { heldInputAt: Date.now(), requestTimeoutMs: 60_000 };
    await runtime.send(bot.id, 'Reply with exactly FLAT_SELECTION_OK. Do not call tools.', { requestId: 'flat-held-selection', mode: 'followUp' });
    await Promise.race([held, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('Held upstream not observed')), 20_000); timeout.unref(); held.finally(() => clearTimeout(timeout)); })]);
    Object.assign(report.revocation, { heldBeforeTransition: Boolean(heldSocket && !heldSocket.destroyed), maxElapsedMs: 5000 });
    if (!report.revocation.heldBeforeTransition) throw new Error('FLAT_HELD_SOCKET_CLOSED_BEFORE_REVOKE');
    tasks.requestBotStop(bot.id, 'controlled-domain-revoke');
    report.revocation.domainTransitionAt = Date.now();
    domainTransitionMonotonic = performance.now();
    report.revocation.requestAgeAtTransitionMs = domainTransitionMonotonic - heldInputStartedMonotonic;
    let revocationTimer;
    try {
      await Promise.race([
        Promise.all([heldSocketClosed, interrupted.then(revoked => {
          report.revocation.settledAt = Date.now();
          report.revocation.settledElapsedMs = performance.now() - domainTransitionMonotonic;
          report.revocation.outcome = revoked.outcome;
        })]),
        new Promise((_, reject) => { revocationTimer = setTimeout(() => reject(new Error('FLAT_DOMAIN_REVOCATION_NOT_PROMPT')), 5000); }),
      ]);
    } finally { clearTimeout(revocationTimer); }
    if (!promptRevocationVerified(report.revocation)) throw new Error('FLAT_DOMAIN_REVOCATION_EVIDENCE_INVALID');
    report.streamRevoked = true;
    const denied = settled();
    await runtime.send(bot.id, 'Reply with exactly FLAT_SELECTION_OK.', { requestId: 'flat-denied-selection', mode: 'followUp' });
    assert.equal((await denied).outcome, 'failed');
    assert.equal(localArrivals, 2); assert.equal(localAccepted, 2); report.deniedBeforeUpstream = true;
  } else tasks.requestBotStop(bot.id, 'hosted-selection-complete');
  const stop = await runtime.stop(bot.id, { timeoutMs: 20_000 });
  report.stop = { botId: stop.botId, execution: stop.execution, cleanup: stop.cleanup };
  assert.equal(stop.cleanup, 'complete');
  assert.equal(proxy.receipt().forwarded, report.requestCap);
  report.failure = deadline.expired() || proxy.receipt().deadlineReached;
  if (report.failure) throw new Error('FLAT_MODEL_WORK_DEADLINE_EXPIRED');
});

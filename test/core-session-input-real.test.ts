import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import * as sourceSdk from '@luna-shi/murm';
import { preparePackageArchive } from './fixtures/notes-installed-package.js';
import { streamResponse } from '../scripts/local-setup-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

// Build a trusted fixture image with the current Worker as its base.
// docker build -f <(printf 'FROM murm-worker:issue-271-integrated\nCOPY test/fixtures/session-resources /opt/murm/session-proof-resources\n') -t murm-worker:issue-271-session-resources .
test('native Session inputs, isolated configuration, resources, retry and queue controls cross the real Worker', {
  skip: process.env.MURM_SESSION_INPUT_REAL !== '1' && 'Opt in to the bounded local OpenSandbox Session input/resource acceptance',
  timeout: 240000,
}, async t => {
  const execute = promisify(execFile);
  const image = process.env.MURM_CORE_TEST_IMAGE;
  const piVersion = process.env.MURM_CORE_TEST_PI_VERSION ?? '1.3.0';
  assert.ok(image, 'An immutable fixture Worker image is required');
  const settings = JSON.parse(await readFile(process.env.MURM_TEST_SETTINGS ?? join(homedir(), '.config/murm/opensandbox.json'), 'utf8'));
  const outputDir = join(process.cwd(), 'experiments', `core-session-input-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  let phase = 'initial';
  let phaseRequests = 0;
  let failure;
  let completed = false;
  const requests = [];
  const events = [];
  const receipts = [];
  let runtime;
  let installationDirectory;
  let installedPackage;
  let cleanup;
  let deleted = false;
  const seed = 'NATIVE_SESSION_SEEDED_MARKER_271';
  const complete = 'CONTROLLED_SESSION_COMPLETE ' + 'bounded streamed output '.repeat(20);
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      assert.ok(requests.length < 28, 'Finite controlled model request budget');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const json = JSON.stringify(body);
      phaseRequests++;
      const summary = json.includes('context summarization assistant');
      requests.push({ phase, summary, body });
      if (phase === 'retry' || phase === 'abort-retry') {
        if (phaseRequests === 1) {
          response.writeHead(429, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'Controlled rate limit', type: 'rate_limit_exceeded' } })); return;
        }
      }
      let item;
      if (summary) item = { type: 'message', id: `summary_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The seeded marker and explicit resources were verified.', annotations: [] }] };
      else if (phase === 'initial') {
        assert.ok(json.includes('APPEND_RESOURCE_CONTEXT'));
        assert.ok(json.includes('TEMPLATE_RESOURCE_MARKER'));
        assert.ok(json.includes('CONTEXT_RESOURCE_MARKER'));
        assert.ok(json.includes('EXTENSION_RESOURCE_MARKER'));
        const names = body.tools.map(tool => tool.name).sort();
        assert.deepEqual(names, ['bash', 'read']);
        if (phaseRequests === 1) item = { type: 'function_call', id: 'fc_skill', call_id: 'call_skill', name: 'bash', arguments: JSON.stringify({ command: 'cat /opt/murm/session-proof-resources/skills/session-proof/SKILL.md > artifact.txt && cat artifact.txt', timeout: 5 }) };
        else if (phaseRequests === 2) {
          assert.ok(json.includes('SKILL_RESOURCE_MARKER'));
          item = { type: 'function_call', id: 'fc_seed', call_id: 'call_seed', name: 'read', arguments: JSON.stringify({ path: 'marker.txt' }) };
        } else { assert.equal(phaseRequests, 3); assert.ok(json.includes(seed)); }
      } else if (phase === 'hold') {
        if (phaseRequests === 1) item = { type: 'function_call', id: 'fc_hold', call_id: 'call_hold', name: 'bash', arguments: JSON.stringify({ command: 'printf READY > hold-ready.txt; sleep 30', timeout: 40 }) };
        else throw new Error('Interrupted held tool must not continue automatically');
      } else if (phase === 'resume') {
        assert.ok(json.includes('KEEP_NEXT_TURN_CONTEXT'));
        assert.ok(!json.includes('DISCARD_NEXT_TURN_CONTEXT'));
        assert.ok(!json.includes('CANCEL_QUEUED_TEXT'));
      } else if (phase === 'other-agent') {
        assert.deepEqual(body.tools.map(tool => tool.name), ['read']);
        assert.ok(!json.includes('APPEND_RESOURCE_CONTEXT'));
      }
      item ??= { type: 'message', id: `message_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: complete, annotations: [] }] };
      const stream = streamResponse('k3', requests.length, item);
      const boundary = stream.indexOf('event: response.output_item.done');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(stream.slice(0, boundary));
      await delay(25);
      response.end(stream.slice(boundary));
    } catch (error) { failure = error.message; response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: failure } })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const deadline = setTimeout(() => { void runtime?.close({ timeoutMs: 1 }); }, 200000);
  t.after(async () => {
    clearTimeout(deadline);
    try {
      cleanup = await runtime?.close({ timeoutMs: 30000 });
      deleted = runtime ? (await ownedContainers(runtime.id)).length === 0 : true;
    } finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify({ failure: failure ?? (completed ? undefined : 'WORKLOAD_INCOMPLETE'), image, piVersion, installedPackage, source: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(), runtimeId: runtime?.id,
        requestCount: requests.length, requestPhases: requests.map(({ phase, summary }) => ({ phase, summary })), events: events.map(event => ({ type: event.type, child: event.event?.type, agentId: event.agentId })), receipts, cleanup, deleted }, null, 2), { mode: 0o600 });
    }
    if (installationDirectory) await rm(installationDirectory, { recursive: true, force: true });
    assert.equal(cleanup?.cleanup, 'complete'); assert.equal(deleted, true); assert.equal(failure, undefined);
  });
  let sdk = sourceSdk;
  if (process.env.MURM_TEST_PACKAGE_ARCHIVE) {
    installationDirectory = await mkdtemp(join(tmpdir(), 'murm-session-installed-'));
    const { archive } = await preparePackageArchive(installationDirectory);
    await writeFile(join(installationDirectory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    await execute('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive],
      { cwd: installationDirectory, env, timeout: 120000, maxBuffer: 4 * 1024 ** 2 });
    const require = createRequire(join(installationDirectory, 'consumer.cjs'));
    sdk = require('@luna-shi/murm') as typeof sourceSdk;
    installedPackage = { sha256: createHash('sha256').update(await readFile(archive)).digest('hex'), rootOnly: true };
  }
  const { createRuntime, createSandbox, createPiExecutor, ServiceRegistry } = sdk;
  const host = settings.advertiseHost;
  runtime = await createRuntime({
    executor: createPiExecutor({ version: piVersion }),
    sandbox: createSandbox({ lifecycleBaseUrl: settings.endpoint.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1', apiKey: settings.apiKey, endpointHost: '127.0.0.1',
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 30000,
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } }),
    models: { controlled: { provider: 'session_controls', model: 'k3', capabilities: { contextWindow: 32768, maxOutputTokens: 1024, tools: true, reasoning: false },
      upstream: { url: `http://127.0.0.1:${server.address().port}/v1/responses`, headers: {} } } },
    connection: { bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 15000, maxRequests: 28, maxOutputTokens: 1024 } },
    profiles: {
      full: { model: 'controlled', image, writable: true, services: {}, collect: { paths: ['artifact.txt'], required: true, includeGit: false, maxBytes: 65536 }, session: {
        tools: ['bash', 'read'], compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 128 }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000, maxAgentDelayMs: 2000 },
        resources: { contextFiles: ['/opt/murm/session-proof-resources/context.md'], promptTemplates: ['/opt/murm/session-proof-resources/session-proof.md'],
          skills: ['/opt/murm/session-proof-resources/skills/session-proof'], extensions: ['/opt/murm/session-proof-resources/extension.mjs'] },
      } },
      read: { model: 'controlled', image, writable: false, services: {}, session: { tools: ['read'], compaction: { enabled: false }, retry: { enabled: false } } },
    }, services: new ServiceRegistry(), maxAgents: 2, outputDir,
  });
  runtime.onEvent(event => events.push(event));
  const a = await runtime.spawn({ profile: 'full', requestId: 'a', files: { 'marker.txt': { encoding: 'utf8', data: seed } } });
  const b = await runtime.spawn({ profile: 'read', requestId: 'b' });
  assert.equal((await runtime.session.getState(a.id)).executor.version, piVersion);
  assert.equal((await runtime.session.getState(b.id)).executor.version, piVersion);
  const stateA = await runtime.session.getState(a.id); const stateB = await runtime.session.getState(b.id);
  assert.deepEqual([...stateA.tools].sort(), ['bash', 'read']); assert.deepEqual(stateB.tools, ['read']);
  assert.equal(stateA.configuration.retry.enabled, true); assert.equal(stateB.configuration.retry.enabled, false);
  const configured = await runtime.session.configure(a.id, { steeringMode: 'all', retry: { enabled: true } }, { requestId: 'configure' });
  assert.equal(configured.status, 'applied'); assert.equal((await runtime.session.getState(a.id)).configuration.steeringMode, 'all');
  assert.equal((await runtime.session.getState(b.id)).configuration.steeringMode, 'one-at-a-time');
  async function context(content, delivery, id) {
    const receipt = await runtime.send(a.id, { type: 'context', customType: 'native-proof', content, display: false, details: { id } }, { requestId: id, delivery });
    receipts.push({ id, receipt }); assert.equal(receipt.status, 'accepted'); return receipt;
  }
  await context('APPEND_RESOURCE_CONTEXT', 'append', 'append'); assert.equal(requests.length, 0);
  assert.equal((await runtime.session.getMessages(a.id)).messages.some(message => message.content === 'APPEND_RESOURCE_CONTEXT'), true);
  async function turn(agent, text, id) {
    const before = events.filter(event => event.type === 'settled' && event.agentId === agent.id).length;
    const receipt = await runtime.send(agent.id, text, { requestId: id }); receipts.push({ id, receipt }); assert.equal(receipt.status, 'accepted');
    const until = Date.now() + 30000;
    while (events.filter(event => event.type === 'settled' && event.agentId === agent.id).length <= before) { assert.ok(Date.now() < until, 'Native turn did not settle'); await delay(25); }
    return events.filter(event => event.type === 'settled' && event.agentId === agent.id).at(-1);
  }
  assert.equal((await turn(a, '/session-proof RESOURCE_FIRST', 'first')).outcome, 'completed');
  assert.equal(phaseRequests, 3);
  phase = 'other-agent'; phaseRequests = 0;
  assert.equal((await turn(b, 'READ_ONLY_AGENT', 'read-only')).outcome, 'completed');
  phase = 'hold'; phaseRequests = 0;
  const hold = await runtime.send(a.id, 'HOLD_TOOL', { requestId: 'hold' }); assert.equal(hold.status, 'accepted');
  const until = Date.now() + 15000;
  while (!events.some(event => event.type === 'session' && event.event.type === 'tool_execution_start' && event.event.toolCallId.startsWith('call_hold'))) { assert.ok(Date.now() < until); await delay(25); }
  await context('DISCARD_NEXT_TURN_CONTEXT', 'nextTurn', 'discard');
  const queued = await runtime.send(a.id, 'CANCEL_QUEUED_TEXT', { requestId: 'queued', mode: 'followUp' }); assert.equal(queued.disposition, 'queued');
  const cleared = await runtime.session.clearQueue(a.id, { requestId: 'clear' }); receipts.push({ id: 'clear', receipt: cleared });
  assert.ok(cleared.discardedInputHashes.includes(createHash('sha256').update('CANCEL_QUEUED_TEXT').digest('hex')));
  assert.ok(cleared.discardedContextIds.length > 0);
  const interrupted = await runtime.interrupt(a.id, { requestId: 'interrupt' }); assert.equal(interrupted.status, 'interrupted');
  await context('KEEP_NEXT_TURN_CONTEXT', 'nextTurn', 'keep');
  phase = 'resume'; phaseRequests = 0;
  assert.equal((await turn(a, 'RESUME_AFTER_CONTROL', 'resume')).outcome, 'completed');
  phase = 'retry'; phaseRequests = 0;
  assert.equal((await turn(a, 'RETRY_CONTROLLED', 'retry')).outcome, 'completed'); assert.equal(phaseRequests, 2);
  assert.ok(events.some(event => event.type === 'session' && event.event.type === 'auto_retry_start'));
  phase = 'abort-retry'; phaseRequests = 0;
  const retryEvents = events.filter(event => event.type === 'session' && event.event.type === 'auto_retry_start').length;
  const pending = await runtime.send(a.id, 'ABORT_RETRY_CONTROLLED', { requestId: 'abort-retry-turn' }); assert.equal(pending.status, 'accepted');
  const abortUntil = Date.now() + 15000;
  while (events.filter(event => event.type === 'session' && event.event.type === 'auto_retry_start').length <= retryEvents) { assert.ok(Date.now() < abortUntil); await delay(10); }
  const aborted = await runtime.session.abortRetry(a.id, { requestId: 'abort-retry' }); receipts.push({ id: 'abort-retry', receipt: aborted });
  await delay(1500); assert.equal(phaseRequests, 1);
  const fresh = await runtime.session.getState(a.id); assert.equal(fresh.retrying, false);
  phase = 'compact'; phaseRequests = 0;
  const compacted = await runtime.session.compact(a.id, { requestId: 'compact' }); receipts.push({ id: 'compact', receipt: compacted }); assert.equal(compacted.status, 'completed');
  const stats = await runtime.session.getStats(a.id); assert.equal(stats.compactions.manual, 1); assert.equal(stats.compactions.successfulAutoCompactions, 0);
  assert.ok(events.some(event => event.type === 'session' && event.event.type === 'textDelta'));
  const stopped = await runtime.stop(a.id); receipts.push({ id: 'stop-a', receipt: stopped }); assert.equal(stopped.cleanup, 'complete'); assert.ok(stopped.sessionArchive);
  completed = true;
});

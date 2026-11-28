import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sourceSdk from '@luna-shi/murm';
import type { Runtime } from '@luna-shi/murm';
import sourceSubagents from '../examples/subagents/project.js';
import { installNativeNotesExample } from './fixtures/notes-installed-package.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createHarnessSessionUpstream } from './fixtures/harness-session-upstream.js';

const cli = fileURLToPath(new URL('../scripts/murm.js', import.meta.url));
const nativeEnabled = process.env.MURM_HARNESS_SESSION_REAL_TEST === '1';

for (const via of ['sdk', 'rpc', 'export-failure', 'default-task']) {
  test(`interactive Subagents controls, interruption and Service questions traverse real OpenSandbox via ${via}`, {
    skip: !nativeEnabled && 'Requires candidate Worker and configured local OpenSandbox',
    timeout: 150_000,
  }, async t => {
    const image = process.env.MURM_CORE_TEST_IMAGE;
    const configPath = process.env.MURM_HARNESS_SESSION_SANDBOX_CONFIG;
    assert.ok(image && configPath);
    const installed = process.env.MURM_TEST_PACKAGE_ARCHIVE ? await installNativeNotesExample() : undefined;
    if (installed) t.after(installed.close);
    const installedRoot = installed && join(installed.directory, 'node_modules', '@luna-shi', 'murm');
    const sdk = installed ? createRequire(join(installed.directory, 'native-consumer.mjs'))('@luna-shi/murm') as typeof sourceSdk : sourceSdk;
    const subagents = installedRoot ? (await import(pathToFileURL(join(installedRoot, 'dist/examples/subagents/project.js')).href)).default as typeof sourceSubagents : sourceSubagents;
    const runCli = installed ? join(installed.directory, 'node_modules', '.bin', 'murm') : cli;
    const settings = JSON.parse(await readFile(configPath, 'utf8'));
    const endpoint = process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? settings.endpoint ?? settings.lifecycleBaseUrl;
    assert.ok(endpoint && settings.apiKey && settings.advertiseHost);
    const outputBase = join(process.cwd(), 'experiments');
    await mkdir(outputBase, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(outputBase, `harness-session-${via}-`));
    const cwd = await mkdtemp(join(tmpdir(), 'murm-session-project-'));
    const outputRoot = join(temporary, 'runs');
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const seed = 'NATIVE_SEED_8f4fd9d7d362\n';
    const seededPath = join(cwd, 'seed.txt');
    await writeFile(seededPath, seed);
    const upstream = await createHarnessSessionUpstream(seed.trim());
    const rpc = via === 'rpc' || via === 'default-task';
    const launchConfig = {
      image,
      executor: { kind: 'pi', version: process.env.MURM_CORE_TEST_PI_VERSION ?? '1.3.0' },
      sandbox: {
        lifecycleBaseUrl: endpoint.endsWith('/v1') ? endpoint : endpoint.replace(/\/$/, '') + '/v1',
        endpointHost: settings.endpointHost ?? '127.0.0.1', apiKey: settings.apiKey,
        commandTimeoutMs: 20_000, isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
      },
      connection: {
        bridge: { host: '0.0.0.0', publicUrl: `http://${settings.advertiseHost}:{port}` },
        modelGateway: { host: '0.0.0.0', advertiseHost: settings.advertiseHost, requestTimeoutMs: 30_000, maxRequests: 48 },
      },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
      rootSession: { compaction: { enabled: false, keepRecentTokens: 32 }, retry: { enabled: true, baseDelayMs: 5_000 } },
      maxAgents: 3, workTimeoutMs: 120_000, closeTimeoutMs: 20_000,
    };
    let child;
    let exited;
    let stderr = '';
    let session;
    let cleanupOwner: Runtime | undefined;
    try {
      if (!rpc) {
        const definition = via === 'export-failure' ? { ...subagents, run: context => subagents.run({
          ...context,
          registerAgentControls(registration) {
            cleanupOwner = registration.runtime;
            return context.registerAgentControls(registration);
          },
        }) } : subagents;
        session = sdk.createHarnessSession(definition, {
          configuration: launchConfig, outputRoot, lifetime: 'interactive', clientCapabilities: { questions: true },
        });
      }
      else {
        const modulePath = join(temporary, 'candidate-config.mjs');
        await writeFile(modulePath, 'export default JSON.parse(process.env.HARNESS_NATIVE_TEST_CONFIG);\n', { mode: 0o600 });
        child = spawn(process.execPath, [runCli, '--harness', 'subagents', '--mode', 'rpc',
          ...(via === 'default-task' ? [] : ['--lifetime', 'interactive', '--interaction', 'questions']),
          '--config', modulePath, '--output-dir', outputRoot], {
          cwd, stdio: 'pipe', env: { ...(installed?.env ?? process.env), HARNESS_NATIVE_TEST_CONFIG: JSON.stringify(launchConfig) },
        });
        child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
        exited = once(child, 'close');
        session = new sdk.HarnessRpcClient(child);
        const ready = await session.ready;
        assert.equal(ready.status.clientCapabilities.questions, via !== 'default-task');
        assert.equal(ready.status.lifetime, via === 'default-task' ? 'task' : 'interactive');
      }
    } catch (error) {
      child?.kill('SIGTERM');
      await upstream.close();
      throw error;
    }
    const seen = [];
    const unsubscribe = session.onEvent(event => seen.push(event), { initialSnapshot: true });
    let result;
    let runtimeId;
    t.after(async () => {
      try {
        if (!result && session.completion) {
          await session.stop({ requestId: 'test-emergency-stop', reason: 'test-finished' }).catch(() => {});
          result = await session.completion.catch(() => undefined);
        }
        runtimeId ??= result?.result?.runtimeId;
        const retained = runtimeId ? await ownedContainers(runtimeId) : [];
        await writeFile(join(temporary, 'acceptance.json'), JSON.stringify({
          via, image, package: installed?.metadata ?? null, runtimeId, runId: result?.runId, phase: result?.outcome, reason: result?.reason,
          upstreamRequests: upstream.requests, upstreamFailure: upstream.failure, result,
          activeContainers: retained, diagnostic: stderr,
        }, null, 2), { mode: 0o600 });
        assert.deepEqual(retained, []);
      } finally {
        unsubscribe();
        if (child?.exitCode === null) child.kill('SIGTERM');
        await upstream.close();
      }
    });
    const nativeEvents = () => seen.filter(row => row.type === 'event' && row.event?.kind === 'agent').map(row => row.event.event);
    const wait = async (name, condition, ms = 20_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        assert.equal(upstream.failure, undefined);
        const found = await condition();
        if (found) return found;
        if (seen.some(row => row.type === 'result')) assert.fail(`Run ended while waiting for ${name}: ${JSON.stringify(seen.find(row => row.type === 'result').result.result?.businessFailure ?? seen.find(row => row.type === 'result').result.failure)}`);
        await delay(40);
      }
      assert.fail(`Timed out waiting for ${name}. Requests: ${JSON.stringify(upstream.requests)}`);
    };
    const completed = text => wait(text, () => nativeEvents().find(event => event.type === 'settled' && event.output === text));
    const detail = async () => (await session.getState()).business?.detail;
    const send = async (input, requestId) => assert.equal((await session.input(input, { requestId })).status, 'accepted');
    const agentReceipt = result => result && 'core' in result ? result.core : result;
    const context = content => ({ type: 'context', customType: 'acceptance', display: false, content });

    const start = await session.start({ cwd, prompt: 'SESSION_READ ' + 'Read and verify the seeded project file. '.repeat(128) }, { requestId: 'begin' });
    const first = await completed('SEED_READ_OK');
    const root = first.agentId;
    if (via === 'default-task') {
      result = await session.completion;
      assert.equal(result.outcome, 'completed');
      assert.equal(result.cleanup.status, 'complete');
      assert.equal(result.result.business.output, 'SEED_READ_OK');
      assert.equal(result.result.business.rootId, root);
      assert.ok(result.artifacts.some(artifact => artifact.kind === 'session-archive'));
      assert.deepEqual(await exited, [0, null]);
      return;
    }
    runtimeId = (await session.getState()).business?.runtimeId;
    assert.ok(runtimeId);
    assert.equal((await session.getState()).phase, 'running');
    if (via === 'export-failure') {
      assert.ok(cleanupOwner);
      const agentOutput = join(outputRoot, start.runId, runtimeId, root);
      await mkdir(agentOutput, { mode: 0o700 });
      const blocker = join(agentOutput, 'artifacts');
      await writeFile(blocker, 'required project export fault', { flag: 'wx', mode: 0o600 });
      try {
        assert.equal((await session.stop({ requestId: 'stop-with-export-fault' })).status, 'accepted');
        result = await session.completion;
        assert.equal(result.export.status, 'pending');
        assert.equal(result.cleanup.status, 'pending');
        assert.ok(result.cleanup.pending.some(resource => resource.action === 'collect-artifacts' && resource.id === root));
        assert.equal((await cleanupOwner.get(root)).lastStop?.execution, 'stopped');
        assert.ok(result.artifacts.some(artifact => artifact.kind === 'session-archive'));
        assert.equal((await ownedContainers(runtimeId)).length, 1);
      } finally {
        await rm(blocker);
        assert.equal((await cleanupOwner.close({ timeoutMs: 30_000 })).cleanup, 'complete');
      }
      return;
    }
    const manifest = JSON.parse(await readFile(join(outputRoot, start.runId, 'initial-files.json'), 'utf8'));
    assert.deepEqual(manifest, [{ path: 'seed.txt', mode: 420, bytes: Buffer.byteLength(seed),
      sha256: createHash('sha256').update(seed).digest('hex') }]);

    assert.equal(agentReceipt(await session.agents.configure(root, { steeringMode: 'all' }, { requestId: 'settings' })).status, 'applied');
    assert.equal((await session.agents.getState(root)).configuration.steeringMode, 'all');
    const requestCount = upstream.requests.length;
    assert.equal(agentReceipt(await session.agents.send(root, context('APPENDED_CONTEXT_VALUE'), { requestId: 'append', delivery: 'append' })).disposition, 'appended');
    assert.equal(upstream.requests.length, requestCount);
    assert.ok((await session.agents.getMessages(root)).messages.some(message => JSON.stringify(message).includes('APPENDED_CONTEXT_VALUE')));
    await send('SESSION_SECOND', 'second');
    assert.equal((await completed('SECOND_TURN_OK')).agentId, root);

    await send('SESSION_INTERRUPT', 'hold-root');
    await wait('Root wait Agent Service', async () => (await detail())?.members.some(member => member.agentId === root && member.waiting));
    assert.equal(agentReceipt(await session.agents.send(root, context('DISCARD_ON_INTERRUPT'), { requestId: 'pending-before-interrupt', delivery: 'nextTurn' })).disposition, 'pending-next-turn');
    const interrupt = await session.agents.interrupt(root, { requestId: 'interrupt-root' });
    assert.equal(agentReceipt(interrupt).status, 'interrupted');
    assert.equal(interrupt.harnessEffects.paused, true);
    upstream.releaseChild();
    await completed('LATE_CHILD_RESULT');
    await wait('late child result buffered', async () => (await detail())?.members.some(member => member.agentId === root && member.pending.some(message => message.state === 'pending')));
    const pausedRequests = upstream.requests.length;
    await delay(200);
    assert.equal(upstream.requests.length, pausedRequests);
    await send('SESSION_RESUME', 'resume-root');
    assert.equal((await completed('SAME_ROOT_RESUMED')).agentId, root);

    await send('SESSION_QUESTIONS', 'question-work');
    const questions = await wait('two native Service questions', async () => {
      const pending = (await session.getState()).questions;
      return pending.length === 2 ? pending : undefined;
    });
    const rootQuestion = questions.find(question => question.agentId === root);
    const childQuestion = questions.find(question => question.agentId !== root);
    assert.ok(rootQuestion && childQuestion);
    const answer = await session.respond(rootQuestion.questionId, 'ROOT_VALUE', { requestId: 'answer-root' });
    assert.equal(answer.status, 'answered');
    assert.deepEqual(await session.respond(rootQuestion.questionId, 'ROOT_VALUE', { requestId: 'answer-root' }), answer);
    await completed('ROOT_ANSWER_OK');
    assert.deepEqual((await session.getState()).questions.filter(question => question.status === 'pending').map(question => question.questionId), [childQuestion.questionId]);
    await session.respond(childQuestion.questionId, 'CHILD_VALUE', { requestId: 'answer-child' });
    await completed('CHILD_ANSWER_OK');

    await send('SESSION_HOLD_QUEUE', 'hold-queue');
    await wait('active Root before clearing queue', async () => (await session.agents.getState(root)).active);
    assert.equal(agentReceipt(await session.agents.send(root, 'QUEUED_TEXT_TO_DISCARD', { requestId: 'queued-text', mode: 'followUp' })).disposition, 'queued');
    assert.equal(agentReceipt(await session.agents.send(root, context('DISCARD_BY_CLEAR'), { requestId: 'queued-context', delivery: 'nextTurn' })).disposition, 'pending-next-turn');
    const cleared = await session.agents.clearQueue(root, { requestId: 'clear-root' });
    assert.equal(agentReceipt(cleared).status, 'completed');
    assert.equal(cleared.harnessEffects.discardedUserInputs.length, 1);
    assert.equal(agentReceipt(cleared).discardedContextIds.length, 1);
    upstream.releaseQueue();
    await completed('QUEUE_TURN_OK');
    for (const [delivery, marker] of [['steer', 'STEER'], ['followUp', 'FOLLOW']]) {
      const receipt = agentReceipt(await session.agents.send(root, context('SESSION_CONTEXT_' + marker), {
        requestId: 'context-' + delivery, delivery,
      }));
      assert.equal(receipt.disposition, 'started');
      await completed('CONTEXT_' + marker + '_OK');
    }
    assert.equal(agentReceipt(await session.agents.send(root, context('CONTINUE_WITH_CONTEXT'), { requestId: 'next-turn', delivery: 'nextTurn' })).disposition, 'pending-next-turn');
    await send('SESSION_AFTER_QUEUE', 'after-queue');
    await completed('CLEAR_QUEUE_VERIFIED');
    await wait('manual compact admission', async () => {
      const state = await session.agents.getState(root);
      return !state.active && !state.compacting;
    });
    const compacted = agentReceipt(await session.agents.compact(root, { requestId: 'compact' }));
    assert.equal(compacted.status, 'completed');
    assert.equal((await session.agents.getStats(root)).compactions.manual, 1);
    const summaries = upstream.requests.filter(row => row.stage === 'summary').length;
    assert.ok(summaries >= 1 && summaries <= 2);

    await send('SESSION_RETRY', 'retry-work');
    await wait('native retry start', () => nativeEvents().find(event => event.type === 'session' && event.event.type === 'auto_retry_start'));
    assert.equal(agentReceipt(await session.agents.abortRetry(root, { requestId: 'abort-retry' })).status, 'completed');
    await wait('retry abort confirmed', async () => !(await session.agents.getState(root)).retrying);
    assert.equal(upstream.requests.filter(row => row.stage === 'retry').length, 1);
    assert.ok(nativeEvents().some(event => event.type === 'session' && event.event.type === 'textDelta'));
    assert.ok(nativeEvents().some(event => event.type === 'session' && event.event.type === 'tool_execution_end'));
    assert.equal((await session.stop({ requestId: 'stop-run', reason: 'requested' })).phase, 'stopping');
    result = await session.completion;
    assert.equal(result.cleanup.status, 'complete');
    assert.equal(result.stopReason, 'requested');
    assert.equal(result.initial.digest.startsWith('complete:sha256:'), true);
    assert.ok(result.artifacts.some(artifact => artifact.kind === 'session-archive' && typeof artifact.path === 'string'));
    assert.equal(result.reportSaveFailure, null);
    assert.equal(result.questions.filter(question => question.status === 'answered').length, 2);
    assert.equal(upstream.failure, undefined);
    if (exited) assert.deepEqual(await exited, [1, null]);
  });
}

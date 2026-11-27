import { randomBytes, randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, createSandbox, getExecutorCapabilities, ServiceRegistry } from '@murm/core';
import type { CloseReceipt, FileTree, Runtime, RuntimeEvent } from '@murm/core';
import { handoffConfig, type HandoffConfig } from './handoff-config.js';
import { createMessageService } from './messages.js';

const writerPrompt = 'Publish the input file through the messages Service.';
const readerPrompt = 'Read the messages Service and save the received text.';
const failure = (code: string) => Object.assign(new Error(code), { code });

export async function runMessageHandoff(
  config: HandoffConfig,
  abort: AbortSignal,
  onEvent: (event: RuntimeEvent) => void = () => {},
  project?: { files: FileTree; prompt: string; artifact: string; ready(): void; observe(runtime: Runtime): () => void },
) {
  abort.throwIfAborted();
  const signal = AbortSignal.any([abort, AbortSignal.timeout(config.workTimeoutMs)]);
  const receivedFile = project?.artifact ?? 'received.txt';
  const key = `handoff-${randomUUID()}`;
  const expected = project ? undefined : randomBytes(24).toString('hex');
  type ObservedCall = Parameters<NonNullable<Parameters<typeof createMessageService>[1]>>[0];
  const calls = new Map<string, ObservedCall>();
  const callKey = (agentId: string, operation: string, operationId: string) => JSON.stringify([agentId, operation, operationId]);
  const messages = createMessageService(config.externalMessages, call => {
    if (call.key === key) calls.set(callKey(call.agentId, call.operation, call.operationId), call);
  });
  const services = new ServiceRegistry();
  services.registerService(messages);
  const capabilities = getExecutorCapabilities(config.executor ?? 'pi');
  const profile = { model: 'default', image: config.image, writable: true };
  const runtime = await createRuntime({
    sandbox: createSandbox(config.sandbox), executor: config.executor, models: config.models,
    connection: config.connection, services, maxAgents: 2, outputDir: config.outputDir,
    profiles: {
      writer: { ...profile, prompt: writerPrompt, services: { messages: ['put'] } },
      reader: { ...profile, prompt: readerPrompt, services: { messages: ['get'] },
        collect: { paths: [receivedFile], includeGit: false, maxBytes: 4096, required: true } },
    },
  });

  const unsubscribe = runtime.onEvent(onEvent);
  const closeObservation = project?.observe(runtime);
  const cancelled = Promise.withResolvers<never>();
  void cancelled.promise.catch(() => {});
  const abortListener = addAbortListener(signal, () => cancelled.reject(signal.reason));
  let readerId: string | undefined;
  let writtenText: string | undefined;
  const submissions: { agentId: string; requestId: string; inputId?: string }[] = [];

  async function runRole(agentId: string, operation: 'put' | 'get', input: string) {
    signal.throwIfAborted();
    const operationId = `${key}-${operation}`;
    const requestId = `input-${operationId}`;
    const submission: (typeof submissions)[number] = { agentId, requestId };
    submissions.push(submission);
    const execution = Promise.withResolvers<void>();
    const unsubscribeRole = runtime.onEvent(event => {
      if (!('agentId' in event) || event.agentId !== agentId) return;
      if (event.type === 'settled') {
        if (event.outcome === 'completed') execution.resolve();
        else execution.reject(failure('HANDOFF_EXECUTION_FAILED'));
      } else if (event.type === 'exit' || (event.type === 'error' && event.fatal)) {
        execution.reject(failure('HANDOFF_EXECUTION_UNCONFIRMED'));
      }
    });
    try {
      const admission = runtime.send(agentId, input, { requestId, mode: 'followUp' }).then(receipt => {
        signal.throwIfAborted();
        submission.inputId = receipt.inputId;
        if (receipt.status !== 'accepted' || receipt.disposition !== 'started') throw failure('HANDOFF_INPUT_UNCONFIRMED');
      });
      await Promise.race([Promise.all([admission, execution.promise]), cancelled.promise]);
      signal.throwIfAborted();
      const call = calls.get(callKey(agentId, operation, operationId));
      if (!call || (operation === 'put' ? call.author !== agentId : call.text !== writtenText)) throw failure('HANDOFF_SERVICE_UNCONFIRMED');
      return call.text;
    } finally {
      unsubscribeRole();
    }
  }

  let business:
    | { status: 'completed'; value: { handoffObserved: true } }
    | { status: 'cancelled' | 'failed'; error: { code: string; message: string } };
  try {
    signal.throwIfAborted();
    const writer = await Promise.race([runtime.spawn({ requestId: 'writer', profile: 'writer',
      files: project?.files ?? { 'handoff-input.json': { encoding: 'utf8', data: JSON.stringify({ key, text: expected }) } } }), cancelled.promise]);
    signal.throwIfAborted();
    project?.ready();
    writtenText = await runRole(writer.id, 'put', project
      ? JSON.stringify({ task: project.prompt, instruction: `Inspect the local project. Use swarm messages put to publish a concrete observation for this task under key ${key} with --request-id ${key}-put. Then finish.` })
      : `Publish ${key}: run swarm messages put --input handoff-input.json --request-id ${key}-put, then finish.`);
    signal.throwIfAborted();
    const reader = await Promise.race([runtime.spawn({ requestId: 'reader', profile: 'reader', ...(project ? { files: project.files } : {}) }), cancelled.promise]);
    readerId = reader.id;
    await runRole(reader.id, 'get', project
      ? JSON.stringify({ task: project.prompt, instruction: `Check the project context for the writer's observation. Run swarm messages get --key ${key} --request-id ${key}-get | jq -er .text > ${receivedFile} to preserve the exact Service handoff. Then finish.` })
      : `Receive ${key}: run swarm messages get --key ${key} --request-id ${key}-get | jq -er .text > ${receivedFile}, then finish.`);
    business = { status: 'completed', value: { handoffObserved: true } };
  } catch (error) {
    const code = signal.aborted ? (abort.aborted ? 'HANDOFF_CANCELLED' : 'HANDOFF_TIMEOUT')
      : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'HANDOFF_FAILED';
    business = { status: abort.aborted ? 'cancelled' : 'failed', error: { code, message: 'The handoff did not finish' } };
  } finally {
    unsubscribe();
    abortListener[Symbol.dispose]();
  }

  let coreClose: { status: 'complete' | 'pending'; receipt: CloseReceipt } | { status: 'unknown' };
  try {
    const receipt = await runtime.close({ timeoutMs: config.cleanupTimeoutMs });
    coreClose = { status: receipt.cleanup, receipt };
  } catch {
    coreClose = { status: 'unknown' };
  }
  closeObservation?.();
  let artifactVerification: { status: 'not-requested' | 'passed' | 'pending' | 'failed' } = { status: 'not-requested' };
  const handoffMissing = business.status === 'failed' && business.error.code === 'HANDOFF_SERVICE_UNCONFIRMED';
  if (readerId !== undefined || handoffMissing) {
    const reader = coreClose.status === 'unknown' ? undefined : coreClose.receipt.agents.find(agent => agent.agentId === readerId);
    const files = reader?.artifacts.find(path => path.endsWith('/artifacts/files'));
    artifactVerification = { status: coreClose.status === 'complete' ? 'failed' : 'pending' };
    if (files) {
      try {
        const actual = await readFile(join(files, receivedFile), {
          encoding: 'utf8', signal: AbortSignal.timeout(config.cleanupTimeoutMs),
        });
        artifactVerification = { status: actual === `${expected ?? writtenText}\n` ? 'passed' : 'failed' };
      } catch { /* The expected bytes could not be verified. */ }
    }
  }
  const report = { runtimeId: runtime.id, business, coreClose, artifactVerification,
    reportSaveFailure: null as null | { code: string }, reportPath: undefined as string | undefined };
  try {
    const reportPath = join(config.outputDir, runtime.id, 'handoff-report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    report.reportPath = reportPath;
  } catch {
    report.reportSaveFailure = { code: 'REPORT_SAVE_FAILED' };
  }
  return { report, key, submissions, capabilities };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const abort = new AbortController();
  const stop = () => abort.abort(failure('HANDOFF_CANCELLED'));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const { report, key, submissions } = await runMessageHandoff(handoffConfig(), abort.signal, update => {
      process.stderr.write(`${update.type}\n`);
    });
    process.stdout.write(JSON.stringify({ key, submissions, report }) + '\n');
    if (report.business.status !== 'completed' || report.artifactVerification.status !== 'passed' ||
        report.coreClose.status !== 'complete' || report.reportSaveFailure) process.exitCode = 1;
  } catch (error) {
    const details = error as { code?: unknown; reportPath?: unknown };
    process.stderr.write(JSON.stringify({ code: details?.code ?? 'HANDOFF_SETUP_FAILED', reportPath: details?.reportPath }) + '\n');
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

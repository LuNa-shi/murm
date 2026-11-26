import { randomBytes, randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, finalizeRun } from '@murm/core';
import type { RuntimeObservationUpdate, RunBusinessOutcome } from '@murm/core';
import { createOpenSandboxBackend, getOpenSandboxBackendCapabilities } from '@murm/core/backends/opensandbox';
import { ServiceRegistry } from '@murm/core/services';
import { handoffConfig, type HandoffConfig } from './handoff-config.js';
import { createMessageService } from './messages.js';

const receivedFile = 'received.txt';
const writerPrompt = 'Publish the input file through the messages Service.';
const readerPrompt = 'Read the messages Service and save the received text.';
const failure = (code: string) => Object.assign(new Error(code), { code });

export async function runMessageHandoff(
  config: HandoffConfig,
  abort: AbortSignal,
  onObservation: (update: RuntimeObservationUpdate) => void = () => {},
) {
  abort.throwIfAborted();
  const signal = AbortSignal.any([abort, AbortSignal.timeout(config.workTimeoutMs)]);
  const key = `handoff-${randomUUID()}`;
  const expected = randomBytes(24).toString('hex');
  const messages = createMessageService(config.externalMessages);
  const services = new ServiceRegistry();
  services.registerService(messages);
  const backend = createOpenSandboxBackend(config.backend);
  const capabilities = getOpenSandboxBackendCapabilities(backend);
  const profile = { model: 'default', image: config.image, writable: true };
  const runtime = await createRuntime({
    backend, services, maxAgents: 2, outputDir: config.outputDir,
    profiles: {
      writer: { ...profile, prompt: writerPrompt, services: { messages: ['put'] } },
      reader: { ...profile, prompt: readerPrompt, services: { messages: ['get'] },
        collect: { paths: [receivedFile], includeGit: false, maxBytes: 4096, required: true } },
    },
  });

  const observation = runtime.observe({ signal });
  const cancelled = Promise.withResolvers<never>();
  void cancelled.promise.catch(() => {});
  const abortListener = addAbortListener(signal, () => cancelled.reject(signal.reason));
  let readerId: string | undefined;
  const submissions: { agentId: string; requestId: string; inputId?: string }[] = [];

  async function runRole(agentId: string, operation: 'put' | 'get', input: string) {
    signal.throwIfAborted();
    const operationId = `${key}-${operation}`;
    const requestId = `input-${operationId}`;
    const submission: (typeof submissions)[number] = { agentId, requestId };
    submissions.push(submission);
    const admission = runtime.send(agentId, input, { requestId, mode: 'followUp' }).then(receipt => {
      signal.throwIfAborted();
      submission.inputId = receipt.inputId;
      if (receipt.status !== 'accepted' || receipt.disposition !== 'started') throw failure('HANDOFF_INPUT_UNCONFIRMED');
    });

    await Promise.race([Promise.all([admission, observeRole(agentId, operation, operationId)]), cancelled.promise]);
  }

  async function observeRole(agentId: string, operation: 'put' | 'get', operationId: string) {
    let serviceSucceeded = false;
    let executionSettled = false;
    while (!serviceSucceeded || !executionSettled) {
      const { done, value: update } = await observation.events.next();
      signal.throwIfAborted();
      if (done || update.type === 'gap') throw failure('HANDOFF_OBSERVATION_GAP');
      onObservation(update);
      if (update.type === 'service' && update.agentId === agentId && update.serviceId === 'messages' &&
          update.operation === operation && update.operationId === operationId && update.state === 'settled') {
        if (update.outcome !== 'succeeded') throw failure('HANDOFF_SERVICE_FAILED');
        serviceSucceeded = true;
      }
      if (update.type === 'execution' && update.agent.id === agentId && update.phase === 'settled') {
        if (update.outcome !== 'completed') throw failure('HANDOFF_EXECUTION_FAILED');
        executionSettled = true;
      }
      if ((update.type === 'agent' && update.agent.id === agentId && update.cause === 'exit') ||
          (update.type === 'trace-gap' && update.agent.id === agentId)) throw failure('HANDOFF_EXECUTION_UNCONFIRMED');
    }
  }

  let business: RunBusinessOutcome<{ handoffObserved: true }>;
  try {
    signal.throwIfAborted();
    const writer = await Promise.race([runtime.spawn({ requestId: 'writer', profile: 'writer',
      files: { 'handoff-input.json': { encoding: 'utf8', data: JSON.stringify({ key, text: expected }) } } }), cancelled.promise]);
    signal.throwIfAborted();
    await runRole(writer.id, 'put',
      `Publish ${key}: run swarm messages put --input handoff-input.json --request-id ${key}-put, then finish.`);
    signal.throwIfAborted();
    const reader = await Promise.race([runtime.spawn({ requestId: 'reader', profile: 'reader' }), cancelled.promise]);
    readerId = reader.id;
    await runRole(reader.id, 'get',
      `Receive ${key}: run swarm messages get --key ${key} --request-id ${key}-get | jq -er .text > ${receivedFile}, then finish.`);
    business = { status: 'completed', value: { handoffObserved: true } };
  } catch (error) {
    const code = signal.aborted ? (abort.aborted ? 'HANDOFF_CANCELLED' : 'HANDOFF_TIMEOUT')
      : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'HANDOFF_FAILED';
    business = { status: abort.aborted ? 'cancelled' : 'failed', error: { code, message: 'The handoff did not finish' } };
  } finally {
    observation.cancel();
    abortListener[Symbol.dispose]();
  }

  const report = await finalizeRun({ runtime, outputDir: config.outputDir, business, cleanupTimeoutMs: config.cleanupTimeoutMs,
    ...(readerId === undefined ? {} : { async verifyArtifacts(receipt, cleanupSignal) {
      const reader = receipt.agents.find(agent => agent.agentId === readerId);
      const files = reader?.artifacts.find(path => path.endsWith('/artifacts/files'));
      if (!files || await readFile(join(files, receivedFile), { encoding: 'utf8', signal: cleanupSignal }) !== `${expected}\n`) {
        throw failure('HANDOFF_ARTIFACT_MISMATCH');
      }
    } }),
  });
  return { report, key, submissions, capabilities };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const abort = new AbortController();
  const stop = () => abort.abort(failure('HANDOFF_CANCELLED'));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const { report, key, submissions } = await runMessageHandoff(handoffConfig(), abort.signal, update => {
      process.stderr.write(`${update.cursor.sequence} ${update.type}\n`);
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

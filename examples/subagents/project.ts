import { createHash } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { runSubagentsHarness } from './business.js';
import {
  createInProcessAdapter, getExecutorCapabilities, type ContextInput, type ContextSendOptions,
  type HarnessJson, type Harness, type HarnessContext, type SendOptions, type ServiceManifest,
  ProjectPreflightError, observeProjectRuntime, projectConfiguration,
} from '@luna-shi/murm';

export async function defaultConfiguration() {
  const { default: config } = await import('./config.js');
  return typeof config === 'function' ? config() : config;
}

const rootInput = {
  description: 'Send nonblank text to Root. Shapes are a string or an object containing text and an optional mode.',
  schema: { anyOf: [{ type: 'string' }, { type: 'object', required: ['text'], additionalProperties: false,
    properties: { text: { type: 'string' }, mode: { enum: ['steer', 'followUp'] } } }] },
} as const;
const configureFields = ['thinkingLevel', 'compaction.enabled', 'retry.enabled', 'steeringMode', 'followUpMode'] as const;
const modes = ['steer', 'followUp'] as const;
const deliveries = ['append', 'nextTurn', ...modes] as const;

function parseInput(payload: HarnessJson) {
  if (typeof payload === 'string' && payload.trim()) return { text: payload, mode: 'steer' as const };
  if (payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string' && payload.text.trim() &&
      Object.keys(payload).every(key => key === 'text' || key === 'mode') &&
      (!('mode' in payload) || payload.mode === 'steer' || payload.mode === 'followUp')) {
    return { text: payload.text, mode: 'mode' in payload && payload.mode === 'followUp' ? 'followUp' as const : 'steer' as const };
  }
  throw Object.assign(new TypeError('Expected nonblank Root text and an optional send mode'), { code: 'INVALID_HARNESS_INPUT' });
}

function questionManifest(timeoutMs: number): ServiceManifest {
  return {
    id: 'user-interaction', title: 'Ask the user', purpose: 'Ask an explicit question needed for the current work.',
    provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' },
    capabilities: [{
      name: 'ask', operation: 'ask', description: 'Wait for the user to answer a specific question.',
      side_effect: 'write', idempotent: true, timeout_ms: timeoutMs + 5_000,
      help: { when: 'Ask for a fact or decision needed to continue work. Use text for free-form answers, choice for stable option IDs, or confirm for a yes/no answer.' },
      input_schema: { type: 'object', required: ['text'], additionalProperties: false,
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 2048 },
          kind: { enum: ['text', 'choice', 'confirm'] },
          options: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'object',
            required: ['id', 'label'], additionalProperties: false,
            properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, label: { type: 'string', minLength: 1, maxLength: 160 } } } },
        },
        if: { required: ['kind'], properties: { kind: { const: 'choice' } } },
        then: { properties: { options: {} }, required: ['options'] },
        else: { properties: { options: false } },
      },
      output_schema: { type: 'object', required: ['answer'],
        properties: { answer: { anyOf: [{ type: 'string' }, { type: 'boolean' }] } }, additionalProperties: false },
      errors: [{ code: 'QUESTION_CANCELLED', retryable: false }, { code: 'QUESTION_EXPIRED', retryable: false }],
    }],
  };
}

function userQuestions(context: HarnessContext, timeoutMs: number) {
  return {
    manifest: questionManifest(timeoutMs),
    adapter: createInProcessAdapter({
      async invoke(request) {
        request.assertAuthorized();
        const id = createHash('sha256').update(JSON.stringify([request.caller.agentId, request.envelope.operation_id])).digest('hex');
        const { text, kind = 'text', options } = request.input as {
          text: string; kind?: 'text' | 'choice' | 'confirm'; options?: { id: string; label: string }[];
        };
        const answer = await context.askUser({
          kind, requestId: 'ask:' + id, agentId: request.caller.agentId, text, options, timeoutMs,
        }, {
          id, agentId: request.caller.agentId, signal: request.signal, assertAuthorized: request.assertAuthorized,
        });
        request.signal.throwIfAborted();
        request.assertAuthorized();
        return { answer };
      },
    }),
  };
}

const subagents = {
  id: 'subagents',
  apiVersion: 1,
  input: true,
  inputDescriptor: rootInput,
  lifetimes: ['task', 'interactive'],
  questions: true,
  async run(context) {
    const config = await projectConfiguration<Parameters<typeof runSubagentsHarness>[0]>(context, async () => ({ default: await defaultConfiguration() }));
    if (![config.workTimeoutMs ?? 120_000, config.closeTimeoutMs ?? 30_000]
      .every(limit => Number.isSafeInteger(limit) && limit > 0 && limit <= 2_147_483_647)) {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Subagents requires finite work and close waits');
    }
    const questionTimeoutMs = config.questionTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(questionTimeoutMs) || questionTimeoutMs < 1 || questionTimeoutMs > 120_000) {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Subagents questionTimeoutMs must be between 1 and 120000');
    }
    if (config.workspace) throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'The project entry uses private Subagents work directories');
    let deadlineAt: number | undefined;
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    try {
      const result = await runSubagentsHarness({
        ...config, goal: context.input.prompt, files: context.initial.files, outputDir: context.outputDir,
        collect: config.collect ?? { paths: ['.'], includeGit: false, maxBytes: 16 * 1024 ** 2, required: true },
      }, context.signal, context.lifetime === 'interactive' ? async (harness, signal) => {
        const stopped = Promise.withResolvers<never>();
        const abort = addAbortListener(signal, () => stopped.reject(signal.reason));
        const check = (event: NonNullable<ReturnType<typeof harness.lastReply>>) => {
          if (event.type === 'exit') stopped.reject(Object.assign(new Error('Root Session ended'), { code: 'ROOT_EXITED' }));
        };
        const unsubscribe = harness.onReply(check);
        try {
          signal.throwIfAborted();
          const last = harness.lastReply();
          if (last) check(last);
          return await stopped.promise;
        } finally {
          abort[Symbol.dispose]();
          unsubscribe();
        }
      } : undefined, {
        childFiles: context.initial.files,
        onChange: () => { void observation?.refresh(); },
        userQuestions: context.clientCapabilities.questions ? userQuestions(context, questionTimeoutMs) : undefined,
        onDeadline: value => { deadlineAt = value; },
        onRuntime: (runtime, team) => {
          const native = getExecutorCapabilities(config.executor ?? 'pi');
          observation = observeProjectRuntime(runtime, context, () => ({ ...team.exportState() as Record<string, unknown>, deadlineAt }), {
            fence: team.beginClose,
            reconcile: (operation, agentId, { operationId }, payload) => {
              const text = operation === 'send' && typeof (payload as { input: unknown }).input === 'string';
              const nativeOperation = operation === 'send' && !text ? 'context' : operation;
              const lookup = () => observation!.reconcile(agentId, nativeOperation, operationId);
              if (operation === 'interrupt' || operation === 'clearQueue') return team.reconcileRootControl(operation, operationId, lookup);
              return text ? team.reconcileRootInput(operationId, lookup) : lookup();
            },
            capabilities: agentId => {
              if (agentId !== team.rootId()) return {};
              return {
                configure: { supported: true, fields: configureFields },
                compact: { supported: true, ...(team.rootBusy() ? { available: false, reason: 'OPERATION_BUSY' } : {}) },
                abortRetry: { supported: true },
                clearQueue: { supported: true },
                send: { supported: true, text: true, context: true, modes, deliveries },
                interrupt: { supported: native.queuedInputCancellation },
              };
            },
            handlers: {
              compact: (_agentId, payload, request) => team.compactRoot({ ...(payload as { customInstructions?: string }), requestId: request.operationId }),
              clearQueue: (_agentId, _payload, request) => team.rootQueueControl('clearQueue', request.operationId),
              interrupt: (_agentId, _payload, request) => team.rootQueueControl('interrupt', request.operationId),
              send(_agentId, payload, request) {
                const { input, options } = payload as { input: string | ContextInput; options: Omit<SendOptions, 'requestId'> | ContextSendOptions };
                return typeof input === 'string' ? team.submitUser(input, request, options as SendOptions, request.signal)
                  : team.sendRootContext(input, { ...options, requestId: request.operationId } as ContextSendOptions, request.signal);
              },
            },
          });
        },
        onReady: harness => {
          context.registerInput((input, { operationId, signal, binding }) => {
            const { text, mode } = parseInput(input);
            return harness.input(text, { operationId }, { mode }, signal, binding as number);
          }, rootInput, input => {
            parseInput(input);
            return harness.inputFence();
          }, (_input, { operationId }) => harness.reconcileInput(operationId,
            () => observation!.reconcile(harness.rootId, 'send', operationId)));
          context.markRunning();
        },
      }, context.runWithRuntime);
      return { ...result, acceptance: { status: 'not-run' } };
    } finally {
      observation?.close();
    }
  },
} satisfies Harness;

export default subagents;

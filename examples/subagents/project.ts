import { addAbortListener } from 'node:events';
import { createHash } from 'node:crypto';
import { runSubagentsHarness } from './main.js';
import {
  createInProcessAdapter, getExecutorCapabilities, type AgentSessionPatch, type ContextInput, type ContextSendOptions,
  type HarnessJson, type ProjectHarness, type ProjectHarnessContext, type SendOptions, type ServiceManifest,
  ProjectPreflightError, observeProjectRuntime, projectConfiguration, projectResult,
} from '@luna-shi/murm';

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

const questionManifest: ServiceManifest = {
  id: 'user-interaction', title: 'Ask the user', purpose: 'Ask an explicit question needed for the current work.',
  provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' },
  capabilities: [{
    name: 'ask', operation: 'ask', description: 'Wait for the user to answer a specific question.',
    side_effect: 'write', idempotent: true, timeout_ms: 65_000,
    help: { when: 'Ask for a fact or decision that is needed to continue the work.' },
    input_schema: { type: 'object', required: ['text'], additionalProperties: false,
      properties: { text: { type: 'string', minLength: 1, maxLength: 2048 } } },
    output_schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false },
    errors: [{ code: 'QUESTION_CANCELLED', retryable: false }, { code: 'QUESTION_EXPIRED', retryable: false }],
  }],
};

function userQuestions(context: ProjectHarnessContext) {
  return {
    manifest: questionManifest,
    adapter: createInProcessAdapter({
      async invoke(request) {
        request.assertAuthorized();
        const id = createHash('sha256').update(JSON.stringify([request.caller.agentId, request.envelope.operation_id])).digest('hex');
        const answer = await context.askUser({
          kind: 'text', requestId: 'ask:' + id, agentId: request.caller.agentId,
          text: (request.input as { text: string }).text, timeoutMs: 60_000,
        }, {
          id, agentId: request.caller.agentId, signal: request.signal, assertAuthorized: request.assertAuthorized,
        });
        request.signal.throwIfAborted();
        request.assertAuthorized();
        return { answer: answer as string };
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
    const config = await projectConfiguration<Parameters<typeof runSubagentsHarness>[0]>(context, () => import('./config.js'));
    if (![config.workTimeoutMs ?? 120_000, config.closeTimeoutMs ?? 30_000]
      .every(limit => Number.isSafeInteger(limit) && limit > 0 && limit <= 2_147_483_647)) {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Subagents requires finite work and close waits');
    }
    if (config.workspace) throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'The project entry uses private Subagents work directories');
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    try {
      const report = await runSubagentsHarness({
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
        userQuestions: context.clientCapabilities.questions ? userQuestions(context) : undefined,
        onRuntime: (runtime, team) => {
          const native = getExecutorCapabilities(config.executor ?? 'pi');
          observation = observeProjectRuntime(runtime, context, team.exportState, {
            fence: team.beginClose,
            capabilities: agentId => {
              if (agentId !== team.rootId()) return {};
              return {
                configure: { supported: !!native.session?.configure, fields: configureFields },
                compact: { supported: !!native.session?.compact, ...(team.rootBusy() ? { available: false, reason: 'OPERATION_BUSY' } : {}) },
                abortRetry: { supported: !!native.session?.abortRetry },
                clearQueue: { supported: !!native.session?.clearQueue },
                send: { supported: true, text: true, context: !!native.session?.context,
                  modes, deliveries: native.session?.context ? deliveries : [] },
                interrupt: { supported: native.queuedInputCancellation },
              };
            },
            handlers: {
              configure: (agentId, patch, request) => runtime.session.configure(agentId, patch as AgentSessionPatch, request),
              compact: (_agentId, payload, request) => team.compactRoot({ ...(payload as { customInstructions?: string }), requestId: request.requestId }),
              abortRetry: (agentId, _payload, request) => runtime.session.abortRetry(agentId, request),
              clearQueue: (_agentId, _payload, request) => team.rootQueueControl('clearQueue', request.requestId),
              interrupt: (_agentId, _payload, request) => team.rootQueueControl('interrupt', request.requestId),
              send(_agentId, payload, request) {
                const { input, options } = payload as { input: string | ContextInput; options: Omit<SendOptions, 'requestId'> | ContextSendOptions };
                return typeof input === 'string' ? team.submitUser(input, request.requestId, options as SendOptions, request.signal)
                  : team.sendRootContext(input, { ...options, requestId: request.requestId } as ContextSendOptions, request.signal);
              },
            },
          });
        },
        onReady: harness => {
          context.registerInput(async (input, { requestId, signal, binding }) => {
            const { text, mode } = parseInput(input);
            const id = createHash('sha256').update(requestId).digest('hex');
            return JSON.parse(JSON.stringify(await harness.input(text, `rpc:${id}`, { mode }, signal, binding as number)));
          }, rootInput, input => {
            parseInput(input);
            return harness.inputFence();
          });
          context.markRunning();
        },
      });
      return { ...projectResult(report, context, report.collaboration), acceptance: { status: 'not-run' } };
    } finally {
      observation?.close();
    }
  },
} satisfies ProjectHarness;

export default subagents;

import type { Runtime, InputReceipt, ConditionalInputReceipt, InterruptReceipt, StopReceipt, SendOptions } from '../core/types.js';
import type { AgentSessionPatch, AgentSessionState, AgentSessionStats, AgentSessionMessages, ContextInput, ContextSendOptions, ContextInputReceipt, SessionControlReceipt } from '../core/session-types.js';
import type { HarnessInput, HarnessJson, Harness } from './project-harness.js';

export type HarnessLifetime = 'task' | 'interactive';
export type HarnessRequest = Readonly<{ requestId: string }>;
/** Stable downstream identity for a request admitted by this Session. */
export type HarnessDispatchRequest = HarnessRequest & Readonly<{ operationId: string; signal: AbortSignal }>;
export type HarnessPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'finished';
export type HarnessOperation = 'getState' | 'getStats' | 'getMessages' | 'configure' | 'compact' | 'abortRetry' |
  'clearQueue' | 'send' | 'interrupt' | 'stop';
export type HarnessCapability = Readonly<{
  supported: boolean;
  available?: boolean;
  reason?: string;
  fields?: readonly string[];
  modes?: readonly string[];
  deliveries?: readonly string[];
  text?: boolean;
  context?: boolean;
}>;
export type HarnessInputDescriptor = Readonly<{ description?: string; schema?: HarnessJson; targets?: HarnessJson }>;
export type HarnessDescriptor = Readonly<{
  id: string;
  apiVersion: 1;
  lifetimes: readonly HarnessLifetime[];
  input: HarnessCapability & HarnessInputDescriptor;
  questions: HarnessCapability;
  agents: Readonly<Record<string, Partial<Record<HarnessOperation, HarnessCapability>>>>;
}>;
export type HarnessQuestionKind = 'text' | 'choice' | 'confirm';
export type HarnessAnswer = string | boolean;
export interface HarnessQuestionRequest {
  requestId: string;
  questionId?: string;
  kind: HarnessQuestionKind;
  text: string;
  options?: readonly Readonly<{ id: string; label: string }>[];
  agentId?: string;
  businessRef?: HarnessJson;
  timeoutMs?: number;
}
export interface HarnessQuestionSource {
  /** Stable execution, Service call, or explicitly owned business lifecycle. */
  id: string;
  signal: AbortSignal;
  agentId?: string;
  assertAuthorized?: () => void;
}
export interface HarnessQuestion {
  questionId: string;
  requestId: string;
  kind: HarnessQuestionKind;
  text: string;
  options?: readonly Readonly<{ id: string; label: string }>[];
  agentId?: string;
  businessRef?: HarnessJson;
  sourceId: string;
  createdAt: string;
  deadline: string;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  /** Maximum UTF-8 bytes of the JSON-encoded string answer, including its quotes. */
  maxAnswerBytes?: number;
  reason?: string;
  answer?: HarnessAnswer;
}
export interface HarnessState {
  runId: string | null;
  harness: Readonly<{ id: string; apiVersion: 1 }>;
  phase: HarnessPhase;
  lifetime: HarnessLifetime;
  capabilities: HarnessDescriptor;
  clientCapabilities: Readonly<{ questions: boolean }>;
  agents: HarnessJson;
  business: HarnessJson;
  questions: readonly HarnessQuestion[];
  output: readonly HarnessJson[];
  stopReason: string | null;
  observedAt: string;
  snapshotTruncated?: boolean;
  result?: HarnessResult;
}
export type HarnessEvent =
  | Readonly<{ type: 'snapshot'; state: HarnessState }>
  | Readonly<{ type: 'state'; state: HarnessState }>
  | Readonly<{ type: 'event'; runId: string | null; event: HarnessJson }>
  | Readonly<{ type: 'question'; runId: string | null; question: HarnessQuestion }>
  | Readonly<{ type: 'operation'; runId: string | null; requestId: string; operation: string; result: unknown }>
  | Readonly<{ type: 'result'; result: HarnessResult }>;
export interface HarnessSubscriptionOptions {
  initialSnapshot?: boolean;
  /** Called independently of the event handler when this subscription can no longer deliver an ordered view. */
  onError?: (error: Error) => void;
}
export interface HarnessStartReceipt { runId: string; phase: 'starting'; status: 'accepted' }
export interface HarnessInputReceipt {
  status: 'accepted' | 'unknown' | 'not_submitted';
  requestId: string;
  result?: HarnessJson;
  reason?: string;
}
export interface HarnessAnswerReceipt { status: 'answered' | 'cancelled' | 'expired'; questionId: string; answer?: HarnessAnswer }
export interface HarnessStopReceipt { status: 'accepted'; runId: string | null; phase: HarnessPhase; reason: string }
export type HarnessResult = Awaited<ReturnType<Harness['run']>> & {
  runId: string;
  harness: Readonly<{ id: string; apiVersion: 1 }>;
  stopReason: string | null;
  failure: Readonly<{ code: string; message: string }> | null;
  reportSaveFailure: Readonly<{ code: string; message: string }> | null;
  questions?: readonly HarnessQuestion[];
  operations?: readonly Readonly<{ requestId: string; operation: string; status: 'pending' | 'unknown' | 'confirmed' | 'failed' }>[];
  snapshotTruncated?: boolean;
  reportPath?: string;
};
export type HarnessAgentHandler = (agentId: string, payload: unknown, request: HarnessDispatchRequest) => Promise<unknown> | unknown;
export interface HarnessAgentRegistration {
  runtime: Runtime;
  /** Targets are refreshed for each query and dispatch. */
  targets?: () => readonly string[] | Promise<readonly string[]>;
  capabilities?: Partial<Record<HarnessOperation, HarnessCapability>> | ((agentId: string) => Partial<Record<HarnessOperation, HarnessCapability>>);
  handlers?: Partial<Record<HarnessOperation, HarnessAgentHandler>>;
  /** Refresh Harness-owned state when the Runtime reports a lifecycle or membership change. */
  onChange?: () => void;
  /** Stop new business dispatch synchronously, retaining cleanup ownership. */
  fence?: () => void;
  /** Optional reconciliation reads the original operation and never redispatches it. */
  reconcile?: (operation: HarnessOperation, agentId: string, request: HarnessDispatchRequest, payload: unknown) => Promise<unknown>;
}
export type HarnessAgentReceipt<T> = T | Readonly<{ core: T; harnessEffects: HarnessJson }> | Readonly<{ status: 'unknown'; requestId: string }>;
export interface HarnessAgents {
  getState(agentId: string): Promise<AgentSessionState>;
  getStats(agentId: string): Promise<AgentSessionStats>;
  getMessages(agentId: string, options?: Readonly<{ limit?: number; maxBytes?: number }>): Promise<AgentSessionMessages>;
  configure(agentId: string, patch: AgentSessionPatch, request: HarnessRequest): Promise<HarnessAgentReceipt<SessionControlReceipt>>;
  compact(agentId: string, options: HarnessRequest & { customInstructions?: string }): Promise<HarnessAgentReceipt<SessionControlReceipt>>;
  abortRetry(agentId: string, request: HarnessRequest): Promise<HarnessAgentReceipt<SessionControlReceipt>>;
  clearQueue(agentId: string, request: HarnessRequest): Promise<HarnessAgentReceipt<SessionControlReceipt>>;
  send(agentId: string, input: string, options: SendOptions): Promise<HarnessAgentReceipt<InputReceipt | ConditionalInputReceipt>>;
  send(agentId: string, input: ContextInput, options: ContextSendOptions): Promise<HarnessAgentReceipt<ContextInputReceipt>>;
  interrupt(agentId: string, request: HarnessRequest): Promise<HarnessAgentReceipt<InterruptReceipt>>;
  stop(agentId: string, options: HarnessRequest & { reason?: string }): Promise<HarnessAgentReceipt<StopReceipt>>;
}
export interface HarnessSession {
  describe(): Promise<HarnessDescriptor>;
  start(input: HarnessInput, request: HarnessRequest): Promise<HarnessStartReceipt>;
  input(payload: HarnessJson, request: HarnessRequest): Promise<HarnessInputReceipt>;
  respond(questionId: string, answer: HarnessAnswer, request: HarnessRequest): Promise<HarnessAnswerReceipt>;
  getState(): Promise<HarnessState>;
  onEvent(handler: (event: HarnessEvent) => void, options?: HarnessSubscriptionOptions): () => void;
  readonly agents: HarnessAgents;
  stop(request: HarnessRequest & { reason?: string }): Promise<HarnessStopReceipt>;
  readonly completion: Promise<HarnessResult> | undefined;
}
export interface HarnessSessionOptions {
  launchDirectory?: string;
  configPath?: string;
  configuration?: unknown;
  outputRoot?: string;
  stopTimeoutMs?: number;
  lifetime?: HarnessLifetime;
  clientCapabilities?: Readonly<{ questions?: boolean }>;
  limits?: Readonly<{ inputQueue?: number; inputBytes?: number; mutations?: number; questions?: number; questionBytes?: number; handlerTimeoutMs?: number; snapshotBytes?: number }>;
}
export type HarnessSessionFactory = (definition: Harness, options?: HarnessSessionOptions) => HarnessSession;

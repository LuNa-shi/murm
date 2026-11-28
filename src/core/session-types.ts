import type { JsonValue } from './service-types.js';
import type { ErrorInfo } from './types.js';
import type { SteeringMode } from './backend-config.js';

export interface AgentSessionResources {
  skills?: readonly string[];
  extensions?: readonly string[];
  promptTemplates?: readonly string[];
  contextFiles?: readonly string[];
}
export interface AgentSessionConfig {
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; maxAgentDelayMs?: number };
  steeringMode?: SteeringMode;
  followUpMode?: SteeringMode;
  tools?: readonly string[];
  resources?: AgentSessionResources;
}
export type AgentSessionPatch = Pick<AgentSessionConfig, 'thinkingLevel' | 'steeringMode' | 'followUpMode'> & {
  compaction?: { enabled?: boolean };
  retry?: { enabled?: boolean };
};
export interface AgentSessionCapabilities {
  readonly configure: boolean;
  readonly compact: boolean;
  readonly abortRetry: boolean;
  readonly clearQueue: boolean;
  readonly state: boolean;
  readonly stats: boolean;
  readonly messages: boolean;
  readonly context: boolean;
  readonly beforeCompact: boolean;
}
export interface SessionRequest { requestId: string }
export interface CompactOptions extends SessionRequest { customInstructions?: string }
export interface SessionMessagesOptions { limit?: number; maxBytes?: number }
export interface ContextInput {
  type: 'context';
  customType: string;
  content: string;
  display?: boolean;
  details?: JsonValue;
}
export type ContextDelivery = 'append' | 'nextTurn' | 'steer' | 'followUp';
export interface ContextSendOptions extends SessionRequest {
  delivery: ContextDelivery;
  source?: string;
  wakeIfIdle?: boolean;
}
export type ContextInputReceipt = { inputId: string } & (
  | { status: 'accepted'; disposition: 'appended' | 'pending-append' | 'pending-next-turn' | 'started' | 'queued' }
  | { status: 'unknown' }
  | { status: 'not-accepted'; reason: 'idle' }
);
export interface AgentSessionState {
  readonly observedAt: string;
  readonly executor: { kind: string; version: string };
  readonly capabilities: AgentSessionCapabilities;
  readonly configuration: AgentSessionConfig;
  readonly model: { provider: string; id: string };
  readonly thinkingLevels: readonly string[];
  readonly active: boolean;
  readonly compacting: boolean;
  readonly retrying: boolean;
  readonly tools: readonly string[];
  readonly toolActivity: readonly { toolCallId: string; toolName: string }[];
  readonly resources: AgentSessionResources;
  readonly queue: { steering: readonly string[]; followUp: readonly string[] };
  readonly pendingContext: readonly { inputId: string; delivery: ContextDelivery; status: string }[];
  readonly [key: string]: unknown;
}
export interface AgentSessionStats {
  readonly sessionUsage: { source: 'pi-session'; cost: null; costStatus: 'not-configured'; [key: string]: unknown };
  readonly contextUsage: { tokens: number | null; contextWindow: number | null; percent: number | null };
  readonly compactions: { successfulAutoCompactions: number; manual: number; failed: number; cancelled: number };
  readonly [key: string]: unknown;
}
export interface AgentSessionMessages {
  readonly messages: readonly { id: string; role: string; [key: string]: unknown }[];
  readonly truncated: boolean;
  readonly observedAt: string;
}
export type SessionControlReceipt = { operationId: string; agentId: string; requestId: string } & (
  | { status: 'applied' | 'completed' | 'noop'; configuration?: AgentSessionConfig; result?: JsonValue; [key: string]: unknown }
  | { status: 'busy'; reason: string }
  | { status: 'unknown' }
  | { status: 'failed'; error: ErrorInfo }
);
export interface RuntimeSession {
  configure(agentId: string, patch: AgentSessionPatch, request: SessionRequest): Promise<SessionControlReceipt>;
  compact(agentId: string, options: CompactOptions): Promise<SessionControlReceipt>;
  abortRetry(agentId: string, request: SessionRequest): Promise<SessionControlReceipt>;
  clearQueue(agentId: string, request: SessionRequest): Promise<SessionControlReceipt>;
  getState(agentId: string): Promise<AgentSessionState>;
  getStats(agentId: string): Promise<AgentSessionStats>;
  getMessages(agentId: string, options?: SessionMessagesOptions): Promise<AgentSessionMessages>;
}
export type BeforeCompactDecision = 'allow' | 'cancel' | 'stop';
export interface BeforeCompactRequest {
  readonly agentId: string;
  readonly profile: string;
  readonly sessionId: string;
  readonly executionEpoch: number;
  readonly compactionId: string;
  readonly reason: 'manual' | 'threshold' | 'overflow';
  readonly successfulAutoCompactions: number;
  readonly signal: AbortSignal;
}
export interface RuntimeHooks {
  beforeCompact?: { timeoutMs?: number; handler(request: BeforeCompactRequest): BeforeCompactDecision | Promise<BeforeCompactDecision> };
}
export type SessionEvent = { type: 'session'; event: { type: string; [key: string]: unknown } };

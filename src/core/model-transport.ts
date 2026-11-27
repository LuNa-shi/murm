export type ModelProtocol = 'responses' | 'chat-completions';

export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  tools: boolean;
  reasoning: boolean;
}

export interface ModelStreamTerminal {
  status: 'completed' | 'incomplete' | 'failed';
  usage?: { inputTokens: number; outputTokens: number };
}

/** Trusted Host code. Receives JSON and complete SSE data frames, without credentials. */
export interface ModelTransport {
  readonly id: string;
  readonly version: string;
  /** Wire protocol used by built-in executors when connecting to the Runtime gateway. */
  readonly clientProtocol?: ModelProtocol;
  /** Absolute path of the Agent-facing POST endpoint, relative to the origin. */
  readonly path: string;
  validateUpstream(url: URL): boolean;
  prepareRequest(body: unknown, policy: {
    model: string;
    maxOutputTokens: number | null;
    capabilities?: ModelCapabilities;
  }): Record<string, unknown> | null;
  stream(model: string): {
    /** Return a terminal status only when it is safe to replay the complete stream. */
    accept(data: string): ModelStreamTerminal | undefined;
  };
}

export function modelClientProtocol(protocol: ModelProtocol | ModelTransport = 'responses') {
  return typeof protocol === 'string' ? protocol : protocol.clientProtocol;
}

export function validateModelCapabilities(capabilities: ModelCapabilities | undefined) {
  if (capabilities === undefined) return;
  if (!capabilities || !Number.isSafeInteger(capabilities.contextWindow) || capabilities.contextWindow < 16 ||
      !Number.isSafeInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens < 16 ||
      capabilities.maxOutputTokens > capabilities.contextWindow ||
      typeof capabilities.tools !== 'boolean' || typeof capabilities.reasoning !== 'boolean') {
    throw new TypeError('Model capabilities require a finite context window and output ceiling, plus tools and reasoning flags');
  }
}

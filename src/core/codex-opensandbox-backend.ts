import type { Backend } from './types.js';
import type { CodexOpenSandboxBackendConfig } from './backend-config.js';
import { createOpenSandboxBackend } from './opensandbox-backend.js';

export function createCodexOpenSandboxBackend(config: CodexOpenSandboxBackendConfig): Backend {
  return createOpenSandboxBackend({ ...config, modelGateway: { maxOutputTokens: null, ...config.modelGateway }, executor: { kind: 'codex', version: '0.172.0' } });
}

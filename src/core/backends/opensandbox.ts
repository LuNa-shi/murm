import type { Backend } from '../types.js';
import type { OpenSandboxBackendConfig } from '../backend-config.js';
import { createPiOpenSandboxBackend } from '../pi-opensandbox-backend.js';
import { createCodexOpenSandboxBackend } from '../codex-opensandbox-backend.js';

export type ConfiguredOpenSandboxBackendConfig = Omit<OpenSandboxBackendConfig, 'executor'> & {
  executor?: 'pi' | 'codex';
};

export function createOpenSandboxBackend(config: ConfiguredOpenSandboxBackendConfig): Backend {
  const { executor = 'pi', ...options } = config;
  if (executor === 'pi') return createPiOpenSandboxBackend(options);
  if (executor === 'codex') return createCodexOpenSandboxBackend(options);
  throw Object.assign(new Error('executor must be pi or codex'), { code: 'INVALID_CONTRACT' });
}

export type { BackendCapabilities } from '../executor-driver.js';

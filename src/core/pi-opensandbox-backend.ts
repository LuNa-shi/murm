import type { Backend } from './types.js';
import type { PiOpenSandboxBackendConfig } from './backend-config.js';
import { createOpenSandboxBackend, claimOpenSandboxBackend, openOpenSandboxBackend } from './opensandbox-backend.js';

export function createPiOpenSandboxBackend(config: PiOpenSandboxBackendConfig): Backend {
  return createOpenSandboxBackend({ ...config, executor: { kind: 'pi', version: '1.3.0' } });
}

// Retained internal entry points for existing consumers of the Pi implementation.
export const claimPiOpenSandboxBackend = claimOpenSandboxBackend;
export const openPiOpenSandboxBackend = openOpenSandboxBackend;
export type { BackendEvent, BackendInputReceipt } from './opensandbox-backend.js';

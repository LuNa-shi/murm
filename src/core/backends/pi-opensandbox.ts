import type { Backend } from '../types.js';
import type { PiOpenSandboxBackendConfig } from '../backend-config.js';
import { createOpenSandboxBackend } from './opensandbox.js';

export type { PiOpenSandboxBackendConfig } from '../backend-config.js';

/** @deprecated Select Pi through createOpenSandboxBackend and its executor setting. */
export function createPiOpenSandboxBackend(config: PiOpenSandboxBackendConfig): Backend {
  return createOpenSandboxBackend({ ...config, executor: 'pi' });
}

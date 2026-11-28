import type { OpenSandboxBackendConfig } from '../backend-config.js';
import type { SandboxManager } from './opensandbox-backend.js';
import { DEFAULT_WORKER_IMAGE } from '../worker-image.js';
import { OpenSandboxManager } from './opensandbox-manager.js';

export interface SandboxPreparation {
  sandboxId: string;
  agent: { agent_id: string; runtime_id: string; resource_key: string };
  bridgeUrl: string;
  modelUrl: string;
  additionalEndpoints: readonly string[];
  workspace?: { id: string; mode: 'read-only' | 'read-write' };
  assertOpen(): void;
}

export interface SandboxProvider {
  readonly id: string;
  readonly version: string;
  readonly capabilities: Readonly<{ sharedWorkspace?: boolean; networkAllowlist?: boolean }>;
  preflight(): Promise<void>;
  openManager(image: string): SandboxManager;
  prepareSandbox(input: SandboxPreparation): Promise<void>;
  createSharedWorkspace?(runtimeId: string, workspaceId: string): Promise<void>;
  deleteSharedWorkspace?(runtimeId: string, workspaceId: string): Promise<void>;
}

export interface OpenSandboxProvider {
  readonly id: string;
  readonly version?: string;
  readonly capabilities?: SandboxProvider['capabilities'];
  preflight?(): Promise<void>;
  beforeAllocation?(): Promise<void>;
  openManager(image: string): SandboxManager;
  prepareSandbox(input: SandboxPreparation): Promise<void>;
  createSharedWorkspace(runtimeId: string, workspaceId: string): Promise<void>;
  deleteSharedWorkspace(runtimeId: string, workspaceId: string): Promise<void>;
}

export function createApiOpenSandboxProvider({ sandbox }: OpenSandboxBackendConfig): OpenSandboxProvider {
  const manager = (image = DEFAULT_WORKER_IMAGE) => new OpenSandboxManager({ ...sandbox, image, requireManagementAuth: true });
  let verified: Promise<void> | undefined;
  return {
    id: 'opensandbox', version: 'sdk-1.2.1', capabilities: { networkAllowlist: sandbox.egressMode === 'dns+nft' },
    beforeAllocation() {
      verified ??= (async () => {
        const probe = manager();
        try { await probe.preflight(); }
        finally { await probe.close(); }
      })().catch(error => { verified = undefined; throw error; });
      return verified;
    },
    openManager: image => manager(image) as unknown as SandboxManager,
    async prepareSandbox() {},
    async createSharedWorkspace() { throw new Error('This OpenSandbox API deployment does not support live shared workspaces'); },
    async deleteSharedWorkspace() {},
  };
}

export function adaptSandboxProvider(provider: SandboxProvider): SandboxProvider & OpenSandboxProvider {
  const preflight = provider.preflight.bind(provider);
  const openManager = provider.openManager.bind(provider);
  const prepareSandbox = provider.prepareSandbox.bind(provider);
  const createSharedWorkspace = provider.createSharedWorkspace?.bind(provider);
  const deleteSharedWorkspace = provider.deleteSharedWorkspace?.bind(provider);
  return {
    id: provider.id, version: provider.version, capabilities: Object.freeze({ ...provider.capabilities }),
    preflight, openManager, prepareSandbox,
    async createSharedWorkspace(runtimeId, workspaceId) {
      if (!createSharedWorkspace) throw new Error('Shared Workspace creation is unavailable');
      await createSharedWorkspace(runtimeId, workspaceId);
    },
    async deleteSharedWorkspace(runtimeId, workspaceId) { await deleteSharedWorkspace?.(runtimeId, workspaceId); },
  };
}

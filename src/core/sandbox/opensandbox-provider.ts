import type { OpenSandboxBackendConfig } from '../backend-config.js';
import type { SandboxManager } from './opensandbox-backend.js';
import { DockerAgentDisk } from './docker-agent-disk.js';
import { DockerAgentNetwork } from './docker-agent-network.js';
import { DEFAULT_WORKER_IMAGE } from '../worker-image.js';
import { OpenSandboxManager } from './opensandbox-manager.js';

type WorkspaceQuota = { bytes: number; inodes: number };

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
  readonly projectQuotaRequired?: boolean;
  preflight?(): Promise<void>;
  openManager(image: string): SandboxManager;
  prepareSandbox(input: SandboxPreparation): Promise<void | WorkspaceQuota>;
  createSharedWorkspace(runtimeId: string, workspaceId: string): Promise<void>;
  deleteSharedWorkspace(runtimeId: string, workspaceId: string): Promise<void>;
}

export function checkLocalWorkspaceQuota(quota: WorkspaceQuota): void {
  new DockerAgentDisk(quota);
}

export function createLocalOpenSandboxProvider({ sandbox, isolation }: OpenSandboxBackendConfig): OpenSandboxProvider {
  const network = new DockerAgentNetwork();
  if (isolation.network !== 'local-docker') throw new TypeError('Strict local Docker isolation requires disk and inode limits');
  const disk = new DockerAgentDisk(isolation.disk);
  return {
    id: 'local', version: 'strict-local-docker', capabilities: { sharedWorkspace: true, networkAllowlist: true },
    openManager: image => new OpenSandboxManager({ ...sandbox, image }) as unknown as SandboxManager,
    async prepareSandbox({ workspace, assertOpen, ...input }) {
      await network.isolate(input);
      assertOpen();
      const quota = await disk.isolate(input);
      if (workspace) {
        await disk.sharedWorkspace('attach', { runtimeId: input.agent.runtime_id, workspaceId: workspace.id,
          mode: workspace.mode, sandboxId: input.sandboxId, agent: input.agent });
      }
      return quota;
    },
    createSharedWorkspace: (runtimeId, workspaceId) => disk.sharedWorkspace('create', { runtimeId, workspaceId }),
    deleteSharedWorkspace: (runtimeId, workspaceId) => disk.sharedWorkspace('delete', { runtimeId, workspaceId }),
  };
}

export function createApiOpenSandboxProvider({ sandbox }: OpenSandboxBackendConfig): OpenSandboxProvider {
  const manager = (image = DEFAULT_WORKER_IMAGE) => new OpenSandboxManager({ ...sandbox, image, requireManagementAuth: true });
  return {
    id: 'opensandbox', version: 'lifecycle-v1', capabilities: {},
    projectQuotaRequired: false,
    async preflight() { await manager().preflight(); },
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
    projectQuotaRequired: false, preflight, openManager, prepareSandbox,
    async createSharedWorkspace(runtimeId, workspaceId) {
      if (!createSharedWorkspace) throw new Error('Shared Workspace creation is unavailable');
      await createSharedWorkspace(runtimeId, workspaceId);
    },
    async deleteSharedWorkspace(runtimeId, workspaceId) { await deleteSharedWorkspace?.(runtimeId, workspaceId); },
  };
}

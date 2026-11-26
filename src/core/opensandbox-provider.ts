import type { OpenSandboxBackendConfig } from './backend-config.js';
import type { SandboxManager } from './opensandbox-backend.js';
import { DockerAgentDisk } from '../runtime/docker-agent-disk.js';
import { DockerAgentNetwork } from '../runtime/docker-agent-network.js';
import { OpenSandboxManager } from '../runtime/opensandbox-manager.js';

type WorkspaceQuota = OpenSandboxBackendConfig['isolation']['disk'];

interface SandboxPreparation {
  sandboxId: string;
  agent: { agent_id: string; runtime_id: string; resource_key: string };
  bridgeUrl: string;
  modelUrl: string;
  additionalEndpoints: readonly string[];
  workspace?: { id: string; mode: 'read-only' | 'read-write' };
  assertOpen(): void;
}

export interface OpenSandboxProvider {
  readonly id: string;
  openManager(image: string): SandboxManager;
  prepareSandbox(input: SandboxPreparation): Promise<WorkspaceQuota>;
  createSharedWorkspace(runtimeId: string, workspaceId: string): Promise<void>;
  deleteSharedWorkspace(runtimeId: string, workspaceId: string): Promise<void>;
}

export function checkLocalWorkspaceQuota(quota: WorkspaceQuota): void {
  new DockerAgentDisk(quota);
}

export function createLocalOpenSandboxProvider({ sandbox, isolation }: OpenSandboxBackendConfig): OpenSandboxProvider {
  const network = new DockerAgentNetwork();
  const disk = new DockerAgentDisk(isolation.disk);
  return {
    id: 'local',
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

import { randomUUID } from 'node:crypto';
import type { OpenSandboxBackendConfig } from './backend-config.js';

export interface BackendCapabilities {
  activeSteer: boolean;
  followUp: boolean;
  conditionalInput: boolean;
  queuedInputCancellation: boolean;
  contextFork: boolean;
  modelRequestAuthorization: boolean;
  rawModelRequestTrace: boolean;
  steeringModes: readonly ('all' | 'one-at-a-time')[];
}

export function executorDriver(config: OpenSandboxBackendConfig) {
  const kind = config.executor?.kind ?? 'pi';
  const version = config.executor?.version ?? '1.3.0';
  const capabilities: Readonly<BackendCapabilities> = Object.freeze({
    activeSteer: true, followUp: true, conditionalInput: true, queuedInputCancellation: true,
    contextFork: kind === 'pi', modelRequestAuthorization: true, rawModelRequestTrace: true,
    steeringModes: Object.freeze(kind === 'pi' ? ['all', 'one-at-a-time'] as const : ['all'] as const),
  });
  return {
    kind, version, name: kind === 'pi' ? 'Pi' : 'Codex', capabilities,
    assertEnvironment(environment: Readonly<Record<string, string>> | undefined) {
      if (kind === 'codex' && Object.keys(environment ?? {}).some(key => /^(?:CODEX_|OPENAI_)/.test(key))) {
        throw Object.assign(new Error('Codex configuration and model credentials must be supplied through the backend'), { code: 'INVALID_CONTRACT' });
      }
    },
    assertVersion(versions: Record<string, unknown>) {
      if (versions[`${kind}Version`] !== version) throw Object.assign(new Error(`Backend requires ${kind} ${version}`), { code: 'INVALID_CONTRACT' });
    },
    start({ model, baseUrl, forkSession }: { model: OpenSandboxBackendConfig['models'][string]; baseUrl: string; forkSession: boolean }) {
      if (kind === 'codex') return { command: 'codex', args: [], codex: { model: model.model, baseUrl, version } };
      return { command: 'pi', args: ['--mode', 'rpc', '--session-dir', '/workspace/runtime/pi-session',
        ...(forkSession ? ['--session', '/workspace/runtime/pi-session/fork.jsonl'] : ['--session-id', randomUUID()]),
        '--tools', 'read,write,edit,bash', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        '--system-prompt', '/workspace/runtime/profile-prompt.txt', '--provider', model.provider, '--model', model.model] };
    },
  };
}

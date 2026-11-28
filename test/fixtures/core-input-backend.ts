export const createSandbox = () => Object.freeze({});
import { DEFAULT_FILE_POLICY } from '../../src/core/file-policy.js';
import { selectExecutorDriver } from '../../src/core/sandbox/executor-driver.js';

export const configuration = {
  sandbox: {},
  filePolicy: DEFAULT_FILE_POLICY,
  isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
  bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
  modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
  models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
};
export const transport = {
  sessionCalls: [], sessionReply: undefined, spawned: [],
  submissions: new Map(), listeners: new Map(), interruptCalls: [],
  reset() { this.sessionCalls = []; this.sessionReply = undefined; this.spawned = []; this.submissions.clear(); this.listeners.clear(); this.interruptCalls = []; this.onInterrupt = undefined; this.next = undefined; },
  confirm(id, disposition) { this.submissions.get(id).receipt = { status: 'accepted', disposition }; },
};
export const claimOpenSandboxBackend = () => ({ ...configuration, driver: selectExecutorDriver() });
export async function openOpenSandboxBackend() {
  return {
    async spawn({ agentId, onEvent, options }) {
      transport.spawned.push({ agentId, options });
      transport.listeners.set(agentId, onEvent);
      return { sandboxId: `fixture-${agentId}`, versions: { piVersion: '1.3.0' } };
    },
    async send(agentId, input, { mode, inputId, steeringMode, wakeIfIdle }) {
      if (!transport.submissions.has(inputId)) {
        transport.submissions.set(inputId, { agentId, input, mode, steeringMode, wakeIfIdle, receipt: { status: 'unknown' } });
        const next = transport.next; transport.next = undefined;
        await next?.(inputId);
      }
      return transport.submissions.get(inputId).receipt;
    },
    async sessionCommand(agentId, command, payload, query) {
      transport.sessionCalls.push({ agentId, command, payload, query });
      return transport.sessionReply?.({ agentId, command, payload, query }) ?? { status: 'applied' };
    },
    async interrupt(agentId, { interruptId, executionEpoch }) {
      transport.interruptCalls.push({ agentId, interruptId, executionEpoch });
      return transport.onInterrupt();
    },
    async stopExecution() { return { collectable: false }; },
    resource() { return { creation: 'absent' }; },
    async destroy() {}, async close() {},
  };
}

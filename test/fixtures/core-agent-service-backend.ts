export { createSandbox } from './core-input-backend.js';
import { claimOpenSandboxBackend as claim, configuration } from './core-input-backend.js';
export const transport = { spawns: new Map(), submissions: new Map(), reset() { this.spawns.clear(); this.submissions.clear(); this.next = undefined; this.onSpawn = undefined; this.onStop = undefined; this.onCollect = undefined; this.onSnapshot = undefined; this.collectable = false; } };
export const claimOpenSandboxBackend = () => ({ ...claim(), bridge: { ...configuration.bridge, publicUrl: 'http://127.0.0.1:{port}' }, isolation: { disk: { bytes: 1048576, inodes: 100 } } });
export async function openOpenSandboxBackend(config, { bridge }) {
  transport.url = bridge.publicUrl;
  return {
    async spawn(options) {
      transport.spawns.set(options.agentId, { ...options, credentials: bridge.credentialsForAgent(options.agentId) });
      await transport.onSpawn?.(options);
      return { sandboxId: `fixture-${options.agentId}` };
    },
    async send(agentId, input, { mode, inputId }) {
      if (!transport.submissions.has(inputId)) { transport.submissions.set(inputId, { agentId, input, mode, receipt: { status: 'accepted', disposition: 'started' } }); const next = transport.next; transport.next = undefined; await next?.(inputId); }
      return transport.submissions.get(inputId).receipt;
    },
    async stopExecution(agentId) { await transport.onStop?.(agentId); return { collectable: transport.collectable }; }, async *collect() { yield { type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 0 }; }, async destroy() {}, async close() {}, resource() { return {}; },
  };
}

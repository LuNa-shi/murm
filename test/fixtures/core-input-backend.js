export const configuration = {
  bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
  modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
  models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
};
export const transport = {
  submissions: new Map(), listeners: new Map(),
  reset() { this.submissions.clear(); this.listeners.clear(); this.next = undefined; },
  confirm(id, disposition) { this.submissions.get(id).receipt = { status: 'accepted', disposition }; },
};
export const claimPiOpenSandboxBackend = () => configuration;
export async function openPiOpenSandboxBackend() {
  return {
    async spawn({ botId, onEvent }) { transport.listeners.set(botId, onEvent); },
    async send(botId, input, { mode, inputId }) {
      if (!transport.submissions.has(inputId)) {
        transport.submissions.set(inputId, { botId, input, mode, receipt: { status: 'unknown' } });
        const next = transport.next; transport.next = undefined;
        await next?.(inputId);
      }
      return transport.submissions.get(inputId).receipt;
    },
    async stopExecution() {}, async destroy() {}, async close() {},
  };
}

export const provider = {
  records: [], messages: [], responses: new Map(), starts: new Map(), wait: undefined,
  reset() { this.records = []; this.messages = []; this.responses.clear(); this.starts.clear(); this.wait = undefined; this.queryError = undefined; this.pollError = undefined; this.wrapperReplay = false; },
  publish(record) { this.records.push({ ...record, worker_sequence: this.records.length + 1 }); },
};
export class OpenSandboxManager {
  async ensureExecution() { return { sandbox_id: 'controlled' }; }
  async agentVersions({ executor } = {}) { return executor === 'codex' ? { codexVersion: '0.172.0' } : { piVersion: '1.3.0' }; }
  async startAgent(input) { provider.starts.set(input.executionId, input); }
  async agentRpc(_id, message, options = {}) {
    provider.messages.push(message);
    if (message.type === 'get_state') {
      if ('since' in message && provider.pollError) throw provider.pollError;
      if ('since' in message) return { records: provider.records.filter(record => record.worker_sequence > message.since) };
      return { response: { success: true, command: 'get_state' }, records: [] };
    }
    if (message.type === 'prompt') {
      const beforeSequence = provider.records.length;
      await provider.wait?.(message);
      if (provider.wrapperReplay) return { ...provider.responses.get(message.id), records: provider.records.filter(record => record.worker_sequence > (options.since ?? beforeSequence)) };
      return provider.responses.get(message.id) ?? { state: 'pending', records: [] };
    }
    if (message.type === 'get_rpc_result') {
      if (provider.queryError) throw provider.queryError;
      return provider.responses.get(message.id) ?? { state: 'pending', records: [] };
    }
    throw new Error('Unexpected command');
  }
  coreResource() { return { creation: 'created', sandboxId: 'controlled' }; }
  async stopAgent() { return true; }
  async *collectCoreSession() { yield { type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 0 }; }
  async stopExecution() {}
}
export class DockerAgentNetwork { async isolate() {} }
export class DockerAgentDisk { async isolate() { return {}; } }

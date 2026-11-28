export const provider = {
  attest: false,
  records: [], messages: [], responses: new Map(), starts: new Map(), wait: undefined, readiness: undefined,
  reset() { this.attest = false; this.records = []; this.messages = []; this.responses.clear(); this.starts.clear(); this.wait = undefined; this.readiness = undefined; this.queryError = undefined; this.pollError = undefined; this.wrapperReplay = false; },
  publish(record) { this.records.push({ ...record, worker_sequence: this.records.length + 1 }); },
};
export class OpenSandboxManager {
  async preflight() {}
  async close() {}
  async ensureExecution() { return { sandbox_id: 'controlled' }; }
  async agentVersions({ executor } = {}) { return executor === 'codex' ? { codexVersion: '0.172.0' } : { piVersion: '1.3.0' }; }
  async startAgent(input) {
    provider.starts.set(input.executionId, input);
    if (provider.attest) provider.publish({ type: 'core_session_ready', version: '1.3.0', capabilities: {
      configure: true, compact: true, abortRetry: true, clearQueue: true, state: true, stats: true, messages: true, context: true, beforeCompact: true,
    } });
  }
  async agentRpc(_id, message, options = {}) {
    provider.messages.push(message);
    if (message.type === 'get_state') {
      if ('since' in message && provider.pollError) throw provider.pollError;
      if ('since' in message) return { records: provider.records.filter(record => record.worker_sequence > message.since) };
      if (provider.readiness) return provider.readiness(message);
      return { response: { success: true, command: 'get_state' }, records: provider.records.filter(record => record.worker_sequence > (options.since ?? 0)) };
    }
    if (message.type === 'prompt' || message.type.startsWith('core_session_') || message.type === 'core_context' || message.type === 'core_before_compact_decision') {
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

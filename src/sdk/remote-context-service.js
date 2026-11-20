import { createDomainCommandClient } from './coordinator-peer-client.js';
import { createHash } from 'node:crypto';
import { ServiceCommitGate } from './service-commit-gate.js';
import { captureServiceAuthority } from './service-authority-snapshot.js';
import { CONTEXT_READ_METHODS, CONTEXT_READ_OPERATIONS } from './context-service-peer.js';
import { stableStringify } from '../protocol/envelope.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

export class RemoteContextService {
  constructor({ taskService, url, token, timeoutMs = 15_000, logger = null }) {
    this.taskService = taskService;
    this.logger = logger;
    this.gate = new ServiceCommitGate(taskService);
    this.command = createDomainCommandClient({ url, token, timeoutMs });
    for (const method of CONTEXT_READ_METHODS) this[method] = (...args) => this.#call(method, args);
  }
  close() { /* independent service owns its database and lifetime */ }
  dispatch(operation, input, envelope) {
    this.logger?.append({ event: 'dispatch.start', service: 'context', operation, envelope, transport: 'http-json' });
    try {
      const result = this.#call('dispatch', [operation, input, envelope], envelope);
      this.logger?.append({ event: 'dispatch.complete', service: 'context', operation, envelope, ok: true, result });
      return result;
    } catch (error) {
      this.logger?.append({ event: 'dispatch.complete', service: 'context', operation, envelope, ok: false, error: { code: error.code, message: error.message } });
      throw error;
    }
  }
  reconcile() {
    const pending = this.gate.pending();
    if (!pending) { this.gate.deliverEvents(); return; }
    if (pending.command.service !== 'context') throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Another service commit awaits reconciliation');
    const receipt = this.command(pending);
    this.#settle(pending, receipt);
  }
  #settle(admission, receipt) {
    if (receipt?.gate_id !== admission.gate_id || receipt?.digest !== admission.digest) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Context returned a receipt for another commit');
    }
    this.gate.settle(admission, receipt);
    this.gate.deliverEvents();
  }
  #call(method, args, envelope = null) {
    const write = method === 'dispatch' && !CONTEXT_READ_OPERATIONS.has(args[0]);
    if (write) this.reconcile();
    const command = () => {
      const value = { service: 'context', method, args, authority: captureServiceAuthority(this.taskService, envelope, {
        missionId: (method === 'dispatch' ? args[1] : args[0])?.mission_id ?? (method === 'dispatch' ? args[1] : args[0])?.missionId,
        taskIds: [(method === 'dispatch' ? args[1] : args[0])?.task_id, (method === 'dispatch' ? args[1] : args[0])?.taskId],
        provenance: method !== 'publicChangeToken',
      }) };
      if (Buffer.byteLength(stableStringify(value)) > 1024 * 1024) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Context coordinator command exceeds its bounded peer payload');
      return value;
    };
    const admission = write ? this.gate.acquire(command) : (() => {
      const value = command();
      return { gate_id: null, digest: createHash('sha256').update(stableStringify(value)).digest('hex'), command: value };
    })();
    const receipt = this.command(admission);
    if (write) this.#settle(admission, receipt);
    if (receipt.error) throw new SwarmEnvError(receipt.error.code, receipt.error.message, receipt.error.details, { retryable: receipt.error.retryable });
    return receipt.result;
  }
}

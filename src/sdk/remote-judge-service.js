import { randomUUID } from 'node:crypto';
import { ServiceCommitGate } from './service-commit-gate.js';
import { captureServiceAuthority } from './service-authority-snapshot.js';
import { createCoordinatorPeerHost } from './coordinator-peer-host.js';
import { callCoordinatorPeer, createDomainCommandClient } from './coordinator-peer-client.js';
import { JUDGE_READ_METHODS } from './judge-service-peer.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

export class RemoteJudgeService {
  constructor({ taskService, token, readProjectRevision = null, timeoutMs = 300_000, logger = null, coordinatorHost = '127.0.0.1', coordinatorPublicUrl = null }) {
    this.taskService = taskService;
    this.token = token;
    this.logger = logger;
    this.readProjectRevision = readProjectRevision;
    this.timeoutMs = timeoutMs;
    this.gate = new ServiceCommitGate(taskService);
    this.calls = new Map();
    this.activeChecks = new Set();
    this.server = createCoordinatorPeerHost({ serviceId: 'task', operation: 'judge_lifecycle',
      actorRef: 'service:judge', token, host: coordinatorHost, publicUrl: coordinatorPublicUrl, handler: input => this.#lifecycle(input) });
    for (const method of JUDGE_READ_METHODS) this[method] = (...args) => this.command({ method, args }).result;
  }
  async startCoordinator(options) { return this.server.start(options); }
  connect(url) {
    this.url = url;
    this.command = createDomainCommandClient({ url, token: this.token });
    this.generation = this.command({ method: 'identity' }).generation;
    this.reconcile();
  }
  reconcile() {
    const pending = this.gate.pending();
    if (!pending || pending.command.service !== 'judge') return;
    const status = this.command({ method: 'phase_receipt', gate_id: pending.gate_id, digest: pending.digest });
    const receipt = status.receipt ?? (status.generation !== pending.command.generation ? {
      terminal: true, gate_id: pending.gate_id, digest: pending.digest, outcome: 'interrupted',
    } : null);
    if (!receipt) throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Judge phase is unresolved; do not release its lifecycle gate', undefined, { retryable: true });
    this.gate.settle(pending, receipt);
  }
  async #lifecycle(input) {
    const call = this.calls.get(input.call_id);
    if (!call) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Judge stage does not belong to an admitted coordinator request');
    call.assertAuthorized?.();
    if (input.action === 'queue_status' && input.generation === this.generation) {
      const execution = this.taskService.getExecution(call.envelope.execution_id);
      return { authority: captureServiceAuthority(this.taskService,
        { ...call.envelope, state_version: execution?.state_version ?? call.envelope.state_version }, { provenance: false }) };
    }
    if (input.action !== 'execute' || input.generation !== this.generation ||
        !['admission', 'preflight', 'source'].includes(input.phase) || !Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Invalid Judge phase identity');
    }
    const key = `${input.sequence}:${input.phase}`;
    if (call.stages.has(key)) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Judge phase cannot be started twice');
    const admission = this.gate.acquire(() => {
      call.assertAuthorized?.();
      const execution = this.taskService.getExecution(call.envelope.execution_id);
      const envelope = { ...call.envelope, state_version: execution?.state_version ?? call.envelope.state_version };
      return { service: 'judge', call_id: input.call_id, generation: this.generation, phase: input.phase,
        sequence: input.sequence, request_hash: input.requestHash, authority: captureServiceAuthority(this.taskService, envelope, { provenance: false, workspace: true }) };
    });
    call.stages.add(key);
    // The coordinator stays synchronous through this short remote commit /
    // actual spawn. The peer is awaiting our async response and can serve
    // this callback; it never synchronously calls back into Task.
    const receipt = this.command({ method: 'execute_phase', admission });
    if (receipt?.gate_id !== admission.gate_id || receipt?.digest !== admission.digest) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Judge phase receipt does not match its command');
    }
    this.gate.settle(admission, receipt);
    return { completed: true };
  }
  setDependencyEventSink(listener) { this.dependencyEventSink = listener; }
  dispatch(operation, input, envelope, { assertAuthorized } = {}) {
    assertAuthorized?.();
    if (operation === 'get_check_result') return Promise.resolve(this.command({
      method: 'dispatch', args: [operation, input, envelope], call_id: randomUUID(), authority: captureServiceAuthority(this.taskService, envelope, { provenance: false, workspace: true }),
    }).result);
    if (operation !== 'workspace_check') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Unsupported remote Judge operation');
    const work = this.#check(operation, input, envelope, assertAuthorized);
    this.activeChecks.add(work);
    void work.finally(() => this.activeChecks.delete(work)).catch(() => {});
    return work;
  }
  async #check(operation, input, envelope, assertAuthorized) {
    const call_id = randomUUID();
    this.logger?.append({ event: 'judge.start', service: 'judge', operation_id: envelope.operation_id, target_task_id: envelope.task_id, transport: 'http-json' });
    let project = null;
    if (['lean-project', 'lean-module'].includes(input.source?.check_mode)) {
      if (!this.readProjectRevision) throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Trusted Workspace export is unavailable');
      const snapshot = await this.readProjectRevision({ workspaceId: input.source.workspace_id, revision: input.source.revision });
      project = { ...snapshot, files: Object.fromEntries(Object.entries(snapshot.files).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')])) };
    }
    assertAuthorized?.();
    const authority = captureServiceAuthority(this.taskService, envelope, { provenance: false, workspace: true });
    this.calls.set(call_id, { envelope, assertAuthorized, stages: new Set() });
    try {
      const { result } = await callCoordinatorPeer({ url: this.url, token: this.token, actorRef: 'service:coordinator',
        operation: 'domain_command', timeoutMs: this.timeoutMs, input: { method: 'dispatch', args: [operation, input, envelope], call_id, authority, project } });
      this.logger?.append({ event: 'judge.complete', service: 'judge', operation_id: envelope.operation_id, result });
      this.dependencyEventSink?.({ kind: 'check_result', task_id: envelope.task_id, execution_id: envelope.execution_id, check_result_id: result.check_result_id });
      return result;
    } finally {
      // A late phase acquire may not start new work after this caller ends.
      this.calls.delete(call_id);
      this.reconcile();
    }
  }
  async verifyCleanup() {
    return callCoordinatorPeer({ url: this.url, token: this.token, actorRef: 'service:coordinator',
      operation: 'domain_command', input: { method: 'reconcile_resources' }, timeoutMs: 35_000 });
  }
  async waitForIdle() { while (this.activeChecks.size) await Promise.allSettled([...this.activeChecks]); }
  async close() { try { await this.waitForIdle(); } finally { await this.server.stop(); } }
}

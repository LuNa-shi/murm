import { randomUUID } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

export function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)!;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key: any) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export interface OperationEnvelope {
  operation_id: string;
  actor_ref: string;
  task_id?: string | null;
  execution_id?: string | null;
  spec_version?: number | null;
  state_version?: number | null;
  fencing_version?: number | null;
}

export interface EnvelopeOptions {
  operationId?: string;
  actorRef: string;
  taskId?: string | null;
  executionId?: string | null;
  specVersion?: number | null;
  stateVersion?: number | null;
  fencingVersion?: number | null;
}

export function operationPayload(operation: string, payload: unknown, envelope: OperationEnvelope) {
  return stableStringify({ operation, payload, envelope });
}

export function makeEnvelope({
  operationId = randomUUID(),
  actorRef,
  taskId = null,
  executionId = null,
  specVersion = null,
  stateVersion = null,
  fencingVersion = null,
}: EnvelopeOptions) {
  const envelope: OperationEnvelope = {
    operation_id: operationId,
    actor_ref: actorRef,
    task_id: taskId,
    execution_id: executionId,
    spec_version: specVersion,
    state_version: stateVersion,
  };
  if (fencingVersion !== null && fencingVersion !== undefined) {
    envelope.fencing_version = fencingVersion;
  }
  validateEnvelope(envelope);
  return envelope;
}

export function validateEnvelope(envelope: any, { executionWrite = false }: any = {}) {
  if (!envelope || typeof envelope !== 'object') {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'operation envelope is required');
  }
  for (const field of ['operation_id', 'actor_ref']) {
    if (typeof envelope[field] !== 'string' || envelope[field].length === 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
    }
  }
  for (const field of ['task_id', 'execution_id']) {
    if (envelope[field] !== null && envelope[field] !== undefined && typeof envelope[field] !== 'string') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} must be a string or null`);
    }
  }
  for (const field of ['spec_version', 'state_version', 'fencing_version']) {
    if (envelope[field] !== null && envelope[field] !== undefined &&
      (!Number.isInteger(envelope[field]) || envelope[field] < 0)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} must be a non-negative integer or null`);
    }
  }
  if (executionWrite && (envelope.execution_id === null || envelope.fencing_version === undefined)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'execution writes require execution_id and fencing_version');
  }
  return envelope;
}

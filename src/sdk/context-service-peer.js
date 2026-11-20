import { CONTEXT_PEER_SCHEMA_SQL } from '../storage/service-peer-schema.js';
import { createHash } from 'node:crypto';
import { ContextService } from '../context/context-service.js';
import { createCoordinatorPeerHost } from './coordinator-peer-host.js';
import { ServiceAuthoritySnapshot } from './service-authority-snapshot.js';
import { stableStringify } from '../protocol/envelope.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

export const CONTEXT_READ_METHODS = Object.freeze(['getMaterial', 'readMaterials', 'listMaterialConsumptions',
  'listMaterialRelations', 'publicChangeToken', 'readTakeMaterialInputs', 'readWorkspaceMaterialUses']);
export const CONTEXT_READ_OPERATIONS = new Set(['read_materials', 'context_search_materials', 'list_material_relations',
  'context_get_material', 'list_material_consumptions']);

function eventsFor(command, result) {
  const operation = command.args[0];
  if (command.method !== 'dispatch' || !['context_publish_material', 'material_dispute', 'material_supersede', 'material_unsupersede'].includes(operation)) return [];
  return [{ event_id: `context:${command.args[2].actor_ref}:${command.args[2].operation_id}`, kind: operation === 'context_publish_material' ? 'material_published' : 'material_corrected', operation,
    task_id: result?.material?.producer_task_id ?? null,
    execution_id: result?.material?.producer_execution_id ?? null }];
}

export function createContextServicePeer({ database, token, host = '127.0.0.1', publicUrl = null }) {
  if (typeof token !== 'string' || token.length < 24) throw new TypeError('Context peer requires a private coordinator credential of at least 24 characters');
  const context = new ContextService(database);
  context.db.exec(CONTEXT_PEER_SCHEMA_SQL);
  const execute = admission => {
    const { command, gate_id, digest } = admission ?? {};
    if (command?.service !== 'context' || !Array.isArray(command.args) ||
        !['dispatch', ...CONTEXT_READ_METHODS].includes(command.method) ||
        createHash('sha256').update(stableStringify(command)).digest('hex') !== digest) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Invalid coordinator Context command');
    }
    const writes = command.method === 'dispatch' && !CONTEXT_READ_OPERATIONS.has(command.args[0]);
    if (writes && (typeof gate_id !== 'string' || !gate_id)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Context mutation requires a durable coordinator gate');
    const prior = gate_id && context.db.prepare('SELECT * FROM context_peer_receipts WHERE gate_id = ?').get(gate_id);
    if (prior) {
      if (prior.digest !== digest) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Context gate was reused with another command');
      return JSON.parse(prior.receipt_json);
    }
    context.taskService = new ServiceAuthoritySnapshot(command.authority);
    let receipt;
    try {
      const result = context[command.method](...command.args);
      receipt = { terminal: true, gate_id, digest, result, events: eventsFor(command, result) };
    } catch (error) {
      receipt = { terminal: true, gate_id, digest, error: { code: error.code ?? ERROR_CODES.INVALID_CONTRACT,
        message: error.message, details: error.details, retryable: Boolean(error.retryable) } };
    }
    // A domain success has its own atomic idempotency receipt. If the process
    // dies before this outer receipt, exact command replay reconstructs it.
    // Rejections are persisted too; no late duplicate can become a new write.
    if (gate_id) context.db.prepare('INSERT INTO context_peer_receipts VALUES (?, ?, ?)').run(gate_id, digest, JSON.stringify(receipt));
    return receipt;
  };
  const server = createCoordinatorPeerHost({ serviceId: 'context', operation: 'domain_command',
    actorRef: 'service:coordinator', token, host, publicUrl, handler: execute });
  return { start: options => server.start(options), environment: () => server.environment(),
    async stop() { await server.stop(); context.close(); } };
}

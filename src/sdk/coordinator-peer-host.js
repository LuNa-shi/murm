import { createServiceHost } from './service-host.js';

/** Operator-only transport. These routes never enter the Bot capability set. */
export function createCoordinatorPeerHost({ serviceId, operation, actorRef, token, handler, host = '127.0.0.1', publicUrl = null, maxBodyBytes = 2 * 1024 * 1024 }) {
  if (typeof token !== 'string' || token.length < 24) throw new TypeError('Peer requires a private credential of at least 24 characters');
  return createServiceHost({
    manifest: { id: serviceId, title: `${serviceId} coordinator peer`, purpose: 'Explicit private domain coordination',
      provider_version: 'builtin-2', contract_version: '1', endpoint: { transport: 'http-json', url: publicUrl ?? `http://${host}:0` },
      capabilities: [{ name: `${serviceId}.${operation}`, operation, description: 'Execute one authenticated domain command',
        audience: ['recovery'], context: [], side_effect: 'write', idempotent: true, path: `/v1/${operation}`,
        input_schema: { type: 'object', properties: {}, additionalProperties: true },
        output_schema: { type: 'object', properties: {}, additionalProperties: true },
        help: { ref: `service://${serviceId}/${operation}`, when: 'Private service coordination only', text: 'Not an Agent capability.' } }] },
    handler: ({ input }) => handler(input), host, publicUrl, trusted: true, maxBodyBytes,
    principals: [{ token, actor_ref: actorRef, role: 'recovery', operations: [operation] }],
  });
}

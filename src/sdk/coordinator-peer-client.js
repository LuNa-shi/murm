import { randomUUID } from 'node:crypto';
import { makeEnvelope } from '../protocol/envelope.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

export async function callCoordinatorPeer({ url, token, actorRef, operation, input, timeoutMs = 15_000 }) {
  const envelope = makeEnvelope({ actorRef, operationId: `peer:${randomUUID()}` });
  let response;
  try {
    response = await fetch(`${url.replace(/\/$/, '')}/v1/${operation}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ envelope, role: 'recovery', input }), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Independent service transport did not return a response', undefined, { cause: error, retryable: true });
  }
  const body = await response.json();
  if (!response.ok || body.ok === false) throw new SwarmEnvError(body.error?.code ?? ERROR_CODES.SERVICE_UNAVAILABLE,
    body.error?.message ?? 'Independent service request failed', body.error?.details, { retryable: Boolean(body.error?.retryable) });
  return body.result;
}

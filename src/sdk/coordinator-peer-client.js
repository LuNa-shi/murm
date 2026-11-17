import { randomUUID } from 'node:crypto';
import { makeEnvelope } from '../protocol/envelope.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { requestHttp } from '../protocol/http-request.js';

export async function callCoordinatorPeer({ url, token, actorRef, operation, input, timeoutMs = 15_000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new TypeError('Peer timeoutMs must be a positive timer-safe integer');
  const envelope = makeEnvelope({ actorRef, operationId: `peer:${randomUUID()}` });
  let response, body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await requestHttp(`${url.replace(/\/$/, '')}/v1/${operation}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ envelope, role: 'recovery', input }), signal: controller.signal });
    body = JSON.parse(response.text);
  } catch (error) {
    throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Independent service transport did not return a response', undefined, { cause: error, retryable: true });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok || body.ok === false) throw new SwarmEnvError(body.error?.code ?? ERROR_CODES.SERVICE_UNAVAILABLE,
    body.error?.message ?? 'Independent service request failed', body.error?.details, { retryable: Boolean(body.error?.retryable) });
  return body.result;
}

import { spawnSync } from 'node:child_process';
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

/** Each call finishes before its caller leaves the synchronous lifecycle boundary. */
export function createDomainCommandClient({ url, token, timeoutMs = 15_000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('Invalid synchronous peer timeout');
  const endpoint = new URL('v1/domain_command', url.replace(/\/?$/, '/')).href;
  if (typeof token !== 'string' || !token.length) throw new TypeError('Private coordinator credential required');
  return input => {
    const envelope = makeEnvelope({ actorRef: 'service:coordinator', operationId: `peer:${randomUUID()}` });
    // Pass the credential and request body on stdin so neither appears in the process list.
    const config = [
      `header = ${JSON.stringify('authorization: Bearer ' + token)}`,
      `data-binary = ${JSON.stringify(JSON.stringify({ envelope, input, role: 'recovery' }))}`,
    ].join('\n');
    const result = spawnSync('curl', [
      '--disable', '--silent', '--show-error', '--max-time', String(timeoutMs / 1000),
      '--header', 'content-type: application/json', '--config', '-',
      '--write-out', '\n%{http_code}', '--url', endpoint,
    ], {
      input: config,
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs + 2_000,
    });
    if (result.error || result.status !== 0) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE,
      'Independent service command did not complete', undefined, { retryable: true, cause: result.error });
    const split = result.stdout.lastIndexOf('\n');
    const status = Number(result.stdout.slice(split + 1));
    let body;
    try { body = JSON.parse(result.stdout.slice(0, split)); } catch (cause) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Invalid independent service response', undefined, { retryable: true, cause });
    }
    if (status < 200 || status >= 300 || body?.ok !== true) {
      throw new SwarmEnvError(body?.error?.code ?? ERROR_CODES.SERVICE_UNAVAILABLE,
        body?.error?.message ?? 'Independent service command failed', body?.error?.details,
        { retryable: body?.error?.retryable ?? (status >= 500) });
    }
    return body.result;
  };
}

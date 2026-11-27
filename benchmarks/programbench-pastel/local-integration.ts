import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSandbox } from '../../dist/src/core/index.js';
import { streamResponse } from '../../dist/test/fixtures/core-controlled-upstream.js';

export const tool = (call, command, timeout = 20) => ({ type: 'function_call', id: `fc_${call}`, call_id: call,
  name: 'bash', arguments: JSON.stringify({ command, timeout }) });
export const message = (number, text) => ({ type: 'message', id: `msg_${number}`, role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] });
export const inputTexts = input => input.filter(row => row.role === 'user')
  .map(row => typeof row.content === 'string' ? row.content : row.content.map(block => block.text ?? '').join(''));
export const toolOutput = (input, call) => input.find(row => row.type === 'function_call_output' && row.call_id === call)?.output;

export async function localUpstream(route, requestLimit, timeoutMs = 120_000) {
  let requests = 0;
  let failure;
  const end = performance.now() + timeoutMs;
  const server = createServer(async (request, response) => {
    const number = ++requests;
    try {
      assert.ok(number <= requestLimit && performance.now() < end && !failure);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 512 * 1024);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, 'k3');
      assert.ok(Array.isArray(body.input));
      const item = route(body.input, number);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse('k3', number, item));
    } catch (error) {
      failure ??= error.message;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Controlled Pastel integration failed' } }));
    }
  });
  server.requestTimeout = 15_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`,
    receipt: () => ({ requests, requestLimit, failure }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export function localRuntimeSettings(upstream, diskMiB = 64, { timeoutSeconds = 180, maxOutputTokens = 2048, requestTimeoutMs = 30_000,
  resourceLimits = { cpu: '1', memory: '1Gi' } } = {}) {
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  if (typeof upstream === 'string') upstream = { url: upstream, headers: {} };
  return {
    sandbox: createSandbox({ lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
      apiKey: process.env.MURM_CORE_TEST_API_KEY, timeoutSeconds, commandTimeoutMs: 20_000,
      ...(resourceLimits === null ? {} : { resourceLimits }),
      isolation: { network: 'local-docker', disk: { bytes: diskMiB * 1024 ** 2, inodes: 8192 } },
    }),
    connection: {
      bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
      modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs, maxOutputTokens },
    },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream } },
  };
}

export const saveReceipt = (dir, data) => writeFile(join(dir, 'receipt.json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });

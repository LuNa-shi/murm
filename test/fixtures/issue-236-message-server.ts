import { createServer } from 'node:http';
import { createMessageService } from '../../examples/bridge-services/messages.js';

const token = process.env.MURM_TEST_MESSAGE_TOKEN;
if (!token || !process.send) throw new Error('Start this fixture from the local acceptance test');
const { manifest, adapter } = createMessageService();
const calls = [];
const external = { runtimeId: 'fixture', agentId: 'existing-owner', profile: 'fixture' };

function invoke(operation, input, envelope = { operation_id: 'fixture' }, caller = external) {
  return adapter.invoke({ manifest, capability: manifest.capabilities.find(capability => capability.operation === operation),
    input, envelope, caller, signal: new AbortController().signal, assertAuthorized() {} });
}

await invoke('put', { key: 'existing', text: 'pre-existing service data' });
const server = createServer(async (request, response) => {
  const reply = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.headers.authorization !== `Bearer ${token}`) { reply(403, { ok: false }); return; }
  if (request.method === 'GET' && request.url === '/fixture') {
    reply(200, { calls, original: await invoke('get', { key: 'existing' }), unknown: await invoke('get', { key: 'lost' }) });
    return;
  }
  const operation = request.url?.split('/').at(-1);
  if (request.method !== 'POST' || !['get', 'put'].includes(operation)) { reply(404, { ok: false }); return; }
  try {
    const { input, caller, envelope } = await new Response(request).json();
    if (request.headers['idempotency-key'] !== envelope.operation_id) { reply(400, { ok: false }); return; }
    const result = await invoke(operation, input, envelope, caller);
    calls.push({ operation, operationId: envelope.operation_id, caller: caller.agentId });
    if (envelope.operation_id === 'lost-response-write') { request.socket.destroy(); return; }
    reply(200, { ok: true, result });
  } catch {
    reply(400, { ok: false, error: { code: 'INVALID_CONTRACT' } });
  }
});
server.listen(0, '127.0.0.1', () => process.send(server.address().port));
process.on('disconnect', () => server.close());

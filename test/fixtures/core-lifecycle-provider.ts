import { fileProtocol } from '../../src/core/files/core-file-seed.js';
import { WORKER_PROTOCOL } from '../../src/core/worker-image.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { decodeFileSeed } from '../../src/core/files/core-file-seed.js';

// External Lifecycle, Execd and Worker services are simulated over HTTP.
// Runtime admission, ownership, SDK transport and cleanup use production modules.
export async function createLifecycleProvider(t, { fileOperation, onStart, onCollect, onStop, onCreate, createExpiresAt, onGet, onRenew, onEgress, onRpc } = {}) {
  const resources = new Map();
  const records = [];
  let allocations = 0;
  let rejectDelete = true;
  let deletion;
  let releaseDelete;
  let holdDelete = true;
  const deletionStarted = new Promise(resolve => { deletion = resolve; });
  const deletionReleased = new Promise(resolve => { releaseDelete = resolve; });
  const apiKey = 'fixture-management-key';
  const info = resource => ({
    id: resource.id, createdAt: resource.createdAt, expiresAt: resource.expiresAt,
    status: { state: 'Running' }, metadata: resource.labels,
  });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(request.url, 'http://fixture');
    const path = url.pathname.replace(/^\/v1(?=\/)/, '');
    const send = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path.startsWith('/sandboxes') && request.headers['open-sandbox-api-key'] !== apiKey) {
      return send({ message: 'Lifecycle authentication required' }, 401);
    }
    const active = [...resources.values()].find(resource => path.startsWith('/execd/')
      ? resource.execdToken && request.headers['x-execd-access-token'] === resource.execdToken
      : request.headers.authorization === `Bearer ${resource.workerToken}` ||
        request.headers['x-murm-worker-token'] === resource.workerToken);
    if ((path.startsWith('/worker/') || path.startsWith('/execd/')) && !active) {
      return send({ message: 'Data plane authentication required' }, 401);
    }
    if (path === '/sandboxes' && request.method === 'POST') {
      const id = `fixture-${++allocations}`;
      records.length = 0;
      resources.set(id, { id, createdAt: new Date().toISOString(),
        expiresAt: createExpiresAt ? createExpiresAt(id) : new Date(Date.now() + body.timeout * 1000).toISOString(),
        workerToken: body.env.MURM_WORKER_TOKEN, execdToken: body.env.EXECD_ACCESS_TOKEN,
        resourceLimits: body.resourceLimits, networkPolicy: body.networkPolicy, labels: { ...body.metadata, 'opensandbox.io/id': id } });
      if (await onCreate?.(id, body) === false) return response.destroy();
      return send(info(resources.get(id)));
    }
    if (path === '/sandboxes' && request.method === 'GET') {
      const items = [...resources.values()].map(info);
      return send({ items, pagination: { page: 1, pageSize: 100, totalItems: items.length, totalPages: 1, hasNextPage: false } });
    }
    const egressEndpoint = path.match(/^\/sandboxes\/([^/]+)\/endpoints\/18080$/);
    if (egressEndpoint) return send({ endpoint: `${base}/egress/${egressEndpoint[1]}`, headers: { 'opensandbox-egress-auth': 'fixture-egress-key' } });
    const egressPolicy = path.match(/^\/egress\/([^/]+)\/policy$/);
    if (egressPolicy) {
      if (request.headers['opensandbox-egress-auth'] !== 'fixture-egress-key') return send({}, 401);
      const policy = resources.get(egressPolicy[1])?.networkPolicy;
      return send(await onEgress?.(policy) ?? { status: 'ok', enforcementMode: 'dns+nft', policy });
    }
    if (path.includes('/endpoints/')) return send({ endpoint: `${base}/${path.endsWith('/44772') ? 'execd' : 'worker'}` });
    if (['/execd/ping', '/worker/health'].includes(path)) return send({ ok: true });
    if (path === '/execd/command') {
      const command = body.command ?? '';
      const cpu = Number.parseFloat(active.resourceLimits.cpu) / (active.resourceLimits.cpu.endsWith('m') ? 1000 : 1);
      const output = command.includes('NoNewPrivs') ? JSON.stringify({ cpu, memory: 1024 ** 3 }) :
        command.includes('pi') ? '1.3.0' : 'v22.19.0';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      return response.end(`data: ${JSON.stringify({ type: 'stdout', text: output })}\n\ndata: {"type":"execution_complete","exit_code":0}\n\n`);
    }
    if (path === '/worker/core/contract') return send({ result: { worker_protocol: WORKER_PROTOCOL, file_protocol: fileProtocol } });
    if (path === '/worker/start') {
      const version = body.writable || body.files !== undefined ? 1 : 0;
      const result = { contract: { version: WORKER_PROTOCOL, resources: [], file_protocol: fileProtocol },
        model_catalog_resource: body.model_catalog_resource,
        project_files: { writable: body.writable, version, ...(version ? { digest: decodeFileSeed(body.files ?? {}).digest } : {}) } };
      onStart?.(body, result);
      return send({ result });
    }
    if (path === '/worker/core/session/archive') {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(JSON.stringify({ type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 0 }) + '\n');
      return;
    }
    if (onCollect && path === '/worker/core/files/collect') {
      const result = await onCollect(body);
      if (result.error) return send({ ok: false, ...result.error }, 400);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return response.end(result.records.map(record => JSON.stringify(record) + '\n').join(''));
    }
    if (fileOperation && path.startsWith('/worker/core/files/')) {
      const reply = await fileOperation(path.split('/').at(-1), body);
      if (reply.disconnect) return response.destroy();
      return send(reply.body, reply.status ?? 200);
    }
    if (path === '/worker/rpc') {
      const result = await onRpc?.(body.message);
      if (result === false) return response.destroy();
      return send({ result: result ?? { response: { id: body.message.id, success: true, command: body.message.type,
        ...(body.message.type === 'prompt' ? { data: { disposition: 'started' } } : {}) },
        records: records.filter(row => row.worker_sequence > (body.message.since ?? 0)) } });
    }
    if (path === '/worker/stop') return send({ result: await onStop?.() ?? { stopped: true } });
    if (path.startsWith('/sandboxes/') && path.endsWith('/renew-expiration') && request.method === 'POST') {
      const id = path.split('/')[2];
      const resource = resources.get(id);
      if (!resource) return send({}, 404);
      if (await onRenew?.(resource, body.expiresAt) === false) return send({}, 503);
      resource.expiresAt = body.expiresAt;
      return send({ expiresAt: resource.expiresAt });
    }
    if (path.startsWith('/sandboxes/') && request.method === 'DELETE') {
      deletion();
      if (holdDelete) await deletionReleased;
      if (rejectDelete) return send({ message: 'Controlled deletion failure' }, 503);
      resources.delete(path.split('/').at(-1));
      return send({});
    }
    if (path.startsWith('/sandboxes/') && request.method === 'GET') {
      const id = path.split('/').at(-1); const resource = resources.get(id);
      return send(onGet && resource ? { createdAt: resource.createdAt, ...await onGet(id, resource, response) } : resource ? info(resource) : {}, resource ? 200 : 404);
    }
    return send({ message: 'Unrecognized fixture request' }, 400);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { releaseDelete(); return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return {
    url: `${base}/v1`, apiKey, deletionStarted,
    allocations: () => allocations,
    publish(row) { records.push({ ...row, worker_sequence: records.length + 1 }); },
    unexpectedExit() { records.push({ type: 'worker_exit', code: 1, worker_sequence: records.length + 1 }); },
    releaseDeletion() { holdDelete = false; releaseDelete(); },
    allowDeletion() { holdDelete = false; rejectDelete = false; releaseDelete(); },
  };
}

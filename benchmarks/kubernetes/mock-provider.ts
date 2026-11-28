import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { decodeFileSeed, fileProtocol } from '../../src/core/files/core-file-seed.js';
import { WORKER_PROTOCOL } from '../../src/core/worker-image.js';
import { createWorkerEventStream, WORKER_EVENT_PROTOCOL } from '../../src/core/worker-event-stream.js';
import { createWorkerControl, WORKER_CONTROL_PROTOCOL } from '../../src/core/worker-control.js';

interface Resource {
  id: string;
  createdAt: string;
  expiresAt: string;
  labels: Record<string, string>;
  workerToken: string;
  execdToken: string;
  policy: unknown;
  events: ReturnType<typeof createWorkerEventStream>;
  control: ReturnType<typeof createWorkerControl>;
  replies: Map<string, unknown>;
  output: string;
  stopped: boolean;
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** External Lifecycle, Execd and Agent APIs are confined to one loopback server. */
export async function createMockSandboxProvider() {
  const resources = new Map<string, Resource>();
  const tokens = new Map<string, Resource>();
  let allocations = 0;
  let inputs = 0;
  let requests = 0;
  let deletingBlocked = false;
  const apiKey = 'local-mock-capacity';
  const info = (resource: Resource) => ({ id: resource.id, createdAt: resource.createdAt, expiresAt: resource.expiresAt,
    status: { state: 'Running' }, metadata: resource.labels });
  let base: string;
  const server = createServer(async (request, response) => {
    requests++;
    const send = (body: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 ** 2) throw new Error('Mock request exceeds its bound');
        chunks.push(chunk);
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const url = new URL(request.url!, 'http://fixture');
      const path = url.pathname.replace(/^\/v1(?=\/)/, '');
      if (path.startsWith('/sandboxes') && request.headers['open-sandbox-api-key'] !== apiKey) { send({}, 401); return; }
      if (path === '/sandboxes' && request.method === 'POST') {
        const id = `mock-${++allocations}`;
        const events = createWorkerEventStream({ workerInstanceId: `${id}-worker`, streamEpoch: `${id}-stream` });
        const resource: Resource = { id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + body.timeout * 1000).toISOString(),
          labels: body.metadata, workerToken: body.env.MURM_WORKER_TOKEN, execdToken: body.env.EXECD_ACCESS_TOKEN,
          policy: body.networkPolicy, events, control: createWorkerControl({ workerInstanceId: events.workerInstanceId,
            initialEpoch: Number(body.env.MURM_CONTROLLER_EPOCH ?? 0) }), replies: new Map(), output: '', stopped: false };
        resources.set(id, resource);
        tokens.set(resource.workerToken, resource);
        tokens.set(resource.execdToken, resource);
        send(info(resource)); return;
      }
      if (path === '/sandboxes' && request.method === 'GET') {
        const metadata = url.searchParams.get('metadata');
        const labels = metadata ? JSON.parse(metadata) : {};
        const selected = [...resources.values()].filter(resource => Object.entries(labels).every(([key, value]) => resource.labels[key] === value));
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
        const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 100)));
        send({ items: selected.slice((page - 1) * pageSize, page * pageSize).map(info), pagination: {
          page, pageSize, totalItems: selected.length, totalPages: Math.ceil(selected.length / pageSize), hasNextPage: page * pageSize < selected.length } });
        return;
      }
      const sandboxPath = path.match(/^\/sandboxes\/([^/]+)(?:\/(.*))?$/);
      if (sandboxPath) {
        const resource = resources.get(sandboxPath[1]);
        if (!resource) { send({}, 404); return; }
        const suffix = sandboxPath[2];
        if (suffix?.startsWith('endpoints/')) {
          const port = suffix.split('/')[1];
          send({ endpoint: `${base}/${port === '44772' ? 'execd' : port === '18080' ? 'egress' : 'worker'}/${resource.id}` }); return;
        }
        if (suffix === 'renew-expiration') { resource.expiresAt = body.expiresAt; send({ expiresAt: resource.expiresAt }); return; }
        if (request.method === 'DELETE') {
          if (deletingBlocked) { send({ message: 'Mock deletion outage' }, 503); return; }
          resource.events.close(); resources.delete(resource.id); tokens.delete(resource.workerToken); tokens.delete(resource.execdToken);
          send({}); return;
        }
        send(info(resource)); return;
      }
      const plane = path.match(/^\/(worker|execd|egress)\/([^/]+)\/(.*)$/);
      if (!plane) { send({}, 404); return; }
      const resource = resources.get(plane[2]);
      if (!resource) { send({}, 404); return; }
      const [kind, action] = [plane[1], plane[3]];
      if (kind === 'egress') { send({ status: 'ok', enforcementMode: 'dns+nft', policy: resource.policy }); return; }
      const token = kind === 'execd' ? request.headers['x-execd-access-token'] :
        request.headers['x-murm-worker-token'] ?? String(request.headers.authorization ?? '').replace(/^Bearer /, '');
      if (typeof token !== 'string' || tokens.get(token) !== resource) { send({}, 401); return; }
      if (action === 'health' || action === 'ping') { send({ ok: true }); return; }
      if (kind === 'execd' && action === 'command') {
        const output = body.command.includes('NoNewPrivs') ? JSON.stringify({ cpu: 1, memory: 1024 ** 3 }) : body.command.includes('pi') ? '1.3.0' : 'v22.19.0';
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ type: 'stdout', text: output })}\n\ndata: {"type":"execution_complete","exit_code":0}\n\n`);
        return;
      }
      const identity = { event_protocol: WORKER_EVENT_PROTOCOL, control_protocol: WORKER_CONTROL_PROTOCOL,
        worker_instance_id: resource.events.workerInstanceId, stream_epoch: resource.events.streamEpoch,
        controller_epoch: resource.control.controllerEpoch };
      if (action === 'core/contract') { send({ result: { worker_protocol: WORKER_PROTOCOL, file_protocol: fileProtocol,
        ...identity, executor_started: true, executor_launched: true, execution_stopped: resource.stopped } }); return; }
      if (action === 'start') {
        send({ result: { contract: { version: WORKER_PROTOCOL, resources: [], file_protocol: fileProtocol }, model_catalog_resource: body.model_catalog_resource,
          project_files: { writable: body.writable, version: body.writable ? 1 : 0, ...(body.writable ? { digest: decodeFileSeed(body.files ?? {}).digest } : {}) } } });
        return;
      }
      resource.control.assertEpoch(Number(request.headers['x-murm-controller-epoch']));
      if (action === 'core/events') {
        const owner = new AbortController();
        response.on('close', () => owner.abort());
        send({ result: await resource.events.poll(body, owner.signal) }); return;
      }
      if (action === 'rpc') {
        const message = body.message;
        let reply = resource.replies.get(message.id);
        if (!reply && message.type === 'prompt') {
          inputs++;
          resource.output = `MOCK_API_OK ${hash(message.message)}`;
          resource.events.publish({ type: 'agent_start' });
          resource.events.publish({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: resource.output }], stopReason: 'stop' } });
          resource.events.publish({ type: 'agent_settled' });
        }
        if (message.type === 'core_event_probe') resource.events.publish({ type: 'controller_probe', traceId: message.id });
        reply ??= { response: { id: message.id, command: message.type, success: true, data: { disposition: 'started' } }, records: [] };
        resource.replies.set(message.id, reply);
        send({ result: reply }); return;
      }
      if (action === 'stop') { resource.stopped = true; resource.events.close(); send({ result: { stopped: true } }); return; }
      if (action === 'core/session/archive' || action === 'core/files/collect') {
        if (!resource.stopped) { send({}, 409); return; }
        const content = Buffer.from(resource.output);
        const records: unknown[] = action === 'core/session/archive' ? [] : [
          { type: 'file', path: 'proof.txt', mode: 0o644, bytes: content.length },
          { type: 'chunk', data: content.toString('base64') }, { type: 'fileEnd', sha256: hash(content) } ];
        records.push({ type: 'end', totalBytes: action === 'core/session/archive' ? 0 : content.length, fileCount: action === 'core/session/archive' ? 0 : 1, directoryCount: 0 });
        response.writeHead(200, { 'content-type': 'application/x-ndjson' }).end(records.map(record => JSON.stringify(record) + '\n').join(''));
        return;
      }
      send({ message: `Unsupported mock route ${kind}/${action}` }, 400);
    } catch (error) {
      if (!response.destroyed) send({ message: (error as Error).message }, 400);
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: `${base}/v1`, apiKey, counts: () => ({ allocations, inputs, requests, remainingResources: resources.size,
    eventWaiters: [...resources.values()].reduce((count, resource) => count + resource.events.snapshot().waiters, 0) }),
    blockDeletion(value: boolean) { deletingBlocked = value; },
    async close() { for (const resource of resources.values()) resource.events.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); } };
}

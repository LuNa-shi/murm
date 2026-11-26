import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTraceReader } from './reader.mjs';

const loopback = '127.0.0.1';
const hostPattern = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/i;
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
]);
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function json(response, status, body) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function allowed(request) {
  const { host, origin } = request.headers;
  return typeof host === 'string' && hostPattern.test(host) &&
    (!origin || origin === 'http://' + host) &&
    request.headers['sec-fetch-site'] !== 'cross-site';
}

function numberParam(query, name, upperLimit) {
  const raw = query.get(name);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw Object.assign(new Error('Invalid ' + name), { status: 400 });
  }
  return Math.min(Number(raw), upperLimit);
}

function pageOptions(query) {
  return {
    cursor: query.get('cursor') ?? undefined,
    limit: numberParam(query, 'limit', 1000),
    agentId: query.get('agentId') ?? undefined,
    type: query.get('type') ?? undefined,
  };
}

async function live(request, response, reader, runId, query) {
  let cursor = request.headers['last-event-id'] || query.get('cursor') || undefined;
  const nextPage = () => reader.events(runId, { cursor, limit: 1000 });
  const controller = new AbortController();
  response.on('close', () => controller.abort());
  let page = await nextPage();
  if (!page) return json(response, 404, { error: 'Run not found' });
  response.writeHead(200, {
    ...headers,
    'Connection': 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  response.write('retry: 1000\n\n');
  let lastWrite = Date.now();
  while (!controller.signal.aborted) {
    cursor = page.cursor;
    if (page.events.length || page.reset) {
      // Close a slow connection rather than queue unbounded data. EventSource can replay
      // from its last fully received id.
      if (!response.write('id: ' + cursor + '\nevent: trace\ndata: ' + JSON.stringify(page) + '\n\n')) {
        if (response.writableLength > 2 ** 20) {
          response.destroy();
          return;
        }
      }
      lastWrite = Date.now();
    } else if (Date.now() - lastWrite >= 15000) {
      response.write(': heartbeat\n\n');
      lastWrite = Date.now();
    }
    if (!page.hasMore) await delay(500, undefined, { signal: controller.signal });
    page = await nextPage();
    if (!page) return response.end();
  }
}

async function staticAsset(path, response) {
  const asset = path === '/' || /^\/runs\/[^/]+\/?$/.test(path) ? 'index.html' : path.slice(1);
  // Only installed assets with a known content type are served.
  const type = contentTypes.get(extname(asset));
  if (!type || !/^[\w-]+(?:\/[\w-]+)*\.[\w]+$/.test(asset)) {
    return json(response, 404, { error: 'Resource not found' });
  }
  const body = await readFile(new URL('./public/' + asset, import.meta.url));
  response.writeHead(200, { ...headers, 'Content-Type': type });
  response.end(body);
}

async function route(request, response, reader) {
  if (!allowed(request)) return json(response, 403, { error: 'A loopback origin is required' });
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return json(response, 405, { error: 'Only read-only GET requests are supported' });
  }
  const { pathname, searchParams } = new URL(request.url, 'http://' + loopback);
  if (pathname === '/api/runs') {
    return json(response, 200, { runs: await reader.listRuns() });
  }
  if (!pathname.startsWith('/api/')) return staticAsset(pathname, response);
  const match = /^\/api\/runs\/([^/]+)(?:\/(events|records|files|live)(?:\/([^/]+))?)?$/.exec(pathname);
  if (!match) return json(response, 404, { error: 'Route not found' });
  const [, encodedRun, resource, encodedRecord] = match;
  const runId = decodeURIComponent(encodedRun);
  let value;
  if (!resource) value = await reader.summary(runId);
  else if (resource === 'records' && encodedRecord) value = await reader.detail(runId, decodeURIComponent(encodedRecord));
  else if (resource === 'events' && !encodedRecord) value = await reader.events(runId, pageOptions(searchParams));
  else if (resource === 'files' && !encodedRecord) {
    value = await reader.file(runId, searchParams.get('path'), {
      offset: numberParam(searchParams, 'offset', Number.MAX_SAFE_INTEGER),
      limit: numberParam(searchParams, 'limit', 256 * 1024),
    });
  } else if (resource === 'live' && !encodedRecord) {
    return live(request, response, reader, runId, searchParams);
  }
  if (value == null) return json(response, 404, { error: 'Evidence not found' });
  json(response, 200, value);
}

function errorResponse(error, response) {
  if (response.destroyed || error.name === 'AbortError') return;
  if (response.headersSent) return response.end();
  const status = error.status ?? error.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return json(response, status, { error: error.message });
  }
  if (error.name === 'URIError') return json(response, 400, { error: 'Invalid URL encoding' });
  if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(error.code)) {
    return json(response, 404, { error: 'Evidence not found' });
  }
  json(response, 500, { error: 'Unable to read Run evidence' });
}

export async function startTraceServer({ root, port = 8787 }) {
  const reader = await createTraceReader({ root });
  const server = createServer((request, response) => {
    route(request, response, reader).catch(error => errorResponse(error, response));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, loopback, resolve);
  });
  return {
    url: 'http://' + loopback + ':' + server.address().port,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

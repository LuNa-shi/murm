import { createServer } from 'node:http';
let dropped = false;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  const upstream = await fetch(process.env.PEER_UPSTREAM + request.url, {
    method: request.method, headers: { authorization: request.headers.authorization, 'content-type': 'application/json' }, body,
  });
  const text = await upstream.text();
  const parsed = JSON.parse(body);
  if (!dropped && parsed.input?.gate_id && upstream.ok) {
    dropped = true; response.destroy(); return;
  }
  response.writeHead(upstream.status, { 'content-type': 'application/json' });
  response.end(text);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })));
process.once('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });

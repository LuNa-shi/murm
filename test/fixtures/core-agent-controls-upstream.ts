import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from '../../scripts/local-setup-upstream.js';

// Synthetic provider usage drives Pi's own threshold checks. The actual Pi
// compaction and Session entries remain the evidence of successful compression.
export async function createAgentControlsUpstream({ requestLimit = 32, inputTokens = 6500 } = {}) {
  const requests: { kind: 'summary' | 'ordinary'; body: any }[] = [];
  let failure: string | undefined;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') throw new Error('Unexpected controlled model route');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('Controlled request is too large');
        chunks.push(chunk);
      }
      if (requests.length >= requestLimit) throw new Error('Controlled model request limit exceeded');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const summary = body.input?.some((item: any) => item.role === 'system' &&
        JSON.stringify(item.content).includes('context summarization assistant'));
      requests.push({ kind: summary ? 'summary' : 'ordinary', body });
      const item = { type: 'message', id: `controls_message_${requests.length}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: summary ? 'Summary of earlier controlled work.' : 'CONTROLLED_TURN_COMPLETE', annotations: [] }] };
      const stream = streamResponse('k3', requests.length, item)
        .replaceAll('"input_tokens":20', `"input_tokens":${inputTokens}`)
        .replaceAll('"total_tokens":40', `"total_tokens":${inputTokens + 20}`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(stream);
    } catch (error: any) {
      failure = error.message;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: failure } }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Controlled upstream did not bind a TCP port');
  return { url: `http://127.0.0.1:${address.port}/v1`, requests, get failure() { return failure; },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

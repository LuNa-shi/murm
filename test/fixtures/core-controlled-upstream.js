import { createServer } from 'node:http';
import { once } from 'node:events';

export const SMOKE_MARKER = 'CORE_TOOL_EFFECT_CONFIRMED';

function event(type, fields) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function streamResponse(model, number, item) {
  const response = { id: `resp_core_${number}`, object: 'response', status: 'completed', model,
    output: [item], usage: { input_tokens: 20, output_tokens: 20, total_tokens: 40 } };
  let result = event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  result += event('response.output_item.added', { output_index: 0, item: item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] } });
  if (item.type === 'function_call') {
    result += event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
    result += event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
  } else {
    result += event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
  }
  result += event('response.output_item.done', { output_index: 0, item });
  result += event('response.completed', { response });
  return result;
}

export async function createControlledUpstream({ model = 'k3' } = {}) {
  const requests = [];
  let failure;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') throw new Error('Unexpected upstream route');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('Controlled upstream request exceeds 2 MiB');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      if (body.model !== model || !Array.isArray(body.input)) throw new Error('Unexpected model or input shape');
      let item;
      if (requests.length === 1) {
        item = { type: 'function_call', id: 'fc_core_bash', call_id: 'call_core_bash', name: 'bash',
          arguments: JSON.stringify({ command: `printf '%s\\n' '${SMOKE_MARKER}' > core-smoke.txt`, timeout: 5 }) };
      } else if (requests.length === 2) {
        if (!body.input.some(value => value.type === 'function_call_output' && value.call_id === 'call_core_bash')) {
          throw new Error('Pi did not return the Bash tool result');
        }
        item = { type: 'function_call', id: 'fc_core_read', call_id: 'call_core_read', name: 'read',
          arguments: JSON.stringify({ path: 'core-smoke.txt' }) };
      } else if (requests.length === 3) {
        const read = body.input.find(value => value.type === 'function_call_output' && value.call_id === 'call_core_read');
        if (typeof read?.output !== 'string' || read.output.trim() !== SMOKE_MARKER) {
          throw new Error('Actual read tool output did not confirm the Bash file effect');
        }
        item = { type: 'message', id: 'msg_core_final', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'FILE_OK', annotations: [] }] };
      } else {
        throw new Error('Controlled upstream exceeded the three-request smoke boundary');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse(model, requests.length, item));
    } catch (error) {
      failure = error;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/responses`,
    requests,
    get failure() { return failure; },
    close() {
      return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

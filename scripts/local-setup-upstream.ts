import { createServer } from 'node:http';
import { once } from 'node:events';

export const SETUP_MARKER = 'MURM_LOCAL_SETUP_VERIFIED';
export const SETUP_BASH = `printf '%s' '{"key":"smoke"}' | swarm service invoke setup-probe verify --stdin --request-id setup-probe && printf '%s\\n' '${SETUP_MARKER}' > setup-smoke.txt`;
export const SETUP_READ = 'setup-smoke.txt';
export const SETUP_RESULT = 'SETUP_OK';

function event(type: string, fields: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

export function streamResponse(model: string, number: number, item: any) {
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

/** The host sends only fixed tool instructions to this loopback Responses endpoint. */
export async function createLocalSetupUpstream(executor: 'pi' | 'codex' = 'pi') {
  const codex = executor === 'codex';
  const model = codex ? 'gpt-5.4' : 'k3';
  const command = (id: string, cmd: string) => ({
    type: 'function_call', id: `fc_setup_${id}`, call_id: `call_setup_${id}`, name: 'exec_command',
    arguments: JSON.stringify({ cmd, yield_time_ms: 1000, max_output_tokens: 128 }),
  });
  let arrivals = 0;
  let verifiedRead = false;
  let failure = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') throw new Error('route');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('size');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== model || !Array.isArray(body.input)) throw new Error('shape');
      arrivals++;
      let item;
      if (arrivals === 1) {
        item = codex ? command('bash', SETUP_BASH) : { type: 'function_call', id: 'fc_setup_bash', call_id: 'call_setup_bash', name: 'bash',
          arguments: JSON.stringify({ command: SETUP_BASH, timeout: 10 }) };
      } else if (arrivals === 2) {
        if (!body.input.some((value: any) => value.type === 'function_call_output' && value.call_id === 'call_setup_bash')) throw new Error('bash');
        item = codex ? command('read', `cat ${SETUP_READ}`) : { type: 'function_call', id: 'fc_setup_read', call_id: 'call_setup_read', name: 'read',
          arguments: JSON.stringify({ path: SETUP_READ }) };
      } else if (arrivals === 3) {
        const read = body.input.find((value: any) => value.type === 'function_call_output' && value.call_id === 'call_setup_read');
        if (typeof read?.output !== 'string' || (codex ? !read.output.includes(SETUP_MARKER) : read.output.trim() !== SETUP_MARKER)) throw new Error('read');
        verifiedRead = true;
        item = { type: 'message', id: 'msg_setup_final', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: SETUP_RESULT, annotations: [] }] };
      } else throw new Error('boundary');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse(model, arrivals, item));
    } catch {
      failure = true;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Local setup probe rejected an unexpected request' } }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local setup upstream did not bind');
  return {
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    receipt: () => ({ arrivals, verifiedRead, failure }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

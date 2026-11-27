import { createServer } from 'node:http';
import { once } from 'node:events';
import type { ModelProtocol } from '../src/core/model-transport.js';

export const SETUP_MARKER = 'MURM_LOCAL_SETUP_VERIFIED';
export const SETUP_BASH = `printf '%s' '{"key":"smoke"}' | swarm service invoke setup-probe verify --stdin --request-id setup-probe && printf '%s\\n' '${SETUP_MARKER}' > setup-smoke.txt`;
export const SETUP_READ = 'setup-smoke.txt';
export const SETUP_RESULT = 'SETUP_OK';
export const SETUP_CONTINUATION = 'Confirm the previous tool result in this session.';
export const SETUP_CONTINUED = 'SETUP_CONTINUED';

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

export function streamChatCompletion(model: string, number: number, item: any) {
  const frame = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
    id: `chat_core_${number}`, model, object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`;
  const terminal = `data: ${JSON.stringify({
    id: `chat_core_${number}`, model, object: 'chat.completion.chunk', created: 1, choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
  })}\n\n`;
  const first = frame({ role: 'assistant' }, null);
  if (item.type !== 'function_call') {
    return first + frame({ content: item.content[0].text }, null) + frame({}, 'stop') + terminal + 'data: [DONE]\n\n';
  }
  const half = Math.floor(item.arguments.length / 2);
  return first + frame({ tool_calls: [{ index: 0, id: item.call_id, type: 'function',
    function: { name: item.name, arguments: item.arguments.slice(0, half) } }] }, null) +
    frame({ tool_calls: [{ index: 0, function: { arguments: item.arguments.slice(half) } }] }, null) +
    frame({}, 'tool_calls') + terminal + 'data: [DONE]\n\n';
}

/** The host sends only fixed tool instructions to this loopback model endpoint. */
export async function createLocalSetupUpstream(executor: 'pi' | 'codex' = 'pi', protocol: ModelProtocol = 'responses') {
  const codex = executor === 'codex';
  const chat = protocol === 'chat-completions';
  const path = chat ? '/v1/chat/completions' : '/v1/responses';
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
      if (request.method !== 'POST' || request.url !== path) throw new Error('route');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('size');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const messages = chat ? body.messages : body.input;
      if (body.model !== model || !Array.isArray(messages)) throw new Error('shape');
      const readResult = (id: string) => chat ? messages.find((value: any) => value.role === 'tool' && value.tool_call_id === id)?.content :
        messages.find((value: any) => value.type === 'function_call_output' && value.call_id === id)?.output;
      arrivals++;
      let item;
      if (arrivals === 1) {
        item = codex ? command('bash', SETUP_BASH) : { type: 'function_call', id: 'fc_setup_bash', call_id: 'call_setup_bash', name: 'bash',
          arguments: JSON.stringify({ command: SETUP_BASH, timeout: 10 }) };
      } else if (arrivals === 2) {
        if (typeof readResult('call_setup_bash') !== 'string') throw new Error('bash');
        item = codex ? command('read', `cat ${SETUP_READ}`) : { type: 'function_call', id: 'fc_setup_read', call_id: 'call_setup_read', name: 'read',
          arguments: JSON.stringify({ path: SETUP_READ }) };
      } else if (arrivals === 3) {
        const read = readResult('call_setup_read');
        if (typeof read !== 'string' || (codex ? !read.includes(SETUP_MARKER) : read.trim() !== SETUP_MARKER)) throw new Error('read');
        verifiedRead = true;
        item = { type: 'message', id: 'msg_setup_final', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: SETUP_RESULT, annotations: [] }] };
      } else if (chat && arrivals === 4 && verifiedRead) {
        const hasText = (role: string, text: string) => messages.some(message => message.role === role &&
          (message.content === text || (Array.isArray(message.content) && message.content.some((part: { text?: string }) => part?.text === text))));
        if (!hasText('assistant', SETUP_RESULT) || !hasText('user', SETUP_CONTINUATION)) {
          throw new Error('continuation');
        }
        item = { type: 'message', content: [{ type: 'output_text', text: SETUP_CONTINUED }] };
      } else throw new Error('boundary');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end((chat ? streamChatCompletion : streamResponse)(model, arrivals, item));
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
    url: `http://127.0.0.1:${address.port}${path}`,
    receipt: () => ({ arrivals, verifiedRead, failure }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

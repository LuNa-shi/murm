import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

export async function createInputUpstream() {
  let count = 0;
  let failure;
  const evidence = { persistedRead: false, bashCompleted: false, steerAtBoundary: false, followUpAfterCurrent: false };
  const tool = (name, args, id) => ({ type: 'function_call', name, id: `fc_${id}`, call_id: id, arguments: JSON.stringify(args) });
  const text = value => ({ type: 'message', id: `message_${count}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] });
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') throw new Error('route');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('body_limit');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.model !== 'k3' || !Array.isArray(body.input)) throw new Error('shape');
      count += 1;
      const result = id => body.input.find(item => item.type === 'function_call_output' && item.call_id === id)?.output;
      const contents = JSON.stringify(body.input);
      let item;
      switch (count) {
        case 1: item = tool('bash', { command: "printf 'PERSISTED_ONE\\n' > persistent.txt", timeout: 5 }, 'persist'); break;
        case 2:
          if (typeof result('persist') !== 'string') throw new Error('missing_write_result');
          item = text('ROUND_ONE_OK'); break;
        case 3: item = tool('read', { path: 'persistent.txt' }, 'read_persisted'); break;
        case 4:
          evidence.persistedRead = result('read_persisted') === 'PERSISTED_ONE\n';
          if (!evidence.persistedRead) throw new Error('read_did_not_match');
          item = text('ROUND_TWO_OK'); break;
        case 5:
          item = tool('bash', { command: "printf 'READY\\n' > busy-ready.txt; sleep 4; printf 'BUSY_DONE\\n' > busy-finished.txt; cat busy-finished.txt", timeout: 10 }, 'busy'); break;
        case 6:
          evidence.bashCompleted = result('busy') === 'BUSY_DONE\n';
          evidence.steerAtBoundary = contents.includes('STEER_AT_TOOL_BOUNDARY');
          if (!evidence.bashCompleted || !evidence.steerAtBoundary) throw new Error('busy_boundary_missing');
          item = text('CURRENT_RUN_DONE'); break;
        case 7:
          evidence.followUpAfterCurrent = contents.includes('FOLLOW_UP_AFTER_CURRENT') && contents.includes('CURRENT_RUN_DONE');
          if (!evidence.followUpAfterCurrent) throw new Error('follow_up_order_missing');
          item = text('BUSY_ROUND_OK'); break;
        default: throw new Error('request_cap');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse('k3', count, item));
    } catch (error) {
      failure = error.message;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'CONTROLLED_INPUT_SCENARIO_FAILED' } }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/responses`,
    receipt: () => ({ requests: count, failure, ...evidence }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

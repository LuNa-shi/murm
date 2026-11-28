import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { streamResponse } from '../../scripts/local-setup-upstream.js';

function text(id: string, value: string) {
  return { type: 'message', id, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: value, annotations: [] }] };
}
function tool(id: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', id: 'fc_' + id, call_id: id, name, arguments: JSON.stringify(args) };
}
function service(id: string, operation: string, input: Record<string, unknown>) {
  return tool(id, 'bash', { command: `printf '%s' '${JSON.stringify(input)}' | swarm ${operation} --stdin --request-id ${id}`, timeout: 45 });
}

export async function createHarnessSessionUpstream(seed: string, editable?: { prompt: string; controller: string }, terminal = false) {
  const slowChild = Promise.withResolvers<void>();
  const heldStream = Promise.withResolvers<void>();
  const childQuestionAllowed = Promise.withResolvers<void>();
  const heldQueue = Promise.withResolvers<void>();
  const heldIdentity = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const requests: { stage: string; count: number }[] = [];
  let failure: string | undefined;
  let ordinal = 0;
  const server = createServer(async (request, response) => {
    if (terminal && request.method === 'GET' && request.url?.startsWith('/terminal-control/')) {
      switch (request.url) {
        case '/terminal-control/stream': heldStream.resolve(); break;
        case '/terminal-control/child': slowChild.resolve(); break;
        case '/terminal-control/child-question': childQuestionAllowed.resolve(); break;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ requests, failure }));
      return;
    }
    let stage = 'parse';
    const number = ++ordinal;
    try {
      assert.ok(number <= 48, 'controlled request bound');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 2 * 1024 * 1024, 'controlled request byte bound');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const rows: any[] = body.input;
      const users = rows.filter(row => row.role === 'user').flatMap(row => row.content ?? []).map(block => block.text ?? '');
      const marker = users.filter(value => /SESSION_(READ|SECOND|INTERRUPT|CHILD|RESUME|QUESTIONS|ASKER|QOLD|QNEW|HOLD_QUEUE|IDENTITY_HOLD|IDENTITY_RESUME|CONTEXT_STEER|CONTEXT_FOLLOW|AFTER_QUEUE|RETRY)/.test(value)).at(-1);
      const output = (id: string) => rows.find(row => row.type === 'function_call_output' && row.call_id === id)?.output;
      const all = JSON.stringify(rows);
      let item;
      if (rows.some(row => (row.role === 'system' || row.role === 'developer') && JSON.stringify(row.content).includes('context summarization assistant'))) {
        stage = 'summary';
        item = text('summary', 'Summary of the controlled project work.');
      } else if (marker?.includes('SESSION_READ')) {
        stage = output('seed-read') ? 'seed-result' : 'seed-read';
        if (stage === 'seed-read') {
          assert.ok(!all.includes(seed), 'capture was not embedded in the initial prompt');
          if (editable) {
            assert.ok(all.includes(editable.prompt), 'the actual model request uses the edited Root prompt');
            assert.ok(marker.includes(editable.controller), 'the actual Root turn passes through the edited controller');
          }
          item = tool('seed-read', 'read', { path: 'seed.txt' });
        } else {
          assert.ok(String(output('seed-read')).includes(seed), 'actual read result includes captured bytes');
          item = text('seed-result', terminal ? 'NATIVE_STREAM_START SEED_READ_OK' : 'SEED_READ_OK');
        }
      } else if (marker?.includes('SESSION_SECOND')) {
        stage = 'second';
        assert.ok(all.includes('APPENDED_CONTEXT_VALUE'));
        item = text('second', 'SECOND_TURN_OK');
      } else if (marker?.includes('SESSION_CHILD')) {
        stage = 'slow-child';
        await slowChild.promise;
        item = text('slow-child', 'LATE_CHILD_RESULT');
      } else if (marker?.includes('SESSION_INTERRUPT')) {
        stage = output('spawn-slow') ? 'root-wait' : 'spawn-slow';
        assert.equal(output('wait-slow'), undefined, 'interrupted Root work must never continue');
        if (stage === 'spawn-slow') item = service('spawn-slow', 'collaboration spawn_agent', {
          task_name: 'slow', message: 'SESSION_CHILD', fork_turns: 'none',
        });
        else item = service('wait-slow', 'collaboration wait_agent', { timeout_ms: 30_000 });
      } else if (marker?.includes('SESSION_RESUME')) {
        stage = 'resume';
        const latest = users.at(-1);
        assert.equal(latest.split('LATE_CHILD_RESULT').length, 2, 'late child result is included exactly once in the new input');
        assert.ok(!all.includes('DISCARD_ON_INTERRUPT'), 'cancelled context did not reach a later request');
        item = text('resume', 'SAME_ROOT_RESUMED');
      } else if (marker?.includes('SESSION_ASKER')) {
        stage = output('child-question') ? 'child-answer' : 'child-question';
        if (stage === 'child-question') {
          if (terminal) await childQuestionAllowed.promise;
          item = service('child-question', 'service invoke user-interaction ask', terminal
            ? { kind: 'choice', text: 'Which child value?', options: [{ id: 'CHILD_VALUE', label: 'Child value' }, { id: 'other', label: 'Other value' }] }
            : { text: 'Which child value?' });
        }
        else {
          assert.ok(String(output('child-question')).includes('CHILD_VALUE'));
          assert.ok(!String(output('child-question')).includes('ROOT_VALUE'));
          item = text('child-answer', 'CHILD_ANSWER_OK');
        }
      } else if (marker?.includes('SESSION_QUESTIONS')) {
        if (!output('spawn-asker')) {
          stage = 'spawn-asker';
          item = service('spawn-asker', 'collaboration spawn_agent', { task_name: 'asker', message: 'SESSION_ASKER', fork_turns: 'none' });
        } else if (!output('root-question')) {
          stage = 'root-question';
          item = service('root-question', 'service invoke user-interaction ask',
            terminal ? { kind: 'confirm', text: 'Which Root value?' } : { text: 'Which Root value?' });
        } else {
          stage = 'root-answer';
          assert.ok(String(output('root-question')).includes(terminal ? 'true' : 'ROOT_VALUE'));
          assert.ok(!String(output('root-question')).includes('CHILD_VALUE'));
          item = text('root-answer', 'ROOT_ANSWER_OK');
        }
      } else if (marker?.includes('SESSION_QOLD')) {
        stage = 'old-question';
        assert.equal(output('old-root-question'), undefined, 'a cancelled Service call cannot resume the old execution');
        item = service('old-root-question', 'service invoke user-interaction ask', { text: 'Old Root execution question' });
      } else if (marker?.includes('SESSION_QNEW')) {
        stage = output('new-root-question') ? 'new-answer' : 'new-question';
        if (stage === 'new-question') item = service('new-root-question', 'service invoke user-interaction ask', { text: 'New Root execution question' });
        else {
          assert.ok(String(output('new-root-question')).includes('NEW_EXECUTION_ANSWER'));
          assert.ok(!all.includes('LATE_OLD_EXECUTION_ANSWER'));
          item = text('new-answer', 'NEW_EXECUTION_ANSWER_OK');
        }
      } else if (marker?.includes('SESSION_IDENTITY_HOLD')) {
        const index = marker.includes('SECOND') ? 1 : 0;
        stage = 'identity-hold-' + index;
        requests.push({ stage, count: number });
        await heldIdentity[index].promise;
        if (!response.destroyed) response.destroy();
        return;
      } else if (marker?.includes('SESSION_IDENTITY_RESUME')) {
        stage = 'identity-resume';
        assert.ok(!all.includes('DISCARDED_NEXT_TURN_281'));
        assert.ok(all.includes('SAME_CONTENT_281_FIRST'));
        if (marker.includes('SECOND')) assert.ok(all.includes('SAME_CONTENT_281_SECOND'));
        item = text('identity-resume-1', 'IDENTITY_');
      } else if (marker?.includes('SESSION_HOLD_QUEUE')) {
        stage = 'held-queue';
        await heldQueue.promise;
        item = text('held-queue', 'QUEUE_TURN_OK');
      } else if (marker?.includes('SESSION_CONTEXT_STEER')) {
        stage = 'context-steer';
        item = text('context-steer', 'CONTEXT_STEER_OK');
      } else if (marker?.includes('SESSION_CONTEXT_FOLLOW')) {
        stage = 'context-follow';
        item = text('context-follow', 'CONTEXT_FOLLOW_OK');
      } else if (marker?.includes('SESSION_AFTER_QUEUE')) {
        stage = 'after-clear';
        assert.ok(!all.includes('DISCARD_BY_CLEAR') && !all.includes('QUEUED_TEXT_TO_DISCARD'));
        assert.ok(all.includes('CONTINUE_WITH_CONTEXT'));
        item = text('after-clear', 'CLEAR_QUEUE_VERIFIED');
      } else if (marker?.includes('SESSION_RETRY')) {
        stage = 'retry';
        requests.push({ stage, count: number });
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: '503 controlled temporary upstream failure' } }));
        return;
      } else throw new Error('Unexpected controlled work request');
      requests.push({ stage, count: number });
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      let bodyText = streamResponse('k3', number, item);
      if (stage === 'identity-resume') {
        const second = text('identity-resume-2', 'RESUME_OK');
        const firstFrames = bodyText.trimEnd().split('\n\n').map(frame => JSON.parse(frame.split('\ndata: ')[1]));
        const secondFrames = streamResponse('k3', number, second).trimEnd().split('\n\n')
          .map(frame => JSON.parse(frame.split('\ndata: ')[1])).slice(1, -1)
          .map(frame => ({ ...frame, output_index: 1 }));
        const terminal = firstFrames.pop();
        terminal.response.output.push(second);
        bodyText = [...firstFrames, ...secondFrames, terminal]
          .map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
      }
      if (terminal && stage === 'seed-result') {
        const frames = bodyText.trimEnd().split('\n\n');
        const index = frames.findIndex(frame => frame.startsWith('event: response.output_text.delta'));
        const parts = frames[index].split('\ndata: ');
        const delta = JSON.parse(parts[1]);
        const prefix = 'NATIVE_STREAM_START';
        frames[index] = parts[0] + '\ndata: ' + JSON.stringify({ ...delta, delta: prefix });
        response.write(frames.slice(0, index + 1).join('\n\n') + '\n\n');
        await heldStream.promise;
        if (response.destroyed) return;
        frames[index] = parts[0] + '\ndata: ' + JSON.stringify({ ...delta, delta: delta.delta.slice(prefix.length) });
        bodyText = frames.slice(index).join('\n\n') + '\n\n';
      }
      response.end(bodyText);
    } catch (error) {
      failure ??= `${stage}: ${error instanceof Error ? error.message : 'controlled provider failure'}`;
      if (!response.destroyed) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: failure } }));
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/v1/responses`, requests, get failure() { return failure; },
    releaseChild: () => slowChild.resolve(), releaseQueue: () => heldQueue.resolve(),
    releaseIdentity: (index: number) => heldIdentity[index].resolve(),
    close() {
      slowChild.resolve();
      heldStream.resolve();
      childQuestionAllowed.resolve();
      heldQueue.resolve();
      for (const hold of heldIdentity) hold.resolve();
      return new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

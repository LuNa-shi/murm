import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { connect } from './connection.js';
import { inputArguments } from './consume.js';

const { child, session } = connect();
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const unsubscribe = session.onEvent(event => {
  if (event.type === 'snapshot' || event.type === 'state') console.log(JSON.stringify(event.state));
  else if (event.type === 'question') console.log(JSON.stringify(event.question));
  else if (event.type === 'event') console.log(JSON.stringify(event.event));
}, { initialSnapshot: true });
try {
  await session.ready;
  await session.start(inputArguments(), { requestId: 'start' });
  console.log('Enter text, /status, /answer QUESTION_ID JSON_VALUE, or /stop.');
  for await (const line of terminal) {
    try {
      if (line === '/stop') break;
      if (line === '/status') { console.log(JSON.stringify(await session.getState())); continue; }
      const answer = /^\/answer\s+(\S+)\s+([\s\S]+)$/.exec(line);
      if (answer) {
        const value: unknown = JSON.parse(answer[2]);
        if (typeof value !== 'string' && typeof value !== 'boolean') throw new Error('Answers must be a JSON string or boolean.');
        console.log(JSON.stringify(await session.respond(answer[1], value, { requestId: randomUUID() })));
      } else console.log(JSON.stringify(await session.input(line, { requestId: randomUUID() })));
    } catch (error) { console.error(error instanceof Error ? error.message : 'Request failed'); }
  }
  await session.stop({ requestId: 'stop', reason: 'terminal-ended' });
  console.log(JSON.stringify(await session.completion));
} finally { unsubscribe(); terminal.close(); child.stdin.end(); }

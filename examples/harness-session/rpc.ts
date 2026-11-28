import { consume, inputArguments } from './consume.js';
import { connect } from './connection.js';

const { child, session } = connect();
try {
  await session.ready;
  console.log(JSON.stringify(await consume(session, inputArguments())));
} finally { child.stdin.end(); }

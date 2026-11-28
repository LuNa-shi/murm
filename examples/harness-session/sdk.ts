import { createHarnessSession } from '@luna-shi/murm';
import harness from './project.js';
import { consume, inputArguments } from './consume.js';

const session = createHarnessSession(harness, { lifetime: 'interactive', clientCapabilities: { questions: true } });
console.log(JSON.stringify(await consume(session, inputArguments())));

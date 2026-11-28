import { randomUUID } from 'node:crypto';
import type { HarnessInput, HarnessSession } from '@luna-shi/murm';

export function inputArguments(): HarnessInput {
  const cwd = process.argv[2];
  if (!cwd) throw new Error('Pass a project directory and an optional prompt.');
  return { cwd, prompt: process.argv[3] ?? 'Demonstrate a public HarnessSession.' };
}

export async function consume(session: HarnessSession, input: HarnessInput) {
  const answered = Promise.withResolvers<void>();
  const failures: Promise<unknown>[] = [];
  const unsubscribe = session.onEvent(event => {
    if (event.type === 'question' && event.question.status === 'pending') {
      const answer = event.question.kind === 'confirm' ? true : 'SDK and RPC';
      const work = session.respond(event.question.questionId, answer, { requestId: 'answer-' + event.question.questionId });
      failures.push(work);
      void work.catch(answered.reject);
    }
    if (event.type === 'state' && event.state.business && typeof event.state.business === 'object' &&
        'stage' in event.state.business && event.state.business.stage === 'answered') answered.resolve();
  }, { initialSnapshot: true });
  try {
    await session.start(input, { requestId: 'start' });
    await answered.promise;
    await Promise.all(failures);
    const receipt = await session.input('A subsequent input', { requestId: 'input-' + randomUUID() });
    if (receipt.status !== 'accepted') throw new Error('The Harness did not confirm the input.');
    await session.stop({ requestId: 'stop', reason: 'example-complete' });
    return await session.completion!;
  } finally { unsubscribe(); }
}

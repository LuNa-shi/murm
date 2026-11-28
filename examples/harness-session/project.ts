import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessJson, ProjectHarness } from '@luna-shi/murm';

/** A deterministic author-contract example with two independent business questions. */
const harness: ProjectHarness = {
  apiVersion: 1,
  id: 'session-example',
  lifetimes: ['task', 'interactive'],
  input: true,
  inputDescriptor: { description: 'Nonblank text records a subsequent business input.', schema: { type: 'string', minLength: 1 } },
  questions: true,
  async run(context) {
    const inputs: HarnessJson[] = [];
    const progress = (stage: string, answers?: readonly (string | boolean)[]) => context.updateStatus({ business: {
      stage, inputs: [...inputs], answers: answers ? [...answers] : null, initialDigest: context.initial.digest,
    } });
    context.registerInput((payload, request) => {
      request.signal.throwIfAborted();
      if (typeof payload !== 'string' || !payload.trim()) throw Object.assign(new TypeError('Expected nonblank text'), { code: 'INVALID_HARNESS_INPUT' });
      inputs.push(payload);
      progress('input-recorded');
      return { disposition: 'recorded', input: payload };
    });
    context.markRunning();
    progress('questions');
    let answers: (string | boolean)[] = [];
    try {
      answers = await Promise.all([
        context.askUser({ requestId: 'question-name', questionId: 'name', kind: 'text', text: 'Which name should the report use?' }, { id: context.runId + '/name', signal: context.signal }),
        context.askUser({ requestId: 'question-confirm', questionId: 'confirm', kind: 'confirm', text: 'Save the report?' }, { id: context.runId + '/confirm', signal: context.signal }),
      ]);
      progress('answered', answers);
      context.emit({ namespace: 'session-example', kind: 'output', text: 'Both business questions have been answered.' });
      if (context.lifetime === 'interactive') {
        await new Promise<void>(resolve => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    } catch (error) {
      if (!context.signal.aborted) throw error;
    }
    const artifact = join(context.outputDir, 'answers.json');
    await writeFile(artifact, JSON.stringify({ answers, inputs, initialDigest: context.initial.digest }) + '\n', { mode: 0o600 });
    return {
      outcome: context.signal.aborted ? 'cancelled' : 'completed', reason: context.signal.aborted ? 'requested' : 'answered',
      result: { answers, inputs }, artifacts: [{ path: artifact }], export: { status: 'complete' }, cleanup: { status: 'complete' },
    };
  },
};
export default harness;

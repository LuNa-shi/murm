import { createHash } from 'node:crypto';
import { runSubagentsHarness } from './main.js';
import type { ProjectHarness } from '../../src/harnesses/shared/project-harness.js';
import { projectError } from '../../src/harnesses/shared/project-input.js';
import { observeProjectRuntime, projectConfiguration, projectResult } from '../../src/harnesses/shared/project-runtime.js';

const subagents = {
  id: 'subagents',
  apiVersion: 1,
  input: true,
  async run(context) {
    const config = await projectConfiguration<Parameters<typeof runSubagentsHarness>[0]>(context, () => import('./config.js'));
    if (config.workspace) throw projectError('INVALID_RUN_CONFIGURATION', 'The project entry uses private Subagents work directories');
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    try {
      const report = await runSubagentsHarness({
        ...config, goal: context.input.prompt, files: context.initial.files, outputDir: context.outputDir,
        collect: config.collect ?? { paths: ['.'], includeGit: false, maxBytes: 16 * 1024 ** 2, required: true },
      }, context.signal, undefined, {
        childFiles: context.initial.files,
        onRuntime: runtime => { observation = observeProjectRuntime(runtime, context); },
        onReady: harness => {
          context.registerInput(async (input, { requestId }) => {
            const text = typeof input === 'string' ? input :
              input && typeof input === 'object' && 'text' in input ? input.text : undefined;
            if (typeof text !== 'string' || !text.trim()) throw projectError('INVALID_HARNESS_INPUT', 'Expected non-blank text');
            const id = createHash('sha256').update(requestId).digest('hex');
            return JSON.parse(JSON.stringify(await harness.input(text, `rpc:${id}`)));
          });
          context.markRunning();
        },
      });
      return { ...projectResult(report, context, report.collaboration), acceptance: { status: 'not-run' } };
    } finally {
      observation?.close();
    }
  },
} satisfies ProjectHarness;

export default subagents;

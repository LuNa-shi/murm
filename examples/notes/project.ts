import { createRuntime, createSandbox, type CreateRuntimeOptions, type SandboxConfig } from '@murm/core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectHarness } from '../../src/harnesses/shared/project-harness.js';
import { observeProjectRuntime, projectConfiguration, projectResult } from '../../src/harnesses/shared/project-runtime.js';
import { projectError } from '../../src/harnesses/shared/project-input.js';
import { createNotes } from './main.js';
import { runInput } from './run-input.js';
import { runWithReport } from './run-report.js';

interface Config extends Pick<CreateRuntimeOptions, 'executor' | 'connection' | 'models'> {
  sandbox: SandboxConfig;
  image: string;
  model?: string;
  turnTimeoutMs?: number;
  closeTimeoutMs?: number;
}

const key = 'project-observation';
export const projectNotesWriterPrompt = 'Read your local project and publish one concrete, task-relevant observation in Notes. Include a relative source path and explain what you found. Publish it with swarm notes put under key project-observation, then finish.';
export const projectNotesReaderPrompt = 'Retrieve project-observation with swarm notes get. Compare the observation with the project files, use it to address the task, and write your evidence and results to the specified result file. Include the exact note text so the handoff can be checked.';

const notesHarness = {
  id: 'notes', apiVersion: 1,
  async run(context) {
    const artifact = `murm-notes-${context.runId}.md`;
    const config = await projectConfiguration<Config>(context, () => import('./config.js'));
    const { image, model = 'default', turnTimeoutMs = 30_000, closeTimeoutMs = 30_000 } = config;
    if (![turnTimeoutMs, closeTimeoutMs].every(ms => Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647) ||
        typeof image !== 'string' || !image) throw projectError('INVALID_RUN_CONFIGURATION', 'Invalid Notes image or time limit');
    let sandbox;
    try { sandbox = createSandbox(config.sandbox); }
    catch { throw projectError('INVALID_RUN_CONFIGURATION', 'Invalid Notes sandbox configuration'); }
    const notes = createNotes();
    const common = { image, model, writable: true };
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    const state = { stage: 'writer' };
    try {
      const report = await runWithReport({ outputDir: context.outputDir, closeTimeoutMs,
        async createRuntime() {
          const runtime = await createRuntime({ sandbox, executor: config.executor, models: config.models,
            connection: config.connection, services: notes.services, outputDir: context.outputDir, maxAgents: 2,
            profiles: {
              writer: { ...common, prompt: projectNotesWriterPrompt, services: { notes: ['put'] } },
              reader: { ...common, prompt: projectNotesReaderPrompt, services: { notes: ['get'] },
                collect: { paths: [artifact], includeGit: false, maxBytes: 64 * 1024, required: true } },
            } });
          observation = observeProjectRuntime(runtime, context, () => state);
          return runtime;
        },
        async run(runtime: Awaited<ReturnType<typeof createRuntime>>) {
          const { signal, initial, input } = context;
          signal.throwIfAborted();
          const writer = await runtime.spawn({ requestId: 'notes-writer', profile: 'writer', files: initial.files });
          signal.throwIfAborted();
          context.markRunning();
          await runInput(runtime, writer.id, input.prompt, { requestId: 'notes-write', timeoutMs: turnTimeoutMs, signal });
          const published = notes.records.get(key);
          if (published?.author !== writer.id) throw projectError('NOTES_PUBLICATION_UNCONFIRMED', 'The writer did not publish its project observation');
          signal.throwIfAborted();
          state.stage = 'reader';
          const reader = await runtime.spawn({ requestId: 'notes-reader', profile: 'reader', files: initial.files });
          signal.throwIfAborted();
          await runInput(runtime, reader.id, JSON.stringify({ task: input.prompt, artifact }),
            { requestId: 'notes-read', timeoutMs: turnTimeoutMs, signal });
          if (!notes.reads.some((read: { agentId: string; key: string; found: boolean }) => read.agentId === reader.id && read.key === key && read.found)) {
            throw projectError('NOTES_HANDOFF_UNCONFIRMED', 'The reader did not retrieve the writer’s note');
          }
          signal.throwIfAborted();
          const stopped = await runtime.stop(reader.id, { timeoutMs: closeTimeoutMs });
          const files = stopped.artifacts.find(path => path.endsWith('/artifacts/files'));
          if (!files || stopped.cleanup !== 'complete') throw projectError('NOTES_EXPORT_PENDING', 'The result export is incomplete');
          const result = await readFile(join(files, artifact), 'utf8');
          if (!result.includes(published.text)) throw projectError('NOTES_HANDOFF_UNVERIFIED', 'The reader’s result omits the published note');
          return { writerId: writer.id, readerId: reader.id, artifact: join(files, artifact), handoffVerified: true };
        },
      });
      return { ...projectResult(report, context), acceptance: { status: 'not-run' } };
    } finally {
      observation?.close();
    }
  },
} satisfies ProjectHarness;

export default notesHarness;

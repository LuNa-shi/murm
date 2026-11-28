import { createRuntime, createSandbox, MurmError, ProjectPreflightError, observeProjectRuntime, projectConfiguration,
  runInput, type CreateRuntimeOptions, type Harness, type SandboxConfig } from '@luna-shi/murm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNotes } from './notes.js';

interface Config extends Pick<CreateRuntimeOptions, 'executor' | 'connection' | 'models' | 'filePolicy'> {
  sandbox: SandboxConfig;
  image: string;
  model?: string;
  turnTimeoutMs?: number;
  closeTimeoutMs?: number;
}

const key = 'project-observation';
export const projectNotesWriterPrompt = 'Read your local project and publish one concrete, task-relevant observation in Notes. Include a relative source path and explain what you found. Publish it with swarm notes put under key project-observation, then finish.';
export const projectNotesFollowupPrompt = 'In this same reader session, read the file you wrote in the preceding turn and copy its exact bytes to the followup filename. Finish when the copy is ready.';
export const projectNotesReaderPrompt = 'Retrieve project-observation with swarm notes get. Compare the observation with the project files, use it to address the task, and write your evidence and results to the specified result file. Include the exact note text so the handoff can be checked.';

export async function defaultConfiguration() {
  const { default: config } = await import('./config.js');
  return typeof config === 'function' ? config() : config;
}

const notesHarness = {
  id: 'notes', apiVersion: 1,
  async run(context) {
    const artifact = `murm-notes-${context.runId}.md`;
    const followup = `murm-notes-followup-${context.runId}.md`;
    const config = await projectConfiguration<Config>(context, async () => ({ default: await defaultConfiguration() }));
    const { image, model = 'default', turnTimeoutMs = 30_000, closeTimeoutMs = 30_000 } = config;
    if (![turnTimeoutMs, closeTimeoutMs].every(ms => Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647) ||
        typeof image !== 'string' || !image) throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Invalid Notes image or time limit');
    let sandbox;
    try { sandbox = createSandbox(config.sandbox); }
    catch { throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Invalid Notes sandbox configuration'); }
    const notes = createNotes();
    const common = { image, model, writable: true };
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    const state: { stage: string; writerId?: string; readerId?: string; handoffObserved?: boolean; artifact?: string } = { stage: 'writer' };
    try {
      const result = await context.runWithRuntime({ closeTimeoutMs,
        async createRuntime() {
          const runtime = await createRuntime({ sandbox, executor: config.executor, models: config.models,
            connection: config.connection, filePolicy: config.filePolicy, services: notes.services, outputDir: context.outputDir, maxAgents: 2,
            profiles: {
              writer: { ...common, prompt: projectNotesWriterPrompt, services: { notes: ['put'] } },
              reader: { ...common, prompt: projectNotesReaderPrompt, services: { notes: ['get'] },
                collect: { paths: [artifact, followup], includeGit: false, maxBytes: 64 * 1024, required: true } },
            } });
          observation = observeProjectRuntime(runtime, context, () => state);
          return runtime;
        },
        async run(runtime: Awaited<ReturnType<typeof createRuntime>>) {
          const { signal, initial, input } = context;
          signal.throwIfAborted();
          const writer = await runtime.spawn({ requestId: 'notes-writer', profile: 'writer', files: initial.files });
          signal.throwIfAborted();
          state.writerId = writer.id;
          context.markRunning();
          await runInput(runtime, writer.id, input.prompt, { requestId: 'notes-write', timeoutMs: turnTimeoutMs, signal });
          const published = notes.records.get(key);
          if (published?.author !== writer.id) throw new MurmError('NOTES_PUBLICATION_UNCONFIRMED', 'The writer did not publish its project observation');
          signal.throwIfAborted();
          state.stage = 'reader';
          state.handoffObserved = true;
          void observation?.refresh();
          const reader = await runtime.spawn({ requestId: 'notes-reader', profile: 'reader', files: initial.files });
          signal.throwIfAborted();
          state.readerId = reader.id;
          await runInput(runtime, reader.id, JSON.stringify({ task: input.prompt, artifact }),
            { requestId: 'notes-read', timeoutMs: turnTimeoutMs, signal });
          if (!notes.reads.some((read: { agentId: string; key: string; found: boolean }) => read.agentId === reader.id && read.key === key && read.found)) {
            throw new MurmError('NOTES_HANDOFF_UNCONFIRMED', 'The reader did not retrieve the writer’s note');
          }
          signal.throwIfAborted();
          state.stage = 'followup';
          void observation?.refresh();
          await runInput(runtime, reader.id, JSON.stringify({ task: input.prompt, instruction: projectNotesFollowupPrompt, artifact, followup }),
            { requestId: 'notes-followup', timeoutMs: turnTimeoutMs, signal });
          signal.throwIfAborted();
          state.stage = 'verification';
          void observation?.refresh();
          const stopped = await runtime.stop(reader.id, { timeoutMs: closeTimeoutMs });
          const files = stopped.artifacts.find(path => path.endsWith('/artifacts/files'));
          if (!files || stopped.cleanup !== 'complete') throw new MurmError('NOTES_EXPORT_PENDING', 'The result export is incomplete');
          const result = await readFile(join(files, artifact));
          const followupResult = await readFile(join(files, followup));
          if (!result.toString('utf8').includes(published.text) || !followupResult.equals(result)) throw new MurmError('NOTES_HANDOFF_UNVERIFIED', 'The exported files do not preserve the note and the reader’s follow-up');
          state.stage = 'verified';
          state.artifact = join(files, artifact);
          void observation?.refresh();
          return { writerId: writer.id, readerId: reader.id, artifact: join(files, artifact), followup: join(files, followup), handoffVerified: true };
        },
      });
      return { ...result, acceptance: { status: 'not-run' } };
    } finally {
      observation?.close();
    }
  },
} satisfies Harness;

export default notesHarness;

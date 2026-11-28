import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime, createSandbox, ProjectPreflightError, runInput, ServiceRegistry, type Harness } from '@luna-shi/murm';
import { createHandoff } from './handoff.js';

type Configuration = typeof import('./config.js').default & { channel?: string };

const firstHarness = {
  id: 'first-harness', apiVersion: 1, questions: true,
  async run(context) {
    const config = (context.configuration ?? (await import('./config.js')).default) as Configuration;
    if (!context.clientCapabilities.questions && !/^[a-z][a-z0-9-]{0,23}$/.test(config.channel ?? '')) {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Set MURM_FIRST_CHANNEL for noninteractive execution');
    }
    const reference = randomBytes(6).toString('hex');
    const handoff = createHandoff();
    const services = new ServiceRegistry();
    services.registerService(handoff.registration);
    const runtime = await createRuntime({
      sandbox: createSandbox(config.sandbox), connection: config.connection, executor: config.executor, models: config.models,
      services, maxAgents: 2, outputDir: context.outputDir,
      profiles: {
        publisher: {
          model: config.model, image: config.image, writable: false, services: { handoff: ['publish'] },
          prompt: 'Read release-data.txt. Publish its reference and one short question asking the user for a release channel. Run swarm service invoke handoff publish --help for arguments. Use the workspace for reading files.',
        },
        writer: {
          model: config.model, image: config.image, services: { handoff: ['take'] }, writable: true,
          prompt: 'Run swarm service invoke handoff take using the exact Bash command supplied in your task. Use the bash tool in your writable workspace. The command reads the reference from the Service and writes delivery.txt with two newline-terminated lines.',
        },
      },
    });
    const turn = { signal: context.signal, timeoutMs: 120_000 };
    let phase = 'publish';
    let writerId: string | undefined;
    let channel: string | undefined;
    let expected: Buffer | undefined;
    let failure: { stage: string; code: string } | undefined;
    let cleanup: Awaited<ReturnType<typeof runtime.close>> | undefined;
    let unobserve: (() => void) | undefined;

    try {
      unobserve = context.registerAgentControls({ runtime });
      context.markRunning();
      const publisher = await runtime.spawn({
        requestId: 'spawn-publisher', profile: 'publisher',
        files: { ...context.initial.files, 'release-data.txt': { encoding: 'utf8', data: `${reference}\n` } },
      });
      await runInput(runtime, publisher.id, [
        context.input.prompt,
        'Read the reference in release-data.txt.',
        'Publish the real reference with --reference=<reference> and --question=<quoted text> or use JSON on stdin.',
        'Use request ID publish-release. Finish when the handoff succeeds.',
      ].join(' '), { ...turn, requestId: 'publisher-turn' });
      const note = handoff.evidence().note;
      if (note?.reference !== reference || note.author !== publisher.id) throw Object.assign(new Error(), { code: 'HANDOFF_NOT_VERIFIED' });

      phase = 'channel';
      const answer = context.clientCapabilities.questions
        ? await context.askUser({ requestId: 'release-channel', kind: 'text', text: note.question, agentId: publisher.id, timeoutMs: 120_000 },
          { id: 'release-handoff', agentId: publisher.id, signal: context.signal })
        : config.channel;
      channel = typeof answer === 'string' ? answer.trim() : undefined;
      if (!channel || !/^[a-z][a-z0-9-]{0,23}$/.test(channel)) throw Object.assign(new Error(), { code: 'INVALID_CHANNEL' });

      phase = 'write';
      const writer = await runtime.spawn({
        requestId: 'spawn-writer', profile: 'writer', files: context.initial.files,
        collect: { paths: ['delivery.txt'], maxBytes: 4096, includeGit: false, required: true },
      });
      writerId = writer.id;
      await runInput(runtime, writer.id, `The user chose channel ${channel}. Run the following exact command with the bash tool in your workspace:
swarm service invoke handoff take --request-id take-release | node -e 'const { reference } = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log("reference=" + reference); console.log("channel=${channel}");' > delivery.txt
Finish when the command succeeds.`, { ...turn, requestId: 'writer-turn' });
      if (handoff.evidence().read?.reader !== writer.id) throw Object.assign(new Error(), { code: 'HANDOFF_NOT_READ' });

      phase = 'verify';
      expected = Buffer.from(`reference=${reference}\nchannel=${channel}\n`);
      const snapshot = await runtime.files.snapshot(writer.id, { requestId: 'verify-delivery', paths: ['delivery.txt'], maxBytes: 4096 });
      const file = snapshot.files['delivery.txt'];
      if (!file || !Buffer.from(file.data, file.encoding).equals(expected)) throw Object.assign(new Error(), { code: 'DELIVERY_BYTES_MISMATCH' });
    } catch (error) {
      failure = { stage: phase, code: (error as { code?: string }).code ?? 'HANDOFF_FAILED' };
    } finally {
      try { cleanup = await runtime.close({ timeoutMs: 60_000 }); }
      finally { unobserve?.(); }
    }

    const directory = cleanup?.agents.find(agent => agent.agentId === writerId)?.artifacts.find(path => path.endsWith('/artifacts/files'));
    const delivery = directory ? join(directory, 'delivery.txt') : undefined;
    const bytes = delivery ? await readFile(delivery).catch(() => undefined) : undefined;
    const verification = delivery && bytes && expected && bytes.equals(expected)
      ? { file: delivery, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } : undefined;
    const { note, read } = handoff.evidence();
    const exportPending = cleanup?.pending?.some(resource => resource.action === 'collect-artifacts');
    return {
      outcome: context.signal.aborted ? 'cancelled' : failure ? 'failed' : 'completed',
      reason: failure?.code ?? (context.signal.aborted ? 'stopped' : 'release-handoff'),
      result: { runtimeId: runtime.id, failure: failure ?? null, handoff: { author: note?.author ?? null,
        publishRequestId: note?.requestId ?? null, read: read ?? null, channel: channel ?? null } },
      acceptance: verification ? { status: 'verified', ...verification } : { status: 'unverified' },
      artifacts: verification ? [{ path: verification.file, sha256: verification.sha256 }] : [],
      ...(writerId ? { export: { status: verification ? 'complete' : exportPending ? 'pending' : 'failed' } } : {}),
      cleanup: { status: cleanup?.cleanup ?? 'pending', pending: cleanup?.pending?.map(({ id, kind, action }) => ({ id, kind, action })) ?? null },
    };
  },
} satisfies Harness;

export default firstHarness;

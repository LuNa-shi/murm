import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createRuntime, createSandbox, ServiceRegistry, type AgentInfo, type CloseReceipt } from '@luna-shi/murm';
import config, { contextWindow } from './config.js';
import { createHandoff } from './handoff.js';
import { createTurnRunner, TurnError } from './turn.js';

async function modelEvidence(reportPath: string) {
  const path = join(dirname(reportPath), 'model-trace');
  const entries = await readdir(path).catch(() => []);
  const attempts = [];
  for (const entry of entries) {
    try {
      const request = JSON.parse(await readFile(join(path, entry, 'request.json'), 'utf8'));
      const result = JSON.parse(await readFile(join(path, entry, 'result.json'), 'utf8'));
      attempts.push({
        agentId: request.agentId, requestId: request.requestId, record: join(path, entry, 'result.json'),
        state: result.state, upstreamStatus: result.upstreamStatus, reason: result.reason,
        inputTokens: result.usage?.inputTokens ?? 'unknown', outputTokens: result.usage?.outputTokens ?? 'unknown',
        contextWindow: contextWindow ?? 'unknown',
      });
    } catch {
      // A partially written or absent trace gives no trusted usage.
    }
  }
  return { attempts };
}

async function main() {
  if (!config.models.default.upstream.url) throw new Error('Set MURM_MODEL_URL before running the Harness.');
  const reference = randomBytes(6).toString('hex');
  const board = createHandoff();
  const services = new ServiceRegistry();
  services.registerService(board.registration);
  const runtime = await createRuntime({
    sandbox: createSandbox(config.sandbox), connection: config.connection, executor: config.executor, models: config.models,
    services, maxAgents: 2, outputDir: './runs',
    profiles: {
      publisher: {
        model: 'default', image: config.image, writable: false, services: { handoff: ['publish'] },
        prompt: 'Read release-data.txt. Publish its reference and one short question asking the user for a release channel. Run swarm service invoke handoff publish --help for arguments. Use the workspace for reading files.',
      },
      writer: {
        model: 'default', image: config.image, services: { handoff: ['take'] }, writable: true,
        prompt: 'Run swarm service invoke handoff take --stdin with input {} and request ID take-release. Read its reference. Use the write tool to create delivery.txt in your workspace with exactly two newline-terminated lines: reference=<reference> and channel=<channel>. The host provides the channel. Do not write into /tmp.',
      },
    },
  });
  console.log(JSON.stringify({ runtimeId: runtime.id, stage: 'start' }));
  const runTurn = createTurnRunner(runtime);
  const cancel = new AbortController();
  const onSignal = () => cancel.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let phase = 'spawn';
  let role = 'publisher';
  let writer: AgentInfo | undefined;
  let publisher: AgentInfo | undefined;
  let channel: string | undefined;
  let expected: Buffer | undefined;
  let failure: object | undefined;
  let cleanup: CloseReceipt | undefined;
  let verification: { bytes: number; sha256: string; file: string } | undefined;
  try {
    publisher = await runtime.spawn({
      requestId: 'spawn-publisher', profile: role,
      files: { 'release-data.txt': { encoding: 'utf8', data: `${reference}\n` } },
    });
    phase = 'publish';
    await runTurn(publisher.id, [
      'Read the reference in release-data.txt.',
      'Optional diagnostic: first attempt to publish with numeric reference 123 and observe the schema rejection, then correct it.',
      'Publish the real reference with --reference=<reference> and --question=<quoted text> or use JSON on stdin.',
      'Use request ID publish-release for the corrected call. Finish when the handoff succeeds.',
    ].join(' '), { requestId: 'publisher-turn', signal: cancel.signal });
    const note = board.evidence().note;
    if (note?.reference !== reference || note.author !== publisher.id) throw Object.assign(new Error(), { code: 'HANDOFF_NOT_VERIFIED' });

    phase = 'operator-reply';
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`Publisher asks: ${note.question}`);
      channel = (await terminal.question('Release channel (lowercase letters, digits, hyphens): ', {
        signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(120_000)]),
      })).trim();
      if (!/^[a-z][a-z0-9-]{0,23}$/.test(channel)) throw Object.assign(new Error(), { code: 'INVALID_CHANNEL' });
    } finally { terminal.close(); }
    role = 'writer';
    phase = 'spawn';
    cancel.signal.throwIfAborted();
    writer = await runtime.spawn({
      requestId: 'spawn-writer', profile: role,
      collect: { paths: ['delivery.txt'], maxBytes: 4096, includeGit: false, required: false },
    });
    phase = 'write';
    await runTurn(writer.id, `The user chose channel ${channel}. Get the reference using handoff take, then create delivery.txt exactly as instructed.`,
      { requestId: 'writer-turn', signal: cancel.signal });
    phase = 'verify';
    if (board.evidence().read?.reader !== writer.id) throw Object.assign(new Error(), { code: 'HANDOFF_NOT_READ' });
    expected = Buffer.from(`reference=${reference}\nchannel=${channel}\n`);
    const snap = await runtime.files.snapshot(writer.id, { requestId: 'verify-delivery', paths: ['delivery.txt'], maxBytes: 4096 });
    const file = snap.files['delivery.txt'];
    if (!file || !Buffer.from(file.data, file.encoding).equals(expected)) throw Object.assign(new Error(), { code: 'DELIVERY_BYTES_MISMATCH' });
  } catch (error) {
    failure = {
      role, stage: error instanceof TurnError ? `${phase}.${error.stage}` : phase,
      code: (error as { code?: string })?.code ?? (cancel.signal.aborted ? 'CANCELLED' : 'HARNESS_FAILED'),
      agentId: role === 'writer' ? writer?.id : publisher?.id,
      requestId: error instanceof TurnError ? error.requestId : ({ spawn: `spawn-${role}`, verify: 'verify-delivery' } as Record<string, string>)[phase],
    };
  } finally {
    try { cleanup = await runtime.close({ timeoutMs: 60_000 }); }
    catch {
      console.error(JSON.stringify({ runtimeId: runtime.id, stage: 'close', code: 'CLOSE_UNCONFIRMED' }));
    }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  if (!failure && cleanup && expected) {
    const directory = cleanup.agents.find(agent => agent.agentId === writer?.id)?.artifacts.find(path => path.endsWith('/artifacts/files'));
    const file = directory ? join(directory, 'delivery.txt') : undefined;
    const bytes = file ? await readFile(file).catch(() => undefined) : undefined;
    if (file && bytes?.equals(expected)) {
      verification = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), file };
    } else {
      failure = { role, stage: 'export', code: 'DELIVERY_EXPORT_UNVERIFIED', agentId: writer?.id };
    }
  }
  const { note, read } = board.evidence();
  console.log(JSON.stringify({
    runtimeId: runtime.id, business: { ok: !failure && !!expected, failure }, verification,
    handoff: { author: note?.author, publishRequestId: note?.requestId, ...read, channel },
    cleanup: { status: cleanup?.cleanup ?? 'unknown', pending: cleanup?.pending, reportPath: cleanup?.reportPath },
    model: cleanup?.reportPath ? await modelEvidence(cleanup.reportPath) : { attempts: [] },
  }, null, 2));
  if (failure || !verification || cleanup?.cleanup !== 'complete') process.exitCode = 1;
}

await main().catch(error => {
  console.error(JSON.stringify({ stage: 'configure', code: error?.code ?? 'HARNESS_CONFIGURATION', message: 'Check the SDK version, connection and model settings.' }));
  process.exitCode = 1;
});

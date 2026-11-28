#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createPiSessionController, PI_SESSION_CAPABILITIES } from './pi-session-controller.js';

// This module is a Guest executable. Core never imports the Pi runtime.
async function loadPi() {
  let entry: string;
  try { entry = import.meta.resolve('@earendil-works/pi-coding-agent'); }
  catch { entry = pathToFileURL('/opt/murm/executor/node_modules/@earendil-works/pi-coding-agent/dist/index.js').href; }
  const sdk: any = await import(entry);
  const packagePath = new URL('../package.json', entry);
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
  if (!['1.3.0', '1.4.0'].includes(metadata.version)) throw new Error('Unsupported Pi SDK bridge version');
  return { sdk, version: metadata.version };
}
const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { sdk, version } = await loadPi();
const args: string[] = options.args ?? [];
const argument = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const configuration = options.configuration ?? {};
const resources = configuration.resources ?? {};
const settingsManager = sdk.SettingsManager.inMemory({ ...configuration, resources: undefined, tools: undefined,
  defaultProvider: argument('--provider'), defaultModel: argument('--model') });
const resourceHashes: any[] = [];
for (const paths of Object.values(resources) as any[]) for (const path of paths) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Guest resources require absolute installed paths');
  const resolved = await realpath(path);
  // Guest executable resources are selected by the Host and must stay outside task content.
  if (resolved === cwd || resolved.startsWith(cwd + '/')) throw new Error('Guest resources cannot be loaded from the task directory');
  const info = await stat(resolved);
  resourceHashes.push({ path: resolved, ...(info.isFile() ? { sha256: createHash('sha256').update(await readFile(resolved)).digest('hex') } : {}) });
}
const systemPrompt = await readFile(argument('--system-prompt') ?? options.systemPromptPath, 'utf8');
for (const path of resources.contextFiles ?? []) {
  const content = await readFile(path, 'utf8');
  (options.contextFiles ??= []).push({ path, content });
}
let controller: ReturnType<typeof createPiSessionController>;
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  systemPrompt, additionalExtensionPaths: resources.extensions ?? [], additionalSkillPaths: resources.skills ?? [],
  additionalPromptTemplatePaths: resources.promptTemplates ?? [],
  agentsFilesOverride: () => ({ agentsFiles: options.contextFiles ?? [] }),
  extensionFactories: [(pi: any) => { pi.on('session_before_compact', (event: any) => controller.beforeCompact(event)); }] });
await loader.reload();
const extensionErrors = loader.getExtensions().errors;
if (extensionErrors?.length) throw new Error('Guest extension loading failed');
if ([...loader.getSkills().diagnostics, ...loader.getPrompts().diagnostics].some((item: any) => item.type === 'error')) throw new Error('Guest resource loading failed');
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false });
const provider = argument('--provider');
const modelId = argument('--model');
const model = provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined;
if (provider && modelId && !model) throw new Error('Selected model is absent from the Guest catalog');
const sessionPath = argument('--session');
const sessionDir = argument('--session-dir') ?? join(dirname(agentDir), 'pi-session');
const sessionManager = sessionPath ? sdk.SessionManager.open(sessionPath, sessionDir, cwd) : sdk.SessionManager.create(cwd, sessionDir);
const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager,
  sessionManager, resourceLoader: loader, thinkingLevel: configuration.thinkingLevel ?? argument('--thinking'),
  ...(configuration.tools !== undefined ? { tools: configuration.tools } : args.includes('--no-tools') ? { tools: [] } : {}) });
if (configuration.tools?.some((name: string) => !session.getAllTools().some((tool: any) => tool.name === name))) throw new Error('Unknown Guest tool');
const emit = (record: any) => {
  const line = JSON.stringify(record) + '\n';
  if (process.stdout.writableLength + Buffer.byteLength(line) > 8 * 1024 * 1024) {
    void session.abort();
    process.exitCode = 1;
    process.stdin.destroy();
    return;
  }
  process.stdout.write(line);
};
let starting = false;
controller = createPiSessionController(session, { emit, version, configuration, beforeCompact: options.beforeCompact, isStarting: () => starting });
session.subscribe((event: any) => emit(controller.observe(event)));
const unsupportedUI = new Proxy({}, { get: () => () => { throw Object.assign(new Error('Guest extension UI is unavailable'), { code: 'OPERATION_UNSUPPORTED' }); } });
await session.bindExtensions({ mode: 'rpc', uiContext: unsupportedUI, onError: (failure: any) => emit({ type: 'extension_error', message: failure.message }) });
emit({ type: 'core_session_ready', version, capabilities: PI_SESSION_CAPABILITIES, resources: resourceHashes });
function success(command: any, data?: any) { emit({ type: 'response', id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) }); }
function failure(command: any, error: any) { emit({ type: 'response', id: command.id, command: command.type, success: false, error: error.message, code: error.code ?? 'EXECUTOR_FAILED' }); }
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function command(message: any) {
  if (message.type.startsWith('core_')) { success(message, await controller.command(message)); return; }
  switch (message.type) {
    case 'prompt': {
      if (controller.fenced) throw Object.assign(new Error('Session is fenced'), { code: 'NOT_ALLOWED' });
      let accepted = false;
      starting = true;
      await controller.beforePrompt();
      void session.prompt(message.message, { streamingBehavior: message.streamingBehavior, source: 'rpc',
        preflightResult: (disposition: string) => { accepted = true; starting = false; success(message, { disposition }); } })
        .catch((error: any) => { starting = false; if (!accepted) failure(message, error); });
      return;
    }
    case 'steer': success(message, { disposition: await session.steer(message.message, undefined, { source: 'rpc' }) }); return;
    case 'follow_up': success(message, { disposition: await session.followUp(message.message, undefined, { source: 'rpc' }) }); return;
    case 'abort': await controller.interrupt(message.executionEpoch); success(message); return;
    case 'clear_queue': success(message, await controller.command({ ...message, type: 'core_session_clear_queue' })); return;
    case 'set_steering_mode': session.setSteeringMode(message.mode); success(message); return;
    case 'set_follow_up_mode': session.setFollowUpMode(message.mode); success(message); return;
    case 'get_state': success(message, { sessionId: session.sessionId, isStreaming: session.isStreaming || starting,
      isCompacting: session.isCompacting, pendingMessageCount: session.pendingMessageCount, thinkingLevel: session.thinkingLevel,
      steeringMode: session.steeringMode, followUpMode: session.followUpMode }); return;
    case 'get_entries': success(message, { entries: sessionManager.getEntries(), leafId: sessionManager.getLeafId() }); return;
    default: throw Object.assign(new Error('Unsupported Guest command'), { code: 'OPERATION_UNSUPPORTED' });
  }
}
input.on('line', line => {
  if (Buffer.byteLength(line) > 1048576) { failure({}, new Error('Guest command exceeds input limit')); return; }
  let message: any;
  try { message = JSON.parse(line); if (!message || typeof message.type !== 'string') throw new Error('Invalid Guest command'); }
  catch (error) { failure({}, error); return; }
  void command(message).catch(error => failure(message, error));
});
let closing = false;
const stop = () => { if (closing) return; closing = true; input.close(); void controller.interrupt().finally(() => { session.dispose(); }); };
input.on('close', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

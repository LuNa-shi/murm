import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Ajv } from 'ajv';
import { Editor, ScrollView, SelectList, TuiAltScreen, matchesKey, truncateToWidth, wrapTextWithAnsi,
  type KeyId, type SelectItem } from '@earendil-works/pi-tui';
import { createRedactor } from '../src/core/run-records.js';
import type { AgentSessionPatch, ContextDelivery, ContextInput } from '../src/core/session-types.js';
import { createHarnessSession, getHarnessExitCode, loadProjectHarness, type Harness, type HarnessAnswer, type HarnessJson,
  type HarnessLifetime, type HarnessOperation, type HarnessQuestion } from '../src/harness/project-harness.js';
import { resolveHarnessInput } from '../src/harness/project-input.js';
import type { TuiCommand } from './murm-arguments.js';
import { builtins } from './murm-harnesses.js';
import { LauncherConfiguration, terminalObject } from './murm-tui-config.js';
import { formatSessionError, TerminalSession } from './murm-tui-session.js';
import { MurmTerminal, terminalText } from './murm-tui-terminal.js';

type Page = 'Run' | 'Agents' | 'Result' | 'Questions';
type Action = { title: string; detail?: string; perform: () => void | Promise<void> };
type Modal = { type: 'menu'; title: string; list: SelectList }
  | { type: 'editor'; key: string; title: string; editor: Editor; limit: number; submit: (text: string) => void | Promise<void> };
type Target = { id: string; title: string; available: boolean };
const pages: readonly Page[] = ['Run', 'Agents', 'Result', 'Questions'];
const inputByteLimit = 262_144;
const pass = (text: string) => text;
const theme = { selectedPrefix: pass, selectedText: pass, description: pass, scrollInfo: pass, noMatch: pass };
const consumed = { consume: true };
const agentOperations: HarnessOperation[] = [
  'getState', 'getStats', 'getMessages', 'send', 'configure', 'compact', 'abortRetry', 'clearQueue', 'interrupt', 'stop',
];
const actions = {
  getState: 'Read Session state', getStats: 'Read Session and context usage', getMessages: 'Read Session messages (including hidden context)',
  send: 'Send to Agent', configure: 'Configure Agent Session', compact: 'Compact context', abortRetry: 'Abort retry',
  clearQueue: 'Clear Agent queue', interrupt: 'Interrupt Agent', stop: 'Stop Agent',
} satisfies Record<HarnessOperation, string>;
const schemaValidator = new Ajv({ strict: false, ownProperties: true });

function routeTargets(entries: unknown, key: string, title: (record: Record<string, unknown>) => string,
  available: (record: Record<string, unknown>) => boolean): Target[] {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 100).flatMap(item => {
    const record = terminalObject(item);
    return typeof record[key] === 'string' ? [{ id: record[key], title: title(record), available: available(record) }] : [];
  });
}

async function readReport(path: string) {
  if (!isAbsolute(path)) throw new Error('Report path is unavailable.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('The report is unavailable.');
    const bytes = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead).toString('utf8') + (bytesRead < stat.size ? '\n[Report preview truncated]' : '');
  } finally { await handle.close(); }
}

class ForegroundScreen extends TuiAltScreen {
  constructor(terminal: MurmTerminal, private readonly renderFailed: () => void) {
    super(terminal, process.env.TERM !== 'dumb', undefined, { mouse: false, copyOnSelect: false });
  }

  protected override doRender() {
    try { super.doRender(); }
    catch { this.renderFailed(); }
  }
}

class Foreground {
  readonly done = Promise.withResolvers<number>();
  readonly terminal: MurmTerminal;
  readonly tui: TuiAltScreen;
  readonly redactor = createRedactor(Object.entries(process.env)
    .filter(([key]) => /(?:TOKEN|PASSWORD|SECRET|API_KEY)$/i.test(key)).map(([, value]) => value));
  private readonly shutdown = new AbortController();
  private readonly requestStop = { requestId: randomUUID(), reason: 'user-stop' };
  private readonly drafts = new Map<string, string>();
  private readonly scrollers = new Map(pages.map(page => [
    page, new ScrollView({ invalidate() {}, render: () => [] }, { follow: page === 'Agents' ? 'end' : 'none' }),
  ]));
  private readonly activityCounts = new Map<Page, number>();
  private readonly launchDirectory: string;
  private launcher?: LauncherConfiguration;
  private definition?: Harness;
  private lifetime: HarnessLifetime = 'task';
  private terminalStarted = false;
  private exitCode?: number;
  private exitAfterStop?: number;
  private stopping = false;
  private starting = false;
  private configurationBusy = true;
  private model?: TerminalSession;
  private latestStatus = 'Loading Harness configuration';
  private log = '';
  private logStream = this.redactor.stream();
  private showLog = false;
  private modal?: Modal;
  private page: Page = 'Run';
  private agentId?: string;
  private questionId?: string;
  private expandedActivity = false;
  private deadlineRefresh?: ReturnType<typeof setInterval>;
  private setupWork?: Promise<void>;

  constructor(private readonly command: TuiCommand, launchDirectory: string) {
    this.launchDirectory = launchDirectory;
    this.terminal = new MurmTerminal(() => this.notice('Paste exceeds 256 KiB and was discarded.'));
    this.tui = new ForegroundScreen(this.terminal, () => this.requestExit(this.model ? 1 : 2, 'terminal-render-failed'));
    if (command.prompt) this.drafts.set('initial', terminalText(command.prompt));
  }

  async open() {
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    const recover = (code: number, reason: string) => this.requestExit(code, reason);
    const signal = (name: NodeJS.Signals) => recover(name === 'SIGINT' ? 130 : name === 'SIGTERM' ? 143 : 1, name);
    const ended = () => recover(1, 'terminal-disconnected');
    process.on('SIGINT', signal);
    process.on('SIGTERM', signal);
    process.on('SIGHUP', signal);
    process.stdin.on('end', ended).on('error', ended).on('close', ended);
    process.stdout.on('error', ended).on('close', ended);
    process.stderr.on('error', ended);
    let restorationError = false;
    try {
      this.tui.setLayoutRoot({
        invalidate() {},
        render: width => {
          try { return this.render(width); }
          catch {
            recover(this.model ? 1 : 2, 'terminal-render-failed');
            return ['Terminal render failed.'];
          }
        },
      });
      this.tui.addInputListener(data => {
        try { this.handle(data); }
        catch (error) { this.notice(formatSessionError(error)); }
        return consumed;
      });
      // Establish raw mode before pi-tui writes any alternate-screen sequence.
      this.terminal.enableRawMode();
      this.terminalStarted = true;
      this.tui.start();
      const divert: typeof process.stdout.write = (chunk: string | Uint8Array, encoding?: BufferEncoding | ((e?: Error | null) => void), callback?: (e?: Error | null) => void) => {
        if (!this.configurationBusy && (this.model || this.launcher)) {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk;
          for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
            this.log = (this.log + this.logStream.write(bytes.subarray(offset, offset + 8192))).slice(-16_384);
          }
          if (this.showLog) this.redraw();
        }
        const completed = typeof encoding === 'function' ? encoding : callback;
        if (completed) queueMicrotask(completed);
        return true;
      };
      process.stdout.write = divert;
      process.stderr.write = divert;
      this.deadlineRefresh = setInterval(() => this.redraw(), 1000);
      this.deadlineRefresh.unref();
      void this.load();
      return await this.done.promise;
    } catch {
      originalErr.call(process.stderr, 'The TUI could not enable terminal mode. Use murm --harness H --prompt "..." for foreground or --mode rpc for JSONL.\n');
      return 2;
    } finally {
      this.shutdown.abort();
      clearInterval(this.deadlineRefresh);
      this.model?.close();
      try { if (this.terminalStarted) this.tui.stop({ preserveScreen: true }); }
      catch { restorationError = true; }
      try { this.terminal.stop(); }
      catch { restorationError = true; }
      if (this.terminalStarted) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([this.terminal.drained(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Terminal restoration could not be confirmed')), 1000);
          })]);
        } catch { restorationError = true; }
        finally { clearTimeout(timer); }
      }
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      if (restorationError && !process.stderr.destroyed) {
        originalErr.call(process.stderr, 'murm: terminal restoration could not be confirmed.\n');
      }
      if (this.setupWork) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([this.setupWork, new Promise<void>(resolve => {
            timer = setTimeout(resolve, 45_000);
          })]);
        } catch { /* The setup command owns reporting and cleanup. */ }
        finally { clearTimeout(timer); }
      }
      process.off('SIGINT', signal);
      process.off('SIGTERM', signal);
      process.off('SIGHUP', signal);
      process.stdin.off('end', ended).off('error', ended).off('close', ended);
      process.stdout.off('error', ended).off('close', ended);
      process.stderr.off('error', ended);
    }
  }

  private async load() {
    try {
      this.definition = await loadProjectHarness(this.launchDirectory, this.command.harness, builtins);
      this.shutdown.signal.throwIfAborted();
      const lifetimes = this.definition.lifetimes ?? ['task'];
      this.lifetime = this.command.lifetime ?? (this.command.harness === 'subagents' && lifetimes.includes('interactive')
        ? 'interactive' : lifetimes.includes('task') ? 'task' : lifetimes[0]);
      if (!lifetimes.includes(this.lifetime)) throw new Error('This Harness does not support the requested lifetime.');
      const launcher = new LauncherConfiguration(this.definition.id, this.command.harness, this.launchDirectory,
        this.command.cwd, this.command.configPath);
      this.launcher = launcher;
      await launcher.refresh();
      this.addSecrets(launcher.configuration);
      if (!this.shutdown.signal.aborted) this.notice(launcher.error ?? 'Ready. F5 edits the initial prompt.');
    } catch (error) {
      if (!this.shutdown.signal.aborted) {
        this.exitCode = 2;
        this.notice(formatSessionError(error));
      }
    } finally {
      this.configurationBusy = false;
      this.redraw();
    }
  }

  private addSecrets(configuration: unknown) {
    const config = terminalObject(configuration);
    const sandbox = terminalObject(config.sandbox);
    const connection = terminalObject(config.connection);
    this.redactor.add([sandbox.apiKey, sandbox.execdToken, connection.apiKey, connection.token,
      ...Object.values(terminalObject(config.models)).flatMap(value =>
        Object.values(terminalObject(terminalObject(terminalObject(value).upstream).headers)))]);
    this.logStream = this.redactor.stream();
  }

  private redraw() { if (this.terminalStarted && !this.shutdown.signal.aborted) this.tui.requestRender(); }
  private notice(message: string) { this.latestStatus = message; this.redraw(); }
  private clean(text: string) { return terminalText(this.redactor.text(text)); }

  private format(value: unknown) {
    const text = typeof value === 'string' ? this.redactor.text(value) : JSON.stringify(this.redactor.value(value), null, 2) ?? 'unknown';
    return terminalText(text.slice(0, 20_000)) + (text.length > 20_000 ? '\n[Preview truncated]' : '');
  }

  private formatReceipt(value: unknown) {
    const receipt = terminalObject(value);
    const nested = terminalObject(receipt.result ?? receipt.core);
    return [receipt.status ?? nested.status, nested.disposition ?? nested.state ?? receipt.disposition,
      receipt.reason ?? nested.reason, nested.inputId ?? receipt.inputId ?? receipt.questionId].filter(value => typeof value === 'string').join(' · ')
      || this.format(value).replace(/\n\s*/g, ' ');
  }

  private requestExit(code: number, reason: string) {
    if (this.shutdown.signal.aborted) return;
    if (this.model && (this.starting || this.model.session.completion) && !this.model.result) {
      this.exitAfterStop ??= code;
      this.stop(reason);
    } else {
      this.shutdown.abort();
      this.done.resolve(code);
    }
  }

  private stop(reason = this.requestStop.reason) {
    if (!this.model || this.stopping || this.model.result) return;
    this.stopping = true;
    this.notice('Stopping Run. Waiting for Harness cleanup.');
    void this.model.session.stop({ ...this.requestStop, reason }).catch(error => this.notice(formatSessionError(error)));
  }

  private async start(prompt: string) {
    const launcher = this.launcher;
    const definition = this.definition;
    if (this.starting || this.model || !launcher || !definition || this.configurationBusy) return;
    if (launcher.error) throw new Error(launcher.error);
    const input = resolveHarnessInput({ cwd: launcher.workspace, prompt }, this.launchDirectory);
    const closeMs = launcher.configuration?.closeTimeoutMs ?? launcher.configuration?.cleanupTimeoutMs;
    const session = createHarnessSession(definition, {
      launchDirectory: this.launchDirectory, configuration: launcher.configuration, outputRoot: this.command.outputRoot,
      lifetime: this.lifetime, clientCapabilities: { questions: this.command.interaction !== 'none' },
      stopTimeoutMs: typeof closeMs === 'number' && Number.isSafeInteger(closeMs) && closeMs > 0
        ? Math.min(2_147_483_647, closeMs + 5_000) : 35_000,
    });
    this.starting = true;
    this.model = new TerminalSession(session, () => this.redraw());
    try {
      await session.start(input, { requestId: randomUUID() });
      this.notice('Run admitted. The Harness is preparing the project.');
      this.drafts.delete('initial');
      void session.completion!.then(result => {
        this.model!.result = result;
        this.exitCode = getHarnessExitCode(session) ?? 1;
        this.switchPage('Result');
        this.notice(result.failure ? result.failure.code + ' ' + result.failure.message : 'Run finished. Ctrl+C or q exits.');
        if (this.exitAfterStop !== undefined) this.requestExit(this.exitAfterStop, 'signal-stop-confirmed');
      }, error => {
        this.exitCode = 1;
          this.notice(formatSessionError(error));
        this.shutdown.abort();
        this.done.resolve(this.exitAfterStop ?? 1);
      });
    } catch (error) {
      this.model.close();
      this.model = undefined;
      this.exitCode = 2;
      if (this.exitAfterStop !== undefined) this.requestExit(this.exitAfterStop, 'start-failed');
      throw error;
    } finally { this.starting = false; }
  }

  private switchPage(page: Page) {
    this.closeModal();
    this.page = page;
    this.redraw();
  }

  private closeModal() {
    if (this.modal?.type === 'editor') {
      const { key, editor } = this.modal;
      const text = editor.getExpandedText();
      if (text) this.drafts.set(key, text);
      else this.drafts.delete(key);
    }
    this.modal = undefined;
  }

  private menu(title: string, items: Action[]) {
    this.closeModal();
    if (!items.length) { this.notice('No targets or operations are currently available.'); return; }
    const list = new SelectList(items.map((item, index): SelectItem => ({
      value: String(index), label: this.clean(item.title), description: item.detail && this.clean(item.detail),
    })), Math.max(2, Math.min(9, this.terminal.rows - 9)), theme);
    list.onSelect = item => {
      this.closeModal();
      this.invoke(items[Number(item.value)].perform);
    };
    this.modal = { type: 'menu', title, list };
    this.redraw();
  }

  private edit(key: string, title: string, submit: (text: string) => void | Promise<void>, options: { value?: string; limit?: number } = {}) {
    this.closeModal();
    if (!this.drafts.has(key) && this.drafts.size >= 160) throw new Error('Draft limit reached.');
    const editor = new Editor(this.tui, { borderColor: pass, selectList: theme }, { paddingX: 1 });
    editor.focused = true;
    editor.disableSubmit = true;
    editor.setText(this.drafts.get(key) ?? options.value ?? '');
    this.modal = { type: 'editor', title, key, editor, limit: options.limit ?? inputByteLimit, submit };
    this.redraw();
  }

  private invoke(action: () => void | Promise<void>) {
    try { void Promise.resolve(action()).catch(error => this.notice(formatSessionError(error))); }
    catch (error) { this.notice(formatSessionError(error)); }
  }

  private configure(action: () => Promise<void>) {
    if (this.configurationBusy) { this.notice('A configuration check is already running.'); return; }
    this.configurationBusy = true;
    const running = action().then(() => {
      this.addSecrets(this.launcher?.configuration);
      this.notice(this.launcher?.error ?? 'Configuration checked.');
    }).finally(() => { this.configurationBusy = false; this.redraw(); });
    this.redraw();
    return running;
  }

  private configurationMenu() {
    const launcher = this.launcher;
    if (!launcher) return;
    this.menu('Configuration', [
      { title: 'Select trusted configuration path', detail: 'Blank uses environment or Harness defaults',
        perform: () => this.edit('config', 'Trusted .js or .mjs path (relative to launch directory)', path =>
          this.configure(() => launcher.select(path)), { value: launcher.path, limit: 4096 }) },
      ...(launcher.legacyCandidate ? [{ title: 'Select legacy config.js', detail: launcher.legacyCandidate,
        perform: () => this.configure(() => launcher.select(launcher.legacyCandidate!)) }] : []),
      { title: 'Retry configuration', perform: () => this.configure(() => launcher.refresh()) },
      { title: 'Remember current configuration for this Harness', perform: () => this.configure(() => launcher.remember()) },
      { title: 'Forget saved launch preference', perform: () => this.configure(() => launcher.forget()) },
      ...(launcher.isBuiltin ? [
        { title: 'Doctor', detail: 'Read-only infrastructure checks', perform: () => this.configure(() =>
          launcher.diagnose(false, this.shutdown.signal, message => this.notice(message))) },
        { title: 'Setup', detail: 'Explicitly prepare Provider and Worker as required', perform: () => this.confirm('Prepare environment with murm setup?', () => {
          const running = this.configure(() => launcher.diagnose(true, this.shutdown.signal, message => this.notice(message)));
          this.setupWork = running;
          return running;
        }) },
      ] : []),
      ...launcher.budgetFields().map(field => ({ title: 'Set ' + field.key + ' (ms)', detail: String(field.value ?? 'unknown'),
        perform: () => this.edit('budget:' + field.key, 'Set ' + field.key + ' (ms)', value =>
          this.configure(() => launcher.setBudget(field, value)), { value: field.value === undefined ? '' : String(field.value), limit: 32 }) })),
    ]);
  }

  private confirm(title: string, perform: Action['perform']) {
    this.menu(title, [{ title: 'Cancel', perform() {} }, { title: 'Confirm', perform }]);
  }

  private async sendRun(key: string, payload: HarnessJson) {
    const model = this.model!;
    const receipt = await model.mutate(key, payload, request => model.session.input(payload, request));
    if (terminalObject(receipt).status === 'accepted') this.drafts.delete(key);
    this.notice(receipt ? this.formatReceipt(receipt) : 'Input already pending.');
  }

  private inputMenu() {
    const model = this.model;
    if (!model) {
      this.edit('initial', 'Initial prompt', prompt => this.start(prompt));
      return;
    }
    const capability = model.state?.capabilities.input;
    if (!capability?.supported || !capability.available || this.stopping || model.result || model.subscribing) {
      this.notice(capability?.reason ?? 'Run input is unavailable.');
      return;
    }
    const detail = terminalObject(terminalObject(model.state?.business).detail);
    if (this.command.harness === 'subagents') {
      this.edit('run:root', 'Run input to Root (steer)', text => this.sendRun('run:root', { text, mode: 'steer' }));
      return;
    }
    if (this.command.harness === 'taskpool' || this.command.harness === 'peermesh') {
      const task = this.command.harness === 'taskpool';
      const targets = task
        ? routeTargets(detail.tasks, 'taskId', item => String(item.taskId) + ' · ' + String(item.state), item => item.state === 'RUNNING')
        : routeTargets(detail.peers, 'key', item => String(item.key), item => item.stopped !== true && !item.unavailable);
      const title = task ? 'Task feedback for the active Execution' : 'Next directed user batch';
      this.menu(title, targets.map(target => ({ title: target.title, detail: target.available ? undefined : 'Unavailable',
        perform: () => {
          if (!target.available) { this.notice('The target is unavailable.'); return; }
          const key = (task ? 'task:' : 'peer:') + target.id;
          this.edit(key, title + ' · ' + target.id, input => this.sendRun(key, task ? { taskId: target.id, input } : { recipient: target.id, input }));
        } })));
      return;
    }
    this.customInput(capability.schema, capability.description ?? 'Harness input');
  }

  private customInput(schema: HarnessJson | undefined, title: string) {
    const description = terminalObject(schema);
    const verify = schema === undefined ? undefined : schemaValidator.compile(schema as object);
    const dispatch = (value: HarnessJson) => {
      if (verify && !verify(value)) throw new Error('Input does not match the Harness schema: ' + schemaValidator.errorsText(verify.errors));
      return this.sendRun('run:custom', value);
    };
    if (description.type === 'string') {
      this.edit('run:custom', title, value => dispatch(value));
      return;
    }
    const properties = Object.entries(terminalObject(description.properties));
    if (description.type === 'object' && properties.length > 0 && properties.length <= 8 &&
        properties.every(([, value]) => terminalObject(value).type === 'string') && Array.isArray(description.required) &&
        properties.every(([field]) => (description.required as unknown[]).includes(field))) {
      const visit = (index: number, data: Record<string, string>) => {
        const [field, property] = properties[index];
        const label = terminalObject(property).description;
        this.edit('input-field:' + field, field + (typeof label === 'string' ? ' · ' + label : ''), value => {
          const next = { ...data, [field]: value };
          if (index < properties.length - 1) visit(index + 1, next);
          else return dispatch(next);
        });
      };
      visit(0, {});
      return;
    }
    this.edit('run:custom', title + ' (JSON payload; schema in Run view)', text => dispatch(JSON.parse(text) as HarnessJson));
  }

  private agentList() {
    const state = this.model?.state;
    const agents = new Map<string, string>();
    for (const raw of Array.isArray(state?.agents) ? state.agents : []) {
      const item = terminalObject(raw);
      const id = item.id ?? item.agentId;
      if (typeof id === 'string') agents.set(id, [item.profile, item.status].filter(Boolean).join(' · '));
    }
    for (const id of Object.keys(state?.capabilities.agents ?? {})) if (!agents.has(id)) agents.set(id, '');
    if (!this.agentId && agents.size) this.agentId = agents.keys().next().value;
    return agents;
  }

  private chooseAgent() {
    this.menu('Select Agent', [...this.agentList()].map(([id, detail]) => ({
      title: id, detail, perform: () => { this.agentId = id; this.switchPage('Agents'); },
    })));
  }

  private agentMenu() {
    const model = this.model;
    const agentId = this.agentId;
    if (!model || !agentId) { this.notice('Select an Agent first.'); return; }
    const capabilities = model.state?.capabilities.agents[agentId] ?? {};
    const agents = model.session.agents;
    const perform = (operation: HarnessOperation) => {
      const capability = model.state?.capabilities.agents[agentId]?.[operation];
      if (!capability?.supported || !capability.available || model.subscribing || this.stopping) {
        this.notice(capability?.reason ?? 'OPERATION_UNAVAILABLE');
        return;
      }
      const key = 'agent:' + agentId + ':' + operation;
      const dispatch = async (payload: unknown, send: Parameters<TerminalSession['mutate']>[2]) => {
        const result = await model.mutate(key, payload, send);
        this.notice(result ? this.formatReceipt(result) : 'Operation already pending.');
      };
      switch (operation) {
        case 'getState': return model.read(key, () => agents.getState(agentId));
        case 'getStats': return model.read(key, () => agents.getStats(agentId));
        case 'getMessages': return model.read(key, () => agents.getMessages(agentId, { limit: 32, maxBytes: 64 * 1024 }));
        case 'send': {
          const choices: Action[] = [];
          for (const value of capability.text ? capability.modes ?? [] : []) {
            if (value !== 'steer' && value !== 'followUp') continue;
            choices.push({ title: 'Agent text · ' + value, perform: () => this.edit(key + ':' + value, 'Agent text · ' + agentId + ' · ' + value, text =>
              dispatch({ text, mode: value }, request => agents.send(agentId, text, { ...request, mode: value }))) });
          }
          for (const value of capability.context ? capability.deliveries ?? [] : []) {
            if (!['append', 'nextTurn', 'steer', 'followUp'].includes(value)) continue;
            const delivery = value as ContextDelivery;
            for (const display of [true, false]) choices.push({
              title: 'Context · ' + value + (display ? ' · visible' : ' · hidden'),
              perform: () => this.edit(key + ':context:' + value + ':' + display, 'Structured context · ' + agentId + ' · ' + value, content => {
                const input: ContextInput = { type: 'context', customType: 'murm:user-context', content, display };
                return dispatch({ input, delivery }, request => agents.send(agentId, input, { ...request, delivery }));
              }),
            });
          }
          return this.menu('Send to ' + agentId, choices);
        }
        case 'configure': {
          const patches: Record<string, Record<string, AgentSessionPatch>> = {
            thinkingLevel: Object.fromEntries((['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const).map(thinkingLevel =>
              [thinkingLevel, { thinkingLevel }])),
            'compaction.enabled': { on: { compaction: { enabled: true } }, off: { compaction: { enabled: false } } },
            'retry.enabled': { on: { retry: { enabled: true } }, off: { retry: { enabled: false } } },
            steeringMode: { all: { steeringMode: 'all' }, 'one-at-a-time': { steeringMode: 'one-at-a-time' } },
            followUpMode: { all: { followUpMode: 'all' }, 'one-at-a-time': { followUpMode: 'one-at-a-time' } },
          };
          return this.menu('Configure ' + agentId, (capability.fields ?? []).filter(field => Object.hasOwn(patches, field))
            .map(field => ({ title: field, perform: () => this.menu(field, Object.entries(patches[field]).map(([title, patch]) =>
              ({ title, perform: () => dispatch(patch, request => agents.configure(agentId, patch, request)) }))) })));
        }
        case 'compact': return this.edit(key, 'Compact ' + agentId + ' · Optional instructions', value =>
          this.confirm('Compact Agent context?', () => dispatch(value, request => agents.compact(agentId,
            { ...request, ...(value ? { customInstructions: value } : {}) }))));
        default: return this.confirm(actions[operation] + ' · ' + agentId + '?', () =>
          dispatch(null, request => agents[operation](agentId, request)));
      }
    };
    this.menu('Agent controls · ' + agentId, agentOperations.map(operation => ({
      title: actions[operation], detail: capabilities[operation]?.available ? undefined :
        capabilities[operation]?.reason ?? 'Unsupported',
      perform: () => perform(operation),
    })));
  }

  private questionMenu() {
    this.menu('Select question', [...(this.model?.questions.values() ?? [])].map(question => ({
      title: '[' + question.status + '] ' + question.text, detail: question.agentId,
      perform: () => { this.questionId = question.questionId; this.switchPage('Questions'); this.answer(question); },
    })));
  }

  private answer(question: HarnessQuestion) {
    const model = this.model!;
    const key = 'question:' + question.questionId;
    if (question.status !== 'pending' || model.subscribing) { this.notice('This question is no longer actionable.'); return; }
    const respond = async (answer: HarnessAnswer) => {
      const current = model.questions.get(question.questionId);
      if (!current || current.status !== 'pending' || Date.parse(current.deadline) <= Date.now()) {
        throw new Error('The question was cancelled, expired or already answered.');
      }
      if (typeof answer === 'string' && current.maxAnswerBytes !== undefined &&
          Buffer.byteLength(JSON.stringify(answer)) > current.maxAnswerBytes) {
        throw new Error('Answer exceeds the question’s JSON byte limit.');
      }
      const receipt = await model.mutate(key, answer, request => model.session.respond(question.questionId, answer, request));
      if (terminalObject(receipt).status === 'answered') this.drafts.delete(key);
      this.notice(receipt ? this.formatReceipt(receipt) : 'Answer already pending.');
    };
    if (question.kind === 'confirm') return this.menu(question.text, [
      { title: 'Yes', perform: () => respond(true) }, { title: 'No', perform: () => respond(false) },
    ]);
    if (question.kind === 'choice') return this.menu(question.text, (question.options ?? []).map(option =>
      ({ title: option.label, detail: option.id, perform: () => respond(option.id) })));
    this.edit(key, question.text + ' · ' + (question.maxAnswerBytes ?? 'unknown') + ' JSON bytes', respond);
  }

  private handle(data: string) {
    if (this.shutdown.signal.aborted) return;
    const key = (value: KeyId) => matchesKey(data, value);
    if (key('ctrl+c')) {
      if (this.model && !this.model.result) this.stop();
      else this.requestExit(this.exitCode ?? 0, 'terminal-exit');
      return;
    }
    const tab = (['f1', 'f2', 'f3', 'f4'] as const).findIndex(key);
    if (tab >= 0) { this.switchPage(pages[tab]); return; }
    if (key('f5')) { this.inputMenu(); return; }
    if (key('f6')) {
      if (!this.model) this.configurationMenu();
      else if (this.page === 'Questions') this.questionMenu();
      else if (this.page === 'Agents') this.chooseAgent();
      return;
    }
    if (key('f7')) {
      if (this.page === 'Agents') this.agentMenu();
      else if (this.page === 'Run' && this.command.harness === 'subagents' && this.model?.state?.capabilities.input.available) {
        this.edit('run:root', 'Run input to Root (followUp)', text => this.sendRun('run:root', { text, mode: 'followUp' }));
      } else if (this.page === 'Result' && this.model?.result?.reportPath) {
        const path = this.model.result.reportPath;
        this.invoke(() => this.model!.read('report', () => readReport(path)));
      }
      return;
    }
    if (key('f8')) {
      if (this.model && !this.model.result) this.confirm('Stop the whole Run?', () => this.stop());
      return;
    }
    if (key('f9')) {
      this.menu('Reconcile unknown operation', [...(this.model?.operations ?? [])].filter(([, entry]) => entry.status === 'unknown')
        .map(([id, entry]) => ({ title: id, detail: entry.request.requestId,
          perform: async () => { const result = await this.model!.retry(id); this.notice(this.formatReceipt(result)); } })));
      return;
    }
    if (key('f10')) { this.showLog = !this.showLog; this.redraw(); return; }
    if (key('escape')) {
      if (this.modal) this.closeModal();
      else this.showLog = false;
      this.redraw();
      return;
    }
    if (key('pageUp') || key('pageDown')) {
      const scroll = this.scrollers.get(this.page)!;
      scroll.scrollBy((key('pageUp') ? -1 : 1) * Math.max(1, scroll.viewportHeight - 2));
      return;
    }
    if (this.modal?.type === 'menu') {
      this.modal.list.handleInput(data);
      this.redraw();
      return;
    }
    if (this.modal?.type === 'editor') {
      const { editor, limit, submit } = this.modal;
      if (key('enter')) {
        const value = editor.getExpandedText();
        if (Buffer.byteLength(value) > limit) { this.notice('Draft exceeds ' + limit + ' UTF-8 bytes.'); return; }
        this.closeModal();
        this.invoke(() => submit(value));
      } else if (key('alt+enter') || key('ctrl+j')) {
        editor.insertTextAtCursor('\n');
      } else {
        const previous = editor.getExpandedText();
        editor.handleInput(data);
        if (Buffer.byteLength(editor.getExpandedText()) > limit) {
          editor.setText(previous);
          this.notice('Draft limit is ' + limit + ' UTF-8 bytes. Input was discarded.');
        }
      }
      this.redraw();
      return;
    }
    if (key('q')) {
      if (!this.model || this.model.result) this.requestExit(this.exitCode ?? 0, 'terminal-exit');
      else this.confirm('Stop the whole Run and exit?', () => this.requestExit(1, 'terminal-exit'));
    } else if (key('end')) {
      this.scrollers.get(this.page)!.scrollToEnd();
    } else if (key('enter')) {
      if (this.page === 'Run') this.inputMenu();
      if (this.page === 'Agents') this.chooseAgent();
      if (this.page === 'Questions') this.questionMenu();
    } else if (key('t') && this.page === 'Agents') {
      this.expandedActivity = !this.expandedActivity;
      this.redraw();
    }
  }

  private overview() {
    const launcher = this.launcher;
    const model = this.model;
    const state = model?.state;
    return [
      'Workspace  ' + (launcher?.workspace ?? this.command.cwd ?? this.launchDirectory),
      'Harness    ' + (this.definition?.id ?? this.command.harness) + ' · ' + this.lifetime,
      'Config     ' + (launcher?.source ?? 'loading') + (launcher?.path ? ' · ' + launcher.path : ''),
      ...(!model && launcher?.preference ? ['Saved      ' + launcher.preference.harness + ' · ' + launcher.preference.configPath] : []),
      ...(!model && launcher?.preferenceError ? [launcher.preferenceError] : []),
      ...(!model && launcher?.legacyCandidate ? ['Legacy project configuration available in F6. Editable host: node ./main.js ./config.js --interactive'] : []),
      ...(model ? [
        'Run        ' + (state?.runId ?? model.result?.runId ?? 'admitting') + ' · ' + (state?.phase ?? 'starting'),
        'Deadline   ' + this.deadline(terminalObject(terminalObject(state?.business).detail).deadlineAt ??
          terminalObject(terminalObject(terminalObject(state?.business).detail).project).deadlineAt),
        'Agents     ' + this.agentList().size,
        ...[...model.operations].slice(-12).map(([key, entry]) =>
          key + ' · ' + entry.status + ' · ' + this.formatReceipt(entry.receipt)),
        state?.capabilities.input.description ?? '',
        ...(this.command.harness !== 'subagents' && state?.capabilities.input.schema ? [this.format(state.capabilities.input.schema)] : []),
        this.format(state?.business),
      ] : [
        ...(launcher?.error ? [launcher.error] : []),
        'Initial prompt  ' + (this.drafts.get('initial') ?? '(F5 or Enter to edit)'),
        this.format(launcher?.details()),
        ...((launcher?.diagnostics?.checks ?? []).map(check =>
          (check.ok ? 'PASS ' : 'FAIL ') + check.id + ' · ' + check.detail + (check.remedy ? ' · ' + check.remedy : ''))),
      ]),
    ];
  }

  private deadline(value: unknown) {
    const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(time) || Math.abs(time) > 8.64e15) return 'unknown';
    return new Date(time).toISOString() + ' · ' + Math.max(0, Math.ceil((time - Date.now()) / 1000)) + ' s remaining';
  }

  private agentDetails() {
    const model = this.model;
    if (!model) return ['No Run yet.'];
    const agents = this.agentList();
    const id = this.agentId;
    return [
      'Selected Agent  ' + (id ?? 'none') + ' · F6 select · F7 controls · t expand tools',
      ...[...agents].slice(0, 65).map(([agent, state]) => (agent === id ? '› ' : '  ') + agent + ' ' + state),
      this.format(model.state?.business),
      ...[...model.observations].filter(([key]) => id && key.startsWith('agent:' + id + ':')).flatMap(([key, value]) =>
        [key.slice(key.lastIndexOf(':') + 1), value.pending ? 'Reading…' : value.error ?? this.format(value.result)]),
      ...[...model.activity.values()].filter(event => event.agentId === id || !event.agentId).slice(-25).flatMap(event =>
        [event.event + ' ' + String(terminalObject(event.detail).toolName ?? '') +
          (this.expandedActivity ? '\n' + this.format(event.detail) : '')]),
      ...[...model.messages.values()].filter(message => message.agentId === id && !message.hidden && message.blocks.size > 0)
        .flatMap(message => [message.role + ' · ' + message.id + (message.complete ? '' : ' · streaming'),
          [...message.blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join('') + (message.truncated ? ' […]' : '')]),
    ];
  }

  private questions() {
    const questions = [...(this.model?.questions.values() ?? [])];
    return ['F6 or Enter selects a question.',
      ...questions.map(question => (this.questionId === question.questionId ? '› ' : '') + '[' + question.status + '] ' +
        question.kind + ' · ' + question.text + '\n' + 'Source ' + (question.agentId ?? question.sourceId) +
        ' · ' + question.questionId + ' · ' + this.deadline(question.deadline) +
        (question.businessRef ? '\n' + this.format(question.businessRef) : '') + (question.reason ? '\n' + question.reason : ''))];
  }

  private results() {
    const result = this.model?.result;
    if (!result) return ['No final result yet.'];
    const report = this.model!.observations.get('report');
    return [
      'Outcome     ' + result.outcome + ' · ' + result.reason,
      'Acceptance  ' + this.format(result.acceptance ?? 'unknown'),
      'Export      ' + this.format(result.export ?? 'unknown'),
      'Artifacts   ' + this.format(result.artifacts),
      'Cleanup     ' + result.cleanup.status,
      'Pending     ' + this.format(result.cleanup.pending ?? terminalObject(result.cleanup.receipt).pending ?? 'unknown'),
      'Retained    ' + this.format(result.cleanup.retained ?? 'unknown'),
      'Report save ' + (result.reportSaveFailure ? this.format(result.reportSaveFailure) : result.reportPath ? 'saved' : 'unknown'),
      ...(result.reportPath ? ['Report path ' + result.reportPath + ' · F7 reads preview'] : []),
      ...(result.failure ? ['Failure     ' + this.format(result.failure)] : []),
      ...(result.cleanup.status === 'pending' ? ['Cleanup is unconfirmed. Use the report to locate resources and their original owner.'] : []),
      'Unconfirmed operations  ' + this.format(result.operations?.filter(entry => entry.status === 'pending' || entry.status === 'unknown') ?? []),
      ...(report ? ['Report preview', report.pending ? 'Reading…' : report.error ?? this.format(report.result)] : []),
    ];
  }

  private render(width: number) {
    const rows = Math.min(this.terminal.rows, 200);
    if (width < 8 || rows < 4) return ['murm'];
    const model = this.model;
    const warnings = [
      ...(model?.subscribing ? ['Observation stale · re-subscribing'] : []),
      ...(model?.observationLost && !model.subscribing ? ['Observation resumed from a bounded snapshot'] : []),
      ...(model?.runtimeObservationLost ? ['Runtime observation has a gap'] : []),
      ...(model?.workerHistoryLost ? ['Worker history has a gap'] : []),
      ...(model?.truncated ? ['History preview truncated · use Agent queries'] : []),
    ];
    const header = ['murm  ' + (model?.state?.phase ?? 'Launch'),
      pages.map((page, index) => 'F' + (index + 1) + ' ' + (this.page === page ? '[' + page + ']' : page)).join('  ')];
    const modal = this.modal;
    const footer = [this.latestStatus.split('\n', 1)[0],
      modal?.type === 'editor' ? 'Enter submit · Alt+Enter newline · Esc keep draft' :
        model ? 'F5 input · F6 select · F7 actions · F8 stop · F9 retry · PgUp/PgDn' :
          'F5 prompt · F6 configuration · Ctrl+C quit · PgUp/PgDn'];
    const body = this.showLog ? ['Diagnostics · F10 closes', this.log || 'No captured diagnostics'] : this.page === 'Run' ? this.overview() : this.page === 'Agents' ? this.agentDetails() :
      this.page === 'Questions' ? this.questions() : this.results();
    const overlay = modal ? [this.clean(modal.title.replace(/\s+/g, ' ')).slice(0, 512), ...(modal.type === 'editor' ?
      modal.editor.render(width) : modal.list.render(width))] : [];
    const overlayRows = Math.min(rows - 4, overlay.length);
    const statusLines = warnings.length ? [warnings.join(' · ')] : [];
    const bodyRows = Math.max(0, rows - header.length - footer.length - overlayRows - statusLines.length);
    const text = body.filter(Boolean).join('\n');
    const bounded = text.length <= 100_000 ? text : this.page === 'Agents'
      ? text.slice(0, 2000) + '\n[Earlier history truncated]\n' + text.slice(-98_000) : text.slice(0, 100_000);
    const wrapped = wrapTextWithAnsi(this.clean(bounded), Math.max(1, width - 1));
    const scroller = this.scrollers.get(this.page)!;
    scroller.updateLayout(wrapped.length, bodyRows, () => this.redraw());
    if (this.page === 'Agents' && scroller.isFollowingEnd) {
      this.activityCounts.set(this.page, model?.revision ?? 0);
    } else if (this.page === 'Agents' && (this.activityCounts.get(this.page) ?? 0) < (model?.revision ?? 0)) {
      statusLines[0] = 'New Agent activity · End follows latest';
    }
    const start = scroller.scrollTop;
    const sanitized = (lines: string[]) => lines.map(line => truncateToWidth(this.clean(line), width, ''));
    return [...sanitized(header), ...wrapped.slice(start, start + bodyRows), ...sanitized(statusLines),
      ...overlay.slice(0, overlayRows), ...sanitized(footer)].slice(0, rows);
  }
}

export async function runMurmTui(command: TuiCommand, launchDirectory: string) {
  return new Foreground(command, launchDirectory).open();
}

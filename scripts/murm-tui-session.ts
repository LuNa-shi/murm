import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { HarnessEvent, HarnessQuestion, HarnessRequest, HarnessResult, HarnessSession, HarnessState } from '../src/harness/project-harness.js';
import { terminalObject } from './murm-tui-config.js';

const messageLimit = 96;
const activityLimit = 100;
const contentLimit = 16_384;
const maxPending = 64;
const readTimeoutMs = 8_000;

type Message = {
  agentId: string;
  id: string;
  role: string;
  blocks: Map<number, string>;
  hidden: boolean;
  complete: boolean;
  truncated: boolean;
};

type Activity = { agentId: string; event: string; detail?: unknown };
type Mutation = {
  payload: unknown;
  request: HarnessRequest;
  send: (request: HarnessRequest) => Promise<unknown>;
  status: 'pending' | 'unknown' | 'confirmed' | 'failed';
  receipt?: unknown;
};

export function formatSessionError(error: unknown) {
  const { code, message } = terminalObject(error);
  const detail = typeof message === 'string' ? message.slice(0, 1024) : 'The request failed.';
  return typeof code === 'string' ? code + ' ' + detail : detail;
}

function boundedMap<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value!);
}

function messageText(message: Record<string, unknown>) {
  if (typeof message.content === 'string') return message.content.slice(0, contentLimit);
  if (!Array.isArray(message.content)) return '';
  let text = '';
  for (const part of message.content.slice(0, 64)) {
    const { type, text: block, name } = terminalObject(part);
    if (type === 'text' && typeof block === 'string') text += block;
    if (type === 'toolCall' && typeof name === 'string') text += '\nTool ' + name;
    if (text.length >= contentLimit) break;
  }
  return text.slice(0, contentLimit);
}

function receiptUnknown(value: unknown) {
  const result = terminalObject(value);
  return result.status === 'unknown' || terminalObject(result.core).status === 'unknown' ||
    terminalObject(result.harnessEffects).status === 'unknown';
}

export class TerminalSession {
  state?: HarnessState;
  revision = 0;
  result?: HarnessResult;
  readonly questions = new Map<string, HarnessQuestion>();
  readonly messages = new Map<string, Message>();
  readonly activity = new Map<string, Activity>();
  readonly operations = new Map<string, Mutation>();
  readonly observations = new Map<string, { pending: boolean; result?: unknown; error?: string }>();
  subscribing = true;
  observationLost = false;
  workerHistoryLost = false;
  runtimeObservationLost = false;
  truncated = false;
  lastError?: string;
  private unsubscribe?: () => void;
  private resubscribe?: ReturnType<typeof setTimeout>;
  private closed = false;
  private anonymousActivity = 0;
  private reading = 0;

  constructor(readonly session: HarnessSession, private readonly update: () => void) {
    this.subscribe();
  }

  close() {
    this.closed = true;
    clearTimeout(this.resubscribe);
    this.unsubscribe?.();
  }

  private subscribe() {
    this.unsubscribe = this.session.onEvent(event => {
      try { this.consume(event); }
      catch (error) { this.subscriptionFailed(error); }
      this.update();
    }, { initialSnapshot: true, onError: error => this.subscriptionFailed(error) });
  }

  private subscriptionFailed(error: unknown) {
    if (this.closed) return;
    this.subscribing = true;
    this.observationLost = true;
    this.lastError = formatSessionError(error);
    this.update();
    if (this.resubscribe) return;
    this.resubscribe = setTimeout(() => {
      this.resubscribe = undefined;
      this.unsubscribe?.();
      try { this.subscribe(); }
      catch (error) { this.subscriptionFailed(error); }
    }, 250);
    this.resubscribe.unref();
  }

  consume(event: HarnessEvent) {
    switch (event.type) {
      case 'snapshot':
      case 'state':
        this.state = event.state;
        this.truncated ||= event.state.snapshotTruncated === true;
        if (event.type === 'snapshot') {
          this.subscribing = false;
          this.messages.clear();
          this.questions.clear();
          for (const message of event.state.output) this.restoreMessage(message);
        }
        for (const question of event.state.questions) boundedMap(this.questions, question.questionId, question, 96);
        if (event.state.result) this.result = event.state.result;
        break;
      case 'question':
        boundedMap(this.questions, event.question.questionId, event.question, 96);
        break;
      case 'result':
        this.result = event.result;
        for (const question of event.result.questions ?? []) boundedMap(this.questions, question.questionId, question, 96);
        break;
      case 'event':
        this.revision++;
        this.observe(event.event);
        break;
      case 'operation':
        for (const operation of this.operations.values()) {
          if (operation.request.requestId === event.requestId && operation.status !== 'pending') {
            operation.receipt = event.result;
            operation.status = receiptUnknown(event.result) ? 'unknown' : 'confirmed';
          }
        }
        break;
    }
  }

  private restoreMessage(value: unknown) {
    const record = terminalObject(value);
    if (typeof record.messageId !== 'string' || typeof record.agentId !== 'string') return;
    const message = this.message(record.agentId, record.messageId);
    if (record.complete) this.finishMessage(message, record.message);
    else if (Array.isArray(record.blocks)) {
      for (const entry of record.blocks.slice(0, 64)) {
        if (Array.isArray(entry) && Number.isSafeInteger(entry[0]) && typeof entry[1] === 'string') {
          message.blocks.set(entry[0], entry[1].slice(-contentLimit));
        }
      }
    } else if (typeof record.text === 'string') message.blocks.set(0, record.text.slice(-contentLimit));
    message.truncated ||= record.truncated === true;
  }

  private message(agentId: string, id: string) {
    const key = JSON.stringify([agentId, id]);
    let current = this.messages.get(key);
    if (!current) {
      if (this.messages.size >= messageLimit) this.truncated = true;
      current = { agentId, id, role: 'assistant', blocks: new Map(), hidden: false, complete: false, truncated: false };
      boundedMap(this.messages, key, current, messageLimit);
    }
    return current;
  }

  private finishMessage(message: Message, raw: unknown) {
    const final = terminalObject(raw);
    message.complete = true;
    message.hidden = final.display === false;
    message.role = typeof final.role === 'string' ? final.role : message.role;
    if (final.truncated === true) {
      message.truncated = true;
      return;
    }
    message.blocks.clear();
    if (!message.hidden) message.blocks.set(0, messageText(final));
  }

  private observe(raw: unknown) {
    const item = terminalObject(raw);
    const event = item.kind === 'agent' ? terminalObject(item.event) : item;
    const agentId = typeof event.agentId === 'string' ? event.agentId : '';
    const eventName = String(event.type ?? item.kind ?? 'event');
    if (event.type === 'subscriberGap') this.runtimeObservationLost = true;
    if (event.type === 'error' &&
        /worker event history has a gap/i.test(String(terminalObject(event.error).message))) this.workerHistoryLost = true;
    if (event.type !== 'session') {
      if (!['output', 'workerProbe'].includes(eventName)) this.rememberActivity(agentId, eventName, event);
      return;
    }
    const session = terminalObject(event.event);
    const name = String(session.type ?? 'event');
    if (typeof session.messageId === 'string') {
      const message = this.message(agentId, session.messageId);
      if (name === 'messageStart' && typeof session.role === 'string') message.role = session.role;
      if (name === 'messageEnd') this.finishMessage(message, session.message);
      if (name === 'textDelta' && !message.complete && typeof session.delta === 'string') {
        const index = Number.isSafeInteger(session.blockIndex) ? Number(session.blockIndex) : 0;
        const text = (message.blocks.get(index) ?? '') + session.delta;
        message.truncated ||= text.length > contentLimit || message.blocks.size >= 64;
        boundedMap(message.blocks, index, text.slice(-contentLimit), 64);
      }
      return;
    }
    this.rememberActivity(agentId, name, session);
  }

  private rememberActivity(agentId: string, event: string, detail: Record<string, unknown>) {
    const toolKey = typeof detail.toolCallId === 'string' ? JSON.stringify([agentId, detail.toolCallId]) : undefined;
    let summary: unknown;
    try {
      const data = JSON.stringify(detail);
      summary = data.length > 4096 ? data.slice(0, 4096) + ' […]' : detail;
    } catch { summary = 'unavailable'; }
    boundedMap(this.activity, toolKey ?? String(this.anonymousActivity++), { agentId, event, detail: summary }, activityLimit);
  }

  async mutate(key: string, payload: unknown, send: (request: HarnessRequest) => Promise<unknown>) {
    const previous = this.operations.get(key);
    if (previous?.status === 'pending') return;
    const retry = previous?.status === 'unknown' && isDeepStrictEqual(previous.payload, payload);
    const preservePrevious = !retry && previous?.status === 'unknown';
    if ((!this.operations.has(key) || preservePrevious) && this.operations.size >= maxPending) {
      const settled = [...this.operations].find(([, item]) => item.status === 'confirmed' || item.status === 'failed');
      if (!settled) throw new Error('Operation limit reached. Resolve an unknown operation before sending more.');
      this.operations.delete(settled[0]);
    }
    if (preservePrevious) this.operations.set(key + ':' + previous.request.requestId, previous);
    const operation: Mutation = retry ? previous : { payload, request: { requestId: randomUUID() }, send, status: 'pending' };
    operation.status = 'pending';
    this.operations.set(key, operation);
    this.update();
    try {
      const receipt = await operation.send(operation.request);
      operation.receipt = receipt;
      operation.status = receiptUnknown(receipt) ? 'unknown' : 'confirmed';
      return receipt;
    } catch (error) {
      const { code } = terminalObject(error);
      operation.status = ['RPC_TIMEOUT', 'RPC_DISCONNECTED', 'OPERATION_UNKNOWN'].includes(String(code)) ? 'unknown' : 'failed';
      operation.receipt = formatSessionError(error);
      throw error;
    } finally { if (!this.closed) this.update(); }
  }

  retry(key: string) {
    const operation = this.operations.get(key);
    if (operation?.status !== 'unknown') return;
    return this.mutate(key, operation.payload, operation.send);
  }

  async read(key: string, query: () => Promise<unknown>) {
    if (this.observations.get(key)?.pending || this.reading >= 4) return;
    this.reading++;
    boundedMap(this.observations, key, { pending: true }, 20);
    this.update();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = Promise.resolve().then(query);
    void running.finally(() => { this.reading--; }).catch(() => {});
    try {
      const result = await Promise.race([running, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Read timed out')), readTimeoutMs);
      })]);
      boundedMap(this.observations, key, { pending: false, result }, 20);
    } catch (error) {
      boundedMap(this.observations, key, { pending: false, error: formatSessionError(error) }, 20);
    } finally {
      clearTimeout(timer);
      if (!this.closed) this.update();
    }
  }
}

import { randomUUID } from 'node:crypto';

interface DriverOptions {
  model: string;
  cwd: string;
  systemPrompt: string;
  write(message: Record<string, unknown>): void;
  publish(record: Record<string, unknown>): void;
  isInputFenced?(): boolean;
}

interface Input {
  type: string;
  id?: string;
  message?: string;
  streamingBehavior?: string;
  steeringMode?: string;
  onlyWhileActive?: boolean;
}

// The Worker owns process isolation and durable command identities. This adapter
// owns one App Server connection and its single persistent native thread.
export function createCodexAppServerDriver(options: DriverOptions) {
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const completionWaiters = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const completedTurns = new Set<string>();
  const followUps: Input[] = [];
  let threadId: string;
  let activeTurn: string | undefined;
  let executing = false;
  let interrupting = false;
  let closed = false;
  let output = '';
  const commands: (() => Promise<void>)[] = [];
  let processingCommands = false;

  const uncertain = (error: Error) => Object.assign(error, { code: 'OPERATION_UNKNOWN' });

  function request(method: string, params: unknown): Promise<any> {
    if (closed) return Promise.reject(uncertain(new Error('Codex App Server connection is closed')));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(uncertain(new Error(`Codex ${method} acknowledgement timed out`)));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      try { options.write({ id, method, params }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(uncertain(error as Error)); }
    });
  }

  const ready = (async () => {
    await request('initialize', { clientInfo: { name: 'murm', version: '0.2.0' },
      capabilities: { experimentalApi: false, requestAttestation: false } });
    options.write({ method: 'initialized', params: {} });
    const result = await request('thread/start', { model: options.model, modelProvider: 'murm', cwd: options.cwd,
      approvalPolicy: 'never', sandbox: 'danger-full-access', baseInstructions: options.systemPrompt,
      config: { web_search: 'disabled', 'agents.enabled': false, 'features.multi_agent': false,
        'features.multi_agent_v2': false, 'features.apps': false, 'features.plugins': false,
        'features.remote_plugin': false, 'features.goals': false } });
    if (typeof result?.thread?.id !== 'string' || !result.thread.id) throw new Error('Codex did not return a thread identity');
    threadId = result.thread.id;
    return { threadId };
  })();
  // The caller awaits ready. Attach a handler immediately for process failures
  // that can precede that await during Worker startup.
  void ready.catch(() => {});

  function respond(message: Input, data: unknown = {}, error?: Error & { code?: string }) {
    options.publish({ type: 'response', id: message.id, command: message.type, success: !error,
      ...(error ? { error: error.message, code: error.code ?? 'NOT_ALLOWED' } : { data }) });
  }

  function startExecution() {
    if (executing) return;
    executing = true;
    output = '';
    options.publish({ type: 'agent_start' });
  }

  async function startTurn(message: Input) {
    const result = await request('turn/start', { threadId, input: [{ type: 'text', text: message.message, text_elements: [] }],
      clientUserMessageId: message.id });
    if (typeof result?.turn?.id !== 'string' || !result.turn.id) throw uncertain(new Error('Codex did not return a turn identity'));
    if (!completedTurns.has(result.turn.id)) { activeTurn = result.turn.id; startExecution(); }
  }

  function settle(turn: any) {
    const failed = turn.status === 'failed';
    const aborted = turn.status === 'interrupted';
    options.publish({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: output }],
      stopReason: aborted ? 'aborted' : failed ? 'error' : 'stop',
      ...(failed ? { errorMessage: turn.error?.message ?? 'Codex turn failed' } : {}) } });
    executing = false;
    options.publish({ type: 'agent_settled', aborted });
  }

  function enqueue(operation: () => Promise<void>, terminal = false) {
    if (terminal) commands.unshift(operation);
    else commands.push(operation);
    if (processingCommands) return;
    processingCommands = true;
    void (async () => {
      try {
        while (commands.length) {
          try { await commands.shift()!(); }
          catch (error) { options.publish({ type: 'worker_error', message: (error as Error).message }); }
        }
      } finally { processingCommands = false; }
    })();
  }

  function observe(record: any) {
    if (record.id !== undefined && !record.method) {
      const entry = pending.get(String(record.id));
      if (!entry) return;
      pending.delete(String(record.id));
      clearTimeout(entry.timer);
      if (record.error) entry.reject(Object.assign(new Error(record.error.message ?? 'Codex request failed'), { nativeRejected: true }));
      else entry.resolve(record.result);
      return;
    }
    if (typeof record.method !== 'string') return;
    if (record.id !== undefined) {
      // Noninteractive profiles have no host approval or dynamic-tool handler.
      options.write({ id: record.id, error: { code: -32601, message: 'murm does not support this server request' } });
      return;
    }
    const params = record.params ?? {};
    if (params.threadId && params.threadId !== threadId) return;
    if (['turn/started', 'turn/completed'].includes(record.method) && typeof params.turn?.id === 'string') {
      options.publish({ type: 'native_event', backend: 'codex', method: record.method,
        threadId: params.threadId, turnId: params.turn.id, status: params.turn.status });
    }
    if (record.method === 'turn/started' && typeof params.turn?.id === 'string') {
      if (completedTurns.has(params.turn.id)) return;
      activeTurn = params.turn.id;
      startExecution();
    }
    if (record.method === 'item/completed' && params.turnId === activeTurn && params.item?.type === 'agentMessage') {
      if (typeof params.item.text === 'string') output += params.item.text;
    }
    if (record.method === 'turn/completed' && typeof params.turn?.id === 'string') {
      const id = params.turn.id;
      if (completedTurns.has(id) || activeTurn !== id) return;
      if (!['completed', 'interrupted', 'failed'].includes(params.turn.status)) {
        options.publish({ type: 'worker_error', message: 'Codex reported an invalid terminal turn status' });
        return;
      }
      completedTurns.add(id);
      if (activeTurn === id) activeTurn = undefined;
      completionWaiters.get(id)?.resolve();
      completionWaiters.delete(id);
      // Finish the old turn after its in-flight acknowledgement and before
      // dispatching a queued successor. Terminal events also release abort's
      // waiter synchronously so execution control cannot deadlock the queue.
      enqueue(async () => {
        const next = interrupting || options.isInputFenced?.() ? undefined : followUps.shift();
        if (next) await startTurn(next);
        else settle(params.turn);
      }, true);
    }
  }

  async function interrupt() {
    interrupting = true;
    const turnId = activeTurn;
    if (!turnId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      completionWaiters.set(turnId, { resolve, reject });
      timer = setTimeout(() => reject(new Error('Codex interruption did not reach a terminal turn')), 30_000);
    });
    try {
      await Promise.all([request('turn/interrupt', { threadId, turnId }), completed]);
    } finally {
      clearTimeout(timer);
      completionWaiters.delete(turnId);
    }
  }

  async function dispatch(message: Input) {
    await ready;
    let expectedTurnId: string | undefined;
    try {
      if (closed) throw uncertain(new Error('Codex App Server connection is closed'));
      if (message.steeringMode !== undefined && message.steeringMode !== 'all') {
        throw Object.assign(new Error('Codex does not support this steering mode'), { code: 'NOT_ALLOWED' });
      }
      if (message.type === 'get_state') { respond(message, { isStreaming: executing, sessionId: threadId }); return; }
      if (message.type === 'clear_queue') {
        const discarded = followUps.splice(0).map(input => input.message);
        respond(message, { steering: [], followUp: discarded });
        return;
      }
      if (message.type === 'abort') {
        await interrupt();
        interrupting = false;
        respond(message);
        return;
      }
      if (!['prompt', 'steer', 'follow_up'].includes(message.type) || typeof message.message !== 'string') {
        throw Object.assign(new Error('Unsupported Codex command'), { code: 'NOT_ALLOWED' });
      }
      if (options.isInputFenced?.()) throw Object.assign(new Error('Codex input is fenced by Worker execution control'), { code: 'NOT_ALLOWED' });
      const queueOnly = message.type !== 'prompt' || message.onlyWhileActive;
      if (queueOnly && !activeTurn) {
        throw Object.assign(new Error('Codex has no active execution'), { code: 'NO_ACTIVE_EXECUTION' });
      }
      if (!activeTurn) {
        interrupting = false;
        await startTurn(message);
        respond(message, { disposition: 'started' });
        return;
      }
      const followUp = message.type === 'follow_up' || message.streamingBehavior === 'followUp';
      if (followUp) {
        followUps.push(message);
        respond(message, { disposition: 'queued' });
        return;
      }
      expectedTurnId = activeTurn;
      const result = await request('turn/steer', { threadId, expectedTurnId,
        input: [{ type: 'text', text: message.message, text_elements: [] }], clientUserMessageId: message.id });
      if (result?.turnId !== expectedTurnId) throw uncertain(new Error('Codex did not confirm the expected steer turn identity'));
      respond(message, { disposition: 'queued' });
    } catch (error) {
      if ((error as Error & { code?: string }).code === 'OPERATION_UNKNOWN') {
        options.publish({ type: 'worker_error', message: (error as Error).message });
        return;
      }
      const rejection = error as Error & { code?: string; nativeRejected?: boolean };
      if (message.onlyWhileActive && expectedTurnId && completedTurns.has(expectedTurnId) && rejection.nativeRejected) {
        rejection.code = 'NO_ACTIVE_EXECUTION';
      }
      respond(message, undefined, rejection);
    }
  }

  return {
    ready,
    observe,
    write(message: Input) { enqueue(() => dispatch(message)); },
    close(error = new Error('Codex App Server exited')) {
      closed = true;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(uncertain(error)); }
      pending.clear();
      for (const waiter of completionWaiters.values()) waiter.reject(uncertain(error));
      completionWaiters.clear();
    },
  };
}

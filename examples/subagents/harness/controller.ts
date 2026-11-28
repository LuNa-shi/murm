import { createHash, randomUUID } from 'node:crypto';
import {
  type RuntimeEvent, type ConditionalInputReceipt, type Runtime, type SpawnOptions, type JsonValue,
  type ContextInput, type ContextSendOptions, type SendOptions,
  type ServiceRequest,
} from '@luna-shi/murm';

type Settled = Extract<RuntimeEvent, { type: 'settled' }>;
type Exit = Extract<RuntimeEvent, { type: 'exit' }>;
type Reply = (Settled | Exit) & { seq: number };
type Message = {
  id: string;
  kind: 'message' | 'result';
  from: string;
  text: string;
  outcome?: 'completed' | 'failed';
  eventSeq?: number;
  state: 'pending' | 'unknown' | 'in-input' | 'queued' | 'returned';
};
type WaitResult = { reason: 'message'; messages: Message[] } | { reason: 'input' | 'timeout' | 'cancelled' };
type Wait = (result: WaitResult) => void;
type Member = {
  path: string;
  parent?: Member;
  id?: string;
  inbox: Message[];
  submitted: Map<string, Message>;
  executionRevision: number;
  wait?: Wait;
  lastOutcome?: 'completed' | 'failed' | 'interrupted';
  fatalReported?: boolean;
  tail?: Promise<unknown>;
  pendingDispatches: number;
};
type Operation = {
  id: string;
  fingerprint: string;
  result?: Promise<JsonValue>;
  batch?: Message[];
  destination?: Member;
  message?: Message;
  inputDispatched?: boolean;
  interruptStatus?: string;
  rootEpoch?: number;
};
function createMember(path: string, parent?: Member): Member {
  return { path, parent, inbox: [], submitted: new Map(), executionRevision: 0, pendingDispatches: 0 };
}

const namePattern = /^[a-z0-9_]{1,48}$/;
const inputLimit = 65_536;
const mailboxLimit = 128;
const operationLimit = 16_384;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function inputText(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > inputLimit) {
    fail('INVALID_CONTRACT', 'Input must be nonempty text within 64 KiB');
  }
  return value;
}

function serial<T>(member: Member, work: () => Promise<T>) {
  member.pendingDispatches++;
  const next = (member.tail ?? Promise.resolve()).then(work).finally(() => { member.pendingDispatches--; });
  member.tail = next.catch(() => undefined);
  return next;
}

export function createSubagentsController(
  runtime: Runtime,
  {
    maxDepth, childWorkspace, childFiles, startupSignal,
  }: { maxDepth: number; childWorkspace?: SpawnOptions['workspace']; childFiles?: SpawnOptions['files']; startupSignal?: AbortSignal },
) {
  const root = createMember('/root');
  const byPath = new Map([[root.path, root]]);
  const byId = new Map<string, Member>();
  const operations = new Map<string, Operation>();
  const replyListeners = new Set<(event: Reply) => void>();
  const jobs = new Set<Promise<unknown>>();
  const deliveryFailures: { id: string; reason: string }[] = [];
  let lastReply: Reply | undefined;
  let eventSequence = 0;
  let accepting = true;
  let rootEpoch = 0;
  let rootPaused = false;
  let rootControl: 'compact' | 'interrupt' | 'clearQueue' | undefined;
  const rootDeliveries = new Map<string, { hash: string; messages: Message[]; inputId?: string; status: string }>();

  function open() {
    if (!accepting) fail('NOT_ALLOWED', 'The team is closing');
  }

  function track<T>(work: Promise<T>) {
    jobs.add(work);
    void work.then(() => jobs.delete(work), () => jobs.delete(work));
    return work;
  }

  function canonical(caller: Member, value: unknown) {
    if (typeof value !== 'string' || !value) fail('INVALID_CONTRACT', 'A target name is required');
    if (byId.has(value)) return byId.get(value)!.path;
    const path = value.startsWith('/') ? value : `${caller.path}/${value}`;
    const segments = path.split('/').slice(1);
    if (segments[0] !== 'root' || segments.slice(1).some(name => !namePattern.test(name) || name === 'root')) {
      fail('NOT_ALLOWED', 'Target must belong to this team and use a valid path');
    }
    return path;
  }

  function target(caller: Member, name: unknown) {
    const member = byPath.get(canonical(caller, name));
    if (!member?.id) fail('NOT_FOUND', 'No team member has that target');
    return member;
  }

  function operate(key: string, parameters: unknown, work: (operation: Operation) => Promise<JsonValue>) {
    const fingerprint = JSON.stringify(parameters);
    let operation = operations.get(key);
    if (operation && operation.fingerprint !== fingerprint) fail('CONFLICT', 'The request ID already has different parameters');
    if (!operation) {
      open();
      if (operations.size >= operationLimit) fail('NOT_ALLOWED', 'The team operation limit has been reached');
      operation = { id: randomUUID(), fingerprint };
      operations.set(key, operation);
    }
    const entry = operation;
    entry.result ??= Promise.resolve().then(() => work(entry)).then(value => {
      if (value && typeof value === 'object' && !Array.isArray(value)
          && (value.status === 'unknown' || value.reason === 'cancelled')) entry.result = undefined;
      return value;
    }, error => {
      if (error.code === 'OPERATION_UNKNOWN' || error.code === 'SERVICE_UNAVAILABLE') entry.result = undefined;
      throw error;
    });
    return track(entry.result);
  }

  function pending(member: Member) {
    return member.inbox.filter(message => message.state === 'pending');
  }

  function reserveMessage(member: Member, message: Message) {
    member.inbox = member.inbox.filter(item => item.state === 'pending' || item.state === 'unknown' || item.state === 'in-input');
    if (member.inbox.length >= mailboxLimit) fail('NOT_ALLOWED', 'The recipient mailbox is full');
    member.inbox.push(message);
  }

  function releaseWait(member: Member) {
    const messages = pending(member);
    if (!member.wait || messages.length === 0 || (member === root && (rootPaused || rootControl))) return false;
    for (const message of messages) message.state = 'returned';
    member.inbox = member.inbox.filter(message => message.state !== 'returned');
    member.wait({ reason: 'message', messages: structuredClone(messages) });
    return true;
  }

  function removeMemberMessage(member: Member, message: Message) {
    member.inbox = member.inbox.filter(item => item !== message);
  }

  async function offer(member: Member, message: Message) {
    if (message.state === 'returned' || (message.state === 'pending' && releaseWait(member))) return;
    if (member === root && (rootPaused || rootControl)) return;
    if (member.submitted.size >= operationLimit) fail('NOT_ALLOWED', 'The recipient delivery history limit has been reached');
    const { state: _state, ...payload } = message;
    const body = JSON.stringify(payload);
    const receipt = await runtime.send(member.id!, body, {
      requestId: message.id, source: message.from, mode: 'steer', wakeIfIdle: false,
    });
    if (receipt.status === 'accepted') {
      message.state = 'queued';
      if (receipt.disposition === 'queued') member.submitted.set(createHash('sha256').update(body).digest('hex'), message);
      removeMemberMessage(member, message);
      member.wait?.({ reason: 'input' });
    } else if (receipt.status === 'unknown') {
      message.state = 'unknown';
    } else {
      message.state = 'pending';
      releaseWait(member);
    }
  }

  function resultFor(member: Member, event: Settled | Exit | Extract<RuntimeEvent, { type: 'error' }>, seq: number) {
    const recipient = member.parent;
    if (!recipient || !accepting) return;
    const message: Message = {
      id: randomUUID(), kind: 'result', from: member.path,
      text: event.type === 'settled'
        ? (event.outcome === 'completed' ? event.output ?? '' : event.error?.message ?? 'Child execution failed')
        : event.type === 'exit' ? event.reason : event.error.message,
      outcome: event.type === 'settled' && event.outcome === 'completed' ? 'completed' : 'failed',
      eventSeq: seq, state: 'pending',
    };
    void track(serial(recipient, async () => {
      open();
      reserveMessage(recipient, message);
      await offer(recipient, message);
    })).catch(error => {
      if (deliveryFailures.length < mailboxLimit) deliveryFailures.push({ id: message.id, reason: error.code ?? 'SERVICE_UNAVAILABLE' });
    });
  }

  const unsubscribe = runtime.onEvent(event => {
    if (!('agentId' in event)) return;
    const member = byId.get(event.agentId);
    if (!member) return;
    const seq = ++eventSequence;
    if (event.type === 'settled' || event.type === 'exit') member.executionRevision++;
    if (event.type === 'settled') {
      member.lastOutcome = event.outcome === 'aborted' ? 'interrupted' : event.outcome;
      if (event.outcome !== 'aborted' && !(member.fatalReported && event.outcome === 'failed')) resultFor(member, event, seq);
    } else if (event.type === 'error' && event.fatal && !member.fatalReported) {
      member.lastOutcome = 'failed';
      member.fatalReported = true;
      resultFor(member, event, seq);
    } else if (event.type === 'exit' && !event.expected && !member.fatalReported && member.lastOutcome !== 'failed') {
      member.lastOutcome = 'failed';
      resultFor(member, event, seq);
    }
    if (member === root && (event.type === 'settled' || event.type === 'exit')) {
      lastReply = { ...event, seq };
      for (const listener of replyListeners) listener(lastReply);
    }
  });

  async function reconcile(member: Member) {
    for (const message of member.inbox.filter(item => item.state === 'unknown')) {
      await offer(member, message);
    }
  }

  function submit(member: Member, entry: Operation, text: string, from: string, requestId: string, authorize?: () => void,
    options: Omit<SendOptions, 'requestId'> = {}, signal?: AbortSignal) {
    const guard = () => {
      signal?.throwIfAborted();
      if (member !== root) return;
      if (entry.rootEpoch !== rootEpoch) fail('RUN_INPUT_CANCELLED', 'The Root input predates its control barrier');
      if (rootControl) fail('OPERATION_BUSY', 'Root dispatch is reserved for control');
    };
    return serial(member, async (): Promise<ConditionalInputReceipt> => {
      guard();
      open();
      authorize?.();
      if (!entry.inputDispatched) {
        await reconcile(member);
        const status = await runtime.get(member.id!);
        open();
        authorize?.();
        guard();
        entry.batch = pending(member);
        for (const message of entry.batch) message.state = 'in-input';
        if (status.status === 'idle') member.executionRevision++;
        entry.inputDispatched = true;
      }
      const messages = entry.batch!;
      const body = messages.length || from !== 'user'
        ? JSON.stringify({ kind: from === 'user' ? 'user' : 'new-task', from, text, messages: messages.map(({ state: _state, ...message }) => message) })
        : text;
      const rootDelivery: { hash: string; messages: Message[]; inputId?: string; status: string } | undefined = member === root ? rootDeliveries.get(requestId) ?? {
        hash: createHash('sha256').update(body).digest('hex'), messages, status: 'dispatching',
      } : undefined;
      if (rootDelivery && !rootDeliveries.has(requestId)) rootDeliveries.set(requestId, rootDelivery);
      let receipt: ConditionalInputReceipt;
      try {
        guard();
        receipt = await runtime.send(member.id!, body, { source: from, wakeIfIdle: true, ...options, requestId });
      } catch (error) {
        rootDeliveries.delete(requestId);
        for (const message of messages) message.state = 'pending';
        releaseWait(member);
        throw error;
      }
      if (rootDelivery && rootDeliveries.get(requestId) === rootDelivery) {
        rootDelivery.inputId = receipt.inputId;
        rootDelivery.status = receipt.status === 'accepted' ? receipt.disposition : receipt.status;
        if (receipt.status !== 'unknown' && rootDelivery.status !== 'queued') rootDeliveries.delete(requestId);
      }
      // A concurrent interrupt or clear already settled this input from the native queue.
      if (member === root && entry.rootEpoch !== rootEpoch) return receipt;
      if (receipt.status === 'accepted') {
        for (const message of messages) removeMemberMessage(member, message);
        if (member === root) rootPaused = false;
        member.wait?.({ reason: 'input' });
      } else if (receipt.status === 'not-accepted') {
        for (const message of messages) message.state = 'pending';
        releaseWait(member);
      }
      return receipt;
    });
  }

  function waitForMessage(member: Member, duration: number, signal: AbortSignal) {
    if (member.wait) fail('CONFLICT', 'This member is already waiting');
    if (signal.aborted || (member === root && rootPaused)) return Promise.resolve<WaitResult>({ reason: 'cancelled' });
    return new Promise<WaitResult>(resolve => {
      const timer = setTimeout(() => finish({ reason: 'timeout' }), duration);
      const cancel = () => finish({ reason: 'cancelled' });
      function finish(result: WaitResult) {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (member.wait === finish) member.wait = undefined;
        resolve(result);
      }
      member.wait = finish;
      signal.addEventListener('abort', cancel, { once: true });
      releaseWait(member);
    });
  }

  function restoreRootQueue(hashes: readonly string[]) {
    const discarded = new Set(hashes);
    const inputs: { requestId: string; inputId?: string }[] = [];
    const inbox: string[] = [];
    const restore = (message: Message) => {
      message.state = 'pending';
      if (!root.inbox.some(item => item.id === message.id)) {
        try { reserveMessage(root, message); }
        catch {
          deliveryFailures.push({ id: message.id, reason: 'MAILBOX_FULL_AFTER_CONTROL' });
          return;
        }
      }
      inbox.push(message.id);
    };
    for (const [hash, message] of root.submitted) {
      if (discarded.has(hash)) restore(message);
    }
    root.submitted.clear();
    for (const [requestId, delivery] of rootDeliveries) {
      if (discarded.has(delivery.hash)) {
        inputs.push({ requestId, ...(delivery.inputId ? { inputId: delivery.inputId } : {}) });
        for (const message of delivery.messages) restore(message);
      } else {
        for (const message of delivery.messages) removeMemberMessage(root, message);
      }
      rootDeliveries.delete(requestId);
    }
    return { discardedUserInputs: inputs, restoredInbox: inbox };
  }

  async function rootQueueControl(operation: 'interrupt' | 'clearQueue', requestId: string) {
    open();
    if (!root.id) fail('RUN_NOT_READY', 'Root is not available yet');
    if (rootControl) fail('OPERATION_BUSY', 'Root already has a reserved control');
    rootControl = operation;
    rootEpoch++;
    if (operation === 'interrupt') {
      rootPaused = true;
      root.wait?.({ reason: 'cancelled' });
    }
    try {
      if (operation === 'interrupt') {
        const receipt = await runtime.interrupt(root.id, { requestId });
        const harnessEffects = receipt.status === 'interrupted'
          ? { status: 'complete', ...restoreRootQueue(receipt.discardedInputHashes ?? []) }
          : { status: 'unknown' };
        return { core: receipt, harnessEffects: { ...harnessEffects, paused: rootPaused } };
      }
      const receipt = await runtime.session.clearQueue(root.id, { requestId });
      const hashes = 'discardedInputHashes' in receipt ? receipt.discardedInputHashes : undefined;
      const harnessEffects = receipt.status === 'completed' || receipt.status === 'noop'
        ? { status: 'complete', ...restoreRootQueue(Array.isArray(hashes) ? hashes : []) }
        : { status: 'unknown' };
      return { core: receipt, harnessEffects };
    } finally {
      rootControl = undefined;
      releaseWait(root);
    }
  }

  function sendRootContext(input: ContextInput, options: ContextSendOptions, signal: AbortSignal) {
    const epoch = rootEpoch;
    return track(serial(root, async () => {
      open();
      signal.throwIfAborted();
      if (!root.id) fail('RUN_NOT_READY', 'Root is not available yet');
      if (epoch !== rootEpoch) fail('RUN_INPUT_CANCELLED', 'The Root input predates its control barrier');
      if (rootControl) fail('OPERATION_BUSY', 'Root dispatch is reserved for control');
      const receipt = await runtime.send(root.id, input, options);
      if (epoch === rootEpoch && receipt.status === 'accepted' &&
          (options.delivery === 'steer' || options.delivery === 'followUp') && options.wakeIfIdle !== false) {
        rootPaused = false;
        for (const message of pending(root)) {
          if (signal.aborted || rootEpoch !== epoch || rootControl) break;
          await offer(root, message);
        }
      }
      return receipt;
    }));
  }

  async function compactRoot(options: Parameters<Runtime['session']['compact']>[1]) {
    open();
    if (!root.id) fail('RUN_NOT_READY', 'Root is not available yet');
    if (rootControl || root.pendingDispatches) fail('OPERATION_BUSY', 'Root dispatch is in progress');
    rootControl = 'compact';
    try { return await runtime.session.compact(root.id, options); }
    finally { rootControl = undefined; }
  }

  function attachRoot(id: string) {
    root.id = id;
    byId.set(id, root);
  }

  return {
    attachRoot,
    rootId: () => root.id,
    rootEpoch: () => rootEpoch,
    rootBusy: () => !!rootControl || root.pendingDispatches > 0,
    submitUser(text: string, requestId: string, options: Omit<SendOptions, 'requestId'> = {}, signal?: AbortSignal, epoch = rootEpoch) {
      inputText(text);
      if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(requestId)) fail('INVALID_CONTRACT', 'Invalid user request ID');
      return operate(`user:${requestId}`, { text, options }, entry => {
        entry.rootEpoch ??= epoch;
        return submit(root, entry, text, 'user', `user:${requestId}`, undefined, options, signal);
      });
    },
    sendRootContext,
    compactRoot,
    rootQueueControl,
    lastReply: () => lastReply,
    onReply(listener: (event: Reply) => void) {
      replyListeners.add(listener);
      return () => { replyListeners.delete(listener); };
    },
    list: () => runtime.list(),
    async invoke(request: ServiceRequest): Promise<JsonValue> {
      const caller = request.caller.runtimeId === runtime.id && byId.get(request.caller.agentId);
      if (!caller) fail('NOT_ALLOWED', 'Caller does not belong to this team');
      request.assertAuthorized();
      const call = request.input as Record<string, JsonValue>;
      const operation = request.capability.operation;
      if (operation === 'list_agents') {
        const prefix = call.path_prefix === undefined ? '/root' : canonical(caller, call.path_prefix);
        const visible = await runtime.list();
        return visible.flatMap(agent => {
          const member = byId.get(agent.id);
          return member && ['starting', 'idle', 'running'].includes(agent.status) &&
            (member.path === prefix || member.path.startsWith(prefix + '/'))
            ? [{ path: member.path, agentId: agent.id, status: agent.status, lastOutcome: member.lastOutcome ?? null }] : [];
        });
      }
      const key = JSON.stringify([caller.id, request.envelope.operation_id]);
      const parameters = [operation, Object.entries(call).sort(([a], [b]) => a.localeCompare(b))];
      return operate(key, parameters, async entry => {
        open();
        request.assertAuthorized();
        if (operation === 'wait_agent') {
          const wait = waitForMessage(caller, Math.max(10_000, (call.timeout_ms as number | undefined) ?? 30_000), request.signal);
          void track(serial(caller, () => reconcile(caller))).catch(() => undefined);
          return await wait as unknown as JsonValue;
        }
        if (operation === 'spawn_agent') {
          const name = call.task_name as string;
          if (name === 'root' || !namePattern.test(name)) fail('INVALID_CONTRACT', 'Invalid child name');
          const path = `${caller.path}/${name}`;
          if (path.split('/').length - 2 > maxDepth) fail('NOT_ALLOWED', 'The team depth limit has been reached');
          if (!entry.destination) {
            if (byPath.has(path)) fail('CONFLICT', 'A child already uses that path');
            entry.destination = createMember(path, caller);
            byPath.set(path, entry.destination);
          }
          const child = entry.destination;
          try {
            if (!child.id) {
              startupSignal?.throwIfAborted();
              const agent = await runtime.spawn({ profile: 'child', requestId: entry.id, parentId: caller.id,
                ...(call.fork_turns === 'none' ? {} : { forkFrom: caller.id }), workspace: childWorkspace, files: childFiles });
              child.id = agent.id;
              byId.set(agent.id, child);
              startupSignal?.throwIfAborted();
            }
          } catch (error) {
            if ((error as { code?: string }).code !== 'OPERATION_UNKNOWN') byPath.delete(path);
            throw error;
          }
          const receipt = await submit(child, entry, inputText(call.message), caller.path, entry.id + ':initial', request.assertAuthorized);
          return { task_name: child.path, agentId: child.id, ...receipt };
        }
        const recipient = target(caller, call.target);
        if (operation === 'followup_task') {
          if (recipient === root) fail('NOT_ALLOWED', 'The Root only receives follow-up tasks from the host');
          const receipt = await submit(recipient, entry, inputText(call.message), caller.path, entry.id, request.assertAuthorized);
          return { ...receipt };
        }
        if (operation === 'interrupt_agent') {
          if (recipient === root || recipient === caller) fail('NOT_ALLOWED', 'Cannot interrupt the Root or yourself');
          const revision = recipient.executionRevision;
          return serial(recipient, async () => {
            open();
            request.assertAuthorized();
            if (!entry.interruptStatus) {
              const before = await runtime.get(recipient.id!);
              open();
              request.assertAuthorized();
              if (recipient.executionRevision !== revision) return { status: 'stale' };
              if (before.status === 'idle') return { status: 'idle' };
              entry.interruptStatus = before.status;
            }
            const { discardedInputHashes, ...receipt } = await runtime.interrupt(recipient.id!, { requestId: entry.id });
            if (receipt.status === 'interrupted') {
              recipient.lastOutcome = 'interrupted';
              for (const hash of discardedInputHashes ?? []) {
                const message = recipient.submitted.get(hash);
                if (message) {
                  message.state = 'pending';
                  try { reserveMessage(recipient, message); }
                  catch { deliveryFailures.push({ id: message.id, reason: 'MAILBOX_FULL_AFTER_INTERRUPT' }); }
                }
              }
              recipient.submitted.clear();
            }
            return { ...receipt, previousStatus: entry.interruptStatus };
          });
        }
        if (operation !== 'send_message') return fail('INVALID_CONTRACT', 'Unknown collaboration operation');
        return serial(recipient, async () => {
          open();
          request.assertAuthorized();
          if (!entry.message) {
            entry.message = { id: entry.id, kind: 'message', from: caller.path, text: inputText(call.message), state: 'pending' };
            reserveMessage(recipient, entry.message);
          }
          await offer(recipient, entry.message);
          return { messageId: entry.message.id, status: entry.message.state };
        });
      });
    },
    beginClose() {
      accepting = false;
      for (const member of byPath.values()) member.wait?.({ reason: 'cancelled' });
    },
    dispose() { unsubscribe(); replyListeners.clear(); },
    drain: () => Promise.allSettled(jobs),
    exportState(): JsonValue {
      return {
        accepting,
        rootPaused,
        rootControl: rootControl ?? null,
        rootInputs: [...rootDeliveries].slice(-64).map(([requestId, { inputId, status, messages }]) => ({
          requestId, inputId: inputId ?? null, status, collaborationIds: messages.map(message => message.id),
        })),
        members: [...byPath.values()].map(member => ({
          path: member.path, agentId: member.id ?? null, parent: member.parent?.path ?? null,
          lastOutcome: member.lastOutcome ?? null, waiting: Boolean(member.wait),
          nativeQueuedAdmissions: member.submitted.size,
          pending: member.inbox.map(({ id, state }) => ({ id, state })),
        })),
        operations: operations.size, deliveryFailures: [...deliveryFailures],
      };
    },
  };
}

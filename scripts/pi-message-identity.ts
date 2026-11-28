import { randomUUID } from 'node:crypto';

type NativeMessage = { role: string; [field: string]: unknown };
type NativeEntry = { id: string; type: string };
type ProjectedEntry = { sourceEntry: NativeEntry; messages: NativeMessage[] };

/** Pi 1.3/1.4 construct a native custom message, then hand its object to a
 * queue, a new turn, or the append path. Track that handoff and persistence
 * without injecting an identity into the message or comparing user content. */
export function trackPiMessageIdentity(session: any, options: {
  canDeliver(inputId: string): boolean;
  onAppend(inputId: string, entryId: string, messageId: string): void;
}) {
  const manager = session.sessionManager;
  const inputs = new WeakMap<object, string>();
  const nativeInputs = new WeakMap<NativeMessage, string>();
  const nativeIds = new WeakMap<NativeMessage, string>();
  const entryIds = new Map<string, string>();
  let current: string | undefined;
  let directAppend: NativeMessage | undefined;
  let streamedAppend: NativeMessage | undefined;
  let assistant: string | undefined;

  function identity(message: NativeMessage) {
    let id = nativeIds.get(message);
    if (!id) { id = randomUUID(); nativeIds.set(message, id); }
    return id;
  }

  function tag(message: NativeMessage) {
    if (current && message.role === 'custom') nativeInputs.set(message, current);
  }

  if (manager) {
    if (!session.agent || !Array.isArray(session._pendingCustomMessages) ||
        [session.sendCustomMessage, session._appendCustomMessage, session._startRun, session.agent.steer, session.agent.followUp,
          manager.appendCustomMessageEntry, manager.appendMessage, manager.buildSessionProjection].some(method => typeof method !== 'function')) {
      throw new Error('Pi Session does not expose the expected message handoff and persistence methods');
    }
    const send = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = (input: object, ...args: unknown[]) => {
      const inputId = inputs.get(input);
      if (inputId && !options.canDeliver(inputId)) return Promise.resolve();
      const previous = current;
      const queued = session._pendingCustomMessages.length;
      current = inputId;
      try {
        const result = send(input, ...args);
        if (session._pendingCustomMessages.length > queued) tag(session._pendingCustomMessages[queued]);
        return result;
      } finally { current = previous; }
    };
    for (const operation of ['steer', 'followUp']) {
      const deliver = session.agent[operation].bind(session.agent);
      session.agent[operation] = (message: NativeMessage, ...args: unknown[]) => {
        tag(message);
        return deliver(message, ...args);
      };
    }
    const startRun = session._startRun.bind(session);
    session._startRun = (trigger: { message?: NativeMessage }, ...args: unknown[]) => {
      if (trigger.message) tag(trigger.message);
      return startRun(trigger, ...args);
    };
    const appendCustom = session._appendCustomMessage.bind(session);
    session._appendCustomMessage = (message: NativeMessage) => {
      tag(message);
      const inputId = nativeInputs.get(message);
      if (inputId && !options.canDeliver(inputId)) return;
      const previous = directAppend;
      directAppend = message;
      try { return appendCustom(message); }
      finally { directAppend = previous; }
    };
    const persistCustom = manager.appendCustomMessageEntry.bind(manager);
    manager.appendCustomMessageEntry = (...args: unknown[]) => {
      const message = directAppend ?? streamedAppend;
      if (!directAppend) streamedAppend = undefined;
      const entryId: string = persistCustom(...args);
      if (message) {
        const messageId = identity(message);
        entryIds.set(entryId, messageId);
        const inputId = nativeInputs.get(message);
        if (inputId) options.onAppend(inputId, entryId, messageId);
      }
      return entryId;
    };
    const persist = manager.appendMessage.bind(manager);
    manager.appendMessage = (message: NativeMessage) => {
      const entryId: string = persist(message);
      entryIds.set(entryId, identity(message));
      return entryId;
    };
  }

  return {
    track(input: object, inputId: string) { inputs.set(input, inputId); },
    discard(inputId: string) {
      if (manager) session._pendingCustomMessages = session._pendingCustomMessages
        .filter((message: NativeMessage) => nativeInputs.get(message) !== inputId);
    },
    observe(type: string, message: NativeMessage) {
      if (message.role === 'assistant') {
        const id = type === 'message_start' ? identity(message) : assistant ?? identity(message);
        nativeIds.set(message, id);
        assistant = type === 'message_end' ? undefined : id;
        return id;
      }
      // Pi publishes an Agent message_end immediately before persist. A
      // context-only append has already persisted inside the wrapped method.
      if (message.role === 'custom' && type === 'message_end' && !directAppend) streamedAppend = message;
      return identity(message);
    },
    messages(): Array<{ id: string } & NativeMessage> {
      if (!manager) return session.messages.map((message: NativeMessage) => ({ ...message, id: identity(message) }));
      const { entries } = manager.buildSessionProjection() as { entries: ProjectedEntry[] };
      return entries.flatMap(({ sourceEntry, messages }) => messages.map((message, part) => ({
        ...message, id: part === 0 ? entryIds.get(sourceEntry.id) ?? `${sourceEntry.id}:${part}` : `${sourceEntry.id}:${part}`,
      })));
    },
  };
}

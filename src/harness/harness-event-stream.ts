import { projectError } from './project-input.js';
import { jsonBytes } from './harness-session-view.js';
import type { HarnessEvent, HarnessSubscriptionOptions } from './harness-session-types.js';

const maxSubscribers = 64;
const maxEvents = 128;
const maxBytes = 1024 * 1024;

type PendingEvent = { event: HarnessEvent; bytes: number };

class EventSubscription {
  #queue: PendingEvent[] = [];
  #bytes = 0;
  #busy = false;
  #active: boolean;
  #handler?: (event: HarnessEvent) => void;
  #onError: HarnessSubscriptionOptions['onError'];
  #remove?: (subscription: EventSubscription) => void;

  constructor(
    handler: (event: HarnessEvent) => void,
    onError: HarnessSubscriptionOptions['onError'],
    remove: (subscription: EventSubscription) => void,
    initialSnapshot: boolean,
  ) {
    this.#active = !initialSnapshot;
    this.#handler = handler;
    this.#onError = onError;
    this.#remove = remove;
  }

  start(event: HarnessEvent) {
    this.#active = true;
    this.enqueue({ event, bytes: jsonBytes(event) });
    this.drain();
  }

  enqueue(entry: PendingEvent) {
    if (!this.#active || !this.#handler) return;
    if (this.#queue.length >= maxEvents || this.#bytes + entry.bytes > maxBytes) {
      this.close(projectError('OBSERVATION_OVERFLOW', 'Event subscription fell behind. Subscribe again with a fresh snapshot.'));
      return;
    }
    this.#queue.push(entry);
    this.#bytes += entry.bytes;
  }

  drain() {
    while (this.#handler && !this.#busy && this.#queue.length) {
      const { event, bytes } = this.#queue.shift()!;
      this.#bytes -= bytes;
      this.#busy = true;
      try {
        const returned: unknown = this.#handler(structuredClone(event));
        if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
          const resume = () => { this.#busy = false; this.drain(); };
          void Promise.resolve(returned).then(resume, resume);
          return;
        }
      } catch { /* Subscriber code has no effect on the Run or other listeners. */ }
      this.#busy = false;
    }
  }

  close(error?: Error, onlyIfIncomplete = false) {
    if (!this.#handler) return;
    const notify = error && (!onlyIfIncomplete || !this.#active || this.#queue.length) ? this.#onError : undefined;
    this.#handler = undefined;
    this.#onError = undefined;
    this.#queue = [];
    this.#bytes = 0;
    this.#remove?.(this);
    this.#remove = undefined;
    if (notify) queueMicrotask(() => {
      try { void Promise.resolve(notify(error!)).catch(() => {}); }
      catch { /* Error notification is independent of event delivery. */ }
    });
  }
}

/** Shared ordered subscription delivery for the in-process Session and RPC client. */
export class HarnessEventStream {
  #subscriptions = new Set<EventSubscription>();

  subscribe(handler: (event: HarnessEvent) => void, options?: HarnessSubscriptionOptions) {
    if (typeof handler !== 'function' || (options?.onError !== undefined && typeof options.onError !== 'function')) {
      throw projectError('INVALID_SUBSCRIBER', 'Expected an event handler and an optional error handler');
    }
    if (this.#subscriptions.size >= maxSubscribers) throw projectError('REQUEST_LIMIT', 'Event subscriber limit reached');
    const subscription = new EventSubscription(handler, options?.onError, value => this.#subscriptions.delete(value), options?.initialSnapshot === true);
    this.#subscriptions.add(subscription);
    return subscription;
  }

  publish(event: HarnessEvent) {
    if (!this.#subscriptions.size) return;
    const entry = { event: structuredClone(event), bytes: jsonBytes(event) };
    const subscriptions = [...this.#subscriptions];
    // Enqueue for everyone before invoking any handler. Reentrant publications
    // follow the current event even for subscribers farther down the list.
    for (const subscription of subscriptions) subscription.enqueue(entry);
    for (const subscription of subscriptions) subscription.drain();
  }

  close(error: Error, onlyIfIncomplete: boolean) {
    for (const subscription of this.#subscriptions) subscription.close(error, onlyIfIncomplete);
  }
}

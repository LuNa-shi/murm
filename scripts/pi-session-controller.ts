import { randomUUID, createHash } from 'node:crypto';
import { trackPiMessageIdentity } from './pi-message-identity.js';

export const PI_SESSION_CAPABILITIES = Object.freeze({ configure: true, compact: true, abortRetry: true,
  clearQueue: true, state: true, stats: true, messages: true, context: true, beforeCompact: true });

type ContextEntry = { inputId: string; delivery: string; input: any; status: string; generation: number };
export function createPiSessionController(session: any, options: {
  emit(record: any): void; isStarting?(): boolean; version?: string; configuration?: any; beforeCompact?: { timeoutMs?: number };
}) {
  const pending = new Map<string, ContextEntry>();
  const decisions = new Map<string, { epoch: number; finish(decision: string, reason?: string): void }>();
  const toolActivity = new Map<string, string>();
  const counts = { successfulAutoCompactions: 0, manual: 0, failed: 0, cancelled: 0 };
  let epoch = 0;
  let fenced = false;
  let compacting: { id: string; reason: string } | undefined;
  const emit = options.emit;
  const error = (message: string, code = 'INVALID_CONTRACT') => Object.assign(new Error(message), { code });
  const messages = trackPiMessageIdentity(session, {
    canDeliver(inputId) {
      const entry = pending.get(inputId);
      return !!entry && (entry.delivery === 'append' || entry.generation === epoch);
    },
    onAppend(inputId, entryId, messageId) {
      const entry = pending.get(inputId);
      if (entry) disposition(entry, 'appended', { entryId, messageId });
    },
  });
  function disposition(entry: ContextEntry, status: string, evidence?: { entryId: string; messageId: string }) {
    entry.status = status;
    emit({ type: 'core_context_disposition', inputId: entry.inputId, delivery: entry.delivery, status, executionEpoch: epoch, ...evidence });
    if (status === 'appended' || status === 'discarded') pending.delete(entry.inputId);
  }
  function discardPending(preserveAppends = false) {
    const entries = [...pending.values()].filter(entry => !preserveAppends || entry.delivery !== 'append');
    const ids = entries.map(entry => entry.inputId);
    for (const entry of entries) {
      messages.discard(entry.inputId);
      disposition(entry, 'discarded');
    }
    return ids;
  }
  function configuration() {
    const settings = session.settingsManager?.getSettings?.() ?? {};
    return { thinkingLevel: session.thinkingLevel, compaction: session.settingsManager?.getCompactionSettings?.(session.model),
      retry: session.settingsManager?.getRetrySettings?.(), steeringMode: session.steeringMode,
      followUpMode: session.followUpMode, tools: session.getActiveToolNames?.() ?? [],
      resources: options.configuration?.resources ?? {}, ...('compaction' in settings ? { compaction: { ...session.settingsManager.getCompactionSettings(session.model), enabled: session.autoCompactionEnabled } } : {}),
      ...(settings.retry ? { retry: { ...session.settingsManager.getRetrySettings(), enabled: session.autoRetryEnabled } } : {}) };
  }
  function state() {
    return { observedAt: new Date().toISOString(), executor: { kind: 'pi', version: options.version ?? 'unknown' },
      capabilities: PI_SESSION_CAPABILITIES, configuration: configuration(),
      model: { provider: session.model?.provider ?? '', id: session.model?.id ?? '' },
      thinkingLevels: session.getAvailableThinkingLevels?.() ?? [], active: options.isStarting?.() || !session.isIdle,
      compacting: session.isCompacting, retrying: session.isRetrying,
      tools: session.getActiveToolNames?.() ?? [], resources: options.configuration?.resources ?? {},
      toolActivity: [...toolActivity].map(([toolCallId, toolName]) => ({ toolCallId, toolName })),
      queue: { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] },
      pendingContext: [...pending.values()].map(({ inputId, delivery, status }) => ({ inputId, delivery, status })) };
  }
  function configure(patch: any) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw error('Session patch must be an object');
    const fields = ['thinkingLevel', 'compaction', 'retry', 'steeringMode', 'followUpMode'];
    if (Object.keys(patch).some(key => !fields.includes(key))) throw error('Unsupported dynamic session field');
    for (const key of ['compaction', 'retry']) if (patch[key] !== undefined &&
      (!patch[key] || Object.keys(patch[key]).some(name => name !== 'enabled') || typeof patch[key].enabled !== 'boolean')) throw error('Only enabled may be changed dynamically');
    for (const key of ['steeringMode', 'followUpMode']) if (patch[key] !== undefined && !['all', 'one-at-a-time'].includes(patch[key])) throw error('Invalid queue mode');
    if (patch.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(patch.thinkingLevel)) throw error('Invalid thinking level');
    if (patch.thinkingLevel !== undefined) session.setThinkingLevel(patch.thinkingLevel);
    if (patch.compaction) session.setAutoCompactionEnabled(patch.compaction.enabled);
    if (patch.retry) session.setAutoRetryEnabled(patch.retry.enabled);
    if (patch.steeringMode) session.setSteeringMode(patch.steeringMode);
    if (patch.followUpMode) session.setFollowUpMode(patch.followUpMode);
    const result = { status: 'applied', configuration: configuration() };
    emit({ type: 'core_session_event', event: { type: 'settings', ...result } });
    return result;
  }
  async function beforePrompt() {
      if (fenced) throw error('Session is fenced', 'NOT_ALLOWED');
      if (!session.isIdle) return;
      const generation = epoch;
      for (const entry of [...pending.values()]) if (entry.status === 'pending-next-turn') {
        if (generation !== epoch || fenced) throw error('Input generation changed', 'NOT_ALLOWED');
        entry.status = 'pending-append';
        await session.sendCustomMessage(entry.input, { triggerTurn: false });
      }
  }
  return {
    get fenced() { return fenced; },
    beforePrompt,
    async interrupt(nextEpoch?: number) {
      epoch = nextEpoch ?? epoch + 1;
      for (const decision of [...decisions.values()]) decision.finish('cancel', 'interrupted');
      const queue = session.clearQueue();
      await session.abort();
      return { ...queue, discardedContextIds: discardPending() };
    },
    observe(event: any) {
      if (event.type === 'tool_execution_start') toolActivity.set(event.toolCallId, event.toolName);
      if (event.type === 'tool_execution_end') toolActivity.delete(event.toolCallId);
      if (event.type === 'agent_settled') toolActivity.clear();
      if (['message_start', 'message_update', 'message_end'].includes(event.type) && event.message) {
        return { ...event, messageId: messages.observe(event.type, event.message) };
      }
      if (event.type.startsWith('summarization_retry_') && compacting) return { ...event, compactionId: compacting.id, reason: compacting.reason };
      if (event.type === 'compaction_start') {
        compacting = { id: randomUUID(), reason: event.reason };
        return { ...event, compactionId: compacting.id };
      }
      if (event.type === 'compaction_end' && compacting) {
        if (event.result && !event.aborted) {
          if (compacting.reason === 'manual') counts.manual++;
          else counts.successfulAutoCompactions++;
        } else if (event.aborted || event.cancelled) counts.cancelled++;
        else counts.failed++;
        const completed = { ...event, compactionId: compacting.id, compactions: { ...counts } };
        compacting = undefined;
        return completed;
      }
      return event;
    },
    async beforeCompact(event: any) {
      if (fenced) return { cancel: true };
      if (!options.beforeCompact) return undefined;
      const compactionId = compacting?.id ?? randomUUID();
      const generation = epoch;
      const decision = await new Promise<string>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (value: string, reason?: string) => {
          if (!decisions.delete(compactionId)) return;
          clearTimeout(timer);
          event.signal?.removeEventListener('abort', cancelled);
          if (value === 'stop') {
            fenced = true;
            session.clearQueue();
            discardPending();
            // abort() waits for this hook. Release the hook before awaiting its run.
            session.abortCompaction();
            void session.abort().catch(() => {});
          }
          emit({ type: 'core_before_compact_result', compactionId, executionEpoch: generation, decision: value, reason });
          resolve(value);
        };
        const cancelled = () => finish('cancel', 'cancelled');
        decisions.set(compactionId, { epoch: generation, finish });
        timer = setTimeout(() => finish('stop', 'HOOK_TIMEOUT'), options.beforeCompact?.timeoutMs ?? 10_000);
        event.signal?.addEventListener('abort', cancelled, { once: true });
        if (event.signal?.aborted) { cancelled(); return; }
        emit({ type: 'core_before_compact', compactionId, executionEpoch: generation,
          reason: event.reason, successfulAutoCompactions: counts.successfulAutoCompactions, sessionId: session.sessionId });
      });
      return decision === 'allow' && !fenced && generation === epoch ? undefined : { cancel: true };
    },
    async command(command: any): Promise<any> {
      const type = command.type;
      if (type === 'core_before_compact_decision') {
        const pendingDecision = decisions.get(command.compactionId);
        if (!pendingDecision || pendingDecision.epoch !== command.executionEpoch || !['allow', 'cancel', 'stop'].includes(command.decision)) throw error('Stale compaction decision', 'NOT_ALLOWED');
        pendingDecision.finish(command.decision, command.reason);
        return { status: 'completed' };
      }
      if (type === 'core_session_get_state') return state();
      if (type === 'core_session_get_stats') {
        const { sessionFile: _privatePath, contextUsage: _sessionContext, cost: _unconfiguredPrice, ...usage } = session.getSessionStats();
        const context = session.getContextUsage();
        return { sessionUsage: { source: 'pi-session', ...usage, cost: null, costStatus: 'not-configured' }, contextUsage: {
          tokens: context?.tokens ?? null, contextWindow: context?.contextWindow ?? session.model?.contextWindow ?? null,
          percent: context?.percent ?? null }, compactions: { ...counts } };
      }
      if (type === 'core_session_get_messages') {
        const limit = command.limit ?? 100;
        const maxBytes = command.maxBytes ?? 262144;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) throw error('Invalid message bounds');
        const all = messages.messages();
        const selected: typeof all = [];
        let bytes = 0;
        for (let index = all.length - 1; index >= 0 && selected.length < limit; index--) {
          const item = all[index];
          const size = Buffer.byteLength(JSON.stringify(item));
          if (bytes + size > maxBytes) break;
          bytes += size;
          selected.unshift(item);
        }
        return { messages: selected, truncated: selected.length < all.length, observedAt: new Date().toISOString() };
      }
      if (fenced) throw error('Session is fenced', 'NOT_ALLOWED');
      if (command.executionEpoch !== undefined && command.executionEpoch !== epoch) throw error('Stale session operation', 'NOT_ALLOWED');
      if (type === 'core_session_configure') return configure(command.patch);
      if (type === 'core_session_compact') {
        if (options.isStarting?.() || !session.isIdle || session.isCompacting || session.isRetrying) return { status: 'busy', reason: 'active-execution' };
        return { status: 'completed', result: await session.compact(command.customInstructions) };
      }
      if (type === 'core_session_abort_retry') {
        const active = session.isRetrying;
        session.abortRetry();
        return { status: active ? 'completed' : 'noop' };
      }
      if (type === 'core_session_clear_queue') {
        const queue = session.clearQueue();
        return { status: 'completed', ...queue, discardedInputHashes: [...queue.steering, ...queue.followUp]
          .filter((text: unknown) => typeof text === 'string').map((text: string) => createHash('sha256').update(text).digest('hex')),
          discardedContextIds: discardPending(true), pendingContext: [...pending.values()].map(({ inputId, delivery, status }) => ({ inputId, delivery, status })) };
      }
      if (type === 'core_context') {
        const input = command.input;
        if (!input || input.type !== 'context' || typeof input.customType !== 'string' || !input.customType || typeof input.content !== 'string' ||
          !['append', 'nextTurn', 'steer', 'followUp'].includes(command.delivery) || Buffer.byteLength(JSON.stringify(input)) > 262144) throw error('Invalid context input');
        const active = !session.isIdle;
        if (['steer', 'followUp'].includes(command.delivery) && !active && command.wakeIfIdle === false) return { status: 'not-accepted', reason: 'idle' };
        const entry: ContextEntry = { inputId: command.id, delivery: command.delivery, generation: epoch,
          input: { customType: input.customType, content: input.content, details: input.details, display: input.display ?? false },
          status: command.delivery === 'nextTurn' ? 'pending-next-turn' : 'pending-append' };
        pending.set(entry.inputId, entry);
        messages.track(entry.input, entry.inputId);
        if (command.delivery === 'nextTurn') { disposition(entry, entry.status); return { status: entry.status, inputId: command.id }; }
        const triggerTurn = command.delivery !== 'append';
        if (triggerTurn && !active) await beforePrompt();
        if (!pending.has(entry.inputId) || (triggerTurn && (fenced || entry.generation !== epoch))) {
          throw error('Stale context submission', 'NOT_ALLOWED');
        }
        const operation = session.sendCustomMessage(entry.input, { triggerTurn, ...(triggerTurn ? { deliverAs: command.delivery } : {}) });
        if (triggerTurn && !active) void operation.catch((failure: any) => emit({ type: 'error', message: failure.message }));
        else await operation;
        const status = triggerTurn ? active ? 'queued' : 'started' : pending.has(entry.inputId) ? 'pending-append' : 'appended';
        if (pending.has(entry.inputId)) disposition(entry, status);
        return { status, inputId: command.id };
      }
      throw error('Unsupported session operation', 'OPERATION_UNSUPPORTED');
    },
  };
}

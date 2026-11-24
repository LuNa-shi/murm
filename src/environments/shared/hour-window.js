export const HOUR_MS = 3_600_000;
export const WINDOW_MS = HOUR_MS / 4;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Trusted host evidence only: callers verify actual domain artifacts before
 * recording a hash/reference. Settlement alone is never business proof.
 * Injected clocks always produce controlled preparation, never hour acceptance. */
export function createHourWindow({ runtimeId, mode, botIds, clock }) {
  if (!text(runtimeId) || !['flat', 'agensh', 'scaleMAS', 'lead-helper'].includes(mode) ||
      !Array.isArray(botIds) || botIds.length < 4 || botIds.length > 8 ||
      new Set(botIds).size !== botIds.length || !botIds.every(text) ||
      (clock !== undefined && typeof clock !== 'function')) throw new TypeError('Hour window requires fixed Runtime, mode and four to eight distinct Bots');
  const controlled = clock !== undefined;
  const now = clock ?? (() => performance.now());
  const members = new Set(botIds), baselines = new Map(), identities = new Set(), latestSequences = new Map();
  const windows = Array.from({ length: 4 }, () => []);
  let start, handoff, endedAt, last = -Infinity;
  function time() {
    const value = now();
    if (!Number.isFinite(value) || value < 0 || value < last) fail('HOUR_CLOCK_INVALID');
    last = value; return value;
  }
  function record(botId, result, proof) {
    if (!members.has(botId)) fail('HOUR_FOREIGN_BOT');
    if (result?.receipt?.status !== 'accepted' || result.receipt.disposition !== 'started' ||
        !text(result.inputId) || result.receipt.inputId !== result.inputId ||
        result.settled?.botId !== botId || result.settled.outcome !== 'completed' ||
        !Number.isSafeInteger(result.settled.seq) || result.settled.seq < 1) fail('HOUR_INPUT_UNCONFIRMED');
    if (!text(proof?.reference) || !digest(proof?.sha256)) fail('HOUR_BUSINESS_UNCONFIRMED');
    const keys = [`input:${result.inputId}`, `event:${botId}:${result.settled.seq}`, `artifact:${botId}:${proof.reference}`];
    if (keys.some(key => identities.has(key)) || result.settled.seq <= (latestSequences.get(botId) ?? 0)) fail('HOUR_RECEIPT_REUSED');
    if (identities.size >= 1024) fail('HOUR_RECEIPT_LIMIT');
    const row = { botId, inputId: result.inputId, seq: result.settled.seq,
      reference: proof.reference, sha256: proof.sha256, atMs: time() };
    keys.forEach(key => identities.add(key)); latestSequences.set(botId, result.settled.seq); return row;
  }
  return Object.freeze({
    baseline(botId, result, proof) {
      if (start !== undefined || baselines.has(botId)) fail('HOUR_BASELINE_INVALID');
      baselines.set(botId, record(botId, result, proof));
    },
    open() {
      if (start !== undefined || baselines.size !== members.size) fail('HOUR_NOT_READY');
      start = time(); return start;
    },
    progress(botId, result, proof) {
      if (start === undefined || endedAt !== undefined) fail('HOUR_NOT_READY');
      const phase = Math.floor((time() - start) / WINDOW_MS);
      if (phase < 0 || phase > 3) fail('HOUR_OUTSIDE_WINDOW');
      windows[phase].push(record(botId, result, proof));
    },
    handoff(proof) {
      if (start === undefined || time() - start < 3 * WINDOW_MS || last - start >= HOUR_MS) fail('HOUR_HANDOFF_WINDOW');
      if (!text(proof?.kind) || !text(proof?.reference) || !digest(proof?.sha256) || handoff) fail('HOUR_BUSINESS_UNCONFIRMED');
      handoff = { kind: proof.kind, reference: proof.reference, sha256: proof.sha256, atMs: last };
    },
    end() {
      if (start === undefined || time() - start < HOUR_MS) fail('HOUR_TOO_SHORT');
      if (endedAt !== undefined) fail('HOUR_WORK_ALREADY_ENDED');
      endedAt = last;
    },
    finish(cleanup) {
      if (start === undefined || time() - start < HOUR_MS) fail('HOUR_TOO_SHORT');
      if (endedAt === undefined) fail('HOUR_WORK_NOT_ENDED');
      if (windows.some(rows => new Set(rows.map(row => row.botId)).size < 4)) fail('HOUR_WINDOW_INCOMPLETE');
      if (!handoff) fail('HOUR_HANDOFF_MISSING');
      if (cleanup?.cleanup !== 'complete' || !Array.isArray(cleanup.bots) || cleanup.bots.length !== members.size ||
          new Set(cleanup.bots.map(bot => bot.botId)).size !== members.size || cleanup.bots.some(bot =>
            !members.has(bot.botId) || bot.execution !== 'stopped' || bot.cleanup !== 'complete') || cleanup.pending?.length) fail('HOUR_CLEANUP_PENDING');
      return structuredClone({ runtimeId, mode, state: controlled ? 'controlled' : 'work-and-cleanup-verified',
        accepted: false, durationMs: endedAt - start, baselines: [...baselines.values()],
        windows: windows.map((rows, index) => ({ index, botIds: [...new Set(rows.map(row => row.botId))], receipts: rows })),
        handoff, cleanup: { cleanup: 'complete', bots: cleanup.bots.map(({ botId, execution, cleanup }) => ({ botId, execution, cleanup })) } });
    },
    elapsed() {
      if (start === undefined) fail('HOUR_NOT_READY');
      return time() - start;
    },
  });
}

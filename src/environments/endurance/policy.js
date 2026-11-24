import { HOUR_MS } from '../shared/hour-window.js';

const invalid = code => Object.assign(new Error(code), { code });
export const HOUR_QUOTAS = Object.freeze({ maxRequests: 96, maxConcurrent: 2,
  generationOutputTokens: 768, maxOutputTokens: 1024, maxAggregateOutputTokens: 98_304,
  maxInputBytes: 128 * 1024, maxAggregateInputBytes: 8 * 1024 ** 2 });

export function validateHourBudgets(budgets) {
  const bounds = { setupMs: [1, 720_000], workMs: [HOUR_MS, 4_200_000],
    cleanupMs: [1, 600_000], recoveryMs: [0, 300_000], marginMs: [1, 120_000], turnMs: [1, 300_000] };
  if (!budgets || Object.keys(budgets).length !== Object.keys(bounds).length ||
      !Object.entries(bounds).every(([key, [low, high]]) => Number.isSafeInteger(budgets[key]) && budgets[key] >= low && budgets[key] <= high) ||
      budgets.workMs < HOUR_MS + budgets.turnMs) throw invalid('HOUR_BUDGET_INVALID');
  return Object.freeze({ ...budgets });
}

/** One immutable owner and policy for the complete run. Only the independent
 * upstream owner may report provider usage; Bot text is never accounting. */
export function createHourQuotaGate(quota, budgets) {
  const first = quota.receipt();
  const policy = first?.frozenPolicy;
  const phases = { setupMs: budgets.setupMs, workMs: budgets.workMs, cleanupMs: budgets.cleanupMs,
    recoveryMs: budgets.recoveryMs, marginMs: budgets.marginMs };
  if (first?.profile !== 'endurance' || first.model !== 'k3' ||
      !Number.isFinite(first.createdAt) || !Number.isFinite(first.deadlineAt) ||
      first.ownerDeadlineAt !== first.deadlineAt + budgets.cleanupMs + budgets.recoveryMs + budgets.marginMs ||
      !policy || !Object.entries(HOUR_QUOTAS).every(([key, value]) => policy[key] === value) ||
      !Object.entries(phases).every(([key, value]) => policy.phases?.[key] === value)) throw invalid('HOUR_QUOTA_OWNER_INVALID');
  const identity = JSON.stringify({ createdAt: first.createdAt, deadlineAt: first.deadlineAt, ownerDeadlineAt: first.ownerDeadlineAt, policy });
  return function check({ final = false } = {}) {
    const receipt = quota.receipt();
    if (identity !== JSON.stringify({ createdAt: receipt.createdAt, deadlineAt: receipt.deadlineAt, ownerDeadlineAt: receipt.ownerDeadlineAt, policy: receipt.frozenPolicy }) ||
        receipt.profile !== 'endurance' || receipt.model !== 'k3') throw invalid('HOUR_QUOTA_OWNER_CHANGED');
    const counters = ['forwarded', 'committedOutputTokens', 'reservedInputBytes', 'peakConcurrent', 'rejectedArrivals', 'activeRequests', 'outstandingOutputTokens'];
    if (!counters.every(key => Number.isSafeInteger(receipt[key]) && receipt[key] >= 0)) throw invalid('HOUR_QUOTA_RECEIPT_INVALID');
    if (receipt.failure || (!final && receipt.deadlineReached) || receipt.forwarded > HOUR_QUOTAS.maxRequests ||
        receipt.committedOutputTokens > HOUR_QUOTAS.maxAggregateOutputTokens ||
        receipt.reservedInputBytes > HOUR_QUOTAS.maxAggregateInputBytes || receipt.peakConcurrent > HOUR_QUOTAS.maxConcurrent ||
        receipt.rejectedArrivals !== 0 || (!final && receipt.admissionClosed)) throw invalid('HOUR_MODEL_BUDGET_FAILED');
    if (final && (receipt.closed !== true || receipt.admissionClosed !== true || receipt.activeRequests !== 0 ||
        receipt.outstandingOutputTokens !== 0 || receipt.forwarded < 1 || !Array.isArray(receipt.requests) ||
        receipt.requests.length !== receipt.forwarded || receipt.requests.some(row => row.status !== 'complete' ||
          !row.terminal || !Number.isSafeInteger(row.usage?.outputTokens) || row.usage.outputTokens < 0 || row.usage.outputTokens > HOUR_QUOTAS.maxOutputTokens))) {
      throw invalid('HOUR_MODEL_SETTLEMENT_UNKNOWN');
    }
    return receipt;
  };
}

export function createHourRunModelGate(owner, budgets) {
  const first = owner.receipt();
  if (first?.profile !== 'time_only') {
    return { check: createHourQuotaGate(owner, budgets), maxConcurrentInputs: HOUR_QUOTAS.maxConcurrent };
  }
  const { deadlineAt } = first;
  const now = Date.now();
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt < now + budgets.workMs || deadlineAt > now + budgets.setupMs + budgets.workMs) {
    throw invalid('HOUR_MODEL_DEADLINE_INVALID');
  }
  const check = ({ final = false } = {}) => {
    const receipt = owner.receipt();
    if (receipt?.profile !== 'time_only' || receipt.deadlineAt !== deadlineAt) throw invalid('HOUR_MODEL_OWNER_CHANGED');
    const counts = ['forwarded', 'active', 'inputBytes', 'actualInputTokens', 'actualOutputTokens', 'unknownRequests'];
    if (!counts.every(key => Number.isSafeInteger(receipt[key]) && receipt[key] >= 0) ||
        receipt.unknownRequests > receipt.forwarded || receipt.active > receipt.forwarded ||
        typeof receipt.closed !== 'boolean') throw invalid('HOUR_MODEL_RECEIPT_INVALID');
    if (receipt.failure) throw invalid('HOUR_MODEL_METER_FAILED');
    if (!final && (receipt.closed || receipt.deadlineReached || Date.now() >= deadlineAt)) throw invalid('HOUR_MODEL_DEADLINE_REACHED');
    if (final && (!receipt.closed || receipt.active !== 0 || receipt.forwarded < 1)) throw invalid('HOUR_MODEL_METER_NOT_CLOSED');
    return receipt;
  };
  return { check, maxConcurrentInputs: undefined };
}

export function checkHourLifetime(receipt, { runtimeId, botIds, workMs, now, controlled }) {
  if (receipt?.runtimeId !== runtimeId || !Number.isFinite(receipt.workDeadlineAtMs) ||
      receipt.workDeadlineAtMs < (controlled ? now : receipt.observedAtMs) + workMs) throw invalid('HOUR_LIFETIME_UNCONFIRMED');
  if (!controlled && (typeof receipt.clockId !== 'string' || !receipt.clockId ||
      !Number.isFinite(receipt.observedAtMs) || receipt.observedAtMs > now || now - receipt.observedAtMs > 5000 ||
      !Number.isFinite(receipt.stopAtMs) || receipt.stopAtMs < receipt.workDeadlineAtMs ||
      !Array.isArray(receipt.resources) || receipt.resources.length !== botIds.length ||
      new Set(receipt.resources.map(row => row.botId)).size !== botIds.length ||
      new Set(receipt.resources.map(row => row.sandboxId)).size !== botIds.length ||
      receipt.resources.some(row => !botIds.includes(row.botId) || typeof row.sandboxId !== 'string' || !row.sandboxId ||
        !Number.isFinite(row.expiresAtMs) || row.expiresAtMs < receipt.stopAtMs))) throw invalid('HOUR_LIFETIME_UNCONFIRMED');
  return receipt;
}

import { ResponsesBudgetGateway } from './responses-budget-gateway.js';
import { assertShippedModelPair } from './model-catalog.js';
import { isSoftCloseout } from '../task/execution-budget.js';

export const DEFAULT_BENCHMARK_MODEL = Object.freeze({ provider: 'kimi_proxy', model: 'k3' });

export async function assertBenchmarkModelPair({ provider, model, command }) {
  if (typeof command !== 'string' || (command !== 'pi' && !command.endsWith('/pi'))) {
    throw new TypeError('Timed benchmarks require direct Pi');
  }
  return assertShippedModelPair({ provider, model });
}

// Trusted composition seam. Research code receives only a random, revocable
// credential for this gateway; the fixed upstream credential never enters Pi.
export class BotModelAccess {
  constructor({ db, taskService, missionId, provider, model, upstream, configuration, timeBounded = false,
    deadline, closeoutDeadline = () => Infinity, isStopping = () => false, fetchImpl } = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(provider ?? '') || !configuration || typeof deadline !== 'function') {
      throw new TypeError('Explicit provider, model gateway and Mission deadline are required');
    }
    this.provider = provider;
    this.prefix = `PI_${provider.toUpperCase().replaceAll('-', '_')}`;
    this.missionId = missionId;
    this.configuration = configuration;
    this.tokens = new Map();
    this.gateway = new ResponsesBudgetGateway({ db, upstream: { ...upstream, model, contract: configuration.contract },
      limits: configuration.limits, timeBounds: timeBounded ? configuration : undefined, fetchImpl,
      withLifecycleWrite: commit => taskService.withServiceLifecycleWrite(commit),
      validateBot: ({ missionId: requestedMission, botId }) => {
        const at = Date.now();
        const bot = taskService.getBot(botId);
        if (isStopping() || requestedMission !== missionId || bot?.mission_id !== missionId || at >= deadline() ||
            !Number.isFinite(Date.parse(bot?.hard_deadline)) || at >= Date.parse(bot.hard_deadline)) return null;
        if (bot.state === 'UNBOUND') return !taskService.isMissionStopped(missionId) && at < Date.parse(bot.selection_deadline) ? { phase: 'selection', deadline: Math.min(deadline(), Date.parse(bot.hard_deadline), Date.parse(bot.selection_deadline)) } : null;
        if (bot.state !== 'ACTIVE') return null;
        const execution = taskService.getExecution(bot.execution_id);
        const executionDeadline = Date.parse(execution?.execution_deadline);
        const leaseDeadline = Date.parse(execution?.lease_expires_at);
        if (execution?.owner_ref !== botId || execution.state !== 'RUNNING' ||
            !(at < executionDeadline && at < leaseDeadline)) return null;
        if (taskService.isMissionStopped(missionId) && !isSoftCloseout(execution, at)) return null;
        const phase = isSoftCloseout(execution, at) ? 'closeout' : 'work';
        return phase === 'closeout' && at >= closeoutDeadline() ? null : { phase, deadline: Math.min(deadline(), Date.parse(bot.hard_deadline),
          executionDeadline, phase === 'closeout' ? closeoutDeadline() : Infinity),
          executionId: bot.execution_id, fencingVersion: execution.fencing_version, leaseDeadline };
      } });
  }

  async start() {
    const { host = '127.0.0.1', port = 0, advertiseHost = host } = this.configuration;
    if (typeof advertiseHost !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(advertiseHost) || ['0.0.0.0', '::'].includes(advertiseHost)) {
      throw new TypeError('Model gateway requires a concrete advertised host');
    }
    const listening = await this.gateway.start({ host, port });
    const hostname = advertiseHost.includes(':') ? `[${advertiseHost}]` : advertiseHost;
    this.baseUrl = `http://${hostname}:${listening.port}/v1`;
    return this;
  }

  credentialsForBot(bot) {
    if (!this.baseUrl || bot?.mission_id !== this.missionId || !bot.bot_id || this.tokens.has(bot.bot_id)) {
      throw new Error('Model access requires one fresh trusted Bot in this Mission');
    }
    const token = this.gateway.issueToken({ missionId: this.missionId, botId: bot.bot_id });
    this.tokens.set(bot.bot_id, token);
    return { environment: { [`${this.prefix}_BASE_URL`]: this.baseUrl }, secretEnvironment: { [`${this.prefix}_API_KEY`]: token } };
  }

  revokeBot(botId) {
    const token = this.tokens.get(botId);
    if (token) this.gateway.revokeToken(token);
    this.tokens.delete(botId);
  }

  evidence() {
    if (this.gateway.policy.mode === 'time_bounded') return {
      mode: 'time_bounded', policy_digest: this.gateway.pin,
      request_timeout_ms: this.gateway.policy.requestTimeoutMs, max_output_tokens: this.gateway.policy.maxOutputTokens,
      observed_usage: this.gateway.observedUsage(this.missionId), cost: null, cost_unit: null,
    };
    return { policy_digest: this.gateway.pin, cost_unit: this.gateway.policy.costUnit,
      bound_evidence: this.gateway.policy.boundEvidence, limits: this.gateway.limits,
      accounted_upper_bound: this.gateway.totals({ missionId: this.missionId }) };
  }

  stop() { this.tokens.clear(); return this.gateway.stop(); }
}

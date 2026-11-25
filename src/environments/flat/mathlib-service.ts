import type { ServiceRegistration } from '../../core/services.js';
import { SwarmEnvError } from '../../errors.js';
import { assertNewExecutionWork } from '../../task/execution-budget.js';
import { createMathlibSearchManifest, type MathlibSearchService } from '../../services/mathlib-search-service.js';

export function createFlatMathlibService({ provider, runtimeId, taskService, missionId, deadline }: {
  provider: MathlibSearchService;
  runtimeId: () => string | undefined;
  taskService: any;
  missionId: string;
  deadline: () => number;
}): ServiceRegistration {
  const { capabilities } = createMathlibSearchManifest({ mathlibRevision: provider.mathlibRevision, leanVersion: provider.leanVersion });
  const search = capabilities[0];
  return {
    manifest: {
      id: 'mathlib-search', title: 'Mathlib Search', purpose: 'Search the pinned Mathlib source used by the Lean checker.',
      provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' },
      capabilities: [{
        name: 'search', operation: 'mathlib_search', description: search.description, side_effect: 'read', idempotent: true,
        help: { when: search.help.when }, input_schema: search.input_schema, output_schema: { type: 'object' }, errors: search.errors,
      }],
    },
    adapter: {
      async invoke({ input, caller, signal, assertAuthorized }) {
        const binding = () => {
          assertAuthorized();
          const bot = taskService.getBot(caller.botId);
          const until = deadline();
          const execution = bot?.execution_id && taskService.getExecution(bot.execution_id);
          if (caller.runtimeId !== runtimeId() || caller.profile !== 'researcher' || bot?.mission_id !== missionId ||
              bot.state !== 'ACTIVE' || execution?.owner_ref !== bot.bot_id || !Number.isFinite(until) || Date.now() >= until ||
              Date.now() >= Date.parse(execution.lease_expires_at) ||
              taskService.getTask(execution.task_id)?.spec_version !== execution.spec_version) {
            throw new SwarmEnvError('NOT_ALLOWED', 'Mathlib search requires the live execution of this Bot');
          }
          taskService.assertMissionResearchOpen(missionId);
          taskService.assertBotDeadline(bot.bot_id);
          assertNewExecutionWork(execution);
          return execution.fencing_version;
        };
        const fence = binding();
        const result = await provider.search(input, { signal });
        if (binding() !== fence) throw new SwarmEnvError('FENCED', 'Mathlib search owner changed');
        return result;
      },
    },
  };
}

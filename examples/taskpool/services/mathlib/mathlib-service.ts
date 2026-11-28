import type { ServiceRegistration } from '@luna-shi/murm';
import { MurmError } from '../../errors.js';
import { assertNewExecutionWork } from '../task/execution-budget.js';
import { mathlibSearchCapability } from './search-contract.js';

export function createTaskPoolMathlibService({ provider, runtimeId, taskService, missionId, deadline }: {
  provider: { search(input: unknown, options: { signal: AbortSignal }): Promise<any> };
  runtimeId: () => string | undefined;
  taskService: any;
  missionId: string;
  deadline: () => number;
}): ServiceRegistration {
  const search = mathlibSearchCapability();
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
          const agent = taskService.getAgent(caller.agentId);
          const until = deadline();
          const execution = agent?.execution_id && taskService.getExecution(agent.execution_id);
          if (caller.runtimeId !== runtimeId() || caller.profile !== 'researcher' || agent?.mission_id !== missionId ||
              agent.state !== 'ACTIVE' || execution?.owner_ref !== agent.agent_id || !Number.isFinite(until) || Date.now() >= until ||
              Date.now() >= Date.parse(execution.lease_expires_at) ||
              taskService.getTask(execution.task_id)?.spec_version !== execution.spec_version) {
            throw new MurmError('NOT_ALLOWED', 'Mathlib search requires the live execution of this Agent');
          }
          taskService.assertMissionResearchOpen(missionId);
          taskService.assertAgentDeadline(agent.agent_id);
          assertNewExecutionWork(execution);
          return execution.fencing_version;
        };
        const fence = binding();
        const result = await provider.search(input, { signal });
        if (binding() !== fence) throw new MurmError('FENCED', 'Mathlib search owner changed');
        return result;
      },
    },
  };
}

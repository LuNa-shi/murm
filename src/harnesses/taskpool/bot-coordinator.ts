import { taskPoolCoordinationPermissions } from './coordination-permissions.js';
function invalid(message: any) { return Object.assign(new Error(message), { code: 'INVALID_CONTRACT' }); }

/** Host-only startup composition; no model-facing method can mark readiness. */
export function createTaskPoolAgentCoordinator({ runtime, taskService, missionId, coordinationPermissions = [] }: any) {
  if (!runtime?.id || typeof runtime.spawn !== 'function' || typeof runtime.stop !== 'function' ||
      !taskService || typeof missionId !== 'string' || !missionId) throw invalid('Trusted Core Runtime and flat Mission are required');
  const permissions = taskPoolCoordinationPermissions(coordinationPermissions);
  const requests: any = new Map();
  return Object.freeze({
    async spawn({ legacySlotId, selectionDeadline, hardDeadline = selectionDeadline, ...options }: any) {
      if (typeof legacySlotId !== 'string' || !legacySlotId || legacySlotId === runtime.id ||
          !options.requestId || !options.profile || ![selectionDeadline, hardDeadline].every((value: any) =>
            typeof value === 'string' && Number.isFinite(Date.parse(value))) || Date.parse(selectionDeadline) > Date.parse(hardDeadline)) {
        throw invalid('Flat startup requires a distinct legacy Slot and finite ordered deadlines');
      }
      const fingerprint = JSON.stringify({ legacySlotId, selectionDeadline, hardDeadline, options });
      const previous = requests.get(options.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('Flat spawn request parameters conflict'), { code: 'CONFLICT' });
        return structuredClone(await previous.result);
      }
      const result = (async () => {
        taskService.assertMissionResearchOpen(missionId);
        if (Date.now() >= Math.min(Date.parse(selectionDeadline), Date.parse(hardDeadline))) throw invalid('Flat startup deadline elapsed');
        const bot = await runtime.spawn(options);
        try {
          if (bot?.status !== 'idle' || typeof bot.id !== 'string' || !bot.id || bot.profile !== options.profile) throw invalid('Core spawn did not return the requested ready Bot');
          taskService.registerBot({ botId: bot.id, missionId, legacySlotId, selectionDeadline, hardDeadline, coordinationPermissions: permissions });
          taskService.markCoreBotReady(bot.id);
          return bot;
        } catch (error: any) {
          // A failed domain admission must not leave an untracked live Core Bot.
          // Core alone deletes resources; pending cleanup remains visible there.
          try {
            const receipt = await runtime.stop(bot.id);
            const registered = taskService.getBot(bot.id);
            if (registered?.mission_id === missionId && registered.state === 'STARTING') {
              taskService.requestBotStop(bot.id, 'flat-startup-failed');
              if (receipt.cleanup === 'complete') taskService.finalizeBotClose(bot.id);
            }
          } catch { /* Preserve the admission error; Core retains cleanup evidence. */ }
          throw error;
        }
      })();
      requests.set(options.requestId, { fingerprint, result });
      return structuredClone(await result);
    },
  });
}

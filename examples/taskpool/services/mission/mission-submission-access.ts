import { ERROR_CODES, MurmError } from '../../errors.js';

/** Bind the retained Bridge entry to host-owned submission storage and run state. */
export function createMissionSubmissionAccess({ store = null, workspaceId, isStopped }: any = {}) {
  if (store && typeof isStopped !== 'function') throw new TypeError('Mission submission access requires a host stop predicate');
  const requireStore = () => {
    if (!store) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Mission submission is not enabled');
    return store;
  };
  return {
    async submit(input: any = {}) {
      return requireStore().submit({ ...input, workspaceId });
    },
    async describe({ missionId, submissionId = null }: any) {
      return requireStore().describe({ missionId, submissionId, workspaceId, isStopped: () => isStopped(missionId) });
    },
  };
}

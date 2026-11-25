import { MurmError } from '../../errors.js';

/** Host policy only. These are existing domain grants, never Profile inference. */
export function taskPoolCoordinationPermissions(permissions: any = []) {
  if (!Array.isArray(permissions) || [...permissions].some((permission: any) => !['task_dependency_replace', 'unsupersede', 'mission_submit'].includes(permission))) {
    throw new MurmError('INVALID_CONTRACT', 'Flat coordination accepts only existing dependency-replacement, Material-revocation and Mission-submission grants');
  }
  return Object.freeze([...new Set(permissions)]);
}

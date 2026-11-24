import { SwarmEnvError } from '../../errors.js';

/** Host policy only. These are existing domain grants, never Profile inference. */
export function flatCoordinationPermissions(permissions = []) {
  if (!Array.isArray(permissions) || [...permissions].some(permission => !['task_dependency_replace', 'unsupersede'].includes(permission))) {
    throw new SwarmEnvError('INVALID_CONTRACT', 'Flat coordination accepts only existing dependency-replacement and Material-revocation grants');
  }
  return Object.freeze([...new Set(permissions)]);
}

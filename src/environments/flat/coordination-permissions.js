import { SwarmEnvError } from '../../errors.js';

/** Host policy only. These are existing domain grants, never Profile inference. */
export function flatCoordinationPermissions(permissions = []) {
  if (!Array.isArray(permissions) || [...permissions].some(permission => permission !== 'task_dependency_replace')) {
    throw new SwarmEnvError('INVALID_CONTRACT', 'Flat Task coordination accepts only the existing dependency-replacement grant');
  }
  return Object.freeze([...new Set(permissions)]);
}

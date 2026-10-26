export const ERROR_CODES = Object.freeze({
  CONFLICT: 'CONFLICT',
  FENCED: 'FENCED',
  INVALID_CONTRACT: 'INVALID_CONTRACT',
  NOT_ALLOWED: 'NOT_ALLOWED',
  PROCESS_EXITED: 'PROCESS_EXITED',
  RPC_ERROR: 'RPC_ERROR',
  START_FAILED: 'START_FAILED',
  CHECKER_UNAVAILABLE: 'CHECKER_UNAVAILABLE',
  BRANCH_TASK_CANNOT_CREATE_BRANCH: 'BRANCH_TASK_CANNOT_CREATE_BRANCH',
  STALE_VERSION: 'STALE_VERSION',
  BACKPRESSURE_ROOT_UNFINISHED_LIMIT: 'BACKPRESSURE_ROOT_UNFINISHED_LIMIT',
  BACKPRESSURE_ROOT_OPEN_LIMIT: 'BACKPRESSURE_ROOT_OPEN_LIMIT',
  BACKPRESSURE_EXECUTION_CHILD_LIMIT: 'BACKPRESSURE_EXECUTION_CHILD_LIMIT',
  BACKPRESSURE_TURN_MUTATION_LIMIT: 'BACKPRESSURE_TURN_MUTATION_LIMIT',
  FAIRNESS_REQUIRED: 'FAIRNESS_REQUIRED',
  DUPLICATE_RESPONSIBILITY: 'DUPLICATE_RESPONSIBILITY',
  INVALID_TASK_CONTRACT: 'INVALID_TASK_CONTRACT',
});

export class SwarmEnvError extends Error {
  constructor(code, message, details = undefined, options = {}) {
    super(message, options);
    this.name = 'SwarmEnvError';
    this.code = code;
    this.details = details;
    this.retryable = options.retryable ?? false;
  }
}

export function asSwarmEnvError(error, fallbackCode = ERROR_CODES.INVALID_CONTRACT) {
  if (error instanceof SwarmEnvError) return error;
  return new SwarmEnvError(fallbackCode, error?.message ?? String(error), undefined, {
    cause: error,
  });
}

export function fail(code, message, details = undefined, options = {}) {
  throw new SwarmEnvError(code, message, details, options);
}

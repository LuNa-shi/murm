export const ERROR_CODES = Object.freeze({
  CONFLICT: 'CONFLICT',
  INVALID_CONTRACT: 'INVALID_CONTRACT',
  NOT_ALLOWED: 'NOT_ALLOWED',
  START_FAILED: 'START_FAILED',
  AGENT_STARTUP_CONTRACT: 'AGENT_STARTUP_CONTRACT',
  WORKSPACE_BUSY: 'WORKSPACE_BUSY',
  WORKSPACE_RECONCILIATION_REQUIRED: 'WORKSPACE_RECONCILIATION_REQUIRED',
  WORKSPACE_RESULT_UNKNOWN: 'WORKSPACE_RESULT_UNKNOWN',
  SERVICE_MANIFEST_INVALID: 'SERVICE_MANIFEST_INVALID',
  SERVICE_CAPABILITY_NOT_FOUND: 'SERVICE_CAPABILITY_NOT_FOUND',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  SERVICE_NOT_READY: 'SERVICE_NOT_READY',
  SERVICE_TIMEOUT: 'SERVICE_TIMEOUT',
});


export class MurmError extends Error {
  declare code: string;
  declare details: unknown;
  declare retryable: boolean;

  constructor(code: string, message: string, details: unknown = undefined, options: ErrorOptions & { retryable?: boolean } = {}) {
    super(message, options);
    // Preserve the diagnostic name used by existing log consumers.
    this.name = 'MurmError';
    this.code = code;
    this.details = details;
    this.retryable = options.retryable ?? false;
  }
}

export const TASK_STATES = Object.freeze(['OPEN', 'BLOCKED', 'RUNNING', 'DONE', 'CANCELED']);
export const EXECUTION_STATES = Object.freeze(['CREATED', 'RUNNING', 'CLOSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'HANDED_OFF']);
export const ACTIVE_EXECUTION_STATES = Object.freeze(['CREATED', 'RUNNING', 'CLOSING']);
export const TERMINAL_TASK_STATES = Object.freeze(['DONE', 'CANCELED']);
export const TERMINAL_EXECUTION_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'HANDED_OFF']);

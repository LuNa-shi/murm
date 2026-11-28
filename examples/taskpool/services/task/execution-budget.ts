import { ERROR_CODES, MurmError } from '../../errors.js';

export interface CloseoutExecution {
  handoff_reminder_sent_at?: string | null;
  handoff_deadline?: string | null;
  execution_id?: string;
  execution_deadline?: string | null;
}

// The durable boundary applies even when the reminder delivery is delayed.
// A recorded early reminder (for example context pressure) also starts closeout.
export function isSoftCloseout(execution: CloseoutExecution | null | undefined, at: number = Date.now()) {
  return Boolean(execution?.handoff_reminder_sent_at ||
    (execution?.handoff_deadline && Date.parse(execution.handoff_deadline) <= at));
}

export function assertNewExecutionWork(execution: CloseoutExecution | null | undefined, at: number = Date.now()) {
  if (isSoftCloseout(execution, at)) throw new MurmError(ERROR_CODES.NOT_ALLOWED,
    'Soft closeout permits saving, publishing existing work and finish; new research work is closed',
    { phase: 'soft_closeout', execution_id: execution!.execution_id, deadline: execution!.execution_deadline });
}

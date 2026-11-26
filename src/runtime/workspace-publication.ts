import { assertServiceCommitSettled } from '../sdk/service-commit-gate.js';
import { ERROR_CODES, MurmError } from '../errors.js';

/** Keep lifecycle writers outside the synchronous Git publication boundary. */
export function publishWorkspace(db: any, publish: any) {
  try { db.exec('BEGIN IMMEDIATE'); }
  catch (error: any) {
    if (error.errcode === 5) throw new MurmError(ERROR_CODES.WORKSPACE_BUSY, 'Lifecycle publication lock is busy', undefined, { retryable: true, cause: error });
    throw error;
  }
  let published = false;
  try {
    assertServiceCommitSettled(db);
    publish();
    published = true;
    db.exec('COMMIT');
  } catch (error: any) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the publication failure. */ }
    if (published) throw new MurmError(ERROR_CODES.WORKSPACE_RESULT_UNKNOWN,
      'Git publication is durable but lifecycle confirmation failed; retry the original request ID', undefined, { retryable: true, cause: error });
    throw error;
  }
}

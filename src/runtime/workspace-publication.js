import { ERROR_CODES, SwarmEnvError } from '../errors.js';

/** Keep lifecycle writers outside the synchronous Git publication boundary. */
export function publishWorkspace(db, publish) {
  try { db.exec('BEGIN IMMEDIATE'); }
  catch (error) {
    if (error.errcode === 5) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_BUSY, 'Lifecycle publication lock is busy', undefined, { retryable: true, cause: error });
    throw error;
  }
  let published = false;
  try {
    publish();
    published = true;
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the publication failure. */ }
    if (published) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RESULT_UNKNOWN,
      'Git publication is durable but lifecycle confirmation failed; retry the original request ID', undefined, { retryable: true, cause: error });
    throw error;
  }
}

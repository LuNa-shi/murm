/** Includes the native page (up to 1 MiB), JSON envelope and separators. */
export const maxSessionQueryBytes = 1088 * 1024;

/** Read operations on the Worker channel. Mutation receipt lookup uses get_rpc_result. */
export function isSessionQuery(command: unknown): boolean {
  return command === 'core_session_get_state' || command === 'core_session_get_stats' || command === 'core_session_get_messages';
}

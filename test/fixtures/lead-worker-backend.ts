// Only the native transport/collection is simulated; Core, Bridge and Services
// run normally. Actual Git/CLI subprocesses live in the public-seam test.
import { openPiOpenSandboxBackend as open } from './core-agent-service-backend.js';
export { claimPiOpenSandboxBackend } from './core-agent-service-backend.js';
export async function openPiOpenSandboxBackend(...arguments_) {
  return { ...await open(...arguments_), async *collect(_agentId, collect) {
    if (collect.includeGit) yield { type: 'directory', path: '.git' };
    yield { type: 'end', totalBytes: 0, fileCount: 0, directoryCount: collect.includeGit ? 1 : 0 };
  } };
}

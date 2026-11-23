import { openPiOpenSandboxBackend as open } from './core-bot-service-backend.js';
export { claimPiOpenSandboxBackend } from './core-bot-service-backend.js';
export async function openPiOpenSandboxBackend(...arguments_) {
  return { ...await open(...arguments_), async *collect() {
    yield { type: 'directory', path: '.git' };
    yield { type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 1 };
  } };
}

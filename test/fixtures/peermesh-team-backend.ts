import { openPiOpenSandboxBackend as open, transport } from './core-agent-service-backend.js';
export { claimPiOpenSandboxBackend } from './core-agent-service-backend.js';
export async function openPiOpenSandboxBackend(...arguments_) {
  return { ...await open(...arguments_), async *collect(...parameters) {
    await transport.onCollect?.(...parameters);
    yield { type: 'directory', path: '.git' };
    yield { type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 1 };
  } };
}

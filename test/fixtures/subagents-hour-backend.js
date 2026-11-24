import { openPiOpenSandboxBackend as open, transport } from './core-bot-service-backend.js';
export { claimPiOpenSandboxBackend } from './core-bot-service-backend.js';
export async function openPiOpenSandboxBackend(...args) {
  return { ...await open(...args), async *collect(botId, spec) { yield* transport.onCollect(botId, spec); } };
}

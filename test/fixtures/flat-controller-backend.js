// Simulate external provider/Worker failures while retaining the real Runtime.
import { decodeFileSeed } from '../../scripts/core-file-seed.js';
import { openPiOpenSandboxBackend as openBase } from './core-input-backend.js';
export { claimPiOpenSandboxBackend, transport } from './core-input-backend.js';
export const controls={stopError:null,destroyError:null,credentials:new Map(),preparedFiles:new Map(),onPrepare:null};
export async function openPiOpenSandboxBackend(config,ports) {
  const backend=await openBase();
  return {...backend,
    async spawn(input) {controls.credentials.set(input.botId,ports.bridge.credentialsForBot(input.botId));return backend.spawn(input);},
    async prepareFiles(botId,input) {const decoded=decodeFileSeed(input.files);controls.preparedFiles.set(botId,decoded.entries);await controls.onPrepare?.(botId,decoded.entries);return {version:input.version,digest:decoded.digest};},
    async grantFiles(botId,input) {return {...input,writable:true};},
    async stopExecution(...args) {if(controls.stopError) throw controls.stopError;return backend.stopExecution(...args);},
    async destroy(...args) {if(controls.destroyError) throw controls.destroyError;return backend.destroy(...args);},
  };
}

// Simulate external provider/Worker failures while retaining the real Runtime.
import { decodeFileSeed } from '../../scripts/core-file-seed.js';
import { openOpenSandboxBackend as openBase } from './core-input-backend.js';
export { claimOpenSandboxBackend, transport } from './core-input-backend.js';
export const controls={stopError:null,destroyError:null,credentials:new Map(),preparedFiles:new Map(),onPrepare:null};
export async function openOpenSandboxBackend(config,ports) {
  const backend=await openBase();
  return {...backend,
    async spawn(input) {controls.credentials.set(input.agentId,ports.bridge.credentialsForAgent(input.agentId));return backend.spawn(input);},
    async prepareFiles(agentId,input) {const decoded=decodeFileSeed(input.files);controls.preparedFiles.set(agentId,decoded.entries);await controls.onPrepare?.(agentId,decoded.entries);return {version:input.version,digest:decoded.digest};},
    async grantFiles(agentId,input) {return {...input,writable:true};},
    async stopExecution(...args) {if(controls.stopError) throw controls.stopError;return backend.stopExecution(...args);},
    async destroy(...args) {if(controls.destroyError) throw controls.destroyError;return backend.destroy(...args);},
  };
}

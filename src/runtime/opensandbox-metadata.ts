import { createHash } from 'node:crypto';

function key(prefix: string, identity: string | NodeJS.ArrayBufferView) {
  return `${prefix}-${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`;
}

export const openSandboxMissionKey = (missionId: string) => key('m', missionId);
export const openSandboxBotKey = (botId: string) => key('b', botId);

export const openSandboxRuntimeKey = (runtimeId: string) => key('r', runtimeId);

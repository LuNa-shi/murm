import { createHash } from 'node:crypto';

function key(prefix, identity) {
  return `${prefix}-${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`;
}

export const openSandboxMissionKey = missionId => key('m', missionId);
export const openSandboxBotKey = botId => key('b', botId);
export const openSandboxExecutionKey = executionId => key('e', executionId);

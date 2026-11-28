import type { AgentSessionConfig, AgentSessionPatch, ContextInput, ContextSendOptions } from './session-types.js';
import { stableStringify } from '../protocol/stable-json.js';

const tools = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Session settings require plain objects');
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unknown or unsupported session setting');
}
export function snapshotSessionConfig(input: AgentSessionConfig | undefined, dynamic = false): AgentSessionConfig | undefined {
  if (input === undefined) return undefined;
  object(input);
  keys(input, dynamic ? ['thinkingLevel', 'steeringMode', 'followUpMode', 'compaction', 'retry'] : ['thinkingLevel', 'steeringMode', 'followUpMode', 'compaction', 'retry', 'tools', 'resources']);
  if (input.thinkingLevel !== undefined && !levels.has(input.thinkingLevel as string)) throw new TypeError('Invalid thinkingLevel');
  for (const key of ['steeringMode', 'followUpMode']) if (input[key] !== undefined && !['all', 'one-at-a-time'].includes(input[key] as string)) throw new TypeError('Invalid queue mode');
  for (const key of ['compaction', 'retry']) {
    if (input[key] === undefined) continue;
    const value = input[key]; object(value);
    keys(value, dynamic ? ['enabled'] : key === 'compaction' ? ['enabled', 'reserveTokens', 'keepRecentTokens'] : ['enabled', 'maxRetries', 'baseDelayMs', 'maxAgentDelayMs']);
    for (const [name, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (name === 'enabled' ? typeof item !== 'boolean' : !Number.isSafeInteger(item) || (item as number) < (name === 'maxRetries' ? 0 : 1)) throw new TypeError(`Invalid ${key}.${name}`);
    }
  }
  if (input.tools !== undefined && (!Array.isArray(input.tools) || new Set(input.tools).size !== input.tools.length || input.tools.some(tool => !tools.has(tool)))) throw new TypeError('Invalid tools loadout');
  if (input.resources !== undefined) {
    object(input.resources); keys(input.resources, ['skills', 'extensions', 'promptTemplates', 'contextFiles']);
    for (const paths of Object.values(input.resources)) {
      if (!Array.isArray(paths) || paths.length > 64 || paths.some(path => typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || path.length > 4096)) throw new TypeError('Resources require explicit absolute Guest paths');
    }
  }
  return JSON.parse(JSON.stringify(input));
}
export function mergeSessionConfig(base?: AgentSessionConfig, override?: AgentSessionConfig): AgentSessionConfig | undefined {
  if (!base && !override) return undefined;
  base = snapshotSessionConfig(base);
  override = snapshotSessionConfig(override);
  const combined = { ...base, ...override };
  for (const key of ['compaction', 'retry', 'resources'] as const) {
    if (base?.[key] || override?.[key]) (combined as Record<string, unknown>)[key] = { ...base?.[key], ...override?.[key] };
  }
  return snapshotSessionConfig(combined);
}
export function snapshotContext(input: ContextInput, options: ContextSendOptions) {
  object(input); keys(input, ['type', 'customType', 'content', 'display', 'details']);
  if (input.type !== 'context' || typeof input.customType !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.customType) || typeof input.content !== 'string' ||
      (input.display !== undefined && typeof input.display !== 'boolean')) throw new TypeError('Invalid context input');
  object(options); keys(options, ['requestId', 'delivery', 'wakeIfIdle', 'source']);
  if (!['append', 'nextTurn', 'steer', 'followUp'].includes(options.delivery) ||
      (options.wakeIfIdle !== undefined && (typeof options.wakeIfIdle !== 'boolean' || !['steer', 'followUp'].includes(options.delivery))) ||
      (options.source !== undefined && (typeof options.source !== 'string' || !options.source.trim() || options.source.length > 256))) throw new TypeError('Invalid context delivery options');
  const serialized = stableStringify(input);
  if (Buffer.byteLength(serialized) > 256 * 1024) throw new TypeError('Context exceeds 256 KiB');
  const snapshot = JSON.parse(serialized) as ContextInput;
  snapshot.display ??= false;
  return snapshot;
}

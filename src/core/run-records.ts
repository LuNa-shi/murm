import type { Profile, ErrorInfo } from './types.js';
import type { ResolvedOpenSandboxBackendConfig } from './sandbox/opensandbox-backend.js';
import type { ServiceRegistration } from './services.js';

import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { defaultTimedResponsesLimits } from './model/responses-budget-gateway.js';
import { permittedServiceManifests } from './bridge.js';
import { renderStartupPrompt } from './startup-prompt.js';
import { getAdapterMetadata } from './services.js';
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';

const packageInfo = JSON.parse(readFileSync(findPackageJSON(import.meta.url)!, 'utf8'));

const queueLimit = 4096;
const queueBytesLimit = 8 * 1024 ** 2;
const redactMarker = '[redacted]';
const credentialField = /^(?:authorization|proxy.authorization|api.?key|access.?token|refresh.?token|client.?secret|password|secret.?env)$/i;

export function createRedactor(values: readonly unknown[] = []) {
  const secrets = new Set<string>();
  let pattern: RegExp | undefined;
  let longest = 0;

  function addSecret(value: string) {
    for (const text of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value.toWellFormed())]) {
      secrets.add(text);
      longest = Math.max(longest, text.length);
    }
  }

  function add(values: readonly unknown[]) {
    for (const value of values) {
      if (typeof value !== 'string' || !value) continue;
      addSecret(value);
      const credential = /^(?:Bearer|Basic)\s+(\S+)$/i.exec(value)?.[1];
      if (credential) addSecret(credential);
    }
    pattern = undefined;
  }

  function matchingSecrets() {
    pattern ??= new RegExp([...secrets].sort((a, b) => b.length - a.length)
      .map(secret => secret.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|'), 'g');
    return pattern;
  }

  function text(value: string): string;
  function text(value: unknown): unknown;
  function text(value: unknown): unknown {
    return typeof value === 'string' && secrets.size ? value.replace(matchingSecrets(), redactMarker) : value;
  }

  function value(data: unknown): unknown {
    if (Array.isArray(data)) return data.map(value);
    if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data).map(([key, item]) =>
      [text(key), credentialField.test(key) ? redactMarker : value(item)]));
    return text(data);
  }

  function stream() {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    return {
      write(bytes: Uint8Array) {
        pending += decoder.write(bytes);
        let safeEnd = Math.max(0, pending.length - longest);
        if (safeEnd === 0) return '';
        // A match starting in the stable prefix can also consume the padded suffix.
        for (const match of secrets.size ? pending.matchAll(matchingSecrets()) : []) {
          if (match.index >= safeEnd) break;
          safeEnd = Math.max(safeEnd, match.index + match[0].length);
        }
        if (pending.charCodeAt(safeEnd - 1) >= 0xD800 && pending.charCodeAt(safeEnd - 1) <= 0xDBFF) safeEnd--;
        const result = text(pending.slice(0, safeEnd));
        pending = pending.slice(safeEnd);
        return result;
      },
      end() {
        const result = text(pending + decoder.end());
        pending = '';
        return result;
      },
    };
  }

  function jsonl() {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    function redactLine(line: string) {
      if (!line.trim()) return line;
      const record = JSON.parse(line);
      const redacted = JSON.stringify(value(record));
      return redacted === JSON.stringify(record) ? line : redacted;
    }
    return {
      write(bytes: Uint8Array) {
        const lines = (pending + decoder.write(bytes)).split('\n');
        pending = lines.pop()!;
        return lines.map(line => redactLine(line) + '\n').join('');
      },
      end() {
        return redactLine(pending + decoder.end());
      },
    };
  }

  function error(caught: unknown, fallback = 'SERVICE_UNAVAILABLE'): ErrorInfo {
    const value = caught as { code?: unknown; message?: unknown; retryable?: unknown } | null | undefined;
    return {
      code: text(typeof value?.code === 'string' ? value.code : fallback),
      message: text(typeof value?.message === 'string' ? value.message : 'Operation failed'),
      retryable: value?.retryable === true,
    };
  }

  add(values);
  return { add, text, value, stream, jsonl, error };
}

export function runtimeConfiguration({ config, profiles, registrations, maxAgents, defaultTimeoutMs }: {
  config: ResolvedOpenSandboxBackendConfig;
  profiles: ReadonlyMap<string, Profile>;
  registrations: ReadonlyMap<string, ServiceRegistration>;
  maxAgents: number;
  defaultTimeoutMs: number;
}, redact: (value: string) => string) {
  const { sandbox, isolation, models, modelGateway, driver, provider } = config;
  const cpu = sandbox.resourceLimits?.cpu ?? '2';
  const memory = sandbox.resourceLimits?.memory ?? '2Gi';
  return {
    schemaVersion: 1,
    coreVersion: packageInfo.version,
    maxAgents,
    backend: {
      type: `${driver.kind}-${provider?.id ?? 'opensandbox'}`, [`${driver.kind}Version`]: driver.version,
      authMode: 'api-key', capabilities: driver.capabilities, network: isolation.network,
      ...(provider ? {} : { cpu: redact(cpu), memory: redact(memory) }),
      provider: provider ? { id: provider.id, version: redact(provider.version), capabilities: provider.capabilities } :
        { id: 'opensandbox', version: 'sdk-1.2.1' },
      constraints: {
        requested: { ...sandbox.resourceLimits },
        ...(sandbox.resourceRequests ? { schedulingRequests: sandbox.resourceRequests } : {}),
        ...(provider ? {} : { configured: { cpu: redact(cpu), memory: redact(memory) } }),
      },
    },
    waiting: {
      hostDefaultMs: defaultTimeoutMs, workerStartupMs: 30_000, piReadyMs: 10_000, piSubmitMs: 30_000,
      piSubmitTransportMs: 40_000, fileOperationTransportMs: 30_000, workerStopTransportMs: 15_000, collectionTransportMs: 30_000,
      providerCommandMs: sandbox.commandTimeoutMs ?? 120_000, bridgeServiceMs: 30_000,
    },
    filePolicy: config.filePolicy,
    models: Object.fromEntries(Object.entries(models).map(([alias, model]) => [alias, {
      provider: model.provider, model: model.model,
      protocol: typeof model.protocol === 'object' ? { id: model.protocol.id, version: model.protocol.version } : model.protocol ?? 'responses',
      maxOutputTokens: modelGateway.maxOutputTokens === undefined ? defaultTimedResponsesLimits.maxOutputTokens : modelGateway.maxOutputTokens,
      ...(modelGateway.maxRequests === undefined ? {} : { maxRequests: modelGateway.maxRequests }),
      requestTimeoutMs: modelGateway.requestTimeoutMs ?? defaultTimedResponsesLimits.requestTimeoutMs,
    }])),
    profiles: Object.fromEntries([...profiles].map(([id, profile]) => [id, {
      model: profile.model, image: redact(profile.image), writable: profile.writable, services: profile.services,
      environmentKeys: Object.keys(profile.env ?? {}).sort(), network: profile.network, collect: profile.collect,
      session: profile.session, spawnProfiles: profile.spawnProfiles, promptSha256: createHash('sha256').update(profile.prompt ?? '').digest('hex'),
      stagedSystemPromptSha256: createHash('sha256').update(renderStartupPrompt(permittedServiceManifests(registrations, profile.services), profile.prompt, driver.kind, config.models[profile.model].capabilities?.tools === false ? [] : profile.session?.tools)).digest('hex'),
    }])),
    services: [...registrations.values()].map(({ manifest, adapter }) => ({
      id: manifest.id, transport: manifest.endpoint.transport, ...getAdapterMetadata(adapter),
    })),
  };
}

export type RunEvidenceRecord = Readonly<Record<string, unknown>> & {
  type: string;
  seq: number;
  runtimeId: string;
  at: string;
};

export function createRunRecords(outputDir: string, runtimeId: string, controllerEpoch?: number) {
  const path = join(outputDir, controllerEpoch === undefined ? 'evidence.jsonl' : `evidence-recovery-${controllerEpoch}.jsonl`);
  let queued: string[] = [];
  let queuedBytes = 0;
  let writer: Promise<void> | undefined;
  let sequence = 0;
  let written = 0;
  let lost = 0;
  let initialized = false;

  function progress() { return { recorded: written, lost, pending: sequence - written - lost }; }

  function lose(count: number) {
    lost += count;
  }

  async function drain() {
    try {
      while (queued.length) {
        const batch = queued;
        queued = [];
        queuedBytes = 0;
        try {
          await appendFile(path, batch.join(''), { mode: 0o600, flag: 'a' });
          written += batch.length;
        } catch {
          lose(batch.length);
        }
      }
    } finally {
      writer = undefined;
    }
  }

  return {
    async initialize() {
      await writeFile(path, '', { flag: 'wx', mode: 0o600 });
      initialized = true;
    },
    record(type: string, data: Readonly<Record<string, unknown>>) {
      const row = { ...data, type, seq: ++sequence, runtimeId, at: new Date().toISOString() };
      let line;
      try { line = JSON.stringify(row) + '\n'; }
      catch { lose(1); return; }
      const bytes = Buffer.byteLength(line);
      if (queued.length >= queueLimit || queuedBytes + bytes > queueBytesLimit) {
        lose(1);
        return;
      }
      queued.push(line);
      queuedBytes += bytes;
      writer ??= Promise.resolve().then(drain);
    },
    async flush() {
      while (writer) await writer;
    },
    snapshot() { return { ...(initialized ? { path } : {}), ...progress() }; },
  };
}

import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultTimedResponsesLimits } from '../agent/responses-budget-gateway.js';
import { getAdapterMetadata } from './services.js';
import packageInfo from '../../package.json' with { type: 'json' };

const queueLimit = 4096;
const queueBytesLimit = 8 * 1024 ** 2;
const redactMarker = '[redacted]';

export function createRedactor(values = []) {
  const secrets = new Set();
  let pattern;

  function add(values) {
    for (const value of values) {
      if (typeof value !== 'string' || !value) continue;
      secrets.add(value);
      const credential = /^(?:Bearer|Basic)\s+(\S+)$/i.exec(value)?.[1];
      if (credential) secrets.add(credential);
    }
    pattern = undefined;
  }

  function text(value) {
    if (typeof value !== 'string' || !secrets.size) return value;
    pattern ??= new RegExp([...secrets].sort((a, b) => b.length - a.length)
      .map(secret => secret.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|'), 'g');
    return value.replace(pattern, redactMarker);
  }

  function error(value, fallback = 'SERVICE_UNAVAILABLE') {
    return {
      code: text(typeof value?.code === 'string' ? value.code : fallback),
      message: text(typeof value?.message === 'string' ? value.message : 'Operation failed'),
      retryable: value?.retryable === true,
    };
  }

  add(values);
  return { add, text, error };
}

export function runtimeConfiguration({ config, profiles, registrations, maxBots, modelAccessPolicy, defaultTimeoutMs }, redact) {
  const { sandbox, isolation, models, modelGateway } = config;
  return {
    schemaVersion: 1,
    coreVersion: packageInfo.version,
    maxBots,
    backend: {
      type: 'pi-opensandbox', piVersion: '1.3.0', network: isolation.network, disk: isolation.disk,
      cpu: redact(sandbox.resourceLimits?.cpu ?? '2'), memory: redact(sandbox.resourceLimits?.memory ?? '2Gi'),
    },
    waiting: {
      hostDefaultMs: defaultTimeoutMs, workerStartupMs: 30_000, piReadyMs: 10_000, piSubmitMs: 30_000,
      piSubmitTransportMs: 40_000, fileOperationTransportMs: 30_000, workerStopTransportMs: 15_000, collectionTransportMs: 30_000,
      providerCommandMs: sandbox.commandTimeoutMs ?? 120_000, bridgeServiceMs: 30_000,
    },
    modelAccessPolicy: modelAccessPolicy ? 'host' : 'default',
    models: Object.fromEntries(Object.entries(models).map(([alias, model]) => [alias, {
      provider: model.provider, model: model.model,
      maxOutputTokens: modelGateway.maxOutputTokens === undefined ? defaultTimedResponsesLimits.maxOutputTokens : modelGateway.maxOutputTokens,
      requestTimeoutMs: modelGateway.requestTimeoutMs ?? defaultTimedResponsesLimits.requestTimeoutMs,
    }])),
    profiles: Object.fromEntries([...profiles].map(([id, profile]) => [id, {
      model: profile.model, image: redact(profile.image), writable: profile.writable, services: profile.services,
      environmentKeys: Object.keys(profile.env ?? {}).sort(), network: profile.network, collect: profile.collect,
      spawnProfiles: profile.spawnProfiles, promptSha256: createHash('sha256').update(profile.prompt).digest('hex'),
    }])),
    services: [...registrations.values()].map(({ manifest, adapter }) => ({
      id: manifest.id, transport: manifest.endpoint.transport, ...getAdapterMetadata(adapter),
    })),
  };
}

export function createRunRecords(outputDir, runtimeId) {
  const path = join(outputDir, 'evidence.jsonl');
  let queued = [];
  let queuedBytes = 0;
  let writer;
  let sequence = 0;
  let written = 0;
  let lost = 0;
  let initialized = false;

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
          lost += batch.length;
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
    record(type, data) {
      const seq = ++sequence;
      let line;
      try { line = JSON.stringify({ ...data, type, seq, runtimeId, at: new Date().toISOString() }) + '\n'; }
      catch { lost++; return; }
      const bytes = Buffer.byteLength(line);
      if (queued.length >= queueLimit || queuedBytes + bytes > queueBytesLimit) {
        lost++;
        return;
      }
      queued.push(line);
      queuedBytes += bytes;
      writer ??= Promise.resolve().then(drain);
    },
    async flush() {
      while (writer) await writer;
    },
    snapshot() { return { ...(initialized ? { path } : {}), recorded: written, lost, pending: sequence - written - lost }; },
  };
}

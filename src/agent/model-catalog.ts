import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { modelClientProtocol } from '../core/model-transport.js';
import type { ModelConfig } from '../core/backend-config.js';

const PROVIDER_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/;

export interface PiModelCatalogSelection {
  path: string;
  sha256: string;
  content?: string;
  capabilities: NonNullable<ModelConfig['capabilities']>;
  capabilitySource: 'shipped-catalog' | 'configured' | 'compatibility-default';
}

export async function resolvePiModelCatalog({ provider, model, capabilities, protocol }:
  Pick<ModelConfig, 'provider' | 'model' | 'capabilities' | 'protocol'>): Promise<PiModelCatalogSelection> {
  if (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider)) {
    throw new TypeError('Configured Pi provider must be a non-empty alphanumeric, underscore, or hyphen identifier');
  }
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model) || model.includes('..')) {
    throw new TypeError('Configured Pi model ID must be a valid non-empty model identifier');
  }
  const prefix = `PI_${provider.toUpperCase().replaceAll('-', '_')}`;
  const catalogBytes = await readFile(new URL('../../deploy/worker/pi-models.json', import.meta.url));
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  const entry = Object.hasOwn(catalog.providers ?? {}, provider) ? catalog.providers[provider] : null;
  const api = modelClientProtocol(protocol) === 'chat-completions' ? 'openai-completions' : 'openai-responses';
  const row = entry?.models?.find((item: any) => item.id === model);
  const shipped = row && entry?.api === api && entry.baseUrl === `$${prefix}_BASE_URL` &&
    entry.apiKey === `$${prefix}_API_KEY` && entry.authHeader === true;
  if (!capabilities && shipped) {
    return { path: '/opt/murm/pi-agent/models.json', sha256: createHash('sha256').update(catalogBytes).digest('hex'),
      capabilities: { contextWindow: row.contextWindow, maxOutputTokens: row.maxTokens, tools: true, reasoning: row.reasoning },
      capabilitySource: 'shipped-catalog' };
  }
  const effective = capabilities ?? { contextWindow: 32768, maxOutputTokens: 8192, tools: true, reasoning: false };
  const synthesized = `${JSON.stringify({
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {
      [provider]: {
        name: provider,
        baseUrl: `$${prefix}_BASE_URL`,
        api,
        apiKey: `$${prefix}_API_KEY`,
        authHeader: true,
        compat: {
          supportsReasoningEffort: effective.reasoning,
          supportsDeveloperRole: api === 'openai-responses',
          supportsStrictMode: api === 'openai-responses',
          ...(api === 'openai-responses' ? { supportsMaxOutputTokens: true } : { supportsStore: false }),
        },
        models: [
          {
            id: model,
            name: model,
            reasoning: effective.reasoning,
            contextWindow: effective.contextWindow,
            maxTokens: effective.maxOutputTokens,
          },
        ],
      },
    },
  }, null, 2)}\n`;
  return {
    path: '/workspace/runtime/pi-agent/models.json',
    sha256: createHash('sha256').update(synthesized, 'utf8').digest('hex'),
    content: synthesized,
    capabilities: effective,
    capabilitySource: capabilities ? 'configured' : 'compatibility-default',
  };
}

export const assertShippedModelPair = resolvePiModelCatalog;

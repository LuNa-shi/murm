import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const PROVIDER_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/;

export interface PiModelCatalogSelection {
  path: string;
  sha256: string;
  content?: string;
}

export async function resolvePiModelCatalog({ provider, model }: { provider: unknown; model: unknown }): Promise<PiModelCatalogSelection> {
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
  if (entry?.api === 'openai-responses' && entry.baseUrl === `$${prefix}_BASE_URL` &&
      entry.apiKey === `$${prefix}_API_KEY` && entry.authHeader === true &&
      entry.models?.some((item: any) => item.id === model)) {
    return { path: '/opt/murm/pi-agent/models.json', sha256: createHash('sha256').update(catalogBytes).digest('hex') };
  }
  const synthesized = `${JSON.stringify({
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {
      [provider]: {
        name: provider,
        baseUrl: `$${prefix}_BASE_URL`,
        api: 'openai-responses',
        apiKey: `$${prefix}_API_KEY`,
        authHeader: true,
        compat: {
          supportsReasoningEffort: true,
          supportsDeveloperRole: true,
          supportsStrictMode: true,
          supportsMaxOutputTokens: true,
        },
        models: [
          {
            id: model,
            name: model,
            reasoning: true,
            contextWindow: 256000,
            maxTokens: 128000,
          },
        ],
      },
    },
  }, null, 2)}\n`;
  return {
    path: '/workspace/runtime/pi-agent/models.json',
    sha256: createHash('sha256').update(synthesized, 'utf8').digest('hex'),
    content: synthesized,
  };
}

export const assertShippedModelPair = resolvePiModelCatalog;

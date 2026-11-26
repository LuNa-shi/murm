import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function assertShippedModelPair({ provider, model }: { provider: unknown; model: unknown }) {
  const catalogBytes = await readFile(new URL('../../services/opensandbox-agent/pi-models.json', import.meta.url));
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  const name = typeof provider === 'string' && /^[a-zA-Z0-9_-]+$/.test(provider) ? provider : null;
  const entry = name && Object.hasOwn(catalog.providers, name) ? catalog.providers[name] : null;
  const prefix = name ? `PI_${name.toUpperCase().replaceAll('-', '_')}` : null;
  if (entry?.api !== 'openai-responses' || entry.baseUrl !== `$${prefix}_BASE_URL` ||
      entry.apiKey !== `$${prefix}_API_KEY` || entry.authHeader !== true || !entry.models?.some((item: any) => item.id === model)) {
    throw new TypeError('Configured provider and model do not match the Responses catalog shipped in the Agent image');
  }
  return { path: '/opt/murm/pi-agent/models.json', sha256: createHash('sha256').update(catalogBytes).digest('hex') };
}

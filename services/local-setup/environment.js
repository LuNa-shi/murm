import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadEnvironment(configUrl = import.meta.url) {
  const filename = resolve(dirname(fileURLToPath(configUrl)), '.env');
  if (existsSync(filename)) process.loadEnvFile(filename);
}

loadEnvironment();

import { readFile, writeFile } from 'node:fs/promises';
import { createFinalTreeArtifactLock } from '../src/judge/final-tree-deployment.js';

const [configurationPath, sourcesPath, outputPath] = process.argv.slice(2);
if (!configurationPath || !sourcesPath || !outputPath) {
  throw new Error('Usage: node dist/scripts/lock-final-tree-checker.js <trusted-checker-config.json> <approved-source-checkouts.json> <new-lock.json>');
}

const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
const sources = JSON.parse(await readFile(sourcesPath, 'utf8'));
const lock = await createFinalTreeArtifactLock({ configuration, sources });
await writeFile(outputPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${lock.sha256}\n`);

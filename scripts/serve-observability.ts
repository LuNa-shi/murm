#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ObservationStore, ObservationStoreCollection } from '../src/observability/observation-store.js';
import { OBSERVABILITY_AUTH_VERSION, ObservabilityServer, observabilityAccessMode } from '../src/observability/observability-server.js';
import { FileWorkspaceProvider } from '../src/observability/workspace-provider.js';

function optionsFromArgs(argv: string[]) {
  const options = {
    root: 'experiments',
    db: null,
    metadata: null,
    host: '127.0.0.1',
    advertiseHost: null,
    port: 8787,
    additionalRoots: [] as string[],
    scanRoots: [] as string[],
  };
  let rootWasExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [key, inline] = arg.split('=', 2);
    const value = inline ?? argv[++index];
    if (key === '--root') {
      if (rootWasExplicit) options.additionalRoots.push(value);
      else { options.root = value; rootWasExplicit = true; }
      continue;
    }
    if (key === '--scan-root') {
      options.scanRoots.push(value);
      continue;
    }
    const fields = {
      '--db': 'db',
      '--metadata': 'metadata',
      '--host': 'host',
      '--advertise-host': 'advertiseHost',
      '--port': 'port',
    };
    if (!(fields as Record<string, any>)[key]) throw new Error(`unknown option: ${arg}`);
    (options as Record<string, any>)[(fields as Record<string, any>)[key]] = key === '--port' ? Number(value) : value;
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error('--port must be an integer between 0 and 65535');
  return options;
}

function isDirectory(path: any) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function inferRepositoryWorktreeRoots(options: ReturnType<typeof optionsFromArgs>) {
  const scanRoots = new Set(options.scanRoots.map(root => resolve(root)));
  const experimentRoots = [options.root, ...options.additionalRoots];
  for (const root of experimentRoots) {
    const repositoryRoot = dirname(resolve(root));
    if (!isDirectory(repositoryRoot)) continue;
    for (const name of ['.worktrees', '.worktree']) {
      const candidate = join(repositoryRoot, name);
      // Keep the conventional path even before the directory exists. The
      // registry rescan can then discover a worktree created while the daemon
      // is already serving Observation Store queries.
      scanRoots.add(candidate);
    }
  }
  return [...scanRoots];
}

function discoverExperimentRoots(options: ReturnType<typeof optionsFromArgs>) {
  const roots = new Set([resolve(options.root), ...options.additionalRoots.map(root => resolve(root))]);
  for (const scanRoot of options.scanRoots) {
    if (!isDirectory(scanRoot)) continue;
    if (basename(scanRoot) === 'experiments' || isDirectory(join(scanRoot, '.observability'))) roots.add(scanRoot);
    let entries: any[] = [];
    try { entries = readdirSync(scanRoot, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(scanRoot, entry.name, 'experiments');
      if (isDirectory(candidate)) roots.add(candidate);
    }
  }
  return [...roots];
}

const MAX_DATABASE_SCAN_DEPTH = 5;

function collectObservationDatabases(directory: any, depth: any, databases: any) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === 'observability.sqlite') databases.add(resolve(path));
    else if (entry.isDirectory() && depth > 0 && entry.name !== '.git' && entry.name !== 'node_modules') collectObservationDatabases(path, depth - 1, databases);
  }
}

function discoverObservationDatabases(options: any) {
  const databases = new Set();
  for (const root of discoverExperimentRoots(options)) collectObservationDatabases(root, MAX_DATABASE_SCAN_DEPTH, databases);
  return [...databases];
}

async function writeMetadata(path: any, metadata: any) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(metadata, null, 2));
  await rename(temporaryPath, path);
}

const options = optionsFromArgs(process.argv.slice(2));
const operatorPassword = process.env.SWARMENV_OBSERVABILITY_OPERATOR_PASSWORD ?? null;
const accessMode = observabilityAccessMode({ host: options.host, operatorPassword });
options.scanRoots = inferRepositoryWorktreeRoots(options);
const experimentRoots = discoverExperimentRoots(options);
const experimentRoot = experimentRoots[0];
const databasePath = options.db ? resolve(options.db) : join(experimentRoot, '.observability', 'observability.sqlite');
const metadataPath = options.metadata ? resolve(options.metadata) : join(experimentRoot, '.observability', 'server.json');
await mkdir(dirname(databasePath), { recursive: true });
await mkdir(dirname(metadataPath), { recursive: true });

async function readServerMetadata(path: any) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function serverIsHealthy(metadata: any) {
  if (!metadata?.port || !metadata.host || metadata.host !== options.host || metadata.access_mode !== accessMode) return false;
  const host = metadata.host === '0.0.0.0' || metadata.host === '::' ? '127.0.0.1' : metadata.host;
  try {
    const response = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${metadata.port}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const health = await response.json() as { auth_version: number; access_mode: string };
    return health.auth_version === OBSERVABILITY_AUTH_VERSION && health.access_mode === accessMode;
  } catch {
    return false;
  }
}

const existingServer = await readServerMetadata(metadataPath);
if (existingServer && existingServer.pid !== process.pid && await serverIsHealthy(existingServer)) {
  process.stdout.write(JSON.stringify({ ...existingServer, reused: true }) + '\n');
  process.exit(0);
}

const primaryStore = new ObservationStore(databasePath);
const observationStore = new ObservationStoreCollection({
  stores: [primaryStore],
  discover: () => discoverObservationDatabases(options),
  watchPaths: [...experimentRoots, ...options.scanRoots.map(root => resolve(root))],
});
const server = new ObservabilityServer({
  observationStore,
  experimentRoot,
  workspaceProvider: new FileWorkspaceProvider({ observationStore }),
  host: options.host,
  advertiseHost: options.advertiseHost,
  operatorPassword,
});
const address = await server.start({ port: options.port });
const metadata = {
  schema_version: 2,
  access_mode: address.access_mode,
  pid: process.pid,
  persistent: true,
  experiment_root: experimentRoot,
  experiment_roots: experimentRoots,
  scan_roots: options.scanRoots.map(root => resolve(root)),
  database_path: databasePath,
  metadata_path: metadataPath,
  host: address.host,
  advertise_host: address.advertise_host,
  port: address.port,
  url: address.url,
  started_at: new Date().toISOString(),
};
await writeMetadata(metadataPath, metadata);
process.stdout.write(JSON.stringify({
  url: address.url,
  host: address.host,
  advertise_host: address.advertise_host,
  port: address.port,
  database_path: databasePath,
  experiment_roots: experimentRoots,
  scan_roots: options.scanRoots.map(root => resolve(root)),
}) + '\n');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  observationStore.close();
  try {
    const current = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (current.pid === process.pid) await unlink(metadataPath);
  } catch {
    // The metadata may have been replaced by a newer daemon.
  }
}
process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });

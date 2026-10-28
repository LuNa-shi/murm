#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ObservationStore, ObservationStoreCollection } from '../src/observability/observation-store.js';
import { ObservabilityServer } from '../src/observability/observability-server.js';
import { importBenchmarkReport } from '../src/observability/benchmark-report-importer.js';
import { FileWorkspaceProvider } from '../src/observability/workspace-provider.js';

function optionsFromArgs(argv) {
  const options = {
    reportPath: null,
    experimentDir: null,
    root: 'experiments',
    db: null,
    metadata: null,
    host: '127.0.0.1',
    advertiseHost: null,
    port: 8787,
    includeRawLogs: true,
    additionalRoots: [],
    scanRoots: [],
  };
  let rootWasExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-raw-logs') { options.includeRawLogs = false; continue; }
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
      '--report': 'reportPath',
      '--experiment-dir': 'experimentDir',
      '--db': 'db',
      '--metadata': 'metadata',
      '--host': 'host',
      '--advertise-host': 'advertiseHost',
      '--port': 'port',
    };
    if (!fields[key]) throw new Error(`unknown option: ${arg}`);
    options[fields[key]] = key === '--port' ? Number(value) : value;
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error('--port must be an integer between 0 and 65535');
  return options;
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function discoverExperimentRoots(options) {
  const roots = new Set([resolve(options.root), ...options.additionalRoots.map((root) => resolve(root))]);
  for (const scanRoot of options.scanRoots.map((root) => resolve(root))) {
    if (!isDirectory(scanRoot)) continue;
    if (basename(scanRoot) === 'experiments' || isDirectory(join(scanRoot, '.observability'))) roots.add(scanRoot);
    let entries = [];
    try { entries = readdirSync(scanRoot, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(scanRoot, entry.name, 'experiments');
      if (isDirectory(candidate)) roots.add(candidate);
    }
  }
  return [...roots];
}

function collectObservationDatabases(directory, depth, databases) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === 'observability.sqlite') databases.add(resolve(path));
    else if (entry.isDirectory() && depth > 0 && entry.name !== '.git' && entry.name !== 'node_modules') collectObservationDatabases(path, depth - 1, databases);
  }
}

function discoverObservationDatabases(options) {
  const databases = new Set();
  for (const root of discoverExperimentRoots(options)) collectObservationDatabases(root, 2, databases);
  return [...databases];
}

async function writeMetadata(path, metadata) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(metadata, null, 2));
  await rename(temporaryPath, path);
}

const options = optionsFromArgs(process.argv.slice(2));
const experimentRoots = discoverExperimentRoots(options);
const experimentRoot = experimentRoots[0];
const experimentDir = options.experimentDir ? resolve(options.experimentDir) : null;
const databasePath = options.db ? resolve(options.db) : join(experimentRoot, '.observability', 'observability.sqlite');
const metadataPath = options.metadata ? resolve(options.metadata) : join(experimentRoot, '.observability', 'server.json');
await mkdir(dirname(databasePath), { recursive: true });
await mkdir(dirname(metadataPath), { recursive: true });

async function readServerMetadata(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function serverIsHealthy(metadata) {
  if (!metadata?.port || !metadata.host) return false;
  const host = metadata.host === '0.0.0.0' || metadata.host === '::' ? '127.0.0.1' : metadata.host;
  try {
    const response = await fetch(`http://${host}:${metadata.port}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

const existingServer = await readServerMetadata(metadataPath);
if (existingServer && existingServer.pid !== process.pid && await serverIsHealthy(existingServer)) {
  let imported = { imported_events: 0, raw_event_count: 0, report_path: null, experiment_id: null };
  if (options.reportPath) {
    const existingStore = new ObservationStore(resolve(existingServer.database_path ?? databasePath));
    const importedReport = await importBenchmarkReport({
      observationStore: existingStore,
      reportPath: options.reportPath,
      experimentDir,
      includeRawLogs: options.includeRawLogs,
    });
    imported = {
      imported_events: importedReport.imported_events,
      raw_event_count: importedReport.raw_event_count,
      report_path: importedReport.report_path,
      experiment_id: importedReport.experiment?.experiment_id ?? null,
    };
    existingStore.close();
  }
  process.stdout.write(JSON.stringify({ ...existingServer, ...imported, reused: true }) + '\n');
  process.exit(0);
}

const primaryStore = new ObservationStore(databasePath);
const imported = options.reportPath
  ? await importBenchmarkReport({
    observationStore: primaryStore,
    reportPath: options.reportPath,
    experimentDir,
    includeRawLogs: options.includeRawLogs,
  })
  : { experiment: null, imported_events: 0, raw_event_count: 0, report_path: null };
const observationStore = new ObservationStoreCollection({
  stores: [primaryStore],
  discover: () => discoverObservationDatabases(options),
  watchPaths: [...experimentRoots, ...options.scanRoots.map((root) => resolve(root))],
});
const server = new ObservabilityServer({
  observationStore,
  experimentRoot,
  workspaceProvider: new FileWorkspaceProvider({ observationStore }),
  host: options.host,
  advertiseHost: options.advertiseHost,
});
const address = await server.start({ port: options.port });
const metadata = {
  schema_version: 1,
  pid: process.pid,
  persistent: true,
  experiment_root: experimentRoot,
  experiment_roots: experimentRoots,
  scan_roots: options.scanRoots.map((root) => resolve(root)),
  database_path: databasePath,
  metadata_path: metadataPath,
  host: address.host,
  advertise_host: address.advertise_host,
  port: address.port,
  url: address.url,
  started_at: new Date().toISOString(),
  experiment_id: imported.experiment?.experiment_id ?? null,
};
await writeMetadata(metadataPath, metadata);
process.stdout.write(JSON.stringify({
  url: address.url,
  host: address.host,
  advertise_host: address.advertise_host,
  port: address.port,
  experiment_id: imported.experiment?.experiment_id ?? null,
  imported_events: imported.imported_events,
  raw_event_count: imported.raw_event_count,
  report_path: imported.report_path,
  database_path: databasePath,
  experiment_roots: experimentRoots,
  scan_roots: options.scanRoots.map((root) => resolve(root)),
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

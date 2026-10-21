#!/usr/bin/env node
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ObservationStore } from '../src/observability/observation-store.js';
import { ObservabilityServer } from '../src/observability/observability-server.js';
import { importBenchmarkReport } from '../src/observability/benchmark-report-importer.js';
import { FileWorkspaceProvider } from '../src/observability/workspace-provider.js';

function optionsFromArgs(argv) {
  const options = {
    reportPath: null,
    experimentDir: null,
    root: 'experiments',
    db: null,
    host: '127.0.0.1',
    advertiseHost: null,
    port: 8787,
    includeRawLogs: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-raw-logs') { options.includeRawLogs = false; continue; }
    const [key, inline] = arg.split('=', 2);
    const value = inline ?? argv[++index];
    const fields = {
      '--report': 'reportPath',
      '--experiment-dir': 'experimentDir',
      '--root': 'root',
      '--db': 'db',
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

async function writeMetadata(path, metadata) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(metadata, null, 2));
  await rename(temporaryPath, path);
}

const options = optionsFromArgs(process.argv.slice(2));
const experimentRoot = resolve(options.root);
const experimentDir = options.experimentDir ? resolve(options.experimentDir) : null;
const databasePath = options.db ? resolve(options.db) : join(experimentRoot, '.observability', 'observability.sqlite');
const metadataPath = join(experimentRoot, '.observability', 'server.json');
await mkdir(dirname(databasePath), { recursive: true });
await mkdir(dirname(metadataPath), { recursive: true });

const observationStore = new ObservationStore(databasePath);
const imported = options.reportPath
  ? await importBenchmarkReport({
    observationStore,
    reportPath: options.reportPath,
    experimentDir,
    includeRawLogs: options.includeRawLogs,
  })
  : { experiment: null, imported_events: 0, raw_event_count: 0, report_path: null };
const server = new ObservabilityServer({
  observationStore,
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

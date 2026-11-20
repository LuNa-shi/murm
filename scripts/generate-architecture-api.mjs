#!/usr/bin/env node
import { SERVICE_COMMIT_SCHEMA_SQL, CONTEXT_PEER_SCHEMA_SQL, JUDGE_PEER_SCHEMA_SQL } from '../src/storage/service-peer-schema.js';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { builtInServiceManifest, createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';
import { listTools } from '../src/sdk/service-catalog.js';
import { buildCapabilityProfile } from '../src/agent/capability-profile.js';
import { SCHEMA_SQL } from '../src/storage/schema.js';
import { CONTEXT_SCHEMA_SQL } from '../src/storage/context-schema.js';
import { JUDGE_SCHEMA_SQL } from '../src/storage/judge-schema.js';
import { OBSERVATION_SCHEMA_SQL } from '../src/observability/observation-store.js';
import { ERROR_CODES } from '../src/errors.js';
import { DatabaseSync } from 'node:sqlite';
import { EXECUTION_WORKSPACE_SCHEMA_SQL } from '../src/runtime/execution-workspace.js';
import { TaskService } from '../src/task/task-service.js';
import { RESPONSES_BUDGET_SCHEMA_SQL } from '../src/agent/responses-budget-gateway.js';
import { MANUAL_MISSION_REVIEW_SCHEMA_SQL } from '../src/runtime/manual-mission-review.js';
import { MISSION_SUBMISSION_SCHEMA_SQL } from '../src/runtime/mission-submission.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: node scripts/generate-architecture-api.mjs [--check]');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fence = (language, value) => `\n\`\`\`${language}\n${value.trimEnd()}\n\`\`\`\n`;
const json = (value) => fence('json', JSON.stringify(value, null, 2));
const registry = createBuiltinServiceRegistry({});
const sourcePaths = [
  'src/sdk/service-catalog.js', 'src/sdk/builtin-registry.js', 'src/sdk/service-manifest.js',
  'src/sdk/service-registry.js', 'src/agent/capability-profile.js', 'src/agent/services-bridge.js',
  'src/benchmark/putnam-runner.js',
  'services/mathlib-search/service.json', 'src/errors.js',
];
const sourceRows = await Promise.all(sourcePaths.map(async (path) => `| [${path}](../../${path}) | \`${hash(await readFile(resolve(root, path)))}\` |`));
let api = '## Generated API inventory\n\nThis section is generated from executable exports and checked against the source hashes below. It contains declarations; call-time behavior and known differences are explained in [Services](04-services.md), [Mission and Task](03-mission-task.md), and [Workspace](05-workspace-continuity.md).\n\n| Source | SHA-256 |\n|---|---|\n' + sourceRows.join('\n') + '\n';
api += '\n### Exact built-in command operation surface\n\nBots use native Bash to invoke typed swarm commands. Registry declarations below describe authorized domain operations; no additional Pi tool registration is installed. Optional Services extend the Registry.\n\n';
const profile = buildCapabilityProfile({ role: 'bound', registry });
api += '| Capability identity | Service | Operation |\n|---|---|---|\n';
for (const cap of profile.capabilities) api += `| \`${cap.id}\` | \`${cap.service_id}\` | \`${cap.operation}\` |\n`;
for (const serviceId of ['catalog', 'task', 'context', 'judge']) {
  const manifest = builtInServiceManifest(serviceId);
  const {capabilities, ...metadata} = manifest;
  api += `\n### ${manifest.title}: ${capabilities.length} registered capabilities\n\nExact normalized built-in manifest metadata:\n${json(metadata)}`;
  for (const cap of capabilities) api += `\n#### ${serviceId}.${cap.name}\n\n${cap.description}\n${json(cap)}`;
}
api += '\n### Optional Mathlib Search manifest\n\nExact repository bundle declaration. Loading the bundle additionally binds its documentation hashes into the normalized manifest; deployment endpoint overrides change the manifest hash. The implementation also returns `duration_ms` and, after fallback, `fallback`/`upstream_error_code`; these are not listed in this declaration\'s closed output schema.\n';
api += fence('json', await readFile(resolve(root, 'services/mathlib-search/service.json'), 'utf8'));
const represented = new Set(['task', 'context', 'judge', 'catalog'].flatMap((serviceId) => builtInServiceManifest(serviceId).capabilities.map((cap) => `${serviceId}:${cap.operation}`)));
const internalExtras = listTools(null, { includeInternal: true }).filter((cap) => !represented.has(`${cap.service}:${cap.operation}`));
const uniqueInternalExtras = [...new Map(internalExtras.map((cap) => [`${cap.service}:${cap.operation}:${cap.name}`,cap])).values()];
api += '\n### Internal catalog entries\n\nThis section records catalog declarations used by trusted service composition but not exposed as Agent operations. It is not an authorization list for the Agent.\n';
for (const cap of uniqueInternalExtras) api += `\n#### Catalog ${cap.service}.${cap.name} / ${cap.operation}\n${json(cap)}`;
api += '\n### Exact shared error-code vocabulary\n' + json(ERROR_CODES);

const schemas = [
  ['Task-owned independent service commit gates', 'src/storage/service-peer-schema.js', SERVICE_COMMIT_SCHEMA_SQL],
  ['Context peer receipts', 'src/storage/service-peer-schema.js', CONTEXT_PEER_SCHEMA_SQL],
  ['Judge peer launch phases', 'src/storage/service-peer-schema.js', JUDGE_PEER_SCHEMA_SQL],
  ['Model budget gateway', 'src/agent/responses-budget-gateway.js', RESPONSES_BUDGET_SCHEMA_SQL],
  ['Mission submission coordinator', 'src/runtime/mission-submission.js', MISSION_SUBMISSION_SCHEMA_SQL],
  ['Owner-local manual Mission review', 'src/runtime/manual-mission-review.js', MANUAL_MISSION_REVIEW_SCHEMA_SQL],
  ['Execution Workspace coordinator', 'src/runtime/execution-workspace.js', EXECUTION_WORKSPACE_SCHEMA_SQL],
  ['Task and Execution database', 'src/storage/schema.js', SCHEMA_SQL],
  ['Context database', 'src/storage/context-schema.js', CONTEXT_SCHEMA_SQL],
  ['Judge database', 'src/storage/judge-schema.js', JUDGE_SCHEMA_SQL],
  ['Observation database', 'src/observability/observation-store.js', OBSERVATION_SCHEMA_SQL],
];
let storage = '## Generated SQL schema reference\n\nThe SQL below is the complete exported create-schema text, including checks, keys and indexes. It is schema text, not an export of a user database. The `tasks` interpolation is expanded. Constructors initialize the current schema on new databases. Shared `operations` declarations intentionally appear in several owners because the services can share a SQLite connection.\n';
for (const [label, path, sql] of schemas) {
  storage += `\n### ${label}\n\nSource: [${path}](../../${path}); source SHA-256: \`${hash(await readFile(resolve(root, path)))}\`.\n${fence('sql',sql.trim())}`;
}

const schemaOnly = new DatabaseSync(':memory:');
schemaOnly.exec(SCHEMA_SQL);
schemaOnly.exec(CONTEXT_SCHEMA_SQL);
schemaOnly.exec(JUDGE_SCHEMA_SQL);
const priorObjects = new Set(schemaOnly.prepare('SELECT name FROM sqlite_master').all().map((row) => row.name));
const initialized = new TaskService(schemaOnly);
const supplemental = schemaOnly.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().filter((row) => !priorObjects.has(row.name));
storage += '\n### Constructor-added schema objects\n\nFresh Task Service initialization adds the following objects beyond the exported create-schema strings. Source: [src/task/task-service.js](../../src/task/task-service.js); SHA-256: `' + hash(await readFile(resolve(root, 'src/task/task-service.js'))) + '`.\n';
for (const row of supplemental) storage += '\n#### ' + row.name + '\n' + fence('sql', row.sql + ';');
initialized.close();

let changed = false;
for (const [relative, generated] of [['docs/architecture/10-service-api-reference.md',api], ['docs/architecture/11-storage-reference.md',storage]]) {
  const path = resolve(root, relative);
  const existing = await readFile(path, 'utf8');
  const marker = /<!-- BEGIN GENERATED REFERENCE -->[\s\S]*?<!-- END GENERATED REFERENCE -->/;
  if (!marker.test(existing)) throw new Error(`${relative}: generated markers missing`);
  const expected = existing.replace(marker, () => `<!-- BEGIN GENERATED REFERENCE -->\n\n${generated.trimEnd()}\n\n<!-- END GENERATED REFERENCE -->`);
  if (existing !== expected) {
    changed = true;
    if (check) console.error(`Stale reference: ${relative}`);
    else { await writeFile(path, expected); console.log(`Updated ${relative}`); }
  } else console.log(`Current ${relative}`);
}
if (check && changed) process.exitCode = 1;

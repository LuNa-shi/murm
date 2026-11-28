#!/usr/bin/env node
import { SERVICE_COMMIT_SCHEMA_SQL, CONTEXT_PEER_SCHEMA_SQL, JUDGE_PEER_SCHEMA_SQL } from '../examples/taskpool/persistence/service-peer-schema.js';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { builtInServiceManifest, createBuiltinServiceRegistry } from '../examples/taskpool/services/builtin-registry.js';
import { listTools } from '../examples/taskpool/services/service-catalog.js';
import { buildCapabilityProfile } from '../test-support/taskpool-legacy/capability-profile.js';
import { SCHEMA_SQL } from '../examples/taskpool/services/task/schema.js';
import { CONTEXT_SCHEMA_SQL } from '../examples/taskpool/services/material/context-schema.js';
import { JUDGE_SCHEMA_SQL } from '../examples/taskpool/services/judge/judge-schema.js';
import { ERROR_CODES } from '../examples/taskpool/errors.js';
import { DatabaseSync } from 'node:sqlite';
import { EXECUTION_WORKSPACE_SCHEMA_SQL } from '../examples/taskpool/services/workspace/execution-workspace.js';
import { TaskService } from '../examples/taskpool/services/task/task-service.js';
import { CORE_MODEL_SCHEMA_SQL } from '../src/core/model/responses-budget-gateway.js';
import { MANUAL_MISSION_REVIEW_SCHEMA_SQL } from '../examples/taskpool/services/mission/manual-mission-review.js';
import { MISSION_SUBMISSION_SCHEMA_SQL } from '../examples/taskpool/services/mission/mission-submission.js';
import { SERVICE_HISTORY_SCHEMA_SQL } from '../examples/taskpool/persistence/service-history.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const check = process.argv.includes('--check');
if (process.argv.slice(2).some((arg: any) => arg !== '--check')) throw new Error('Usage: node scripts/generate-architecture-api.js [--check]');
const hash = (value: any) => createHash('sha256').update(value).digest('hex');
const fence = (language: any, value: any) => `\n\`\`\`${language}\n${value.trimEnd()}\n\`\`\`\n`;
const json = (value: any) => fence('json', JSON.stringify(value, null, 2));
const registry = createBuiltinServiceRegistry({});
const sourcePaths = [
  'examples/taskpool/services/service-catalog.ts', 'examples/taskpool/services/builtin-registry.ts', 'examples/taskpool/deploy/service-hosts/service-manifest.ts',
  'examples/taskpool/deploy/service-hosts/service-registry.ts', 'test-support/taskpool-legacy/capability-profile.ts', 'test-support/taskpool-legacy/services-bridge.ts',
  'examples/services/mathlib-search/service.json', 'src/errors.ts',
  'src/core/index.ts', 'src/core/types.ts', 'src/core/services.ts', 'src/core/service-types.ts',
  'src/core/sandbox/opensandbox-backend.ts', 'src/core/sandbox/executor-driver.ts', 'src/core/backend-config.ts',
  'src/core/sandbox/opensandbox-provider.ts', 'src/core/sandbox/sandbox-connection.ts',
];
const sourceRows = await Promise.all(sourcePaths.map(async (path: any) => `| [${path}](../../${path}) | \`${hash(await readFile(resolve(root, path)))}\` |`));
let api = '## Generated API inventory\n\nThis section is generated from executable exports and checked against the source hashes below. It contains declarations; call-time behavior and known differences are explained in [Services](04-services.md), [Mission and Task](03-mission-task.md), and [Workspace](05-workspace-continuity.md).\n\n| Source | SHA-256 |\n|---|---|\n' + sourceRows.join('\n') + '\n';
api += '\n### Exact built-in command operation surface\n\nAgents use native Bash to invoke typed swarm commands. Registry declarations below describe authorized domain operations; no additional Pi tool registration is installed. Optional Services extend the Registry.\n\n';
const profile = buildCapabilityProfile({ role: 'bound', registry });
api += '| Capability identity | Service | Operation |\n|---|---|---|\n';
for (const cap of profile.capabilities) api += `| \`${cap.id}\` | \`${cap.service_id}\` | \`${cap.operation}\` |\n`;
for (const serviceId of ['catalog', 'task', 'context', 'judge']) {
  const manifest = builtInServiceManifest(serviceId)!;
  const {capabilities, ...metadata} = manifest;
  api += `\n### ${manifest.title}: ${capabilities.length} registered capabilities\n\nExact normalized built-in manifest metadata:\n${json(metadata)}`;
  for (const cap of capabilities) api += `\n#### ${serviceId}.${cap.name}\n\n${cap.description}\n${json(cap)}`;
}
api += '\n### Optional Mathlib Search manifest\n\nExact repository bundle declaration. Loading the bundle additionally binds its documentation hashes into the normalized manifest; deployment endpoint overrides change the manifest hash. The implementation also returns `duration_ms` and, after fallback, `fallback`/`upstream_error_code`; these are not listed in this declaration\'s closed output schema.\n';
api += fence('json', await readFile(resolve(root, 'examples/services/mathlib-search/service.json'), 'utf8'));
const represented = new Set(['task', 'context', 'judge', 'catalog'].flatMap((serviceId: any) => builtInServiceManifest(serviceId)!.capabilities.map((cap: any) => `${serviceId}:${cap.operation}`)));
const internalExtras: { service: string; operation: string; name: string }[] = listTools(null, { includeInternal: true }).filter((cap: any) => !represented.has(`${cap.service}:${cap.operation}`));
const uniqueInternalExtras = [...new Map(internalExtras.map(cap => [`${cap.service}:${cap.operation}:${cap.name}`, cap] as const)).values()];
api += '\n### Internal catalog entries\n\nThis section records catalog declarations used by trusted service composition but not exposed as Agent operations. It is not an authorization list for the Agent.\n';
for (const cap of uniqueInternalExtras) api += `\n#### Catalog ${cap.service}.${cap.name} / ${cap.operation}\n${json(cap)}`;
api += '\n### Exact shared error-code vocabulary\n' + json(ERROR_CODES);
api += '\n### Core public declarations\n\nThese are the package entrypoint declarations and the declarations they reference. [Core Runtime](15-core-runtime.md) describes the executable contracts and limits.\n';
for (const source of sourcePaths.filter((path: any) => path.startsWith('src/core/'))) {
  const declaration = 'dist/' + source.replace(/\.ts$/, '.d.ts');
  api += `\n#### ${declaration}\n${fence('ts', await readFile(resolve(root, declaration), 'utf8'))}`;
}

const { ALLOCATION_SCHEMA_SQL } = await import('../src/core/allocation-ledger.js');
const schemas = [
  ['Core Runtime allocation ownership', 'src/core/allocation-ledger.ts', ALLOCATION_SCHEMA_SQL],
  ['Automatic service history', 'examples/taskpool/persistence/service-history.ts', SERVICE_HISTORY_SCHEMA_SQL],
  ['Task-owned independent service commit gates', 'examples/taskpool/persistence/service-peer-schema.ts', SERVICE_COMMIT_SCHEMA_SQL],
  ['Context peer receipts', 'examples/taskpool/persistence/service-peer-schema.ts', CONTEXT_PEER_SCHEMA_SQL],
  ['Judge peer launch phases', 'examples/taskpool/persistence/service-peer-schema.ts', JUDGE_PEER_SCHEMA_SQL],
  ['Core Runtime model attempts', 'src/core/model/responses-budget-gateway.ts', CORE_MODEL_SCHEMA_SQL],
  ['Mission submission coordinator', 'examples/taskpool/services/mission/mission-submission.ts', MISSION_SUBMISSION_SCHEMA_SQL],
  ['Owner-local manual Mission review', 'examples/taskpool/services/mission/manual-mission-review.ts', MANUAL_MISSION_REVIEW_SCHEMA_SQL],
  ['Execution Workspace coordinator', 'examples/taskpool/services/workspace/execution-workspace.ts', EXECUTION_WORKSPACE_SCHEMA_SQL],
  ['Task and Execution database', 'examples/taskpool/services/task/schema.ts', SCHEMA_SQL],
  ['Context database', 'examples/taskpool/services/material/context-schema.ts', CONTEXT_SCHEMA_SQL],
  ['Judge database', 'examples/taskpool/services/judge/judge-schema.ts', JUDGE_SCHEMA_SQL],
];
let storage = '## Generated SQL schema reference\n\nThe SQL below is the complete exported create-schema text, including checks, keys and indexes. It is schema text, not an export of a user database. The `tasks` interpolation is expanded. Constructors initialize the current schema on new databases. Shared `operations` declarations intentionally appear in several owners because the services can share a SQLite connection.\n';
for (const [label, path, sql] of schemas) {
  storage += `\n### ${label}\n\nSource: [${path}](../../${path}); source SHA-256: \`${hash(await readFile(resolve(root, path)))}\`.\n${fence('sql',sql.trim())}`;
}

const schemaOnly = new DatabaseSync(':memory:');
schemaOnly.exec(SCHEMA_SQL);
schemaOnly.exec(CONTEXT_SCHEMA_SQL);
schemaOnly.exec(JUDGE_SCHEMA_SQL);
const priorObjects = new Set(schemaOnly.prepare('SELECT name FROM sqlite_master').all().map((row: any) => row.name));
const initialized = new TaskService(schemaOnly);
const supplemental = schemaOnly.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().filter((row: any) => !priorObjects.has(row.name));
storage += '\n### Constructor-added schema objects\n\nFresh Task Service initialization adds the following objects beyond the exported create-schema strings. Source: [examples/taskpool/services/task/task-service.ts](../../examples/taskpool/services/task/task-service.ts); SHA-256: `' + hash(await readFile(resolve(root, 'examples/taskpool/services/task/task-service.ts'))) + '`.\n';
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

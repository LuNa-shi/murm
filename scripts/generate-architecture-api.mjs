#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { builtInServiceManifest, createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';
import { listTools } from '../src/sdk/service-catalog.js';
import { buildCapabilityProfile } from '../src/agent/capability-profile.js';
import { runtimeCapabilityList } from '../src/runtime/runtime-capabilities.js';
import { SCHEMA_SQL } from '../src/storage/schema.js';
import { CONTEXT_SCHEMA_SQL } from '../src/storage/context-schema.js';
import { JUDGE_SCHEMA_SQL } from '../src/storage/judge-schema.js';
import { OBSERVATION_SCHEMA_SQL } from '../src/observability/observation-store.js';
import { ERROR_CODES } from '../src/errors.js';
import { DatabaseSync } from 'node:sqlite';
import { EXECUTION_WORKSPACE_SCHEMA_SQL } from '../src/runtime/execution-workspace.js';
import { TaskService } from '../src/task/task-service.js';

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
  'src/sdk/services-sdk.js', 'src/sdk/service-router.js',
  'src/runtime/runtime-capabilities.js', 'src/benchmark/putnam-runner.js',
  'services/mathlib-search/service.json', 'src/errors.js',
];
const sourceRows = await Promise.all(sourcePaths.map(async (path) => `| [${path}](../../${path}) | \`${hash(await readFile(resolve(root, path)))}\` |`));
let api = '## Generated API inventory\n\nThis section is generated from executable exports and checked against the source hashes below. It contains declarations; call-time behavior and known differences are explained in [Services](04-services.md), [Mission and Task](03-mission-task.md), and [Workspace](05-workspace-continuity.md).\n\n| Source | SHA-256 |\n|---|---|\n' + sourceRows.join('\n') + '\n';
api += '\n### Exact tool exposure for the built-in benchmark\n\nThe four columns apply the benchmark\'s current Task-model and Sandbox filters. Optional registered Services add capabilities. Both built-in `bound` and `recovery` roles currently have the same named surface. Presence in this table does not bypass the Bridge\'s Task/Execution binding, modern-retired-operation or Workspace-contract checks. `swarmenv_` is the Pi extension prefix.\n\n';
const profiles = [];
for (const model of ['flat']) for (const sandbox of [false, true]) {
  const runtimeCapabilities = runtimeCapabilityList()
    .filter((capability) => sandbox || !['sandbox_exec', 'sandbox_job'].includes(capability.operation))
    ;
  profiles.push({ label: `${model}; Sandbox ${sandbox ? 'on' : 'off'}`, profile: buildCapabilityProfile({ role: 'bound', registry, runtimeCapabilities }) });
}
const ids = [...new Set(profiles.flatMap(({profile}) => profile.capabilities.map((capability) => capability.id)))].sort();
api += `| Capability identity | ${profiles.map(({label}) => label).join(' | ')} |\n|---|${profiles.map(() => '---').join('|')}|\n`;
for (const id of ids) api += `| \`${id}\` | ${profiles.map(({profile}) => { const cap = profile.capabilities.find((capability) => capability.id === id); return cap ? `\`swarmenv_${cap.tool_name ?? cap.name}\`` : 'Absent'; }).join(' | ')} |\n`;
api += '\nThe flat Mission Task profile is the only Agent-facing Task model. Retired structural and lease operations may remain in internal catalog definitions for storage/analysis compatibility, but are filtered from the built-in Registry and cannot be called by a bound Agent. The normal handoff tool is `execution_progress` with `kind: "handoff"`.\n';
for (const serviceId of ['catalog', 'task', 'context', 'judge']) {
  const manifest = builtInServiceManifest(serviceId);
  const {capabilities, ...metadata} = manifest;
  api += `\n### ${manifest.title}: ${capabilities.length} registered capabilities\n\nExact normalized built-in manifest metadata:\n${json(metadata)}`;
  for (const cap of capabilities) api += `\n#### ${serviceId}.${cap.name}\n\n${cap.description}\n${json(cap)}`;
}
api += '\n### Runtime-owned capabilities\n\nThese declarations are merged into a Session profile after deployment filtering. They are not registered HTTP providers. Most Runtime output schemas are empty strict-object placeholders; they do not enumerate the actual return fields described in the narrative chapters.\n';
for (const cap of runtimeCapabilityList()) api += `\n#### ${cap.id}\n${json(cap)}`;
api += '\n### Optional Mathlib Search manifest\n\nExact repository bundle declaration. Loading the bundle additionally binds its documentation hashes into the normalized manifest; deployment endpoint overrides change the manifest hash. The implementation also returns `duration_ms` and, after fallback, `fallback`/`upstream_error_code`; these are not listed in this declaration\'s closed output schema.\n';
api += fence('json', await readFile(resolve(root, 'services/mathlib-search/service.json'), 'utf8'));
const represented = new Set(['task', 'context', 'judge', 'catalog'].flatMap((serviceId) => builtInServiceManifest(serviceId).capabilities.map((cap) => `${serviceId}:${cap.operation}`)));
const legacy = listTools(null, { includeInternal: true }).filter((cap) => !represented.has(`${cap.service}:${cap.operation}`));
const uniqueLegacy = [...new Map(legacy.map((cap) => [`${cap.service}:${cap.operation}:${cap.name}`,cap])).values()];
api += '\n### Additional catalog entries retained for compatibility/internal callers\n\nThis section records every extra catalog declaration not represented by the registered built-in operation set above. It is not an authorization list for the current Agent. Internal SDK/domain methods can have additional operations that are never a model tool; see the operation routing section in [Services](04-services.md).\n';
for (const cap of uniqueLegacy) api += `\n#### Catalog ${cap.service}.${cap.name} / ${cap.operation}\n${json(cap)}`;
api += '\n### Complete local SDK dispatch mapping\n\nThe SDK constructor requires `dispatch` and `actorRef`. `withContext` creates another SDK with merged context. The methods below are the complete direct read/write wrappers, extracted from the source. This table records local/internal entry points, not the current Agent tool authorization list. Each call constructs an envelope from its context and explicit write options; read calls also have an operation ID. `createMission` and `proposeTask` clear Task/Execution/fence binding; `taskTake` supplies the context actor and configured Core lane. Structural methods select the Task state version from explicit options/context.\n\n| SDK method | Dispatched operation | Wrapper |\n|---|---|---|\n';
const sdkSource = await readFile(resolve(root, 'src/sdk/services-sdk.js'), 'utf8');
const sdkMethods = [...sdkSource.matchAll(/^  ([A-Za-z]\w*)\((.*)\) \{$/gm)];
let documentedSdkWrappers = 0;
for (let index = 0; index < sdkMethods.length; index++) {
  const method = sdkMethods[index];
  const body = sdkSource.slice(method.index, sdkMethods[index + 1]?.index ?? sdkSource.length);
  const dispatch = body.match(/return this\.#(read|write)\('([^']+)'/);
  if (dispatch) {
    documentedSdkWrappers++;
    api += `| \`${method[1]}\` | \`${dispatch[2]}\` | ${dispatch[1]} |\n`;
  }
}
if (documentedSdkWrappers !== [...sdkSource.matchAll(/return this\.#(?:read|write)\('/g)].length) throw new Error('Unmapped SDK dispatch wrapper; update the reference extractor');
api += '\n### Complete local router fallback sets\n\nRegistry matches are resolved first by capability name or operation and must be unique. Only when no Registry match exists does the local router use these exact fallback sets. Candidate submission belongs to Task here; only result retrieval belongs directly to Judge. Unlisted operations fail with no service route.\n';
const routerSource = await readFile(resolve(root, 'src/sdk/service-router.js'), 'utf8');
for (const owner of ['TASK', 'CONTEXT', 'JUDGE']) {
  const declaration = routerSource.match(new RegExp(`const ${owner}_OPERATIONS = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!declaration) throw new Error(`Missing ${owner} router operation declaration`);
  api += `\n#### ${owner} fallback operations\n` + json([...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
}
api += '\n### Exact shared error-code vocabulary\n' + json(ERROR_CODES);

const schemas = [
  ['Execution Workspace coordinator', 'src/runtime/execution-workspace.js', EXECUTION_WORKSPACE_SCHEMA_SQL],
  ['Task and Execution database', 'src/storage/schema.js', SCHEMA_SQL],
  ['Context database', 'src/storage/context-schema.js', CONTEXT_SCHEMA_SQL],
  ['Judge database', 'src/storage/judge-schema.js', JUDGE_SCHEMA_SQL],
  ['Observation database', 'src/observability/observation-store.js', OBSERVATION_SCHEMA_SQL],
];
let storage = '## Generated SQL schema reference\n\nThe SQL below is the complete exported create-schema text, including checks, keys and indexes. It is schema text, not an export of a user database. The `tasks` interpolation is expanded. Constructors also migrate older databases as described above. Shared `operations` declarations intentionally appear in several owners because the services can share a SQLite connection.\n';
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

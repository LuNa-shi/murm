#!/usr/bin/env node
// Deterministic, offline prompt documentation. No Agent, provider or service is invoked.
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { SETUP_PROFILE_PROMPT, SETUP_FOLLOW_UP } from './local-setup-smoke.js';
import { SETUP_BASH, SETUP_READ, SETUP_RESULT } from './local-setup-upstream.js';
import { rootPrompt, childPrompt } from '../examples/subagents/prompts/prompts.js';
import { parentPromptFor, initialGoalFor } from '../test-support/subagents/communication-fixture-prompts.js';
import { AGENT_ROLES, buildCapabilityProfile } from '../test-support/taskpool-legacy/capability-profile.js';
import { AGENT_CONTINUATION_MESSAGE, AGENT_SOFT_CLOSEOUT_MESSAGE, AGENT_MATERIAL_CONTINUATION_MESSAGE, AGENT_MATERIAL_SOFT_CLOSEOUT_MESSAGE, buildAgentSoftCloseoutNotice, buildAgentNotification, agentServiceDirectory } from '../examples/taskpool/prompts/agent-contract.js';
import { createSwarmCli } from '../src/cli/swarm-cli.js';
import { taskPoolCommands } from '../examples/taskpool/cli.js';
import { createBuiltinServiceRegistry } from '../examples/taskpool/services/builtin-registry.js';
import { loadServiceBundle } from '../examples/taskpool/deploy/service-hosts/service-bundle.js';
import { buildTaskPoolAutonomousDiscoveryMessage } from '../examples/taskpool/harness/controller.js';
import { renderStartupPrompt } from '../src/core/startup-prompt.js';
import { fateServiceManifest } from '../benchmarks/fate/fate-service.js';
import { fateVerificationContinuation, fateVerifiedInput } from '../benchmarks/fate/fate-run.js';
import { paperSubstrateManifest } from '../benchmarks/fate/paper-substrate.js';

const { runSwarmCli } = createSwarmCli(taskPoolCommands);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = 'docs/architecture/prompts';
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'Usage: node dist/scripts/generate-architecture-prompts.js [--check]');
const check = args[0] === '--check';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sourcePaths = [
  'examples/taskpool/prompts/agent-contract.ts',
  'test-support/taskpool-legacy/capability-profile.ts',
  'test-support/taskpool-legacy/services-bridge.ts',
  'src/cli/swarm-cli.ts', 'examples/taskpool/cli.ts',
  'src/core/index.ts', 'src/core/bridge.ts', 'src/core/startup-prompt.ts', 'src/core/sandbox/opensandbox-backend.ts', 'scripts/opensandbox-agent-worker.ts', 'scripts/codex-app-server-driver.ts',
  'scripts/local-setup-smoke.ts', 'scripts/local-setup-upstream.ts',
  'examples/messages/handoff.ts',
  'examples/notes/main.ts', 'examples/notes/project.ts', 'examples/taskpool/project.ts', 'src/harness/project-git.ts', 'src/harness/run-input.ts', 'examples/substrate/harness/index.ts', 'examples/substrate/services/substrate.ts',
  'examples/taskpool/harness/controller.ts', 'examples/taskpool/harness/harness.ts',
  'benchmarks/fate/fate-run.ts', 'benchmarks/fate/fate-service.ts', 'benchmarks/fate/paper-substrate.ts',
  'benchmarks/putnambench-taskpool/run.ts',
  'benchmarks/programbench-pastel/subagents-example.ts',
  'examples/subagents/main.ts', 'examples/subagents/harness/controller.ts',
  'examples/subagents/prompts/prompts.ts', 'examples/subagents/services/collaboration-service.ts',
  'test-support/subagents/communication-fixture.ts', 'test-support/subagents/communication-fixture-controller.ts', 'test-support/subagents/communication-fixture-prompts.ts',
  'examples/peermesh/harness/index.ts', 'examples/peermesh/harness/router.ts', 'examples/peermesh/harness/routed.ts', 'examples/peermesh/harness/team.ts',
  'test/fixtures/peermesh-team-kimi.ts', 'test/peermesh-team-kimi-real.test.ts',
  'examples/lead-worker/harness/prompts.ts', 'examples/lead-worker/harness/index.ts',
  'examples/lead-worker/harness/dynamic-scheduler.ts', 'examples/lead-worker/harness/dynamic.ts', 'benchmarks/lead-worker-orders/dynamic-orders.ts',
  'test-support/taskpool-legacy/runtime.ts',
  'examples/taskpool/services/workspace/workspace-contract.ts', 'examples/taskpool/services/workspace/mission-workspace.ts',
  'examples/taskpool/services/service-catalog.ts', 'examples/taskpool/services/builtin-registry.ts', 'examples/taskpool/deploy/service-hosts/service-bundle.ts',
  'examples/taskpool/deploy/service-hosts/service-registry.ts', 'examples/taskpool/deploy/service-hosts/service-manifest.ts', 'examples/taskpool/persistence/envelope.ts',
  'examples/taskpool/services/task/task-service.ts', 'examples/taskpool/services/task/task-types.ts',
  'examples/services/mathlib-search/service.json', 'examples/services/mathlib-search/SKILL.md',
  'examples/services/mathlib-search/references/loogle.md',
];
const sources = new Map(await Promise.all(sourcePaths.map(async path => [path, await readFile(resolve(root, path), 'utf8')] as const)));
const extracted: {path: string; anchor: string; line: number; sha256: string}[] = [];
function between(path: string, start: string, end: string, scope: string | null = null) {
  const full = sources.get(path);
  assert.ok(full, `unlisted prompt source: ${path}`);
  const from = scope ? full.indexOf(scope) : 0;
  assert.ok(from >= 0, `missing scope ${scope} in ${path}`);
  const a = full.indexOf(start, from);
  const b = a < 0 ? -1 : full.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b >= 0, `prompt extraction anchors changed in ${path}: ${start}`);
  const text = full.slice(a + start.length, b);
  extracted.push({ path, anchor: start, line: full.slice(0, a).split('\n').length, sha256: sha256(text) });
  return text;
}
// Only known pure source expressions are evaluated, with synthetic data and no I/O bindings.
// This avoids a second hand-maintained copy of production wording.
function evaluate(expression: string, context: Record<string, unknown> = {}) {
  return vm.runInNewContext(`(${expression})`, context, { timeout: 1000 });
}
function block(title: string, text: unknown, note = '') {
  assert.equal(typeof text, 'string', `non-text prompt ${title}`);
  const body = text as string;
  const fence = '`'.repeat(Math.max(4, ...(body.match(/`+/g) ?? []).map(s => s.length + 1)));
  return `## ${title}\n\n${note ? `${note}\n\n` : ''}Body SHA-256: \`${sha256(body)}\`\n\n${fence}text\n${text}\n${fence}\n`;
}
function header(title: string, description: string) {
  return `# ${title}\n\n> Generated by \`node dist/scripts/generate-architecture-prompts.js\`; edit source or generator, then regenerate. Check without writing: \`node dist/scripts/generate-architecture-prompts.js --check\`.\n\n${description}\n\nThese are repository-owned texts and deterministic examples, not transcripts of an actual experiment. Synthetic examples use explicit fixture inputs; other blocks preserve literal repository text, including its own placeholders and fallback markers. Complete bodies are shown without truncation. The body hash excludes Markdown framing.\n`;
}
const outputs = new Map<string, string>();
function output(file: string, text: string) { outputs.set(`${outputDir}/${file}`, `${text.trimEnd()}\n`); }

const registry = createBuiltinServiceRegistry();
const profile = buildCapabilityProfile({ registry, role: AGENT_ROLES.BOUND });
const mathlibBundle = await loadServiceBundle(resolve(root, 'examples/services/mathlib-search'));
const extendedRegistry = createBuiltinServiceRegistry();
extendedRegistry.registerService({ manifest: mathlibBundle.manifest, bundle: mathlibBundle, adapter: { invoke() { throw new Error('documentation never invokes services'); } } });
const extendedProfile = buildCapabilityProfile({ registry: extendedRegistry, role: AGENT_ROLES.BOUND });

let toolsDoc = header('CLI directory and optional Service documentation', 'Core selects the four native tools read/write/edit/bash. The synthetic namespace directories below illustrate the retained agentServiceDirectory projection; current startup discovery is composed by the Harness. Schemas and documentation are fetched through swarm service commands, not registered as separate Pi tools.');
for (const [title, p] of [['Built-in Services', profile], ['With optional Mathlib Search', extendedProfile]] as const) toolsDoc += block(title, JSON.stringify(agentServiceDirectory(p), null, 2));
for (const path of ['examples/services/mathlib-search/SKILL.md', 'examples/services/mathlib-search/references/loogle.md']) toolsDoc += block(path, sources.get(path), 'Available through the authorized Service documentation resource. The directory example above shows its metadata and hash.');
output('02-task-loop-and-tools.md', toolsDoc);

let turnsDoc = header('Complete TaskPool continuation messages', 'The TaskPool controller selects these repository-owned texts from the durable Execution phase after a settled turn. Host Profile and initial input composition are described in the Harness references.');
turnsDoc += block('TaskPool bound continuation', AGENT_CONTINUATION_MESSAGE);
turnsDoc += block('Soft closeout continuation', `${buildAgentSoftCloseoutNotice('<EXECUTION_ID>', '2026-01-01T00:01:00.000Z', Date.parse('2026-01-01T00:00:30.000Z'))}\n${AGENT_SOFT_CLOSEOUT_MESSAGE}`);
output('03-runtime-turns.md', turnsDoc);
let runtimeDoc = header('Complete Runtime notification messages', 'The TaskPool controller composes durable handoff warnings and eligible Material/dependency notices using buildAgentNotification from agent-contract.js. Serialized admission uses followUp by default. PutnamBench selects steer for Material notices so Pi can include them at a tool continuation. The retained Runtime no longer sends notification inputs. The controller records eligibility and input admission. Synthetic identifiers below illustrate the exact current body. Confirm model visibility from the actual provider input.');
for (const notification_type of ['handoff_warning', 'material_available', 'dependency_satisfied']) runtimeDoc += block(notification_type, buildAgentNotification({ notification_type, notification_id: '<NOTIFICATION_ID>', material_id: '<MATERIAL_ID>', source_task_id: '<SOURCE_TASK_ID>', source_execution_id: '<SOURCE_EXECUTION_ID>', recipient_task_id: '<TASK_ID>', payload: { execution_id: '<EXECUTION_ID>', deadline: '2099-01-01T00:00:00.000Z' } }, { at: Date.parse('2098-12-31T23:59:30.000Z') }));
output('04-runtime-messages.md', runtimeDoc);

async function listSourceFiles(directory: string): Promise<string[]> {
  const files = [];
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.murm'].includes(entry.name)) files.push(...await listSourceFiles(path));
    }
    else if (/\.(?:js|mjs|ts)$/.test(path)) files.push(path);
  }
  return files.sort();
}
const sendSites = [];
const instructionFields = [];
const nonInstructionActions = new Set(['integration', 'continue_until_boundary', 'execute', 'queue_status', 'task']);
const cleanupActions = new Set(['close', 'save', 'persist-failure']);
const instructionActions = new Set([
  'modify_task_contract_or_register_capability', 'call_the_capability_or_block_on_a_real_dependency',
  'call_list_tools_or_get_service_metadata', 'retry_with_the_registered_input_schema',
  'inspect_material_and_record_task_feedback', 'use_dependency_kind_TASK_or_CAPABILITY',
]);
let guidanceDoc = header('Complete fixed guidance in tool results and notification data', 'This appendix records complete literal hint, remediation and guidance fields in executable sources, plus instructional action values. These are individual response fields, not fabricated full error responses or actual run transcripts. Dynamic IDs, versions, paths, provider diagnostics and complete error envelopes follow the contracts in [Services](../04-services.md) and [the API reference](../10-service-api-reference.md).');
guidanceDoc += '\n## Delivery conditions\n\n| Source | When the fixed field can be visible |\n|---|---|\n| services-bridge.ts | Capability-admission errors, invalid capability blocking, unavailable operation or malformed payload; the protected CLI prints the structured response into the native Bash result |\n| workspace-contract.ts remediation | Path normalization, forbidden/undeclared output, locked-input writes, missing required input or input-hash mismatch; setup-time failures are not guaranteed to reach an Agent tool call |\n| task-service.ts action | Material-available notification payload, or invalid typed dependency error. The payload action is visible when notification data is read/composed; the retained Runtime no longer renders or sends a notification user message. |\n\nThe action values integration and task are consumption/contract enums, and continue_until_boundary is an operator log event field; neither is a separate instructional tool-result string. The actions execute and queue_status are private Judge authorization protocol enums, never Agent instructions. Arbitrary runtime Task/Material/provider text is outside this fixed-field inventory.\n';
for (const path of (await Promise.all(['src', 'examples/taskpool', 'test-support/taskpool-legacy'].map(listSourceFiles))).flat()) {
  const original = await readFile(resolve(root, path), 'utf8');
  // Strip type-only fields while preserving line and column positions.
  const source = path.endsWith('.ts') ? stripTypeScriptTypes(original) : original;
  for (const [i, line] of source.split('\n').entries()) {
    if (/\.prompt\s*(?:\?\.)?\(|\.agentRpc\([^,]+,\s*\{\s*type:\s*'prompt'/.test(line)) {
      assert.ok(sourcePaths.includes(path), `new prompt sender requires documented ownership: ${path}:${i + 1}`);
      sendSites.push({ path, line: i + 1, expression: line.trim() });
    }
  }
  const fields = /\b(hint|remediation|guidance|action):\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/g;
  for (const match of source.matchAll(fields)) {
    const key = match[1];
    const value = evaluate(match[2]);
    assert.equal(typeof value, 'string', `non-static instruction field requires explicit documentation: ${path}`);
    if (key === 'action' && nonInstructionActions.has(value)) continue;
    // OpenSandbox's create policy uses a provider-side enum, outside the Agent prompt.
    if (key === 'action' && path === 'src/core/sandbox/opensandbox-backend.ts' && value === 'allow') continue;
    if (key === 'action' && path === 'src/core/runtime-management.ts' && value === 'retire-service') continue;
    if (key === 'action' && ['src/core/index.ts', 'src/core/model/model-access.ts', 'examples/lead-worker/harness/index.ts'].includes(path) && cleanupActions.has(value)) continue;
    if (key === 'action') assert.ok(instructionActions.has(value), `review new literal action field for prompt delivery: ${path}: ${value}`);
    assert.ok(sourcePaths.includes(path), `new instruction-field source requires documented ownership: ${path}`);
    const line = source.slice(0, match.index).split('\n').length;
    instructionFields.push({ path, line, field: key, sha256: sha256(value) });
    guidanceDoc += block(`${key} — ${path}:${line}`, value, `Source: [${path}](../../../${path}). This block is the complete value of the ${key} field, without JSON quoting. See delivery conditions above.`);
  }
}
output('06-tool-return-guidance.md', guidanceDoc);
output('10-local-setup-probe.md', header('Complete local setup probe texts',
  'Setup and explicit doctor smoke use one temporary Runtime and the controlled Responses gateway. The probe input follows admitted Worker startup. The two tool calls and final result come from the fixed loopback upstream sequence.')
  + block('Probe Profile instruction', SETUP_PROFILE_PROMPT)
  + block('Host follow-up', SETUP_FOLLOW_UP)
  + block('Controlled Bash arguments', JSON.stringify({ command: SETUP_BASH, timeout: 10 }, null, 2))
  + block('Controlled read arguments', JSON.stringify({ path: SETUP_READ }, null, 2))
  + block('Controlled final text', SETUP_RESULT));

const notesPath = 'examples/notes/main.ts';
const notesKey = between(notesPath, "const key = '", "';\n");
const notesInput = evaluate(between(notesPath, 'const inputText = Object.freeze(', ');\n'), { key: notesKey });
output('07-notes-harness.md', header('Installed Notes Harness prompts',
  'The Writer and Reader use the default Core system prompt with their own Notes grants and an empty Added System Prompt. The host supplies three fixed user inputs through its exclusive input helper. The seeded fact enters the model transcript when a Agent reads its file or receives it in a Service result.')
  + block('Writer publication', notesInput.put)
  + block('Reader retrieval', notesInput.get)
  + block('Reader follow-up', notesInput.follow)
  + block('Project Writer Profile prompt', between('examples/notes/project.ts', "export const projectNotesWriterPrompt = '", "';"),
    'The writer receives the original user prompt directly through followUp after the project FileTree is installed.')
  + block('Project Reader Profile prompt', between('examples/notes/project.ts', "export const projectNotesReaderPrompt = '", "';"),
    'The reader receives JSON with task equal to the original user prompt and artifact equal to the Run-specific result filename.'));
const handoffPath = 'examples/messages/handoff.ts';
const handoffVariables = { key: 'handoff-example', receivedFile: 'received.txt' };
output('14-sdk-handoff.md', header('Installed public SDK handoff prompts',
  'The host selects one role-specific Profile prompt for each Agent, then sends one follow-up through the public send method. The key is derived from a host-generated UUID and occurs in both prompts and Service request IDs. Only the writer is seeded with the undisclosed handoff value.')
  + block('Writer Profile prompt', evaluate(between(handoffPath, 'const writerPrompt = ', ';\n')))
  + block('Reader Profile prompt', evaluate(between(handoffPath, 'const readerPrompt = ', ';\n')))
  + block('Writer follow-up', evaluate('`Publish' + between(handoffPath, '`Publish', '`);') + '`', handoffVariables))
  + block('Reader follow-up', evaluate('`Receive' + between(handoffPath, '`Receive', '`);') + '`', handoffVariables))
  + block('Project Writer instruction', evaluate('`Inspect' + between(handoffPath, '`Inspect', '` })') + '`', handoffVariables),
    'This instruction accompanies task, the unmodified user prompt, in the role input JSON. The named key uses the actual fresh UUID.')
  + block('Project Reader instruction', evaluate('`Check' + between(handoffPath, '`Check', '` })') + '`', handoffVariables),
    'This instruction accompanies task in the Reader input JSON. The filename is set to the actual Run-specific reader output.'));
const subagentsPath = 'test-support/subagents/communication-fixture-prompts.ts';
output('08-subagents-harness.md', header('Subagents Harness prompts',
  'The ordinary Harness stages the Root and Child Profile prompts verbatim and sends user or model-authored task text through the collaboration controller. The separate communication fixture stages its own Profile prompts. It sends the default goal or configured goal and supplements through explicit followUp. Child round results are JSON snapshots composed in communication-fixture-controller.ts with childId, eventSeq, outcome, optional output/error and a terminal failure source. These variable fields originate in the accepted Core event, never latestOutput. Parent-created child and followup inputs are model-authored through Bash Agent Service requests.')
  + block('Root Profile prompt', rootPrompt)
  + block('Recursive Child Profile prompt', childPrompt)
  + block('Pastel example initial task', evaluate(between('benchmarks/programbench-pastel/subagents-example.ts', 'const initial = ', ';\nconst supplement')))
  + block('Pastel example HSL supplement', evaluate(between('benchmarks/programbench-pastel/subagents-example.ts', 'const supplement = ', ';\nconst probes')))
  + block('Fixture Parent Profile prompt', evaluate(between(subagentsPath, 'export const parentPrompt = ', ';\n')))
  + block('Child Profile prompt', evaluate(between(subagentsPath, 'export const childPrompt = ', ';\n')))
  + block('Default initial goal', evaluate(between(subagentsPath, 'export const initialGoal = ', ';\n')))
  + [3, 4, 5, 6, 7].map((childCount: any) => block(`Parent Profile prompt: ${childCount + 1} Agents`, parentPromptFor(childCount))
    + block(`Default initial goal: ${childCount + 1} Agents`, initialGoalFor(childCount))).join(''));
for (const path of ['examples/subagents/harness/controller.ts', 'test-support/subagents/communication-fixture-controller.ts']) {
  for (const [index, line] of sources.get(path)!.split('\n').entries()) {
    if (line.includes('await runtime.send(')) sendSites.push({ path, line: index + 1, expression: line.trim() });
  }
}
const substrateIndexPath = 'examples/substrate/harness/index.ts';
const substratePath = 'examples/substrate/services/substrate.ts';
const fatePath = 'benchmarks/fate/fate-run.ts';
output('01-core-startup.md', header('Core startup system prompt',
  'The backend stages this file. Pi receives it through --system-prompt and can append its working directory. Codex receives it as thread/start baseInstructions and can add its own context. Services are rendered from the registered manifest purpose and operation descriptions after Bridge permission filtering. An optional nonblank Profile.prompt is included verbatim inside added_system_prompt.')
  + block('Profile with no allowed Service operations and no Added System Prompt', renderStartupPrompt([]))
  + block('Codex Profile with no allowed Service operations or Added System Prompt', renderStartupPrompt([], undefined, 'codex')));
const fateManifest = fateServiceManifest();
const fateSharing = evaluate(between(fatePath, 'export const fateSharingPrompt = ', ';\n'));
const fatePrivate = evaluate(between(fatePath, 'export const fatePrivatePrompt = ', ';\n'));
output('09-substrate-harness.md', header('Substrate peer prompts',
  'In the generic configuration all three default peers receive the same Profile prompt. Each serial cycle sends the full host question after a peer/cycle header, followed by the fixed cycle text. These texts do not encode a Task/Mission protocol or verify correctness.')
  + block('Peer Profile prompt', between(substrateIndexPath, "export const peerPrompt = '", "';\n"))
  + block('Substrate purpose', between(substratePath, "purpose: '", "'"))
  + ['publish', 'visit', 'search'].map(operation =>
    block('Substrate ' + operation, between(substratePath, "capability('" + operation + "', '", "'"))).join('')
  + block('Cycle instruction', between(substrateIndexPath, "export const cyclePrompt = '", "';\n"))
  + block('Exact input composition', between(substrateIndexPath, '                  const text = ', '\n                  const sendInput'),
    'index is the fixed zero-based peer index; round is its zero-based serial cycle; cycleQuestion is the validated trusted per-cycle question when supplied, otherwise the host question; cyclePrompt is the complete literal above. The host runInput helper sends this string as followUp. attempt is zero initially; a trusted checker correction appends finite feedback and uses a fresh correction request ID on the same Agent inside the original turn deadline.')
  + block('FATE startup in the no-library condition', renderStartupPrompt([fateManifest]))
  + block('FATE startup in the shared condition', renderStartupPrompt([fateManifest, paperSubstrateManifest('shared')], fateSharing))
  + block('FATE startup in the private condition', renderStartupPrompt([fateManifest, paperSubstrateManifest('private')], fatePrivate))
  + block('FATE shared startup with verified completion', renderStartupPrompt([fateServiceManifest(true), paperSubstrateManifest('shared')], fateSharing),
    'The verified FATE manifest also supplies the submit description for the private and no-library variants, which otherwise use the startup composition above.')
  + block('FATE initial input', evaluate(between(fatePath, 'export const fateInput = ', ';\n')),
    'Every peer receives the same followUp through runInput after the fixed pool is ready. The host stages the frozen formal and informal problem as files. The informal file appends the problem resource address derived from the original declaration SHA-256.')
  + block('FATE initial input with verified completion and a 30-minute work window', fateVerifiedInput(1_800_000),
    'The host supplies the configured workTimeoutMs. The displayed duration uses whole minutes when divisible by 60,000, otherwise seconds. The initial task is sent after all peers are ready.')
  + block('FATE continuation before verified completion', fateVerificationContinuation,
    'A verified-completion peer receives this followUp through runInput in the same Session after a known natural settlement without a verified finish, while the work window remains open and the peer can still check and submit, or can submit an already passing proof. Eligibility is checked again before dispatch. The input uses a fresh continuation request ID. The final scorer sends no prompt.'));
output('08-peermesh-harness.md', header('PeerMesh peer, batch and notice prompts',
  'The Profile prompt is installed before peer startup. The routed entrypoint composes one instruction line plus JSON batch data and shared-board context, then calls the sole exclusive input helper. The project path uses Core start for ordinary batches and Core steer for eligible peer notices during an active batch. The compatibility paths use explicit followUp.')
  + block('Compatibility peer Profile prompt', between('examples/peermesh/harness/index.ts', 'export const peerPrompt = `', '`;'))
  + block('Project fixture peer Profile prompt', between('examples/peermesh/harness/index.ts', 'export const projectPeerPrompt = `', '`;'))
  + block('Seeded checkout instruction', between('src/harness/project-git.ts', "export const seededCheckoutInstruction = '", "';"),
    'In the project command this replaces the clone clause in the PeerMesh Profile and is appended to all project Lead–Worker Profiles. The host sets RUN_INITIAL_COMMIT to the commit of the fixed FileTree.')
  + block('Project kickoff text', between('examples/peermesh/harness/team.ts', 'router.kickoff(', ');'),
    'All peers receive the same trusted project body as the kickoff user input. The provisioned Gitea issue stores the same body and its title.')
  + block('Exact serial input composition', between('examples/peermesh/harness/router.ts', 'const input = `', '`;'),
    'The Router owns the batch identity and source metadata. Context is the current Board read for the mapped viewer. Kickoff, external input and nudges travel through this same composition.')
  + block('Compatibility batch instruction', between('examples/peermesh/harness/router.ts', "export const routerInstruction = '", "';"))
  + block('Project batch instruction', between('examples/peermesh/harness/router.ts', "export const projectRouterInstruction = '", "';"))
  + block('Project peer notice instruction', between('examples/peermesh/harness/router.ts', "export const noticeInstruction = '", "';"))
  + block('Exact steer input composition', between('examples/peermesh/harness/router.ts', 'const steerText = `', '`;'),
    'The same router selects an eligible DM or admitted Board entry. Its event metadata comes from the authorized Mattermost source or Board admission. Core sends steer as a separate same-Session prompt at the next Pi execution boundary. It appears in model context when Pi consumes the queued input, separately from the ordinary batch JSON.')
  + block('Configured idle nudge', between('examples/peermesh/harness/router.ts', "export const idleNudgeInput = '", "';"))
  + block('Opt-in hosted acceptance common instructions', between('test/fixtures/peermesh-team-kimi.ts', 'export const liveCommon = `', '`;'))
  + block('Opt-in hosted A initial instructions', between('test/fixtures/peermesh-team-kimi.ts', 'export const liveAInitial = `', '`;'))
  + block('Opt-in hosted B initial instructions', between('test/fixtures/peermesh-team-kimi.ts', 'export const liveBInitial = `', '`;'))
  + block('Opt-in hosted A external comment instructions', between('test/fixtures/peermesh-team-kimi.ts', 'export const liveAUser = `', '`;'))
  + block('Exact hosted initial composition', between('test/fixtures/peermesh-team-kimi.ts', '  return [`', '];'),
    'The host supplies two distinct provisioned peer usernames and a fresh 24-character seed. Only A receives the seed. The user comment names only A and appends liveAUser. Negotiation and agreement text are actual model-authored Mattermost posts, delivered by the normal authenticated subscription. The fixture injects no model tool program or terminal response.'));
const leadWorkerPath = 'examples/lead-worker/harness/prompts.ts';
let leadWorkerDoc = header('Lead-Worker role and turn instructions', 'The Harness serializes the selected instruction or Board update before exclusive followUp delivery. The output quotes source templates and composition paths.');
for (const name of ['leadPrompt', 'helperPrompt', 'initializeInstruction', 'helperInitialInstruction', 'leadAdjustmentInstruction', 'helperFollowupInstruction', 'dynamicLeadPrompt', 'dynamicWorkerPrompt', 'projectLeadPrompt', 'projectStaticWorkerPrompt', 'projectDynamicLeadPrompt', 'projectDynamicWorkerPrompt', 'projectIntegrationInstruction']) {
  const source = sources.get(leadWorkerPath)!;
  const start = `export const ${name} = `;
  const from = source.indexOf(start);
  const delimiter = source[from + start.length];
  leadWorkerDoc += block(name, between(leadWorkerPath, start + delimiter, delimiter + ';'));
}
leadWorkerDoc += block('Staged corrective input composition and send', between('examples/lead-worker/harness/index.ts', '                  const nextPath =', '\n                  final = board.snapshot();'), 'The trusted host checker must explicitly return STAGE_CANDIDATE_REJECTED. Actual stage, helper role and attempt derive the fresh path and request ID; the original task and monotonic deadline remain fixed. No reference answer or new permission is supplied.');
leadWorkerDoc += block('Dynamic goal and dispatch', between('examples/lead-worker/harness/dynamic-scheduler.ts', "    send(lead, { type: 'dynamic-goal'", '\n  } finally'), 'The ordinary project path sends the original user prompt in goal. The Orders fixture uses its frozen task specification and selected public JSONL data. Later inputs contain committed Board sequence numbers, member and task identities, and the current revision. Each ready recipient receives an exclusive followUp in its original Session.');
leadWorkerDoc += block('Dynamic checker Profile composition', between('examples/lead-worker/harness/dynamic.ts', '                model, image, writable: true, prompt:', '\n                network:'), 'The shared Worker instructions precede the Lead-authored Profile instructions. The composed string becomes the startup Profile prompt for the new Agent.');
output('08-lead-worker-harness.md', leadWorkerDoc);
const flatControllerPath = 'examples/taskpool/harness/controller.ts';
const taskPoolHarnessPath = 'examples/taskpool/harness/harness.ts';
const putnamPath = 'benchmarks/putnambench-taskpool/run.ts';
const discoveryFields = {
  mission: { mission_id: '<MISSION_ID>', goal: '<MISSION_GOAL>', acceptance_conditions: '<MISSION_ACCEPTANCE>' },
  agent: { agent_id: '<AGENT_ID>', selection_deadline: '<SELECTION_DEADLINE>', hard_deadline: '<AGENT_HARD_DEADLINE>' },
  runDeadline: '<MISSION_DEADLINE>',
};
const autonomousDiscovery = buildTaskPoolAutonomousDiscoveryMessage(discoveryFields);
const putnamDiscovery = buildTaskPoolAutonomousDiscoveryMessage({
  ...discoveryFields,
  mission: { ...discoveryFields.mission, mission_id: 'mission:putnam_2025_b1', goal: between(putnamPath, 'const goal = `', '`;') },
  discoveryContext: evaluate('`' + between(putnamPath, 'source: string) => `', '`;') + '`',
    { path: 'lean4/src/putnam_2025_b1.lean', source: '<FROZEN_ORIGINAL_LEAN_SOURCE>' }),
  discoveryWorkflow: between(putnamPath, 'const collaboration = `', '`;'),
});
const sampleCloseout = { at: Date.parse('2026-01-01T00:00:30.000Z'), workspaceSaveAvailable: false };
const warningDeadline = '2026-01-01T00:01:00.000Z';
const flatCliHelp = await Promise.all(['create', 'link'].map(async command => {
  let help = '';
  const status = await runSwarmCli(['task', command, '--help'], { stdout: { write: (chunk: string) => { help += chunk; } } });
  assert.equal(status, 0);
  return block(`Offline swarm task ${command} help`, help.trimEnd(),
    'The CLI returns this help to native Bash on request without contacting the Bridge or a Service.');
}));
output('08-taskpool-harness.md', header('TaskPool discovery and continuation prompts',
  'After trusted domain registration, the controller sends discovery through public Runtime.send with explicit followUp. The current Execution determines whether the controller sends the ordinary continuation or the soft-closeout body. The trusted Core capture or explicit snapshot binding selects the guidance for the available Workspace operations. Host-supplied directed feedback retains its original text, request ID and chosen mode through the same serialized controller.')
  + block('Project discovery workflow', between('examples/taskpool/project.ts', "discoveryWorkflow: '", "',"),
    'The project entry also gives discovery the exact user prompt as the Mission goal. The controller sends the discovery input after installing the read-only initial tree.')
  + block('Profile suffix when live Workspace save is unavailable', between(taskPoolHarnessPath, "export const TASKPOOL_WITHOUT_WORKSPACE_SAVE_PROMPT = '", "';"),
    'The default Added System Prompt is empty. Without a Core or injected live capture binding, the host includes this explanation after any supplied Profile text.')
  + block('Default discovery input', between(flatControllerPath, "export const TASKPOOL_DISCOVERY_MESSAGE='", "';"))
  + block('Autonomous discovery input', autonomousDiscovery,
    'When autonomous Tasks are enabled and there is no host override, the controller reads the public Mission and registered Agent after the final discovery send guard. The effective run deadline comes from the controller host admission clock. The initial batch is sent after any configured host admission callback.')
  + block('PutnamBench first user input', putnamDiscovery,
    'The original source and path come from the same locked fixture used to initialize the public Workspace. The controller adds the original source to each Agent’s first discovery input. Subsequent discovery inputs use the same Mission goal, current deadlines and collaboration guidance. The PutnamBench Profile supplies no Added System Prompt.')
  + flatCliHelp.join('')
  + block('Default ordinary continuation with a snapshot binding', AGENT_CONTINUATION_MESSAGE)
  + block('Default ordinary continuation without a snapshot binding', AGENT_MATERIAL_CONTINUATION_MESSAGE,
    'The host can override controller.continuationPrompt in either configuration. During soft closeout the controller selects the built-in text for the registered Workspace capabilities.')
  + block('Soft-closeout continuation without a snapshot binding',
    `${buildAgentSoftCloseoutNotice('<EXECUTION_ID>', warningDeadline, sampleCloseout.at, sampleCloseout)}\n${AGENT_MATERIAL_SOFT_CLOSEOUT_MESSAGE}`)
  + block('Handoff warning without a snapshot binding', buildAgentNotification({
    notification_id: '<NOTIFICATION_ID>', notification_type: 'handoff_warning',
    payload: { execution_id: '<EXECUTION_ID>', deadline: warningDeadline },
  }, sampleCloseout), 'The persisted warning payload supplies the Execution ID and deadline. The controller records the notification ID and fixed composed message before dispatch.'));
for (const [index, line] of sources.get(flatControllerPath)!.split('\n').entries()) {
  if (line.includes('await runtime.send(')) sendSites.push({ path: flatControllerPath, line: index + 1, expression: line.trim() });
}
const manifest = {
  description: 'Offline source fingerprints and prompt extraction anchors; no actual run data. A hash match establishes source alignment, not delivery to an Agent.',
  sources: sourcePaths.map((path: any) => ({ path, sha256: sha256(sources.get(path)!) })),
  extracted_spans: extracted,
  prompt_send_sites: sendSites,
  fixed_instruction_fields: instructionFields,
  generated_bodies: [...outputs].map(([path, content]: any) => ({ path, sha256: sha256(content) })),
};
output('source-manifest.json', JSON.stringify(manifest, null, 2));
let stale = false;
for (const [path, content] of outputs) {
  if (check) {
    const existing = await readFile(resolve(root, path), 'utf8').catch(() => null);
    if (existing !== content) { console.error(`stale generated prompt document: ${path}`); stale = true; }
  } else {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), content);
  }
}
if (stale) process.exitCode = 1;
else console.log(`${check ? 'Checked' : 'Generated'} ${outputs.size} prompt documents; ${sourcePaths.length} source fingerprints; ${sendSites.length} send sites; ${instructionFields.length} fixed guidance fields.`);

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { requestHttp } from '../protocol/http-request.js';
import { COMMAND_OPERATIONS, operationForCommand, transportService } from './service-command.js';

const SERVICE_NAMES = ['task', 'bot', 'material', 'workspace', 'mission', 'judge', 'catalog'];
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
function operationTimeoutMs(operation: any, explicit?: any) {
  const configured = ['workspace_check', 'workspace_merge', 'mission_submit'].includes(operation)
    ? process.env.SWARMENV_CLI_CHECK_REQUEST_TIMEOUT_MS : undefined;
  return parseScalar(explicit) ?? (configured === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : Number(configured));
}
const RESERVED = new Set(['help', 'json', 'input', 'stdin', 'actor-ref', 'task-id', 'execution-id', 'fencing-version', 'spec-version', 'state-version', 'request-id', 'timeout-ms']);
const TASK_COMMANDS = Object.keys(COMMAND_OPERATIONS.task).join('|');
const WORKSPACE_FILES_HELP = 'List public paths. Use --at R (main is allowed), an optional positional path prefix, --limit or --cursor. Example: swarm workspace files --at 0.1 --limit 20';
const COMMAND_HELP = Object.freeze({
  bot: { exit: 'End an unbound Bot with no pending take after the selection budget expires. Use --reason selection-budget. For an open Mission with selection time left, inspect current public state and existing Tasks within the selection budget. The Core is released after cleanup.' },
  task: {
    create: `Propose a concrete missing deliverable when the host enables autonomous Tasks. An active Bot keeps its current Execution.
Required: --summary, --gap, --expected-output, --priority (high, medium, or low), and --acceptance-conditions (a nonempty JSON array or object).
  swarm task create --summary "Check a boundary case" --gap "The current argument leaves one case open" --expected-output "A reproducible check" --acceptance-conditions '["State the inputs and result"]' --priority medium --request-id propose-boundary
Replace the example with your actual proposal. You can also pass the same fields in JSON through --input or --stdin. The Service binds the Mission and Workspace. The result includes task.task_id. Use that ID with swarm task take if you choose to claim it.
Use swarm service view task --json to see the enabled operations and complete input schemas.`,
    list: `Search Task summaries using --query, --limit (1-100) and --cursor. Omit the state filter to include all states, use --state for one state, or pass a quoted JSON array to --states.
  swarm task list --state ready
  swarm task list --states '["ready","running","blocked","done","canceled"]'
Candidate summaries include gap and priority; inspect their relevance and choose freely. Follow next_cursor even after an empty page, then view Task details before taking. Creation order is stable within a scan; state and readiness are live at each page.`,
    view: 'Required: <task-id> (or --task-id). Read a Task contract, gap, priority, versions, dependencies, Materials and Executions. Use --contract-history-after-version and --contract-history-limit (1-100) to continue contract_history_page.next_after_version.',
    take: 'Take an eligible Task by its positional ID. Example: swarm task take T1 --request-id take-t1 (replace T1 with the returned task_id). The result includes the Execution and pinned inputs. If the response is unknown, reuse the same request ID with the same Task.',
    link: `Link a published Material during an active Execution. The role determines which Task ID to use.
To send your published Material to another Task, use the receiving Task's ID in --task-id and choose --role response. The authenticated Execution supplies the producer. Omit --receiving-task-id, or give it the same ID as --task-id. Flat queues a notice for the receiving Task.
  swarm task link --task-id RECEIVING_TASK_ID --material-id MATERIAL_ID --role response --request-id send-m1-to-recipient
To attach Material as input to your own work, use --role input and your current Task's ID. To cite your own published Material when finishing, link it to your current Task with --role experience.
  swarm task link --task-id CURRENT_TASK_ID --material-id MATERIAL_ID --role experience --request-id link-m1-to-current
Replace each placeholder with the corresponding actual ID. Response and handoff links require the producing Execution.`,
    finish: `Finish the current Task with outcome done, incomplete, blocked, or cancelled. For a declared Workspace delivery, provide --workspace-revision and any required --check-result-id.
Publication records who produced a Material. To explicitly cite that Material in a done result, first create a Task link with swarm task link.
Example after linking: swarm task finish --outcome done --material-ids '["M1"]' --request-id finish-t1
Use a quoted JSON array of actual Material IDs. Omit this optional list when your checked Workspace revision and other evidence already satisfy the Task's completion contract. Required deliverables still apply.`,
    revise: 'An UNBOUND Bot can revise an open, unowned Task, including a previously executed Task. Use <task-id> --expected-spec-version N --expected-state-version N --reason TEXT --changes JSON (or --input/--stdin). Changes include summary, gap, expected_output, acceptance_conditions, priority and optional inputs/dependencies. Example: --changes \'{"priority":"high"}\'. Read current versions first; running, preparing, cleaning up and closed responsibilities are protected. Old Executions retain their original contract.',
    cancel: 'An UNBOUND Bot can cancel an open, unowned Task with <task-id> --expected-spec-version --expected-state-version --reason and optional --replacement. Cancellation preserves history and does not satisfy dependencies. No extra coordination grant is required.',
    'dependency-replace': 'Repair a cancelled prerequisite of an unowned blocked Task. Required: <task-id> --from-task-id --to-task-id --expected-spec-version --expected-state-version --reason. Requires a Mission coordination grant.',
    feedback: 'Record handling of a notice for your current Task. Use --notification-id, --decision (for example adopted or rejected), --action and optional --details JSON. Use swarm service view task --json for the contract.',
  },
  material: {
    list: 'Read bounded Material summaries using --query, --task-id, --limit and --cursor; follow next_cursor even after an empty page.',
    view: 'Read one immutable Material including provenance and corrections. Required: <material-id>.',
    search: 'Search Materials. Input: --query and explicit scope filters.',
    publish: `Publish immutable Material from your current Execution with --content and optional --title and --summary. For saved code, put its fixed revision, file, declaration, and verification outcome in structured content.
  swarm material publish --content '{"revision":"0.2","path":"lean4/src/Proof/Geometry.lean","declaration":"proof_lemma","check_status":"pass","check_result_id":"CHECK_ID"}' --request-id publish-lemma
Use revision and check information from your actual receipts. Read the returned material.material_id. To notify a different Task, use swarm task link --role response with the receiving Task ID and that Material ID. See swarm task link --help.`,
    dispute: 'Question a Material. Required: <material-id> --reason --claim; claim identifies the affected claim or section.',
    supersede: 'Replace a whole Material. Required: <old-id> --with <new-id> --expected-version <observed relation_version> --reason.',
    unsupersede: 'Revoke only the matching replacement. Required: <old-id> --with <new-id> --expected-version <observed relation_version> --reason. Preserves history.',
    consume: `Record a meaningful Material use in the current Execution. Pass --material-ids as a quoted JSON array of 1–100 unique IDs, even for a single ID.
Allowed --action values: route, task, workspace, integration. Use --impact to describe what changed because of the Material.
Example: swarm material consume --material-ids '["M1"]' --action integration --impact "Used M1 to choose the boundary case in the integrated proof." --request-id use-m1
Replace M1 with an actual Material ID. After an unknown response, reuse the same request ID and payload.`,
  },
  workspace: {
    view: 'Read the current public Workspace and main.',
    history: 'Read main history; --all includes unmerged saves. Filter --task, --execution, --material-id, --path; paginate with --limit and --cursor.',
    status: 'Inspect current E initial input, saved revision, dirty paths and conflicts.',
    diff: 'Compare the current Execution project against its last save. To compare two fixed public revisions, use swarm workspace public-diff --from R --to R. The original diff --from R --to R form also works.',
    'public-diff': 'Compare two fixed public revisions, including unmerged saves. Use --from R --to R and optional --path, --limit or --cursor.',
    files: WORKSPACE_FILES_HELP,
    read: 'Read one public file by its positional path. Use --at R (main is allowed) and optional --max-bytes. Example: swarm workspace read notes.txt --at 0.1 (choose a path from workspace files).',
    search: 'Search public paths and UTF-8 text at --at R; paginate with --max-results and --cursor.',
    save: `Save the actual current E project as a stable public revision. Use --resolved only after resolving recorded conflicts and removing their alternatives. To cite Materials in the saved revision, first record each use in this Execution with swarm material consume --action workspace. Then pass up to 20 distinct IDs as --material-ids '["M1"]'. No file, identity or lineage arguments. Reuse --request-id after an unknown response.`,
    apply: 'First save your own changes. Apply refuses a dirty project. Use --from a fixed public revision to integrate its files into this Execution. Resolve recorded conflicts and save --resolved. Retry the original request ID after an unknown response.',
    merge: 'Merge --from a fixed public revision; Runtime pins main, checks the combined tree when configured, and conditionally advances main. For a configured 3-minute project check, use --timeout-ms 210000 to wait for its response. After response loss, repeat the same --from and --request-id to recover the original operation; do not assume the merge failed or start a new request.',
  },
  mission: {
    view: 'Read the current Mission goal and acceptance conditions through the trusted Bot binding.',
    submit: 'Submit current main plus an explicit Material selection using --materials M1,M2 (or --materials [] for files only). Requires a Mission coordination grant. The service fixes the checker, configuration and main. Use a stable --request-id, then use swarm mission submission view with that ID to follow the accepted submission or recover a lost response.',
    'submission view': 'Read Mission submission state and immutable snapshots.',
  },
  judge: {
    check: `Check a saved public Workspace revision with --revision R. When the project checker is configured, Lake builds the revision's Lean modules, including local imports. Find the locked target path with swarm mission view. Keep Lean sources under the target's source directory, and import siblings by module name relative to that directory. Example: if the target is lean4/src/Main.lean, save lean4/src/Proof/Geometry.lean and write import Proof.Geometry. Judge uses its trusted project configuration.
For iteration on a local proposition, save its module and use --revision R --check-mode lean-module --path P. This checks that whole module and its necessary dependencies, with actual scope and cache evidence in the receipt; it does not select an individual declaration within a multi-declaration file. Independently useful lemmas and definitions may live in separate imported modules to keep iteration focused. A local PASS is not a whole-project or Mission PASS. Without this mode, --path P identifies a delivery file and still builds the whole project. The selected file must satisfy the delivery source policy. Legacy single-file checkers require --path.
A build result is diagnostic. A check without --path does not supply a Task delivery file receipt. Mission acceptance separately validates the locked target proof on a fixed tree.
--timeout-ms controls how long the CLI waits for HTTP. The service controls the checker's execution limit. Without a deployment override the HTTP wait is 30 seconds; the effective default is shown below and may be too short for a cold module build. For a 10-minute source phase with preflight already ready and no queue wait, use --timeout-ms 630000. Allow additional time for queue waiting and cold preflight; changing HTTP wait never extends Execution or checker deadlines.
Use a stable --request-id. After a lost response, use swarm judge result --request-key with the original ID, or repeat the same request with the same ID.`,
    result: 'Read one CheckResult. Use --check-result-id or --request-key; request-key lookup survives a lost submit response.',
  },
});

function usage(scope: any = 'top', commandName: any = null) {
  if (scope === 'top') return `Usage: swarm <service> <command> [options]\n\nServices:\n  service list|view <id>     Discover configured service manifests\n  service invoke <id> <op>  Call a registered operation by its exact ID\n  bot spawn|get|send|stop     Core direct-child control when granted\n  task ${TASK_COMMANDS}\n  material list|view|search|publish|consume|dispute|supersede|unsupersede\n  workspace view|history|status|diff|public-diff|files|read|search|save|apply|merge\n  mission view|submit|submission view\n  judge check|result\n  <configured service> <manifest operation>\n\nOptions:\n  --json                     Pretty-print a JSON result\n  --input <file>             Read JSON input from a file\n  --stdin                    Read JSON input from stdin\n  --request-id <id>          Stable identity for a write; reuse after an unknown response\n  --help                     Show this help\n\nBots use their protected Bridge binding; caller flags cannot authorize another identity.\nOperator service endpoints use SWARMENV_<SERVICE>_SERVICE_URL,\nSWARMENV_SERVICE_ENDPOINTS, and optional service tokens. Requests are non-interactive JSON.`;
  if (scope === 'service') return 'Usage: swarm service list|view <service-id> [--json]\n\nLists configured service manifests or shows one manifest through the Bot Bridge. No network is required for --help.';
  if (commandName && (COMMAND_HELP as Record<string, any>)[scope]?.[commandName]) return `Usage: swarm ${scope} ${commandName} [options]\n\n${(COMMAND_HELP as Record<string, any>)[scope][commandName]}\n\nCommon options:\n  --input <file>             Read a JSON request body\n  --stdin                    Read a JSON request body from stdin\n  --json                     Pretty-print the JSON result\n  --request-id <id>        Stable request ID; reuse the same ID and payload after unknown response\n  --timeout-ms <milliseconds>Bound the HTTP request (default ${operationTimeoutMs((COMMAND_OPERATIONS as Record<string, any>)[scope]?.[commandName] ?? commandName)})\n  --help                     Show this command help`;
  const commands = scope === 'task' ? `\n\nCommands: ${TASK_COMMANDS}. See swarm service view task --json for the operations enabled by the host.` : '';
  return `Usage: swarm ${scope} <command> [options]${commands}\n\nUse --input file or --stdin for a complete JSON payload. Task and Material IDs and file paths use the documented positional arguments.\nBot identity always comes from the protected Bridge binding.\nUse "swarm ${scope} <command> --help" for command-specific parameters.`;
}

function parseArgs(argv: any) {
  const booleanFlags = new Set(['help', 'json', 'stdin', 'all', 'resolved']);
  const positionals: any[] = [];
  const options: Record<string, any> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const separator = token.indexOf('=');
    const rawKey = token.slice(2, separator < 0 ? undefined : separator);
    const inline = separator < 0 ? undefined : token.slice(separator + 1);
    const key = rawKey.replaceAll('_', '-');
    if (key === 'operation-id') throw new Error('Use --request-id for request identity');
    if (inline !== undefined) options[key] = inline;
    else if (booleanFlags.has(key)) options[key] = true;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) options[key] = argv[++index];
    else throw new Error(`--${key} requires a value`);
  }
  return { positionals, options };
}

function envName(service: any) { return `SWARMENV_${transportService(service).toUpperCase()}_SERVICE_URL`; }
function tokenName(service: any) { return `SWARMENV_${transportService(service).toUpperCase()}_SERVICE_TOKEN`; }
function endpointFor(service: any) { return process.env[envName(service)] ?? null; }
function safeEndpoint(value: any) {
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return '[invalid endpoint]'; }
}
function configuredEndpoint(service: any) {
  service = transportService(service);
  const direct = endpointFor(service);
  if (direct) return { url: direct, token: process.env[tokenName(service)] ?? null };
  if (!process.env.SWARMENV_SERVICE_ENDPOINTS) return null;
  const configured = JSON.parse(process.env.SWARMENV_SERVICE_ENDPOINTS);
  const value = configured?.[service];
  if (!value) return null;
  if (typeof value === 'string') return { url: value, token: null };
  return { url: value.url, token: value.token ?? null };
}
function configuredService(service: any) { return typeof service === 'string' && (SERVICE_NAMES.includes(service) || Boolean(configuredEndpoint(service))); }

function parseScalar(value: any) {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('{') || value.startsWith('[')) { try { return JSON.parse(value); } catch { return value; } }
  return value;
}

async function inputFrom(options: any) {
  if (options.input && options.stdin) throw new Error('--input and --stdin are mutually exclusive');
  if (options.input) return requireObject(JSON.parse(await readFile(String(options.input), 'utf8')));
  if (options.stdin) return requireObject(JSON.parse(await new Promise<any>((resolve: any, reject: any) => { let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk: any) => { data += chunk; }); process.stdin.on('end', () => resolve(data)); process.stdin.on('error', reject); })));
  return {};
}

function requireObject(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input must be a JSON object');
  return value;
}

function flagInput(options: any) {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(options)) {
    if (RESERVED.has(key) || ['input', 'stdin'].includes(key)) continue;
    result[key.replaceAll('-', '_')] = parseScalar(value);
  }
  for (const [from, to] of [['task-id', 'task_id'], ['execution-id', 'execution_id'], ['fencing-version', 'fencing_version'], ['spec-version', 'spec_version'], ['state-version', 'state_version']]) {
    if (options[from] !== undefined) result[to] = parseScalar(options[from]);
  }
  return result;
}

function envelope(options: any, service: any) {
  return {
    operation_id: String(options['request-id'] ?? `cli:${service}:${randomUUID()}`),
    actor_ref: String(options['actor-ref'] ?? `cli:${process.env.USER ?? 'local'}`),
    task_id: options['task-id'] ?? null,
    execution_id: options['execution-id'] ?? null,
    spec_version: options['spec-version'] === undefined ? null : Number(options['spec-version']),
    state_version: options['state-version'] === undefined ? null : Number(options['state-version']),
    ...(options['fencing-version'] === undefined ? {} : { fencing_version: Number(options['fencing-version']) }),
  };
}

async function request(url: any, { method = 'GET', token = null, body = undefined, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }: any = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) throw new Error(`timeout-ms must be between 1 and ${MAX_REQUEST_TIMEOUT_MS}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('CLI request timed out')), timeoutMs);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await requestHttp(url, { method, headers, signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = response.text;
    let parsed: Record<string, any> = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    if (!response.ok || parsed.ok === false) {
      const error = parsed.error ?? {};
      const failure: any = new Error(error.message ?? `HTTP ${response.status}`);
      failure.code = error.code ?? `HTTP_${response.status}`;
      failure.status = response.status;
      failure.details = error.details;
      if (typeof error.retryable === 'boolean') failure.retryable = error.retryable;
      if (error.request_id !== undefined) failure.request_id = error.request_id;
      throw failure;
    }
    return parsed.result ?? parsed;
  } catch (error: any) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      const timeoutError: any = new Error(`service request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'SERVICE_TIMEOUT';
      timeoutError.details = { url: safeEndpoint(url), timeout_ms: timeoutMs };
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function manifest(service: any) {
  if (process.env.SWARMENV_BRIDGE_URL) {
    if (service === 'bot') {
      try { return await bridgeCall('get_service_metadata', { service: 'bot' }); }
      catch (error: any) { if (error.code !== 'NOT_ALLOWED') throw error; }
    }
    return bridgeCall('get_service_metadata', { service: transportService(service) });
  }
  service = transportService(service);
  const endpoint = configuredEndpoint(service);
  if (!endpoint?.url) throw new Error(`no endpoint configured for ${service}; set ${envName(service)}`);
  return request(`${endpoint.url.replace(/\/$/, '')}/v1/manifest`, { token: endpoint.token });
}

async function listServices() {
  if (process.env.SWARMENV_BRIDGE_URL) return bridgeCall('list_services', {});
  const configured = process.env.SWARMENV_SERVICE_ENDPOINTS ? JSON.parse(process.env.SWARMENV_SERVICE_ENDPOINTS) : {};
  const services = [...new Set([...SERVICE_NAMES, ...Object.keys(configured)])];
  const result: any[] = [];
  for (const service of services) {
    const configuredValue = configured[service];
    const endpoint = endpointFor(service) ?? configuredValue?.url ?? configuredValue ?? null;
    if (!endpoint) continue;
    try { result.push(await request(`${String(endpoint).replace(/\/$/, '')}/v1/manifest`, { token: process.env[tokenName(service)] ?? configuredValue?.token ?? null })); }
    catch (error: any) { result.push({ service_id: service, endpoint: safeEndpoint(endpoint), available: false, error: { code: error.code ?? 'SERVICE_UNAVAILABLE', message: error.message } }); }
  }
  return { services: result };
}

async function bridgeCall(operation: string, payload: unknown, options: any = {}, serviceId?: string, capabilityTimeoutMs?: number) {
  const token = process.env.SWARMENV_BRIDGE_TOKEN;
  if (!token) throw new Error('SWARMENV_BRIDGE_TOKEN is required for Bot operations');
  const requestId = options['request-id'] ?? `cli:${operation === 'task_take' ? 'take' : operation}:${randomUUID()}`;
  try { return await request(`${process.env.SWARMENV_BRIDGE_URL!.replace(/\/$/, '')}/call`, {
    method: 'POST', token, timeoutMs: options['timeout-ms'] === undefined && capabilityTimeoutMs !== undefined ? capabilityTimeoutMs + 1000 : operationTimeoutMs(operation, options['timeout-ms']),
    body: { operation, service_id: serviceId, operation_id: requestId, payload },
  }); } catch (error: any) {
    if (requestId && (error.code === 'SERVICE_TIMEOUT' || !error.code || /^(ECONN|EPIPE|ENET|EHOST|EAI_)/.test(error.code))) {
      error.details = { ...error.details, request_id: requestId, operation, request_outcome: 'unknown',
        notice: `请求 ${requestId} 结果未明。查询或重试同一请求；仅用相同 ID 和相同参数恢复原请求；修改参数应使用新请求。` };
    }
    throw error;
  }
}

function commandInput(service: any, command: any, options: any, args: any, input: any) {
  const fields = {
    task: { view: 'task_id', take: 'task_id', revise: 'task_id', cancel: 'task_id', 'dependency-replace': 'task_id' },
    material: { view: 'material_id', search: 'query', dispute: 'material_id', supersede: 'material_id', unsupersede: 'material_id' },
    workspace: { files: 'path', read: 'path', search: 'query' },
    judge: { result: 'check_result_id' },
    mission: { 'submission view': 'submission_id' },
  };
  const field = (fields as Record<string, any>)[service]?.[command];
  if (args.length > (field ? 1 : 0)) throw new Error('unexpected positional arguments');
  if (args.length) {
    if (input[field] !== undefined && input[field] !== args[0]) throw new Error(`conflicting ${field}`);
    input[field] = args[0];
  }
  const rename = (from: any, to: any) => {
    if (input[from] === undefined) return;
    if (input[to] !== undefined && input[to] !== input[from]) throw new Error(`conflicting ${to}`);
    input[to] = input[from]; delete input[from];
  };
  if (service === 'workspace' || service === 'judge') rename('at', 'revision');
  if (service === 'workspace' && command === 'history') { rename('task', 'producer_task_id'); rename('execution', 'producer_execution_id'); }
  if (service === 'material' && ['supersede', 'unsupersede'].includes(command)) rename('with', 'replacement_material_id');
  if (service === 'workspace' && command === 'save' && typeof input.material_ids === 'string') input.material_ids = input.material_ids.split(',').filter(Boolean);
  if (service === 'mission' && command === 'submit') {
    rename('materials', 'material_ids');
    if (typeof input.material_ids === 'string') input.material_ids = input.material_ids.split(',').filter(Boolean);
    if (!Array.isArray(input.material_ids)) throw new Error('mission submit requires an explicit --materials selection, including [] for files only');
  }
  if (service === 'task' && ['finish', 'cancel'].includes(command)) rename('replacement', 'replacement_task_id');
  if (process.env.SWARMENV_BRIDGE_URL) {
    const forbidden = ['actor_ref', 'owner_ref', 'bot_id', 'bot', 'core_id', 'execution_id', 'execution', 'task_owner', 'fencing_version', 'spec_version', 'state_version'];
    if (options['actor-ref'] !== undefined || forbidden.some((key: any) => input[key] !== undefined)) throw new Error('Bot identity comes from the protected Bridge; identity overrides are not allowed');
  }
  return input;
}

async function invoke(service: any, commandName: any, options: any, args: any = []) {
  if (process.env.SWARMENV_BRIDGE_URL && service === 'bot' && ['spawn', 'get', 'send', 'stop'].includes(commandName)) {
    const metadata = await manifest('bot');
    if (metadata.id !== 'bot' || !metadata.capabilities.some((item: any) => item.operation === commandName)) throw new Error(`service bot does not advertise capability ${commandName}`);
    const input = { ...(await inputFrom(options)), ...flagInput(options) };
    if (args.length > (commandName === 'spawn' ? 0 : 1)) throw new Error('unexpected positional arguments');
    if (args.length) {
      if (input.bot_id !== undefined && input.bot_id !== args[0]) throw new Error('conflicting bot_id');
      input.bot_id = args[0];
    }
    if (input.text !== undefined) {
      if (input.input !== undefined && input.input !== input.text) throw new Error('conflicting input');
      input.input = input.text; delete input.text;
    }
    return bridgeCall(commandName, input, options, 'bot', metadata.capabilities.find((item: { operation: string; timeout_ms?: number }) => item.operation === commandName)?.timeout_ms);
  }
  const alias = operationForCommand(service, commandName);
  const knownGroup = Object.hasOwn(COMMAND_OPERATIONS, service);
  const coreV2 = process.env.SWARMENV_BRIDGE_URL && process.env.SWARMENV_BRIDGE_CONTRACT_VERSION === '2';
  if (knownGroup && !alias && !coreV2) throw new Error(`unknown ${service} command: ${commandName}`);
  let operation = alias ?? commandName;
  const input = commandInput(service, commandName, options, args, { ...(await inputFrom(options)), ...flagInput(options) });
  if (service === 'workspace' && commandName === 'diff' && (input.from !== undefined || input.to !== undefined)) {
    if (typeof input.from !== 'string' || typeof input.to !== 'string' || !input.from || !input.to) throw new Error('public Workspace diff requires both --from and --to');
    operation = 'workspace_public_diff';
  }
  if (process.env.SWARMENV_BRIDGE_URL) {
    if (coreV2 || !knownGroup) {
      const metadata = await manifest(service);
      const capability = metadata.capabilities?.find((item: { operation: string }) => item.operation === operation) ??
        (alias ? undefined : metadata.capabilities?.find((item: { name: string }) => item.name === operation));
      if (!capability && !alias) {
        if (knownGroup) throw new Error(`unknown ${service} command: ${commandName}`);
        throw new Error(`service ${service} does not advertise capability ${operation}`);
      }
      return bridgeCall(capability?.operation ?? operation, input, options, transportService(service), capability?.timeout_ms);
    }
    // Legacy Bridges retain their operation-only request and one delivery.
    return bridgeCall(operation, input, options);
  }
  const provider = await manifest(service);
  const capability = provider.capabilities?.find((candidate: any) => candidate.operation === operation || candidate.name === operation);
  if (!capability) throw new Error(`service ${service} does not advertise capability ${operation}`);
  const endpoint = configuredEndpoint(service);
  const invocationBase = endpoint?.url ?? provider.endpoint.url;
  return request(`${invocationBase.replace(/\/$/, '')}${capability.path}`, {
    method: capability.method ?? 'POST', token: endpoint?.token ?? null, timeoutMs: operationTimeoutMs(operation, options['timeout-ms']),
    body: { envelope: envelope(options, service), input, role: 'bound' },
  });
}

function writeManifestHelp(stdout: any, command: string, provider: any, capabilities: any[]) {
  stdout.write(`Usage: ${command} [--input <json-file> | --stdin] [--request-id <id>]\n${provider.purpose}\n`);
  stdout.write('Use an actual input schema property name as a flag, replacing underscores with hyphens. Use a JSON object with --input or --stdin for structured input.\n');
  for (const capability of capabilities) stdout.write(`${capability.operation}: ${capability.description}\n${capability.help.when}\nside_effect=${capability.side_effect}; idempotent=${capability.idempotent}\nInput schema: ${JSON.stringify(capability.input_schema)}\nOutput schema: ${JSON.stringify(capability.output_schema)}\nErrors: ${JSON.stringify(capability.errors)}\n`);
  return 0;
}

async function invokeRegisteredService(args: string[], options: any, stdout: any) {
  const [service, operation] = args;
  if (args.length !== 2 || !service || !operation) {
    if (options.help) { stdout.write('Usage: swarm service invoke <service-id> <operation> [--input <json-file> | --stdin]\n'); return 0; }
    throw new Error('service invoke requires one registered service ID and one operation');
  }
  if (!process.env.SWARMENV_BRIDGE_URL || process.env.SWARMENV_BRIDGE_CONTRACT_VERSION !== '2') {
    throw new Error('service invoke requires a Core v2 Bridge');
  }
  const provider = await bridgeCall('get_service_metadata', { service });
  const capability = provider.capabilities?.find((item: any) => item.operation === operation);
  if (!capability) throw new Error(`service ${service} does not advertise capability ${operation}`);
  if (options.help) return writeManifestHelp(stdout, `swarm service invoke ${service} ${operation}`, provider, [capability]);
  const input = commandInput('', '', options, [], { ...(await inputFrom(options)), ...flagInput(options) });
  return writeResult(await bridgeCall(operation, input, options, service, capability.timeout_ms), options, stdout);
}

export async function runSwarmCli(argv: any = process.argv.slice(2), { stdout = process.stdout }: any = {}) {
  const { positionals, options } = parseArgs(argv);
  if (positionals[0] === 'service' && positionals[1] === 'invoke') return invokeRegisteredService(positionals.slice(2), options, stdout);
  if (positionals[0] === 'context') throw new Error('unknown command group: context');
  const [helpService, helpCommand] = positionals;
  const localHelp: Readonly<Record<string, Readonly<Record<string, string>>>> = COMMAND_HELP;
  const hasLocalHelp = (Object.hasOwn(localHelp, helpService) && Object.hasOwn(localHelp[helpService], helpCommand)) ||
    (helpService === 'mission' && helpCommand === 'submission');
  const botDiscovery = helpService === 'bot' && !helpCommand;
  const manifestHelp = options.help && helpService && helpService !== 'service' && !hasLocalHelp &&
    (Boolean(helpCommand) || !Object.hasOwn(COMMAND_OPERATIONS, helpService));
  if ((manifestHelp || botDiscovery) && process.env.SWARMENV_BRIDGE_URL) {
    const provider = await manifest(helpService);
    if (botDiscovery && provider.id !== 'bot') { stdout.write(usage('bot') + '\n'); return 0; }
    const operation = operationForCommand(helpService, helpCommand) ?? helpCommand;
    const exact = operation && provider.capabilities.find((item: any) => item.operation === operation);
    const capabilities = exact ? [exact]
      : operation ? provider.capabilities.filter((item: any) => item.name === operation) : provider.capabilities;
    if (!capabilities.length) throw new Error('Service does not advertise this operation');
    return writeManifestHelp(stdout, `swarm ${helpService} ${helpCommand ?? '<operation>'}`, provider, capabilities);
  }
  if (options.help) {
    if (positionals[0] === 'mission' && positionals[1] === 'submission') {
      stdout.write('Usage: swarm mission submission view [id] [--json]\nWithout an ID, read current Mission state and its submissions. With an ID, read that submission and its fixed inputs.\n');
      return 0;
    }
    const scope = positionals[0] === 'service' ? 'service' : (positionals[0] ?? 'top');
    stdout.write(`${usage(scope, positionals[1] ?? null)}\n`);
    return 0;
  }
  if (positionals.length === 0) { stdout.write(`${usage('top')}\n`); return 0; }
  const [service, rawCommand, serviceId] = positionals;
  let commandName = rawCommand;
  let args = positionals.slice(2);
  if (service === 'mission' && commandName === 'submission') {
    if (args[0] !== 'view') throw new Error('mission submission requires view [id]');
    commandName = 'submission view'; args = args.slice(1);
  }
  if (service === 'service') {
    if (positionals.length > (commandName === 'view' ? 3 : 2)) throw new Error('unexpected service arguments');
    if (!commandName || commandName === 'list') return writeResult(await listServices(), options, stdout);
    if (commandName === 'view') { if (!serviceId) throw new Error('service view requires a service id'); return writeResult(await manifest(serviceId), options, stdout); }
    throw new Error(`unknown service command: ${commandName}`);
  }
  if (!configuredService(service) && !process.env.SWARMENV_BRIDGE_URL) throw new Error(`unknown service: ${service}; configure ${envName(service)} or SWARMENV_SERVICE_ENDPOINTS`);
  if (!commandName || options.help) { stdout.write(`${usage(service, commandName)}\n`); return 0; }
  return writeResult(await invoke(service, commandName, options, args), options, stdout);
}

// A checker can complete its request successfully while deciding that the
// submitted Workspace source is invalid. Keep that business verdict distinct from
// transport/service failure (1) and CLI/contract failure (2).
function resultExitCode(result: any) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 0;
  const verdict = String([result.verdict, result.result_class, result.mathematical_outcome, result.status].find((value: any) => value !== undefined && value !== null) ?? '').toLowerCase();
  return ['fail', 'failed', 'source_failure', 'mathematical_failure', 'incorrect'].includes(verdict) ? 3 : 0;
}

function writeResult(result: any, options: any, stdout: any) {
  stdout.write(`${JSON.stringify(result, null, options.json ? 2 : 0)}\n`);
  return resultExitCode(result);
}

export function cliUsage() { return usage('top'); }

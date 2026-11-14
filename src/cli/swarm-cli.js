import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const SERVICE_NAMES = ['task', 'bot', 'material', 'workspace', 'mission', 'judge', 'catalog'];
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 10 * 60_000;
const ALIASES = Object.freeze({
  bot: { exit: 'bot_exit' },
  // complete/block/close remain transport aliases for old clients; finish is
  // the single public Task lifecycle command.
  task: { list: 'task_list', discover: 'task_list', view: 'task_view', create: 'task_create', propose: 'task_create', take: 'task_take', finish: 'task_finish', feedback: 'task_feedback', link: 'task_link_material', status: 'task_status' },
  material: { list: 'read_materials', read: 'context_get_material', get: 'context_get_material', view: 'context_get_material', search: 'context_search_materials', publish: 'context_publish_material', consume: 'consume_materials' },
  workspace: { view: 'workspace_public_view', history: 'workspace_public_history', status: 'workspace_status', diff: 'workspace_current_diff', apply: 'workspace_public_apply', files: 'workspace_public_files', list: 'workspace_public_files', read: 'workspace_public_read', search: 'workspace_public_search', save: 'workspace_save', merge: 'workspace_merge' },
  mission: { view: 'mission_get', submit: 'mission_submit', status: 'mission_submission_get', finish: 'mission_submission_finish' },
  judge: { check: 'workspace_check', submit: 'workspace_check', result: 'get_check_result', get: 'get_check_result' },
});
const RESERVED = new Set(['help', 'json', 'input', 'stdin', 'actor-ref', 'task-id', 'execution-id', 'fencing-version', 'spec-version', 'state-version', 'operation-id', 'request-id', 'timeout-ms']);
const COMMAND_HELP = Object.freeze({
  bot: { exit: 'End an unbound Bot. Required: --reason no-work or selection-budget. The Core is released after cleanup.' },
  task: {
    list: 'Search Task summaries across states using --query, --state/--states, --limit (1-100) and --cursor. Follow next_cursor even after an empty page, then view Task details before proposing or taking. Creation order is stable within a scan; state and readiness are live at each page.',
    view: 'Read one Task. Required: <task-id> (or --task-id). Output: authoritative Task, state, relations and Material links.',
    propose: 'Propose a Task with a bounded goal, deliverable and completion conditions. Use --input file or --stdin. Creator and Mission come from the Bot binding.',
    create: 'Create a Task. Use --input or --stdin for the complete Task contract. Output: created Task.',
    take: 'Take an eligible Task. Use --input or --stdin for the task request. Output: Execution binding.',
    finish: 'Finish the current Task with outcome done, incomplete, blocked, or cancelled. Use --input or --stdin for the outcome contract.',
    feedback: 'Record feedback for the current Task. Use --input or --stdin for the feedback contract.',
  },
  context: {
    list: 'Read bounded Materials. Input: filters such as --mission-id, --kind and --limit.',
    read: 'Read Materials. Use --input or --stdin for the read filter.',
    get: 'Read one Material. Required: <material-id> (or --material-id).',
    view: 'Read one immutable Material including provenance and corrections. Required: <material-id>.',
    search: 'Search Materials. Input: --query and explicit scope filters.',
    publish: 'Publish immutable Material. Use --input or --stdin for content and provenance.',
    consume: 'Record Material consumption. Use --input or --stdin for Material IDs and action.',
  },
  material: {
    list: 'Read bounded Materials. Input: filters such as --mission-id, --kind and --limit.',
    read: 'Read Materials. Use --input or --stdin for the read filter.',
    get: 'Read one Material. Required: <material-id> (or --material-id).',
    view: 'Read one immutable Material including provenance and corrections. Required: <material-id>.',
    search: 'Search Materials. Input: --query and explicit scope filters.',
    publish: 'Publish immutable Material. The service binds producer Task/Execution from the trusted request context.',
    consume: 'Record a meaningful Material use. Use --input or --stdin for Material IDs and action.',
  },
  workspace: {
    view: 'Read the current public Workspace and main.',
    history: 'Read main history; --all includes unmerged saves. Filter --task, --execution, --path; paginate with --limit and --cursor.',
    status: 'Inspect current E initial input, saved revision, dirty paths and conflicts.',
    diff: 'Compare the current E project with its last saved revision.',
    files: 'Read files from a fixed public Workspace revision before take.',
    list: 'List files from a fixed public Workspace revision before take.',
    read: 'Read one file from a fixed public Workspace revision.',
    search: 'Search text in a fixed public Workspace revision.',
    apply: 'Apply a fixed public revision into the current E using --from revision or main. Save dirty work first; reuse --request-id after an unknown response.',
    save: 'Save the actual current E project as a stable public revision. Use --resolved only after resolving recorded conflicts and removing their alternatives. No file, identity or lineage arguments. Reuse --request-id after an unknown response.',
    merge: 'Merge --from a fixed public revision; Runtime pins main, checks the combined tree when configured, and conditionally advances main. Reuse --request-id after response loss.',
  },
  mission: {
    view: 'Read the current Mission goal and acceptance conditions through the trusted Bot binding.',
    submit: 'Mission snapshot submission is pending Runtime integration; registered Bot requests return SERVICE_NOT_READY.',
    status: 'Read Mission submission state and immutable snapshots.',
    finish: 'Record the result of a durable Mission submission.',
  },
  judge: {
    check: 'Check a saved public Workspace file with --revision and --path. Save first; the checker reads that fixed revision, not unsaved local edits. Use --request-id for response recovery.',
    result: 'Read one CheckResult. Use --check-result-id or --request-key; request-key lookup survives a lost submit response.',
  },
});

function usage(scope = 'top', commandName = null) {
  if (scope === 'top') return `Usage: swarm <service> <command> [options]\n\nServices:\n  service list|view <id>     Discover configured service manifests\n  task list|view|propose|take|finish|feedback\n  material list|view|search|publish|consume\n  workspace view|history|status|diff|files|read|search|save|apply|merge\n  mission view|submit|submission view\n  judge check|result\n  <configured service> <manifest operation>\n\nOptions:\n  --json                     Pretty-print a JSON result\n  --input <file>             Read JSON input from a file\n  --stdin                    Read JSON input from stdin\n  --request-id <id>          Stable identity for a write; reuse after an unknown response\n  --operation-id <id>        Reuse a request identity after a lost response\n  --help                     Show this help\n\nBots use their protected Bridge binding; caller flags cannot authorize another identity.\nOperator service endpoints use SWARMENV_<SERVICE>_SERVICE_URL,\nSWARMENV_SERVICE_ENDPOINTS, and optional service tokens. Requests are non-interactive JSON.`;
  if (scope === 'service') return 'Usage: swarm service list|view <service-id> [--json]\n\nLists configured service manifests or shows one manifest through the Bot Bridge. No network is required for --help.';
  if (commandName && COMMAND_HELP[scope]?.[commandName]) return `Usage: swarm ${scope} ${commandName} [options]\n\n${COMMAND_HELP[scope][commandName]}\n\nCommon options:\n  --input <file>             Read a JSON request body\n  --stdin                    Read a JSON request body from stdin\n  --json                     Pretty-print the JSON result\n  --request-id <id>        Stable request ID; reuse the same ID and payload after unknown response\n  --timeout-ms <milliseconds>Bound the HTTP request (default ${DEFAULT_REQUEST_TIMEOUT_MS})\n  --help                     Show this command help`;
  return `Usage: swarm ${scope} <command> [options]\n\nUse --input file or --stdin for a complete JSON payload. Task and Material IDs and file paths use the documented positional arguments.\nBot identity always comes from the protected Bridge binding.\nUse "swarm ${scope} <command> --help" for command-specific parameters.`;
}

function parseArgs(argv) {
  const booleanFlags = new Set(['help', 'json', 'stdin', 'all', 'resolved']);
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const separator = token.indexOf('=');
    const rawKey = token.slice(2, separator < 0 ? undefined : separator);
    const inline = separator < 0 ? undefined : token.slice(separator + 1);
    const key = rawKey.replaceAll('_', '-');
    if (inline !== undefined) options[key] = inline;
    else if (booleanFlags.has(key)) options[key] = true;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) options[key] = argv[++index];
    else throw new Error(`--${key} requires a value`);
  }
  return { positionals, options };
}

function transportService(service) { return service === 'material' ? 'context' : service === 'bot' ? 'task' : service; }
function envName(service) { return `SWARMENV_${transportService(service).toUpperCase()}_SERVICE_URL`; }
function tokenName(service) { return `SWARMENV_${transportService(service).toUpperCase()}_SERVICE_TOKEN`; }
function endpointFor(service) { return process.env[envName(service)] ?? null; }
function safeEndpoint(value) {
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return '[invalid endpoint]'; }
}
function configuredEndpoint(service) {
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
function configuredService(service) { return typeof service === 'string' && (SERVICE_NAMES.includes(service) || Boolean(configuredEndpoint(service))); }

function parseScalar(value) {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('{') || value.startsWith('[')) { try { return JSON.parse(value); } catch { return value; } }
  return value;
}

async function inputFrom(options) {
  if (options.input && options.stdin) throw new Error('--input and --stdin are mutually exclusive');
  if (options.input) return requireObject(JSON.parse(await readFile(String(options.input), 'utf8')));
  if (options.stdin) return requireObject(JSON.parse(await new Promise((resolve, reject) => { let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { data += chunk; }); process.stdin.on('end', () => resolve(data)); process.stdin.on('error', reject); })));
  return {};
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input must be a JSON object');
  return value;
}

function flagInput(options) {
  const result = {};
  for (const [key, value] of Object.entries(options)) {
    if (RESERVED.has(key) || ['input', 'stdin'].includes(key)) continue;
    result[key.replaceAll('-', '_')] = parseScalar(value);
  }
  for (const [from, to] of [['task-id', 'task_id'], ['execution-id', 'execution_id'], ['fencing-version', 'fencing_version'], ['spec-version', 'spec_version'], ['state-version', 'state_version']]) {
    if (options[from] !== undefined) result[to] = parseScalar(options[from]);
  }
  return result;
}

function envelope(options, service) {
  return {
    operation_id: String(options['request-id'] ?? options['operation-id'] ?? `cli:${service}:${randomUUID()}`),
    actor_ref: String(options['actor-ref'] ?? `cli:${process.env.USER ?? 'local'}`),
    task_id: options['task-id'] ?? null,
    execution_id: options['execution-id'] ?? null,
    spec_version: options['spec-version'] === undefined ? null : Number(options['spec-version']),
    state_version: options['state-version'] === undefined ? null : Number(options['state-version']),
    ...(options['fencing-version'] === undefined ? {} : { fencing_version: Number(options['fencing-version']) }),
  };
}

async function request(url, { method = 'GET', token = null, body = undefined, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) throw new Error(`timeout-ms must be between 1 and ${MAX_REQUEST_TIMEOUT_MS}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('CLI request timed out')), timeoutMs);
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetch(url, { method, headers, signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    if (!response.ok || parsed.ok === false) {
      const error = parsed.error ?? {};
      const failure = new Error(error.message ?? `HTTP ${response.status}`);
      failure.code = error.code ?? `HTTP_${response.status}`;
      failure.status = response.status;
      failure.details = error.details;
      throw failure;
    }
    return parsed.result ?? parsed;
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      const timeoutError = new Error(`service request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'SERVICE_TIMEOUT';
      timeoutError.details = { url: safeEndpoint(url), timeout_ms: timeoutMs };
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function manifest(service) {
  if (process.env.SWARMENV_BRIDGE_URL) return bridgeCall('get_service_metadata', { service: transportService(service) });
  service = transportService(service);
  const endpoint = configuredEndpoint(service);
  if (!endpoint?.url) throw new Error(`no endpoint configured for ${service}; set ${envName(service)}`);
  return request(`${endpoint.url.replace(/\/$/, '')}/v1/manifest`, { token: endpoint.token });
}

async function listServices() {
  if (process.env.SWARMENV_BRIDGE_URL) return bridgeCall('list_services', {});
  const configured = process.env.SWARMENV_SERVICE_ENDPOINTS ? JSON.parse(process.env.SWARMENV_SERVICE_ENDPOINTS) : {};
  const services = [...new Set([...SERVICE_NAMES, ...Object.keys(configured)])];
  const result = [];
  for (const service of services) {
    const configuredValue = configured[service];
    const endpoint = endpointFor(service) ?? configuredValue?.url ?? configuredValue ?? null;
    if (!endpoint) continue;
    try { result.push(await request(`${String(endpoint).replace(/\/$/, '')}/v1/manifest`, { token: process.env[tokenName(service)] ?? configuredValue?.token ?? null })); }
    catch (error) { result.push({ service_id: service, endpoint: safeEndpoint(endpoint), available: false, error: { code: error.code ?? 'SERVICE_UNAVAILABLE', message: error.message } }); }
  }
  return { services: result };
}

async function bridgeCall(operation, payload, options = {}, serviceId = undefined) {
  const token = process.env.SWARMENV_BRIDGE_TOKEN;
  if (!token) throw new Error('SWARMENV_BRIDGE_TOKEN is required for Bot operations');
  return request(`${process.env.SWARMENV_BRIDGE_URL.replace(/\/$/, '')}/call`, {
    method: 'POST', token, timeoutMs: parseScalar(options['timeout-ms']) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    body: { operation, service_id: serviceId, operation_id: options['request-id'] ?? options['operation-id'] ?? undefined, payload },
  });
}

function commandInput(service, command, options, args, input) {
  const fields = {
    task: { view: 'task_id', take: 'task_id' },
    material: { view: 'material_id', read: 'material_id', get: 'material_id', search: 'query' },
    workspace: { read: 'path', search: 'query' },
    judge: { result: 'check_result_id', get: 'check_result_id' },
    mission: { status: 'submission_id' },
  };
  const field = fields[service]?.[command];
  if (args.length > (field ? 1 : 0)) throw new Error('unexpected positional arguments');
  if (args.length) {
    if (input[field] !== undefined && input[field] !== args[0]) throw new Error(`conflicting ${field}`);
    input[field] = args[0];
  }
  const rename = (from, to) => {
    if (input[from] === undefined) return;
    if (input[to] !== undefined && input[to] !== input[from]) throw new Error(`conflicting ${to}`);
    input[to] = input[from]; delete input[from];
  };
  if (service === 'workspace' || service === 'judge') rename('at', 'revision');
  if (service === 'workspace' && command === 'history') { rename('task', 'source_task'); rename('execution', 'source_execution'); }
  if (service === 'task' && command === 'finish') rename('replacement', 'replacement_task_id');
  if (options['request-id'] !== undefined && options['operation-id'] !== undefined && options['request-id'] !== options['operation-id']) throw new Error('request-id and operation-id must match');
  if (process.env.SWARMENV_BRIDGE_URL) {
    const forbidden = ['actor_ref', 'owner_ref', 'bot_id', 'bot', 'core_id', 'execution_id', 'execution', 'task_owner', 'fencing_version', 'spec_version', 'state_version'];
    if (options['actor-ref'] !== undefined || forbidden.some(key => input[key] !== undefined)) throw new Error('Bot identity comes from the protected Bridge; identity overrides are not allowed');
  }
  return input;
}

async function invoke(service, commandName, options, args = []) {
  const operation = ALIASES[service]?.[commandName] ?? commandName;
  const input = commandInput(service, commandName, options, args, { ...(await inputFrom(options)), ...flagInput(options) });
  if (process.env.SWARMENV_BRIDGE_URL) {
    if (!ALIASES[service]) {
      const metadata = await manifest(service);
      if (!metadata.capabilities?.some(item => item.operation === operation || item.name === operation)) throw new Error(`service ${service} does not advertise capability ${operation}`);
      return bridgeCall(operation, input, options, transportService(service));
    }
    return bridgeCall(operation, input, options);
  }
  const provider = await manifest(service);
  const capability = provider.capabilities?.find((candidate) => candidate.operation === operation || candidate.name === operation);
  if (!capability) throw new Error(`service ${service} does not advertise capability ${operation}`);
  const endpoint = configuredEndpoint(service);
  const invocationBase = endpoint?.url ?? provider.endpoint.url;
  return request(`${invocationBase.replace(/\/$/, '')}${capability.path}`, {
    method: capability.method ?? 'POST', token: endpoint?.token ?? null, timeoutMs: parseScalar(options['timeout-ms']) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    body: { envelope: envelope(options, service), input, role: 'bound' },
  });
}

export async function runSwarmCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const { positionals, options } = parseArgs(argv);
  if (options.help) {
    if (positionals[0] === 'mission' && positionals[1] === 'submission') {
      stdout.write('Usage: swarm mission submission view <id> [--json]\nRead the persistent submission and its fixed inputs.\n');
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
    if (args[0] !== 'view') throw new Error('mission submission requires view <id>');
    commandName = 'status'; args = args.slice(1);
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
function resultExitCode(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 0;
  const verdict = String([result.verdict, result.result_class, result.mathematical_outcome, result.status].find((value) => value !== undefined && value !== null) ?? '').toLowerCase();
  return ['fail', 'failed', 'source_failure', 'mathematical_failure', 'incorrect'].includes(verdict) ? 3 : 0;
}

function writeResult(result, options, stdout) {
  stdout.write(`${JSON.stringify(result, null, options.json ? 2 : 0)}\n`);
  return resultExitCode(result);
}

export function cliUsage() { return usage('top'); }

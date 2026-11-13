import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const SERVICE_NAMES = ['task', 'material', 'workspace', 'mission', 'judge', 'catalog'];
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 10 * 60_000;
const ALIASES = Object.freeze({
  // complete/block/close remain transport aliases for old clients; finish is
  // the single public Task lifecycle command.
  task: { list: 'list_task', discover: 'task_list', view: 'task_view', create: 'task_create', take: 'task_take', finish: 'task_finish', feedback: 'task_feedback', link: 'task_link_material', status: 'task_status' },
  material: { list: 'read_materials', read: 'context_get_material', get: 'context_get_material', search: 'context_search_materials', publish: 'context_publish_material', consume: 'consume_materials' },
  workspace: { files: 'workspace_public_files', list: 'workspace_public_files', read: 'workspace_public_read', search: 'workspace_public_search', save: 'workspace_save', merge: 'workspace_merge' },
  mission: { submit: 'mission_submit', status: 'mission_submission_get', finish: 'mission_submission_finish' },
  judge: { check: 'workspace_check', submit: 'workspace_check', result: 'get_check_result', get: 'get_check_result' },
});
const RESERVED = new Set(['help', 'json', 'input', 'stdin', 'actor-ref', 'task-id', 'execution-id', 'fencing-version', 'spec-version', 'state-version', 'operation-id', 'timeout-ms']);
const COMMAND_HELP = Object.freeze({
  task: {
    list: 'Discover Mission Tasks. Input: filters such as --mission-id, --state, --limit. Output: bounded task list.',
    view: 'Read one Task. Required: --task-id. Output: authoritative Task, state, relations and Material links.',
    create: 'Create a Task. Use --input or --stdin for the complete Task contract. Output: created Task.',
    take: 'Take an eligible Task. Use --input or --stdin for the task request. Output: Execution binding.',
    finish: 'Finish the current Task with outcome done, incomplete, blocked, or cancelled. Use --input or --stdin for the outcome contract.',
    feedback: 'Record feedback for the current Task. Use --input or --stdin for the feedback contract.',
  },
  context: {
    list: 'Read bounded Materials. Input: filters such as --mission-id, --kind and --limit.',
    read: 'Read Materials. Use --input or --stdin for the read filter.',
    get: 'Read one Material. Required: --material-id.',
    search: 'Search Materials. Input: --query and explicit scope filters.',
    publish: 'Publish immutable Material. Use --input or --stdin for content and provenance.',
    consume: 'Record Material consumption. Use --input or --stdin for Material IDs and action.',
  },
  material: {
    list: 'Read bounded Materials. Input: filters such as --mission-id, --kind and --limit.',
    read: 'Read Materials. Use --input or --stdin for the read filter.',
    get: 'Read one Material. Required: --material-id.',
    search: 'Search Materials. Input: --query and explicit scope filters.',
    publish: 'Publish immutable Material. The service binds producer Task/Execution from the trusted request context.',
    consume: 'Record a meaningful Material use. Use --input or --stdin for Material IDs and action.',
  },
  workspace: {
    files: 'Read files from a fixed public Workspace revision before take.',
    list: 'List files from a fixed public Workspace revision before take.',
    read: 'Read one file from a fixed public Workspace revision.',
    search: 'Search text in a fixed public Workspace revision.',
    save: 'Save a complete file tree as an immutable public Workspace revision.',
    merge: 'Conditionally merge a complete public Workspace revision into main.',
  },
  mission: {
    submit: 'Submit a Mission snapshot of main, Materials, checker and environment for final acceptance.',
    status: 'Read Mission submission state and immutable snapshots.',
    finish: 'Record the result of a durable Mission submission.',
  },
  judge: {
    check: 'Submit a Candidate for checking. Use --input or --stdin for the candidate contract.',
    result: 'Read one CheckResult. Use --check-result-id or --request-key; request-key lookup survives a lost submit response.',
  },
});

function usage(scope = 'top', commandName = null) {
  if (scope === 'top') return `Usage: swarm <service> <command> [options]\n\nServices:\n  service list|view <id>     Discover configured service manifests\n  task list|view|create|take|finish|feedback\n  material list|read|get|search|publish|consume\n  workspace files|read|search|save|merge\n  mission submit|status|finish\n  judge check|result\n  <configured service> <manifest operation>\n\nOptions:\n  --json                     Pretty-print a JSON result\n  --input <file>             Read JSON input from a file\n  --stdin                    Read JSON input from stdin\n  --actor-ref <id>           Actor identity (default: cli:<user>)\n  --operation-id <id>        Reuse a request identity after a lost response\n  --help                     Show this help\n\nService endpoints use SWARMENV_<SERVICE>_SERVICE_URL,\nSWARMENV_SERVICE_ENDPOINTS, and optional service tokens. Requests are non-interactive JSON.`;
  if (scope === 'service') return 'Usage: swarm service list|view <service-id> [--json]\n\nLists configured service manifests or shows one manifest. No network is required for --help.';
  if (commandName && COMMAND_HELP[scope]?.[commandName]) return `Usage: swarm ${scope} ${commandName} [options]\n\n${COMMAND_HELP[scope][commandName]}\n\nCommon options:\n  --input <file>             Read a JSON request body\n  --stdin                    Read a JSON request body from stdin\n  --json                     Pretty-print the JSON result\n  --timeout-ms <milliseconds>Bound the HTTP request (default ${DEFAULT_REQUEST_TIMEOUT_MS})\n  --help                     Show this command help`;
  return `Usage: swarm ${scope} <command> [options]\n\nUse --input file or --stdin for a complete JSON payload. Scalar flags such as\n--task-id and --execution-id are converted to the service input contract.\nUse "swarm ${scope} <command> --help" for command-specific parameters.`;
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const [rawKey, inline] = token.slice(2).split('=', 2);
    const key = rawKey.replaceAll('_', '-');
    if (inline !== undefined) options[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) options[key] = argv[++index];
    else options[key] = true;
  }
  return { positionals, options };
}

function transportService(service) { return service === 'material' ? 'context' : service; }
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
  if (options.input) return JSON.parse(await readFile(String(options.input), 'utf8'));
  if (options.stdin) return JSON.parse(await new Promise((resolve, reject) => { let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { data += chunk; }); process.stdin.on('end', () => resolve(data)); process.stdin.on('error', reject); }));
  return {};
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
    operation_id: String(options['operation-id'] ?? `cli:${service}:${randomUUID()}`),
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
  service = transportService(service);
  const endpoint = configuredEndpoint(service);
  if (!endpoint?.url) throw new Error(`no endpoint configured for ${service}; set ${envName(service)}`);
  return request(`${endpoint.url.replace(/\/$/, '')}/v1/manifest`, { token: endpoint.token });
}

async function listServices() {
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

async function invoke(service, commandName, options) {
  const operation = ALIASES[service]?.[commandName] ?? commandName;
  const provider = await manifest(service);
  const capability = provider.capabilities?.find((candidate) => candidate.operation === operation || candidate.name === operation);
  if (!capability) throw new Error(`service ${service} does not advertise capability ${operation}`);
  const input = { ...(await inputFrom(options)), ...flagInput(options) };
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
    const scope = positionals[0] === 'service' ? 'service' : (configuredService(positionals[0]) ? positionals[0] : 'top');
    stdout.write(`${usage(scope, positionals[1] ?? null)}\n`);
    return 0;
  }
  if (positionals.length === 0) { stdout.write(`${usage('top')}\n`); return 0; }
  const [service, commandName, serviceId] = positionals;
  if (service === 'service') {
    if (!commandName || commandName === 'list') return writeResult(await listServices(), options, stdout);
    if (commandName === 'view') { if (!serviceId) throw new Error('service view requires a service id'); return writeResult(await manifest(serviceId), options, stdout); }
    throw new Error(`unknown service command: ${commandName}`);
  }
  if (!configuredService(service)) throw new Error(`unknown service: ${service}; configure ${envName(service)} or SWARMENV_SERVICE_ENDPOINTS`);
  if (!commandName || options.help) { stdout.write(`${usage(service, commandName)}\n`); return 0; }
  return writeResult(await invoke(service, commandName, options), options, stdout);
}

// A checker can complete its request successfully while deciding that the
// submitted candidate is invalid.  Keep that business verdict distinct from
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

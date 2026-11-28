import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { requestHttp } from '../protocol/http-request.js';
const CORE_AGENT_OPERATIONS = ['spawn', 'get', 'send', 'stop', 'access_get', 'grant', 'revoke'];
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const RESERVED = new Set(['help', 'json', 'input', 'stdin', 'actor-ref', 'task-id', 'execution-id', 'fencing-version', 'spec-version', 'state-version', 'request-id', 'timeout-ms']);

export interface SwarmCommands {
  services: readonly string[];
  aliases: Readonly<Record<string, Readonly<Record<string, string>>>>;
  help: Readonly<Record<string, Readonly<Record<string, string>>>>;
  hiddenGroups: readonly string[];
  overview: string;
  transportService(service: string): string;
  transformInput(service: string, command: string, args: string[], input: Record<string, any>): Record<string, any>;
  groupHelp(service: string): string | undefined;
  extendedHelp(service: string, command: string): string | undefined;
  parseCommand(service: string, command: string, args: string[]): { command: string; args: string[] };
  selectOperation(service: string, command: string, operation: string, input: Record<string, any>): string;
  timeout(operation: string): string | undefined;
  requestLabel(operation: string): string;
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

type InputSchema = {
  type?: string;
  properties?: Record<string, InputSchema>;
  required?: string[];
  examples?: unknown[];
  default?: unknown;
  const?: unknown;
  enum?: unknown[];
  minLength?: number;
};

function schemaExample(schema: InputSchema, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case 'object': return Object.fromEntries((schema.required ?? []).map(name =>
      [name, schemaExample(schema.properties?.[name] ?? {}, depth + 1)]));
    case 'string': return 'x'.repeat(Math.max(1, Math.min(schema.minLength ?? 1, 200)));
    case 'integer':
    case 'number': return 1;
    case 'boolean': return true;
    case 'array': return [];
    case 'null': return null;
  }
}

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function inputHelp(command: string, schema: InputSchema): string {
  const required = schema.required ?? [];
  const properties = Object.entries(schema.properties ?? {});
  const flag = (name: string) => name.replaceAll('_', '-');
  const supportsFlag = (name: string) => /^[a-zA-Z0-9_]+$/.test(name) && !RESERVED.has(flag(name)) &&
    !['all', 'resolved', 'operation-id'].includes(flag(name));
  const lines = properties.map(([name, field]) => `  ${supportsFlag(name) ? '--' + flag(name) : name + ' (JSON only)'} <${field.type ?? 'JSON'}>${required.includes(name) ? ' (required)' : ''}`);
  try {
    const input = schemaExample(schema);
    // Only print a concrete invocation when the example satisfies the schema.
    if (input && typeof input === 'object' && !Array.isArray(input) &&
        new Ajv({ strict: true, addUsedSchema: false, logger: false }).compile(schema)(input)) {
      const fields = Object.entries(input);
      if (fields.every(([name, value]) => supportsFlag(name) &&
          JSON.stringify(parseScalar(typeof value === 'string' ? value : JSON.stringify(value))) === JSON.stringify(value))) {
        lines.push(`  ${command}${fields.map(([name, value]) => ` --${flag(name)}=${quote(typeof value === 'string' ? value : JSON.stringify(value))}`).join('')}`);
      }
      lines.push(`  printf '%s' ${quote(JSON.stringify(input))} | ${command} --stdin`);
    }
  } catch {
    // Legacy manifests and schemas with constraints that need real data still show their contract.
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

function cliInputError(service: string, operation: string, expected: string, actual: string, remedy: string) {
  return Object.assign(new Error('Could not read Service input'), {
    code: 'CLI_ERROR',
    details: { service_id: service, operation, request_outcome: 'not_executed', validation: [{ pointer: '', expected, actual }], remedy },
  });
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

export function createSwarmCli(commands?: SwarmCommands) {
  const transportService = (service: string) => commands?.transportService(service) ?? service;
  const hasAliases = (service: string) => Boolean(commands && Object.hasOwn(commands.aliases, service));
  const operationForCommand = (service: string, command: string) => {
    const aliases = hasAliases(service) ? commands!.aliases[service] : undefined;
    return aliases && Object.hasOwn(aliases, command) ? aliases[command] : undefined;
  };
  const commandHelp = (service: string, command: string) => {
    const group = commands && Object.hasOwn(commands.help, service) ? commands.help[service] : undefined;
    return group && Object.hasOwn(group, command) ? group[command] : undefined;
  };
  function operationTimeoutMs(operation: string, explicit?: string) {
    const configured = commands?.timeout(operation);
    return parseScalar(explicit) ?? (configured === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : Number(configured));
  }

  function usage(scope: any = 'top', commandName: any = null) {
    if (scope === 'top') return `Usage: swarm <service> <command> [options]\n\nServices:\n  service list|view <id>     Discover configured service manifests\n  service invoke <id> <op>  Call a registered operation by its exact ID\n  agent spawn|get|send|stop     Core direct-child control when granted\n${commands ? commands.overview + '\n' : ''}  <configured service> <manifest operation>\n\nOptions:\n  --json                     Pretty-print a JSON result\n  --input <file>             Read JSON input from a file\n  --stdin                    Read JSON input from stdin\n  --request-id <id>          Stable identity for a write; reuse after an unknown response\n  --help                     Show this help\n\nAgents use their protected Bridge binding; caller flags cannot authorize another identity.\nOperator service endpoints use MURM_<SERVICE>_SERVICE_URL,\nMURM_SERVICE_ENDPOINTS, and optional service tokens. Requests are non-interactive JSON.`;
    if (scope === 'service') return 'Usage: swarm service list|view <service-id> [--json]\n\nLists configured service manifests or shows one manifest through the Agent Bridge. No network is required for --help.';
    if (commandName && commandHelp(scope, commandName)) return `Usage: swarm ${scope} ${commandName} [options]\n\n${commandHelp(scope, commandName)}\n\nCommon options:\n  --input <file>             Read a JSON request body\n  --stdin                    Read a JSON request body from stdin\n  --json                     Pretty-print the JSON result\n  --request-id <id>        Stable request ID; reuse the same ID and payload after unknown response\n  --timeout-ms <milliseconds>Bound the HTTP request (default ${operationTimeoutMs(operationForCommand(scope, commandName) ?? commandName)})\n  --help                     Show this command help`;
    const details = commands?.groupHelp(scope);
    return `Usage: swarm ${scope} <command> [options]${details ? '\n\n' + details : ''}\n\nUse --input file or --stdin for a complete JSON payload.\nAgent identity always comes from the protected Bridge binding.\nUse "swarm ${scope} <command> --help" for command-specific parameters.`;
  }

  function envName(service: any) { return `MURM_${transportService(service).toUpperCase()}_SERVICE_URL`; }
  function tokenName(service: any) { return `MURM_${transportService(service).toUpperCase()}_SERVICE_TOKEN`; }
  function endpointFor(service: any) { return process.env[envName(service)] ?? null; }
  function configuredEndpoint(service: any) {
    service = transportService(service);
    const direct = endpointFor(service);
    if (direct) return { url: direct, token: process.env[tokenName(service)] ?? null };
    if (!process.env.MURM_SERVICE_ENDPOINTS) return null;
    const configured = JSON.parse(process.env.MURM_SERVICE_ENDPOINTS);
    const value = configured?.[service];
    if (!value) return null;
    if (typeof value === 'string') return { url: value, token: null };
    return { url: value.url, token: value.token ?? null };
  }
  function configuredService(service: any) { return typeof service === 'string' && (commands?.services.includes(service) || Boolean(configuredEndpoint(service))); }

  async function manifest(service: any) {
    if (process.env.MURM_BRIDGE_URL) {
      const alias = transportService(service);
      if (alias !== service && (service === 'agent' || process.env.MURM_BRIDGE_CONTRACT_VERSION === '2')) {
        try { return await bridgeCall('get_service_metadata', { service }); }
        catch (error: any) { if (error.code !== 'NOT_ALLOWED') throw error; }
      }
      return bridgeCall('get_service_metadata', { service: alias });
    }
    service = transportService(service);
    const endpoint = configuredEndpoint(service);
    if (!endpoint?.url) throw new Error(`no endpoint configured for ${service}; set ${envName(service)}`);
    return request(`${endpoint.url.replace(/\/$/, '')}/v1/manifest`, { token: endpoint.token });
  }

  async function listServices() {
    if (process.env.MURM_BRIDGE_URL) return bridgeCall('list_services', {});
    const configured = process.env.MURM_SERVICE_ENDPOINTS ? JSON.parse(process.env.MURM_SERVICE_ENDPOINTS) : {};
    const services = [...new Set([...(commands?.services ?? []), ...Object.keys(configured)])];
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
    const token = process.env.MURM_BRIDGE_TOKEN;
    if (!token) throw new Error('MURM_BRIDGE_TOKEN is required for Agent operations');
    const requestId = options['request-id'] ?? `cli:${commands?.requestLabel(operation) ?? operation}:${randomUUID()}`;
    try { return await request(`${process.env.MURM_BRIDGE_URL!.replace(/\/$/, '')}/call`, {
      method: 'POST', token, timeoutMs: options['timeout-ms'] === undefined && capabilityTimeoutMs !== undefined ? capabilityTimeoutMs + 1000 : operationTimeoutMs(operation, options['timeout-ms']),
      body: { operation, service_id: serviceId, operation_id: requestId, payload },
    }); } catch (error: any) {
      if (requestId && (error.code === 'SERVICE_TIMEOUT' || !error.code || /^(ECONN|EPIPE|ENET|EHOST|EAI_)/.test(error.code))) {
        error.details = { ...error.details, request_id: requestId, operation, request_outcome: 'unknown',
          notice: `The outcome of request ${requestId} is unknown. Query or retry the same request. Resume the original request only with the same ID and parameters; use a new request for changed parameters.` };
      }
      throw error;
    }
  }

  function assertCallerFlags(options: any, input: Record<string, any>) {
    if (process.env.MURM_BRIDGE_URL) {
      const forbidden = ['actor_ref', 'owner_ref', 'agent_id', 'agent', 'core_id', 'execution_id', 'execution', 'task_owner', 'fencing_version', 'spec_version', 'state_version'];
      if (options['actor-ref'] !== undefined || forbidden.some((key: any) => input[key] !== undefined)) throw new Error('Agent identity comes from the protected Bridge; identity overrides are not allowed');
    }
  }

  async function invoke(service: any, commandName: any, options: any, args: any = []) {
    if (process.env.MURM_BRIDGE_URL && service === 'agent' && CORE_AGENT_OPERATIONS.includes(commandName)) {
      const metadata = await manifest('agent');
      if (metadata.id !== 'agent' || !metadata.capabilities.some((item: any) => item.operation === commandName)) throw new Error(`service agent does not advertise capability ${commandName}`);
      const input = { ...(await inputFrom(options)), ...flagInput(options) };
      if (args.length > (commandName === 'spawn' ? 0 : 1)) throw new Error('unexpected positional arguments');
      if (args.length) {
        if (input.agent_id !== undefined && input.agent_id !== args[0]) throw new Error('conflicting agent_id');
        input.agent_id = args[0];
      }
      if (input.text !== undefined) {
        if (input.input !== undefined && input.input !== input.text) throw new Error('conflicting input');
        input.input = input.text; delete input.text;
      }
      return bridgeCall(commandName, input, options, 'agent', metadata.capabilities.find((item: { operation: string; timeout_ms?: number }) => item.operation === commandName)?.timeout_ms);
    }
    const alias = operationForCommand(service, commandName);
    const knownGroup = hasAliases(service);
    const coreV2 = process.env.MURM_BRIDGE_URL && process.env.MURM_BRIDGE_CONTRACT_VERSION === '2';
    if (knownGroup && !alias && !coreV2) throw new Error(`unknown ${service} command: ${commandName}`);
    const payload = { ...(await inputFrom(options)), ...flagInput(options) };
    if (!commands && args.length) throw new Error('unexpected positional arguments');
    const input = commands?.transformInput(service, commandName, args, payload) ?? payload;
    assertCallerFlags(options, input);
    const operation = commands?.selectOperation(service, commandName, alias ?? commandName, input) ?? alias ?? commandName;
    if (process.env.MURM_BRIDGE_URL) {
      if (coreV2 || !knownGroup) {
        const metadata = await manifest(service);
        const capability = metadata.capabilities?.find((item: { operation: string }) => item.operation === operation) ??
          (alias ? undefined : metadata.capabilities?.find((item: { name: string }) => item.name === operation));
        if (!capability && !alias) {
          if (knownGroup) throw new Error(`unknown ${service} command: ${commandName}`);
          throw new Error(`service ${service} does not advertise capability ${operation}`);
        }
        return bridgeCall(capability?.operation ?? operation, input, options, (coreV2 && metadata.id ? metadata.id : transportService(service)), capability?.timeout_ms);
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
    for (const capability of capabilities) {
      const invocation = command.endsWith('<operation>') ? command.replace('<operation>', capability.operation) : command;
      stdout.write(`${capability.operation}: ${capability.description}\n${capability.help.when}\nside_effect=${capability.side_effect}; idempotent=${capability.idempotent}\nInput schema: ${JSON.stringify(capability.input_schema)}\nOutput schema: ${JSON.stringify(capability.output_schema)}\nErrors: ${JSON.stringify(capability.errors)}\n`);
      stdout.write(inputHelp(invocation, capability.input_schema ?? {}));
    }
    return 0;
  }

  async function invokeRegisteredService(args: string[], options: any, stdout: any) {
    const [service, operation] = args;
    if (args.length !== 2 || !service || !operation) {
      if (options.help) { stdout.write('Usage: swarm service invoke <service-id> <operation> [--input <json-file> | --stdin]\n'); return 0; }
      if (service && operation) throw cliInputError(service, operation, 'input flags or a JSON object', 'positional arguments',
        'Run the operation with --help. Replace extra positional arguments with the documented flags, --input or --stdin.');
      throw new Error('service invoke requires one registered service ID and one operation');
    }
    if (!process.env.MURM_BRIDGE_URL || process.env.MURM_BRIDGE_CONTRACT_VERSION !== '2') {
      throw new Error('service invoke requires a Core v2 Bridge');
    }
    const provider = await bridgeCall('get_service_metadata', { service });
    const capability = provider.capabilities?.find((item: any) => item.operation === operation);
    if (!capability) throw new Error(`service ${service} does not advertise capability ${operation}`);
    if (options.help) return writeManifestHelp(stdout, `swarm service invoke ${service} ${operation}`, provider, [capability]);
    let input;
    try { input = { ...(await inputFrom(options)), ...flagInput(options) }; }
    catch {
      throw cliInputError(service, operation, 'one readable JSON object', 'invalid input source',
        'Use either --input with a readable JSON file or --stdin with a JSON object. Run the operation with --help for fields.');
    }
    // The v2 manifest validates target fields; the Bridge determines the caller from its credential.
    if (options['actor-ref'] !== undefined) throw new Error('Agent identity comes from the protected Bridge; identity overrides are not allowed');
    return writeResult(await bridgeCall(operation, input, options, service, capability.timeout_ms), options, stdout);
  }

  async function runSwarmCli(argv: any = process.argv.slice(2), { stdout = process.stdout }: any = {}) {
    const { positionals, options } = parseArgs(argv);
    if (positionals[0] === 'service' && positionals[1] === 'invoke') return invokeRegisteredService(positionals.slice(2), options, stdout);
    if (commands?.hiddenGroups.includes(positionals[0])) throw new Error(`unknown command group: ${positionals[0]}`);
    const [helpService, helpCommand] = positionals;
    const extendedHelp = commands?.extendedHelp(helpService, helpCommand);
    const hasLocalHelp = Boolean(commandHelp(helpService, helpCommand) ?? extendedHelp);
    const agentDiscovery = helpService === 'agent' && !helpCommand;
    const manifestHelp = options.help && helpService && helpService !== 'service' && !hasLocalHelp &&
      (Boolean(helpCommand) || !hasAliases(helpService));
    if ((manifestHelp || agentDiscovery) && process.env.MURM_BRIDGE_URL) {
      const provider = await manifest(helpService);
      if (agentDiscovery && provider.id !== 'agent') { stdout.write(usage('agent') + '\n'); return 0; }
      const operation = operationForCommand(helpService, helpCommand) ?? helpCommand;
      const exact = operation && provider.capabilities.find((item: any) => item.operation === operation);
      const capabilities = exact ? [exact]
        : operation ? provider.capabilities.filter((item: any) => item.name === operation) : provider.capabilities;
      if (!capabilities.length) throw new Error('Service does not advertise this operation');
      return writeManifestHelp(stdout, `swarm ${helpService} ${helpCommand ?? '<operation>'}`, provider, capabilities);
    }
    if (options.help) {
      if (extendedHelp) { stdout.write(extendedHelp + '\n'); return 0; }
      const scope = positionals[0] === 'service' ? 'service' : (positionals[0] ?? 'top');
      stdout.write(`${usage(scope, positionals[1] ?? null)}\n`);
      return 0;
    }
    if (positionals.length === 0) { stdout.write(`${usage('top')}\n`); return 0; }
    const [service, rawCommand, serviceId] = positionals;
    const { command: commandName, args } = commands?.parseCommand(service, rawCommand, positionals.slice(2)) ??
      { command: rawCommand, args: positionals.slice(2) };
    if (service === 'service') {
      if (positionals.length > (commandName === 'view' ? 3 : 2)) throw new Error('unexpected service arguments');
      if (!commandName || commandName === 'list') return writeResult(await listServices(), options, stdout);
      if (commandName === 'view') { if (!serviceId) throw new Error('service view requires a service id'); return writeResult(await manifest(serviceId), options, stdout); }
      throw new Error(`unknown service command: ${commandName}`);
    }
    if (!configuredService(service) && !process.env.MURM_BRIDGE_URL) throw new Error(`unknown service: ${service}; configure ${envName(service)} or MURM_SERVICE_ENDPOINTS`);
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

  return { runSwarmCli, cliUsage: () => usage('top') };
}

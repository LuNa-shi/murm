import { access, readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ERROR_CODES, MurmError } from '../errors.js';
import { createServiceManifest } from '../sdk/service-manifest.js';

export const MATHLIB_SEARCH_SERVICE_ID = 'mathlib-search';
export const MATHLIB_SEARCH_CAPABILITY = 'mathlib_search';
export const DEFAULT_MAX_RESULTS = 20;
export const MAX_RESULTS = 50;
export const MAX_QUERY_LENGTH = 2_000;
export const MAX_MODULE_LENGTH = 200;
export const MAX_PATH_LENGTH = 1_000;

const DECLARATION_PATTERN = /^\s*(?:theorem|lemma|def|abbrev|opaque|class|structure|inductive|instance)\s+([A-Za-z0-9_'.]+)/;
const DEFAULT_PROVIDER_VERSION = '1.0.0';
const DEFAULT_TIMEOUT_MS = 8_000;

function isRecord(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function objectSchema(properties: any = {}, required: any = []) {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function normalizeQuery(input: any = {}) {
  if (!isRecord(input)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'mathlib_search input must be an object');
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (query.length === 0) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'mathlib_search.query is required');
  if (query.length > MAX_QUERY_LENGTH) {
    throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `mathlib_search.query must be at most ${MAX_QUERY_LENGTH} characters`, { max_length: MAX_QUERY_LENGTH });
  }
  const moduleName = input.module === undefined || input.module === null ? null : String(input.module).trim();
  if (moduleName && (moduleName.length > MAX_MODULE_LENGTH || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(moduleName))) {
    throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'mathlib_search.module must be a Lean module name', { max_length: MAX_MODULE_LENGTH });
  }
  const pathScope = input.path === undefined || input.path === null ? null : String(input.path).trim();
  if (pathScope && (pathScope.length > MAX_PATH_LENGTH || pathScope.includes('\0'))) {
    throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `mathlib_search.path must be at most ${MAX_PATH_LENGTH} characters`, { max_length: MAX_PATH_LENGTH });
  }
  const maxResults = input.max_results ?? input.maxResults ?? DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `mathlib_search.max_results must be an integer from 1 to ${MAX_RESULTS}`, { max_results: maxResults, max: MAX_RESULTS });
  }
  return { query, module: moduleName, path: pathScope, max_results: maxResults };
}

function queryTokens(query: any) {
  return [...new Set(query
    .replaceAll('→', ' ')
    .split(/[^A-Za-z0-9_'.]+/)
    .map((token: any) => token.trim().toLowerCase())
    .filter((token: any) => token.length >= 2))];
}

function moduleNameFor(root: any, file: any, prefix: any = null) {
  const relativePath = relative(root, file).split(sep).join('/');
  const moduleName = relativePath.replace(/\.lean$/, '').split('/').join('.');
  if (!prefix || moduleName === prefix || moduleName.startsWith(`${prefix}.`)) return moduleName;
  return `${prefix}.${moduleName}`;
}

function sourcePathFor(declaration: any) {
  return String(declaration?.source ?? '').split('#L', 1)[0].replaceAll('\\', '/').replace(/^\.\//, '');
}

function pathMatches(declaration: any, scope: any) {
  if (!scope) return true;
  const source = sourcePathFor(declaration);
  return source === scope || source.startsWith(`${scope}/`);
}

function moduleScopeNames(module: any, prefix: any = null) {
  const names = new Set([module]);
  if (prefix && module !== prefix && !module.startsWith(`${prefix}.`)) names.add(`${prefix}.${module}`);
  if (prefix && module.startsWith(`${prefix}.`)) names.add(module.slice(prefix.length + 1));
  return names;
}

function moduleMatches(candidate: any, module: any, prefix: any = null) {
  if (typeof candidate !== 'string' || !module) return false;
  return [...moduleScopeNames(module, prefix)].some((scope: any) => candidate === scope || candidate.startsWith(`${scope}.`));
}

async function walkLeanFiles(root: any, { maxFiles = 100_000 }: any = {}) {
  const files: any[] = [];
  async function visit(directory: any) {
    if (files.length >= maxFiles) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name === '.lake' || entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.lean')) files.push(path);
    }
  }
  await visit(root);
  return files;
}

function declarationFromLine(line: any, file: any, root: any, lineNumber: any, prefix: any = null) {
  const match = DECLARATION_PATTERN.exec(line);
  if (!match) return null;
  return {
    name: match[1],
    type: line.trim(),
    module: moduleNameFor(root, file, prefix),
    source: `${relative(root, file).split(sep).join('/')}#L${lineNumber}`,
  };
}

function normalizeUpstreamResult(value: any, { query, maxResults = null, metadata }: any) {
  const candidates = Array.isArray(value)
    ? value
    : value?.results ?? value?.declarations ?? value?.hits ?? value?.matches ?? [];
  if (!Array.isArray(candidates)) {
    throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'mathlib search backend returned an unsupported result shape', undefined, { retryable: true });
  }
  const normalized = candidates.map((candidate: any) => {
    if (typeof candidate === 'string') return { name: candidate, type: null, module: null, source: null, score: null };
    if (!isRecord(candidate)) return null;
    return {
      name: candidate.name ?? candidate.declaration ?? candidate.id ?? null,
      type: candidate.type ?? candidate.signature ?? candidate.statement ?? null,
      module: candidate.module ?? candidate.namespace ?? null,
      source: candidate.source ?? candidate.url ?? candidate.file ?? null,
      score: Number.isFinite(candidate.score) ? candidate.score : null,
    };
  }).filter((result: any) => typeof result?.name === 'string' && result.name.length > 0);
  const results = Number.isFinite(maxResults) ? normalized.slice(0, maxResults) : normalized;
  return {
    query,
    results,
    result_count: results.length,
    truncated: normalized.length > results.length,
    ...metadata,
  };
}

function endpointUrl(base: any) {
  if (!base) return null;
  let parsed;
  try { parsed = new URL(base); } catch (error: any) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'mathlib search upstream_url must be an absolute URL', { upstream_url: base }, { cause: error });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new MurmError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'mathlib search upstream_url must use http or https', { upstream_url: base });
  }
  return parsed;
}

export function createMathlibSearchManifest({
  endpoint = { transport: 'in-process' },
  providerVersion = DEFAULT_PROVIDER_VERSION,
  contractVersion = '1',
  mathlibRevision = null,
  leanVersion = null,
}: any = {}) {
  return createServiceManifest({
    id: MATHLIB_SEARCH_SERVICE_ID,
    title: 'Mathlib Search',
    purpose: 'Search Lean and Mathlib declarations before selecting a proof or API route.',
    provider_version: providerVersion,
    contract_version: contractVersion,
    endpoint,
    metadata: {
      backend: 'loogle-compatible',
      mathlib_revision: mathlibRevision,
      lean_version: leanVersion,
    },
    capabilities: [{
      name: MATHLIB_SEARCH_CAPABILITY,
      description: 'Search Mathlib declarations by Lean type, name, or query text.',
      audience: ['bound', 'recovery'],
      side_effect: 'read',
      idempotent: true,
      context: ['task', 'execution'],
      // Searching an external research provider is costly domain work; an
      // unbound identity may inspect service help but must not run searches.
      requires_binding: true,
      help: {
        when: 'Use when investigating a proof or API research route; search by a declaration name or Lean type pattern and verify the result in the locked project.',
        ref: 'service://mathlib-search/skill',
        text: [
          'Purpose: find Lean/Mathlib declarations in the locked project.',
          'Inputs: query (declaration name or Lean type pattern); optional module, path, max_results.',
          'Output: the query, a bounded results array ({name, type, module, source, score}), result_count, truncated, backend, mathlib_revision, lean_version.',
          'Errors: INVALID_CONTRACT (bad scope or input), SERVICE_TIMEOUT and SERVICE_UNAVAILABLE are retryable within the configured bound.',
          'Limits: the result list is bounded; module/path scopes must remain inside the configured source boundary.',
          'Verify every returned declaration in the locked project before relying on it. A hit is evidence for a route, not a proof.',
        ].join('\n'),
      },
      input_schema: objectSchema({
        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
        module: { type: 'string', minLength: 1, maxLength: MAX_MODULE_LENGTH },
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH },
        max_results: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
      }, ['query']),
      output_schema: objectSchema({
        query: { type: 'string' },
        results: { type: 'array' },
        result_count: { type: 'integer', minimum: 0 },
        truncated: { type: 'boolean' },
        backend: { type: 'string' },
        mathlib_revision: { type: ['string', 'null'] },
        lean_version: { type: ['string', 'null'] },
      }),
      path: `/v1/${MATHLIB_SEARCH_CAPABILITY}`,
      errors: [
        { code: ERROR_CODES.INVALID_CONTRACT, retryable: false },
        { code: ERROR_CODES.SERVICE_TIMEOUT, retryable: true },
        { code: ERROR_CODES.SERVICE_UNAVAILABLE, retryable: true },
      ],
    }],
  });
}

export class MathlibSearchService {
  declare upstreamUrl: any;
  declare sourceRoot: any;
  declare projectRoot: any;
  declare boundaryRoot: any;
  declare sourceModulePrefix: any;
  declare allowedModules: any;
  declare fetch: any;
  declare timeoutMs: any;
  declare maxResults: any;
  declare mathlibRevision: any;
  declare leanVersion: any;
  declare logger: any;
  declare indexPromise: any;
  declare sourceModules: any;

  constructor({
    upstreamUrl = process.env.MATHLIB_SEARCH_UPSTREAM_URL ?? null,
    sourceRoot = process.env.MATHLIB_SEARCH_SOURCE_ROOT ?? null,
    projectRoot = process.env.MATHLIB_SEARCH_PROJECT_ROOT ?? null,
    allowedModules = null,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResults = DEFAULT_MAX_RESULTS,
    mathlibRevision = process.env.MATHLIB_REVISION ?? null,
    leanVersion = process.env.LEAN_VERSION ?? null,
    logger = null,
  }: any = {}) {
    if (upstreamUrl === null && sourceRoot === null) {
      throw new TypeError('MathlibSearchService requires upstreamUrl or sourceRoot');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('MathlibSearchService requires fetch');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) throw new TypeError(`maxResults must be an integer from 1 to ${MAX_RESULTS}`);
    this.upstreamUrl = endpointUrl(upstreamUrl);
    this.sourceRoot = sourceRoot;
    this.projectRoot = projectRoot;
    this.boundaryRoot = sourceRoot ?? projectRoot;
    this.sourceModulePrefix = sourceRoot && basename(resolve(sourceRoot)) === 'Mathlib' ? 'Mathlib' : null;
    if (allowedModules !== null && !Array.isArray(allowedModules) && !(allowedModules instanceof Set)) {
      throw new TypeError('allowedModules must be an array or Set of Lean module names');
    }
    this.allowedModules = allowedModules === null ? null : new Set([...allowedModules].map((module: any) => String(module).trim()).filter(Boolean));
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResults = maxResults;
    this.mathlibRevision = mathlibRevision;
    this.leanVersion = leanVersion;
    this.logger = logger;
    this.indexPromise = null;
    this.sourceModules = null;
  }

  async readiness() {
    if (this.upstreamUrl) {
      try {
        await this.#probeUpstream();
        return true;
      } catch {
        // A configured source tree is a deliberate fallback and is sufficient
        // for readiness when the optional Loogle endpoint is unavailable.
        if (!this.sourceRoot) return false;
      }
    }
    if (!this.sourceRoot) return false;
    try {
      const source = await stat(this.sourceRoot);
      return source.isDirectory();
    } catch {
      return false;
    }
  }

  async #probeUpstream() {
    const url = new URL(this.upstreamUrl.toString());
    const path = url.pathname.endsWith('/json') ? url.pathname : `${url.pathname.replace(/\/$/, '')}/json`;
    url.pathname = path;
    url.searchParams.set('q', 'Nat.add_comm');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('mathlib readiness probe timed out')), Math.min(this.timeoutMs, 3_000));
    try {
      const response = await this.fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error(`mathlib readiness probe returned HTTP ${response.status}`);
      await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async search(input: any, { signal = null }: any = {}) {
    const normalized = normalizeQuery(input);
    const scoped = await this.#validateScope(normalized);
    const searchInput = { ...normalized, ...scoped };
    const started = performance.now();
    let upstreamError: any = null;
    if (this.upstreamUrl) {
      try {
        const result = await this.#searchUpstream(searchInput, { signal });
        return { ...result, duration_ms: Math.round(performance.now() - started) };
      } catch (error: any) {
        upstreamError = error;
        if (!this.sourceRoot) throw error;
        this.logger?.({ event: 'mathlib.search.fallback', error: { code: error.code, message: error.message } });
      }
    }
    if (this.sourceRoot) {
      const result = await this.#searchSource(searchInput);
      return {
        ...result,
        duration_ms: Math.round(performance.now() - started),
        ...(upstreamError ? { fallback: true, upstream_error_code: upstreamError.code ?? ERROR_CODES.SERVICE_UNAVAILABLE } : {}),
      };
    }
    throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'mathlib search backend is not configured', undefined, { retryable: true });
  }

  async handle({ input, signal }: any = {}) {
    return this.search(input, { signal });
  }

  async #validateScope({ module, path }: any) {
    if (!module && !path) return { path: null };
    if (path && !this.boundaryRoot) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'mathlib_search.path requires a configured source/project boundary', { path });
    }
    let scopedPath = path;
    if (path) {
      const boundary = resolve(this.boundaryRoot);
      const candidate = isAbsolute(path) ? resolve(path) : resolve(boundary, path);
      const relativeCandidate = relative(boundary, candidate).split(sep).join('/');
      if (relativeCandidate === '..' || relativeCandidate.startsWith('../') || isAbsolute(relativeCandidate)) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'mathlib_search.path is outside the configured source/project boundary', {
          path,
          source_root: this.boundaryRoot,
        });
      }
      scopedPath = relativeCandidate === '.' ? null : relativeCandidate;
    }
    const scopedModule = module ? (this.sourceModulePrefix && module !== this.sourceModulePrefix && !module.startsWith(`${this.sourceModulePrefix}.`)
      ? `${this.sourceModulePrefix}.${module}`
      : module) : null;
    if (scopedModule && !this.sourceRoot && !this.allowedModules) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'mathlib_search.module requires a configured project/module boundary', {
        module,
      });
    }
    if (scopedModule && this.allowedModules && ![...this.allowedModules].some((candidate: any) => moduleMatches(candidate, scopedModule, this.sourceModulePrefix))) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'mathlib_search.module is outside the configured source/project boundary', {
        module,
        allowed_modules: [...this.allowedModules].slice(0, 100),
      });
    }
    if (scopedModule && this.sourceRoot) {
      const declarations = await this.#loadSourceIndex();
      const modules = this.sourceModules ?? new Set(declarations.map((declaration: any) => declaration.module));
      const inBoundary = [...modules].some((candidate: any) => moduleMatches(candidate, scopedModule, this.sourceModulePrefix));
      if (!inBoundary) {
        throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'mathlib_search.module is outside the configured source/project boundary', {
          module,
          source_root: this.sourceRoot,
        });
      }
    }
    return { module: scopedModule, path: scopedPath };
  }

  async #searchUpstream({ query, module, path: scopePath, max_results: maxResults }: any, { signal }: any) {
    const url = new URL(this.upstreamUrl.toString());
    const path = url.pathname.endsWith('/json') ? url.pathname : `${url.pathname.replace(/\/$/, '')}/json`;
    url.pathname = path;
    url.searchParams.set('q', query);
    // Loogle's HTTP wrapper documents only /json?q=...; --module and
    // --max-results are backend process flags, not request parameters. Apply
    // the SwarmEnv module and result limits after normalizing the response so
    // a deployment cannot silently ignore a caller's bounded filter.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('mathlib search timed out')), this.timeoutMs);
    const onAbort = () => controller.abort(signal.reason ?? new Error('mathlib search aborted'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await this.fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      let body;
      try { body = await response.json(); } catch (error: any) {
        throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'mathlib search backend returned invalid JSON', { status: response.status }, { cause: error, retryable: true });
      }
      if (!response.ok) {
        throw new MurmError(response.status === 408 || response.status === 504 ? ERROR_CODES.SERVICE_TIMEOUT : ERROR_CODES.SERVICE_UNAVAILABLE, `mathlib search backend returned HTTP ${response.status}`, { status: response.status }, { retryable: response.status >= 500 || response.status === 408 });
      }
      const normalized = normalizeUpstreamResult(body, {
        query,
        // Loogle's HTTP contract accepts only `q`; module filtering is a
        // SwarmEnv-side concern. Normalize the complete response first so a
        // non-matching declaration cannot consume the caller's result limit
        // before a matching declaration is considered.
        maxResults: null,
        metadata: { backend: 'loogle-http', mathlib_revision: this.mathlibRevision, lean_version: this.leanVersion },
      });
      const scoped = module
        ? normalized.results.filter((candidate: any) => moduleMatches(candidate.module, module, this.sourceModulePrefix))
        : normalized.results;
      const pathScoped = scopePath ? scoped.filter((candidate: any) => pathMatches(candidate, scopePath)) : scoped;
      const results = pathScoped.slice(0, Math.min(maxResults, this.maxResults));
      return {
        ...normalized,
        results,
        result_count: results.length,
        truncated: normalized.truncated || pathScoped.length > results.length,
      };
    } catch (error: any) {
      if (error instanceof MurmError) throw error;
      if (controller.signal.aborted) {
        throw new MurmError(ERROR_CODES.SERVICE_TIMEOUT, `mathlib search timed out after ${this.timeoutMs}ms`, undefined, { cause: error, retryable: true });
      }
      throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, error?.message ?? 'mathlib search backend is unavailable', undefined, { cause: error, retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #loadSourceIndex() {
    if (!this.indexPromise) {
      this.indexPromise = (async () => {
        const root = await stat(this.sourceRoot);
        if (!root.isDirectory()) throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'mathlib search sourceRoot must be a directory', { source_root: this.sourceRoot }, { retryable: true });
        const files: any = await walkLeanFiles(this.sourceRoot);
        this.sourceModules = new Set(files.map((file: any) => moduleNameFor(this.sourceRoot, file, this.sourceModulePrefix)));
        const declarations: any[] = [];
        for (const file of files) {
          const content = await readFile(file, 'utf8');
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const declaration = declarationFromLine(lines[index], file, this.sourceRoot, index + 1, this.sourceModulePrefix);
            if (declaration) declarations.push(declaration);
          }
        }
        return declarations;
      })().catch((error: any) => {
        this.indexPromise = null;
        throw error;
      });
    }
    return this.indexPromise;
  }

  async #searchSource({ query, module, path, max_results: maxResults }: any) {
    const declarations = await this.#loadSourceIndex();
    const tokens = queryTokens(query);
    const matched = declarations
      .filter((declaration: any) => !module || moduleMatches(declaration.module, module, this.sourceModulePrefix))
      .filter((declaration: any) => pathMatches(declaration, path))
      .map((declaration: any) => {
        const haystack = `${declaration.name} ${declaration.type} ${declaration.module}`.toLowerCase();
        const score = tokens.reduce((total: any, token: any) => total + (haystack.includes(token) ? 1 : 0), 0);
        return { ...declaration, score };
      })
      .filter((declaration: any) => tokens.length === 0 || declaration.score > 0)
      .sort((a: any, b: any) => b.score - a.score || a.name.localeCompare(b.name));
    const filtered = matched.slice(0, Math.min(maxResults, this.maxResults));
    return {
      query,
      results: filtered,
      result_count: filtered.length,
      truncated: matched.length > filtered.length,
      backend: 'source-index',
      mathlib_revision: this.mathlibRevision,
      lean_version: this.leanVersion,
    };
  }
}

export function createMathlibSearchService(options: any = {}) {
  const service = new MathlibSearchService(options);
  const endpoint = options.endpoint ?? { transport: 'in-process' };
  const manifest = createMathlibSearchManifest({
    endpoint,
    providerVersion: options.providerVersion,
    contractVersion: options.contractVersion,
    mathlibRevision: options.mathlibRevision ?? service.mathlibRevision,
    leanVersion: options.leanVersion ?? service.leanVersion,
  });
  return {
    service,
    manifest,
    handler: service.handle.bind(service),
    readiness: service.readiness.bind(service),
  };
}

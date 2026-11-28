import { ERROR_CODES } from '../../errors.js';

export const MATHLIB_SEARCH_SERVICE_ID = 'mathlib-search';
export const MATHLIB_SEARCH_CAPABILITY = 'mathlib_search';
export const DEFAULT_MAX_RESULTS = 20;
export const MAX_RESULTS = 50;
export const MAX_QUERY_LENGTH = 2_000;
export const MAX_MODULE_LENGTH = 200;
export const MAX_PATH_LENGTH = 1_000;

function objectSchema(properties: any = {}, required: any = []) {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function mathlibSearchCapability() {
  return {
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
  };
}

# Mathlib Search

## Purpose

Find Lean and Mathlib declarations in the project's locked source boundary so a
research route can cite real declarations instead of guessed names.

## When to use

Use it before proposing or revising a proof or API research route. It is
read-only domain research: it does not prove anything and it does not grant
authority beyond the current bound Execution.

## Inputs

- `query` (required): a declaration name, namespace fragment, or Lean type
  pattern.
- `module` (optional): a Lean module scope, bounded to the configured project
  source tree.
- `path` (optional): a relative source path scope inside the configured tree.
- `max_results` (optional): 1-50, default 20.

## Output

A structured result:

```json
{
  "query": "distance_nonneg",
  "results": [{ "name": "distance_nonneg", "type": "...", "module": "Mathlib...", "source": "...", "score": 0.9 }],
  "result_count": 1,
  "truncated": false,
  "backend": "source-index",
  "mathlib_revision": "<locked revision>",
  "lean_version": "<locked toolchain>"
}
```

## Errors and retries

- `INVALID_CONTRACT`: the query or scope is malformed. Fix the call; do not
  retry unchanged.
- `SERVICE_TIMEOUT`, `SERVICE_UNAVAILABLE`: retry only within the bounded
  research budget. A provider failure is not a mathematical failure.

## Limits

The result list is bounded, module/path scopes cannot escape the configured
source root, and no arbitrary URL is fetched. Verify every returned declaration
in the locked project before relying on it.

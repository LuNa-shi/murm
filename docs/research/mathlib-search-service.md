# Mathlib search Service research

**Date:** 2026-10-29

## Findings from primary sources

### Loogle is the suitable formal search backend

[Loogle's upstream repository](https://github.com/nomeata/loogle) describes Loogle as a Lean/Mathlib search tool and documents command-line, API, editor, and web use. Its README gives the local deployment contract: build the binary with the target project's Lean toolchain, point it at the target Lake project/module, and let the on-disk index be reused and rebuilt when the underlying `.olean` files change ([local setup and index behavior](https://github.com/nomeata/loogle/blob/master/README.md#running-locally)). This makes it a good backend for a separately deployed SwarmEnv service: the service can mount the locked Lean project and keep the generated index in a service-owned cache volume.

The same README documents an HTTP wrapper that accepts `--host`, `--port`, `--loogle-bin`, and `--project-dir`, and exposes JSON responses at `/json?q=...` ([web service section](https://github.com/nomeata/loogle/blob/master/README.md#web-service)). The README explicitly says that the JSON format has no stability guarantee. SwarmEnv therefore needs an adapter that validates and normalizes the upstream response into its own stable output schema instead of exposing Loogle's response directly.

The CLI supports `--json`, `--module`, `--path`, `--index-mode`, `--index-file`, and `--max-results` ([CLI options](https://github.com/nomeata/loogle/blob/master/README.md#cli-usage)). A production container should pin the Lean toolchain and Mathlib revision, choose a writable index file or cache volume, set a bounded result count, and report the pinned revision in the Service readiness/metadata response.

### LeanSearchClient is a client surface, not the Service host

The official [LeanSearchClient repository](https://github.com/leanprover-community/LeanSearchClient) provides Lean syntax for LeanSearch, LeanStateSearch, and Loogle. Its README shows `#loogle` for precise type/name queries and `#search`/`#leansearch` for natural-language queries ([query forms](https://github.com/leanprover-community/LeanSearchClient#query-command), [Loogle syntax](https://github.com/leanprover-community/LeanSearchClient#loogle-search)). It is useful as an Agent-facing convention and future Lean editor integration, but it is not the HTTP host or a stable server protocol. The standalone SwarmEnv Service should call Loogle's documented local/web endpoint and may later add a separate LeanSearch adapter when a deployment explicitly provides that backend.

## Recommended SwarmEnv boundary

Expose one registered Service manifest named `mathlib-search` with one stable capability, `mathlib_search`, whose input is `{ query, module?, max_results? }` and whose output is a normalized list of declarations (`name`, `type`, `module`, `source?`, `score?`) plus backend metadata (`backend`, `mathlib_revision`, `truncated`). The capability is read-only and idempotent, scoped to bound/recovery Agents, and should carry help text telling the Agent to use it before proposing a proof or API research task.

Run the provider as a separate process/container. The provider may use the Loogle HTTP wrapper as its backend, configured through an environment variable or service configuration. The SwarmEnv Registry only receives the manifest and an HTTP adapter; it must not import Loogle, share the provider's process, or depend on Loogle's unstable response shape. A small local fixture backend is appropriate for deterministic tests, while real deployment uses the pinned Loogle project/index.

The Service should enforce these limits at its own boundary:

- reject empty or excessively long queries;
- cap `max_results` to a bounded value;
- reject path/module values outside the configured project;
- time out upstream requests and return a typed retryable Service error;
- mark readiness false until the pinned project/index backend is available;
- include the configured Mathlib/Lean revision in metadata for replay and evidence.

## Sources

- [Loogle repository](https://github.com/nomeata/loogle)
- [Loogle README: local setup](https://github.com/nomeata/loogle/blob/master/README.md#running-locally)
- [Loogle README: CLI options](https://github.com/nomeata/loogle/blob/master/README.md#cli-usage)
- [Loogle README: HTTP service and JSON endpoint](https://github.com/nomeata/loogle/blob/master/README.md#web-service)
- [LeanSearchClient repository](https://github.com/leanprover-community/LeanSearchClient)
- [LeanSearchClient README: query forms](https://github.com/leanprover-community/LeanSearchClient#query-command)
- [LeanSearchClient README: Loogle syntax](https://github.com/leanprover-community/LeanSearchClient#loogle-search)

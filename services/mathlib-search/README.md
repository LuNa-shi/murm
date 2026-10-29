# Mathlib Search Service

This is a separately deployable HTTP provider for the SwarmEnv `mathlib-search`
Service. It exposes the versioned `/v1/mathlib_search` capability through the
same Manifest and JSON envelope used by every other registered Service.

The provider should use a local Loogle HTTP process or a locked Lean source
root. Loogle's own server is the preferred production backend because it builds
and reuses a `.olean` search index for the selected Lean toolchain. Set
`MATHLIB_SEARCH_UPSTREAM_URL` to the Loogle server base URL (the provider adds
`/json?q=...`) or set `MATHLIB_SEARCH_SOURCE_ROOT` to a mounted source tree for
the bounded deterministic source-index fallback. A real deployment should pin
`MATHLIB_REVISION` and `LEAN_VERSION` and keep the Loogle index in a persistent
service volume.

Example:

```sh
docker build -f services/mathlib-search/Dockerfile -t swarmenv-mathlib-search .
docker run --rm -p 8787:8787 \
  -e MATHLIB_SEARCH_UPSTREAM_URL=http://loogle:8080 \
  -e MATHLIB_REVISION=<locked-mathlib-revision> \
  -e LEAN_VERSION=<locked-lean-toolchain> \
  swarmenv-mathlib-search
```

The SwarmEnv process registers the provider with a manifest and an
`HttpJsonServiceAdapter`; it does not import Loogle or share the provider's
process. See `docs/research/mathlib-search-service.md` for the upstream API and
indexing research.


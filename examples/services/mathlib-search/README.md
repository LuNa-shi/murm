# Mathlib Search Service

This optional domain Service supports the TaskPool and Substrate FATE benchmark
integrations. It is not installed by `murm setup`, and it is unrelated to the
MySQL database used by PeerMesh's Board.

The provider exposes `/v1/mathlib_search` through the retained HTTP JSON v1
service-bundle protocol. Its Docker build explicitly includes the TaskPool v1
HTTP host, manifest and search contract. Check `GET /readyz` at the configured
host and port before attaching a workload. The host uses those compatibility modules;
it is not a standalone package or an HTTP JSON v2 adapter example. Use the
[Messages tutorial](../../messages/README.md) to learn the current public Service API.

The provider should use a local Loogle HTTP process or a locked Lean source
root. Loogle's own server is the preferred production backend because it builds
and reuses a `.olean` search index for the selected Lean toolchain. Set
`MATHLIB_SEARCH_UPSTREAM_URL` to the Loogle server base URL (the provider adds
`/json?q=...`) or set `MATHLIB_SEARCH_SOURCE_ROOT` to a mounted source tree for
the bounded deterministic source-index fallback. A real deployment should pin
`MATHLIB_REVISION` and `LEAN_VERSION` and keep the Loogle index in a persistent
service volume.

The release workflow does not publish an image for this Service. Build the
following recipe from the repository root:

```sh
docker build -f examples/services/mathlib-search/Dockerfile -t murm-mathlib-search .
docker run --rm -p 8787:8787 \
  -e MATHLIB_SEARCH_UPSTREAM_URL=http://loogle:8080 \
  -e MATHLIB_SEARCH_PUBLIC_URL=http://mathlib-search:8787 \
  -e MATHLIB_REVISION=<locked-mathlib-revision> \
  -e LEAN_VERSION=<locked-lean-toolchain> \
  murm-mathlib-search
```

The murm process registers the provider with a manifest and an
`HttpJsonServiceAdapter`; it does not import Loogle or share the provider's
process. See the maintained [Mathlib service implementation](../../../docs/architecture/04-services.md#6-optional-mathlib-search) and [Loogle reference](references/loogle.md) for backend behavior and query guidance.

To run the host without a container after building the checkout, use
`npm run service:mathlib-search` from the root, or
`node ../../../dist/examples/services/mathlib-search/main.js` from this directory.
The caller supplies the host token with `MATHLIB_SEARCH_TOKEN`, and configures
the endpoint in its own service adapter. The application/operator owns the
external provider's lifecycle and persistent data; Runtime close does not remove it.

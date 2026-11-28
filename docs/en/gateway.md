---
title: Host Gateway
description: Understand the trust boundary between isolated Sandboxes and the host — how Service Bridge enforces identity and schemas, and how Model Gateway keeps API keys off containers.
section: CORE BUILDING BLOCKS
order: 6
---

Every Agent runs inside an isolated container without upstream model keys or direct access to host Service credentials. **Host Gateway** is the trusted host boundary handling all model and Service traffic, composed of **Service Bridge** and **Model Gateway** (shown above).

## 1. Service Bridge: authenticated cross-sandbox calls

Whenever an Agent runs `swarm <service> <operation>` inside its container, the request passes through the host **Service Bridge**, which enforces four checks before calling your Service and returning the reply:

1. **Verified caller identity**: each Agent receives a unique per-Agent bearer token at spawn time. The Bridge resolves the real `caller.agentId`, `caller.profile`, and optional `caller.binding` — an Agent can never spoof another member in JSON input.
2. **Permission enforcement**: verifies that the Agent is currently allowed to call that operation (combining `Profile.services` and any live `runtime.access` updates).
3. **Pre-call input and post-call output JSON Schema checks**: Ajv (draft-07, no coercion or default injection) validates inputs **before** dispatching — malformed requests are blocked before touching business state. Outputs are validated **after** the adapter returns (for writes, a `SERVICE_OUTPUT_INVALID` error means the side effect may already have occurred — inspect Service state before retrying).
4. **Automatic audit ledger**: logs every input, timing, result, and error to `service-calls.jsonl`, powering cross-Agent handoffs in [Trace Viewer](trace-viewer.md).

## 2. Model Gateway: keeping API keys off containers

Inside a container, Pi or Codex sends `/v1/responses` requests only to the host **Model Gateway** using a revocable per-Agent token:

- **Host-only credentials**: your upstream API keys stay in `createRuntime({ models })` on the host and never enter container environment variables.
- **Instant revocation**: calling `stop()`, encountering a fatal error, or detecting an unexpected exit immediately revokes the Agent's token and aborts active streams.
- **Optional lease gating (`modelAccessPolicy`)**: harnesses like [TaskPool](harnesses/taskpool.md) can check a synchronous permit before every model request and immediately abort inference if a task lease expires.
- **Full model tracing**: raw forwarded Responses or Chat Completions requests and streamed responses (as well as custom trusted `ModelTransport` handlers) are archived under `model-trace/` for token auditing and debugging.
- **Remote & TLS proxy callbacks**: when connecting to a remote OpenSandbox behind a domain or HTTPS reverse proxy, set `connection.bridge.publicUrl` and `connection.modelGateway.publicUrl` using URL templates containing `{port}`.

## 3. Fine-grained egress allowlists (strict local policy)

When using the strict local isolation policy (`isolation.network: 'local-docker'`), the host firewall permits only Service Bridge and Model Gateway by default. When a role legitimately needs native tools to talk to an internal server (such as local Gitea in [PeerMesh](harnesses/peermesh.md)), explicitly grant only what it needs:

- `Profile.network: { allow: ['172.17.0.1:3000'] }` — opens only that non-loopback IPv4 destination in the sandbox firewall.
- `runtime.spawn({ secretEnv: { GITEA_TOKEN: '...' } })` — injects a member-scoped token into the container while keeping admin credentials strictly on the host.

---

**Next:** learn how to build and connect your own shared Services in **[Services & Permissions](services.md)**.

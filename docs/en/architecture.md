---
title: System Architecture
description: Public SDK boundaries, the host control plane, OpenSandbox execution, Service and model paths, and Run ownership.
section: ARCHITECTURE
order: 3
---

A murm application runs its Harness on the trusted host. The Harness creates one Runtime for a Run, selects an OpenSandbox backend, and registers the Services its Agents may use. Each Agent executes inside a Sandbox; its Service and model requests cross host gateways that enforce caller identity and record execution.

The default Provider connects a Linux Controller to local or remote OpenSandbox. Pi and Codex use the same authenticated Worker transport. An explicitly selected same-host Docker policy adds local network rules, workspace quotas and shared mounts. A package can supply another Provider through the root SDK.

## Component boundaries

<div class="doc-diagram" role="region" aria-label="murm trust boundaries between Trusted Host and Isolated Sandbox">
  <div class="dd-zone dd-host">
    <div class="dd-zone-head">
      <span class="dd-zone-title">TRUSTED HOST</span>
      <span class="dd-zone-sub">Node.js process · owns secrets, Services, and authoritative logs</span>
    </div>
    <div class="dd-row-3">
      <div class="dd-box dd-yellow">
        <div class="dd-box-title">Your Harness</div>
        <ul class="dd-list">
          <li>Control loop &amp; rules</li>
          <li>Role Profiles</li>
          <li>Custom Services</li>
        </ul>
      </div>
      <div class="dd-arrow-h" aria-hidden="true">──►</div>
      <div class="dd-box dd-indigo">
        <div class="dd-box-title">Core Runtime</div>
        <ul class="dd-list">
          <li>Agent registry &amp; slots</li>
          <li>Input &amp; file ledgers</li>
          <li>Lifecycle event stream</li>
        </ul>
      </div>
      <div class="dd-arrow-h" aria-hidden="true">──►</div>
      <div class="dd-box dd-amber">
        <div class="dd-box-title">outputDir/&lt;runtimeId&gt;/</div>
        <ul class="dd-list">
          <li>runtime.json</li>
          <li>evidence.jsonl</li>
          <li>service-calls.jsonl &amp; model-trace/</li>
        </ul>
      </div>
    </div>
    <div class="dd-inner-link">
      <div class="dd-pipe">
        <span class="dd-pipe-line" aria-hidden="true">▲</span>
        <span class="dd-pipe-meta"><span>validated Service dispatch</span></span>
      </div>
      <div class="dd-pipe">
        <span class="dd-pipe-line" aria-hidden="true">▲</span>
        <span class="dd-pipe-meta"><span>model traces &amp; lease gate</span></span>
      </div>
    </div>
    <div class="dd-row-2">
      <div class="dd-box dd-service">
        <div class="dd-box-title">Service Bridge (HTTP)</div>
        <ul class="dd-list">
          <li>Bearer auth → real agentId</li>
          <li>Profile.services ACL check</li>
          <li>Ajv draft-07 schema validation</li>
        </ul>
      </div>
      <div class="dd-box dd-indigo">
        <div class="dd-box-title">Model Gateway (/v1/responses)</div>
        <ul class="dd-list">
          <li>Per-agent revocable token</li>
          <li>Injects upstream API keys on host</li>
          <li>Optional modelAccessPolicy gate</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="dd-pipes">
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">▲<br/>│</span>
      <span class="dd-pipe-meta"><strong>MURM_BRIDGE_URL</strong><span>firewall-allowed IPv4</span></span>
    </div>
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">▲<br/>│</span>
      <span class="dd-pipe-meta"><strong>Gateway origin</strong><span>firewall-allowed IPv4</span></span>
    </div>
  </div>

  <div class="dd-zone dd-sandbox">
    <div class="dd-zone-head">
      <span class="dd-zone-title">ISOLATED SANDBOX</span>
      <span class="dd-zone-sub">Linux Sandbox per Agent · authenticated control plane</span>
    </div>
    <div class="dd-row-2-arrow">
      <div class="dd-box dd-teal">
        <div class="dd-box-title">Root Worker Supervisor</div>
        <ul class="dd-list">
          <li>Stages frozen profile prompt</li>
          <li>Pauses writers for snapshot / install</li>
          <li>Stops executor &amp; streams archives</li>
        </ul>
      </div>
      <div class="dd-arrow-h" aria-hidden="true">── manages ──►</div>
      <div class="dd-box">
        <div class="dd-box-title">Pi or Codex executor</div>
        <ul class="dd-list">
          <li>Local file and shell tools</li>
          <li>Runs swarm &lt;service&gt; &lt;operation&gt;</li>
          <li>Bounded /workspace/project quota</li>
        </ul>
      </div>
    </div>
  </div>
</div>


| Layer | Owns | Public entry point |
| --- | --- | --- |
| Harness | Roles, collaboration policy, Service state, work deadlines, and business verification | Your application code |
| Core Runtime | Agent identities and capacity, input receipts, observation, file operations, and cleanup | `@luna-shi/murm` |
| Service integration | Manifest validation, adapters, and operation registration | `@luna-shi/murm` |
| OpenSandbox backend | Executor selection, Sandbox configuration, and supported execution capabilities | `@luna-shi/murm` |
| External facilities | Independent databases, HTTP services, Git/chat servers, and their deployment | Application or facility owner |

Use `createSandbox` to capture OpenSandbox settings. Each Runtime selects its executor and owns its host connections and model configuration.

## Runtime creation establishes the host control plane

`createRuntime()` first validates its options, captures Profiles and the Service registry, and resolves model aliases. It adds the built-in `agent` Service, whose operations are `spawn`, `get`, `send`, and `stop`. Profiles must explicitly grant these operations and the child Profiles they may spawn.

The Runtime then opens a private Run directory, Model Gateways, the Service Bridge, and its backend resources. Unknown model aliases, Service operations, or unsupported context-fork authority are rejected before an Agent Sandbox is created. Initialization failures attempt rollback and report any unresolved cleanup.

A later `spawn()` prepares an Agent's Sandbox, files, permissions, credentials, and executor session. Agent state, input acceptance, actual execution, and resource cleanup remain separately observable. [Use the SDK](sdk.md) and [Run lifecycle](run-lifecycle.md) explain those controls.

## Worker and executor have different responsibilities

A root-owned Worker supervises an unprivileged executor inside each Sandbox. The executor performs model and tool work; the Worker owns management routes for input, interruption, file operations, session export, and shutdown. This lets trusted operations continue after the executor has stopped.

Pi runs in RPC mode with `read`, `write`, `edit`, and `bash`. Its project extensions, skills, prompt templates, and context files are disabled by the Worker launch configuration. Codex uses its own app-server integration and native tools. Both executors use the host Model Gateway and the same Runtime and Service interfaces.

| Capability | Pi | Codex |
| --- | --- | --- |
| Active steering, follow-up, conditional input | Supported | Supported |
| Queued-input cancellation | Supported | Supported |
| Context fork | Supported | Unsupported |
| Steering modes | `all`, `one-at-a-time` | `all` |
| Model-request authorization and raw request tracing | Supported | Supported |

Use `getExecutorCapabilities(executor)` to check the selected executor. A Harness should gate optional behavior on those capabilities instead of assuming that executor sessions are interchangeable.

The Worker uses the same `FileTree` at startup, snapshot and private directory replacement. `files.replace` checks a complete digest, can enable writing after success, and preserves the Agent and Session.

## A Service request travels through the Bridge

An Agent can run:

```bash
swarm service list
swarm service view messages --json
swarm messages get --key review --request-id read-review
```

The CLI uses the Sandbox's Bridge URL and scoped bearer token. For an invocation, the Bridge:

1. Authenticates the token and resolves the real Runtime, Agent, Profile, and optional bindings.
2. Checks caller liveness and whether the Profile grants this Service operation.
3. Validates the input against the manifest's strict JSON Schema draft-07 contract.
4. Calls the registered adapter with `input`, `envelope`, `caller`, `signal`, and `assertAuthorized`.
5. Validates the result, records the invocation, and returns it to the caller.

The Bridge invokes an operation once per received call; business idempotency belongs to the Service. A write whose response is lost may already have committed. Preserve `envelope.operation_id` and use that identity to reconcile state. In-process handlers call `assertAuthorized()` immediately before a protected mutation so a revoked caller cannot commit using stale authority.

An in-process adapter executes host code. An HTTP JSON adapter sends `{ input, envelope, caller }` to the registered endpoint with an `Idempotency-Key` header and a bearer token when one is configured. The remote Service must authenticate this host connection before trusting the forwarded `caller`; JSON caller fields alone do not authenticate a request. An external endpoint remains independently owned: registration does not deploy or destroy it. Existing Git or chat protocols can be wrapped by a custom adapter, or deliberately made accessible to an Agent with its own restricted credentials and network rules.

## Model requests use a separate gateway

Each configured model alias has a host gateway and attempt ledger. The Agent holds a revocable gateway token; the gateway attaches the real upstream headers when forwarding `/v1/responses`. It saves the received and forwarded request, streamed response, and attempt metadata.

The default request timeout is 120 seconds. Pi's default host output cap is 32,768 tokens; Codex defaults to `maxOutputTokens: null`, preserving its output parameters without a host clamp. A Harness can configure these values explicitly.

Lease-based Harnesses can provide `modelAccessPolicy` with synchronous `authorize` and `withCommit` hooks. This allows the gateway to refuse or interrupt model work whose lease or deadline is no longer valid. Task selection, lease policy, and renewal still belong to the Harness and its Services.

## Isolation and credential ownership

The local provider prepares filesystem quotas and default-deny network rules before starting the executor. Sandbox destinations include the Service Bridge, Model Gateway, and explicitly allowed non-loopback IPv4 origins. Workspaces are private unless the Harness requests sharing.

Upstream model keys and lifecycle credentials remain on the host. HTTP adapter credentials also remain on the host. A Harness may deliberately supply an Agent-specific credential through `spawn.secretEnv` for direct access to a permitted external service; that credential then belongs to the Sandbox's authorized environment.

Registered credentials are redacted from saved traces. This does not remove the private task content, source files, or conversations from the archive, so Run storage still needs to be private.

## Export, verification, and resource ownership

`stop()` stops executor work and exports the native session and declared artifacts before deleting the Sandbox. Required export failure retains the resource for follow-up. `close()` closes admission, reconciles in-flight work, stops Agents, exports Service state when provided, and reports complete or pending cleanup.

The application uses the `runtime.close()` receipt to check exported artifacts and close its own facilities.

| Run path | Contents |
| --- | --- |
| `runtime.json` | Effective configuration, lifecycle summary, and cleanup receipts |
| `evidence.jsonl` | Ordered host execution evidence |
| `service-calls.jsonl` | Service inputs, results, and errors |
| `service-state.<serviceId>.json` | Optional state exported by a Service adapter |
| `model-access/` and `model-trace/` | Attempt ledgers and request/response traces |
| `<agentId>/session/` | Exported native executor session |
| `<agentId>/artifacts/` | Collected files and their manifest |
| `handoff-report.json` | Public SDK application finalization report |
| `harness-report.json` | Report produced by existing repository Harness wrappers |

For implementation detail, see [Core Runtime](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/15-core-runtime.md), [OpenSandbox backend](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/16-pi-opensandbox-backend.md), and [prompt composition](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/08-prompts.md). For writing an application, continue with [Build Your Own Harness](build-your-harness.md).

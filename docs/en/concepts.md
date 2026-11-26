---
title: How murm Works
description: Follow one handoff to understand Harness, Runtime, Agent, Profile, Service, Sandbox, and Run.
section: GET STARTED
order: 2
---

A Harness is the program that decides how Agents collaborate. It calls the SDK to create a Runtime, gives each Agent a role and permissions, and decides what should happen after an Agent produces a result. The Runtime carries out those decisions and records their effects.

The [Messages handoff](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff.ts) makes the relationship concrete: one Agent publishes information, another consumes it, and the host verifies the final file.

## Follow the work

Before either Agent exists, the Harness registers a Messages Service with `put` and `get` operations. It defines a writer Profile permitted to call `put` and a reader Profile permitted to call `get`. Profiles also select a model alias, Worker image, writable workspace policy, and any files to collect.

`createRuntime()` captures that configuration and opens the host-side gateways and Run records. `runtime.spawn()` then allocates a Sandbox and starts a persistent executor session. The returned Agent is initially idle: creating it does not send a task to the model.

The Harness subscribes with `runtime.onEvent(listener)` before submitting work. It calls `runtime.send()` with a stable `requestId`. The receipt reports whether that input was accepted; the Harness continues observing what actually executes.

Inside the Sandbox, the writer discovers its permitted Service operations and calls `swarm messages put` through a local shell tool. The host Bridge authenticates the caller, checks its permission, validates the request, and invokes the registered implementation. The information now lives in Service state, where the reader can retrieve it with `swarm messages get`.

The Harness checks both the expected Service operation and the Agent's completed execution before proceeding. At the end, the Harness calls `runtime.close()`, verifies exported artifacts, and records the separate business, verification, and cleanup outcomes. The Messages example compares the reader's exported bytes with the original value, so success has evidence beyond an Agent saying it has finished.

## Where the pieces live

<div class="doc-diagram" role="region" aria-label="Five cooperating layers of murm">
  <div class="dd-row-2-arrow">
    <div class="dd-box dd-yellow">
      <div class="dd-box-title">HARNESS</div>
      <ul class="dd-list">
        <li>Your control loop &amp; rules</li>
        <li>Role Profiles &amp; stop policy</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">◄── spawn · send · onEvent ──►</div>
    <div class="dd-box dd-indigo">
      <div class="dd-box-title">RUNTIME</div>
      <div class="dd-sandbox-stack">
        <div class="dd-sandbox-pill"><strong>SANDBOX A</strong> · Agent (executor + workspace)</div>
        <div class="dd-sandbox-pill"><strong>SANDBOX B</strong> · Agent (executor + workspace)</div>
        <div class="dd-sandbox-pill"><strong>SANDBOX C</strong> · Agent (executor + workspace)</div>
      </div>
    </div>
  </div>

  <div class="dd-pipes">
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">│<br/>▼</span>
      <span class="dd-pipe-meta"><strong>registers</strong><span>v2 manifests &amp; adapters</span></span>
    </div>
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">│<br/>▼</span>
      <span class="dd-pipe-meta"><strong>swarm CLI · /v1/responses</strong><span>authenticated over host bridge</span></span>
    </div>
  </div>

  <div class="dd-row-3">
    <div class="dd-box dd-service">
      <div class="dd-box-title">SHARED SERVICES</div>
      <ul class="dd-list">
        <li>Customizable domain state</li>
        <li>Boards, pools, Git &amp; verifiers</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">◄──</div>
    <div class="dd-box dd-teal">
      <div class="dd-box-title">HOST GATEWAY</div>
      <ul class="dd-list">
        <li>Service Bridge (auth + schema)</li>
        <li>Model Gateway (host API keys)</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">──►</div>
    <div class="dd-box dd-amber">
      <div class="dd-box-title">RUN TRACES</div>
      <ul class="dd-list">
        <li>outputDir/&lt;runtimeId&gt;/</li>
        <li>Sessions, calls &amp; artifacts</li>
      </ul>
    </div>
  </div>
</div>


| Concept | What it means | Who owns the policy |
| --- | --- | --- |
| **Harness** | Your application that composes roles, Services, scheduling, and acceptance checks | Your application |
| **Runtime** | One live control plane for Agents, input delivery, observation, files, and cleanup | Core |
| **Profile** | A named role configuration, including prompt, model alias, permissions, and collection policy | Defined by the Harness; enforced by Core and the backend |
| **Agent** | A persistent executor session with an identity and workspace | Runtime manages its lifecycle; Harness decides its work |
| **Sandbox** | The isolated environment in which an Agent runs | OpenSandbox backend and its local isolation provider |
| **Service** | Shared operations with a manifest, schemas, and an implementation | Harness or external service owner |
| **Run** | A concrete execution identified by `runtime.id`, with records under `outputDir/<runtimeId>/` | Core records execution; Harness defines the result |

## Sessions persist across turns

When an execution settles, the Agent keeps its session and files and normally returns to `idle`. It still occupies a capacity Slot. A later `send()` can start another turn in that same Agent; `interrupt()` can stop active work while preserving the Agent; `stop()` begins permanent teardown of that Agent.

This lets a Harness implement review loops, follow-up questions, or long-lived workers. It also means the Harness must decide when an idle Agent should be reused or stopped. Core does not interpret an Agent's answer as completion of the whole task.

A `settled` event describes an execution. It does not establish exactly which of several queued inputs that execution processed. Keep input receipts, execution state, and business evidence distinct. The [Run lifecycle guide](run-lifecycle.md) covers that distinction in detail.

## A Profile supplies both instructions and authority

`Profile.prompt` describes the role to the model. `Profile.services` controls which shared operations that role can call. Workspace, network, child-spawn, and collection settings control the corresponding Runtime or backend operations.

At Runtime creation, Profiles and registered Service manifests are captured. Later edits to the original configuration object or new registrations on the original registry do not reconfigure that Runtime. Shared Service state can still evolve during execution; for example, a task pool creates and claims Tasks while its operation contract remains the same.

Each Runtime selects one executor in its Runtime options. The OpenSandbox backend supports Pi and Codex. Query `getExecutorCapabilities(executor)` when your Harness needs a specific feature: Pi supports context forking and both steering modes, while Codex currently supports the `all` steering mode and does not support context forking.

## Services define the collaboration mechanism

A Service can run in the Harness process or behind an HTTP adapter. The Agent discovers and calls its permitted operations using the same `swarm` CLI in either case. The Bridge supplies the caller identity from the Agent's credential; a request payload cannot grant itself another Agent's authority.

What those operations mean is your design choice. A TaskPool's claim is exclusive and leased. A PeerMesh Board claim is a coordination signal. A Substrate publication makes a finding available for search and citation. Those differences belong in Services and Harness policy, while Runtime input delivery and cleanup remain common.

A registered Service does not have to occupy its own container. Use an in-process adapter for host code, an HTTP adapter for a separately managed endpoint, or an adapter for an existing native protocol. The application decides whether it owns that external service's lifecycle.

## Files and records serve different purposes

Agents have private workspaces by default. A Harness can explicitly request a shared workspace, seed files when spawning, or use guarded file operations to prepare, snapshot, and install revisions. Sharing files does not itself define ownership or merging rules; the Harness and its Services supply those rules.

Run records capture lifecycle, Service, model, and native-session evidence. Required artifact collection exports declared workspace files before the Sandbox is deleted. If required export or cleanup cannot be confirmed, receipts retain a pending state and resource identities for follow-up. Logs explain what happened; your verifier decides whether the result is useful or correct.

Continue with [Use the SDK](sdk.md) for the public interfaces, or [System Architecture](architecture.md) for the host, backend, Worker, and gateway implementation boundaries.

---
title: murm Documentation
description: A local-first TypeScript runtime for building multi-agent harnesses with isolated sandboxes, customizable shared services, and complete trace archives.
section: GET STARTED
order: 0
---

`murm` separates **multi-agent coordination** from **execution infrastructure**.

You write a **Harness** — plain TypeScript rules and control loops that define roles, shared capabilities, and how agents hand off work. `murm` provides the **Runtime** that runs each agent in an isolated Docker **Sandbox**, enforces permissions and secrets on the host, routes calls to your **Services**, and records the entire execution as a durable **Run**.

Use `murm` to build and compare multi-agent systems across software engineering, formal mathematics, and open-ended research — without rebuilding container isolation, session continuity, model gateways, or trace logging for every topology.

## Start using murm

New to `murm`? Follow the [Quickstart](../quickstart/) to build the worker image, run your first two-agent handoff, and inspect the saved run archive.

If your local environment is already set up, choose where to go next:

- Read [How murm Works](../concepts/) for the mental model: how your Harness steers a Runtime arena of Sandboxes, Agents, customizable Services, and Traces.
- Read [System Architecture](../architecture/) to trace the exact trust boundaries between the host process, OpenSandbox containers, the Service Bridge, and the Model Gateway.
- Read [Anatomy of a Run](../run-lifecycle/) to follow one concrete multi-agent run through `spawn`, unified `send`, file handoffs, safe `interrupt`, and archive-before-delete `close`.

## Build your own Harness

You never have to modify the Runtime or rebuild the worker image to try a new collaboration pattern. Every multi-agent system in `murm` imports the same three package entry points:

```ts
import { createRuntime } from '@murm/core';
import { ServiceRegistry, createInProcessAdapter } from '@murm/core/services';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
```

Follow [Build Your Own Harness](../build-your-harness/) to register custom Services, configure frozen role Profiles, choose a host control loop, and wrap teardown with independent error reporting.

## Explore built-in Harnesses

Five distinct multi-agent topologies ship in the repository on top of the exact same Runtime:

| Harness | Collaboration style | Good fit for |
| --- | --- | --- |
| [Subagents](../harnesses/subagents/) | Hierarchical `/root` delegation, context forking, non-waking mailbox | Interactive tasks, recursive decomposition, mid-flight user steering |
| [TaskPool](../harnesses/taskpool/) | Exclusive leased task claims, immutable Materials, versioned Workspace `main` | Long-running pools where workers time out or rotate |
| [PeerMesh](../harnesses/peermesh/) | Peer engineers using soft Board claims, Mattermost chat/DMs, and verified Gitea PRs | Flat engineering teams collaborating on Git branches |
| [Substrate](../harnesses/substrate/) | Equal peers publishing, searching, and citing immutable SQLite artifacts | Zero-queue parallel research and proof exploration |
| [Lead-Worker](../harnesses/lead-worker/) | Staged direction-and-feedback loop with transactional SQLite claims and Git SHA-256 checks | Explicit lead ownership with enforced feedback read gates |

See [Five Topologies Overview](../harnesses/) for a side-by-side comparison.

## Find reference information

- [API & Configuration](../reference/api/) — Runtime methods, unified `send` semantics, file controls, Service v2 protocol, `swarm` CLI, foreground host CLI, backend config, and error codes.
- [Types & Source Map](../reference/types/) — Public TypeScript declarations from `@murm/core` `0.2.0` and links to the implementation in `src/`.
- [Deployment](../reference/deploy/) — Local website preview and static publishing to GitHub Pages or Cloudflare Pages.

## Security and data boundaries

Agents execute shell commands and file edits inside isolated Docker containers with explicit disk quotas and IPv4 network allowlists. Upstream model API keys, OpenSandbox lifecycle credentials, and external service admin tokens stay on the trusted host behind the Model Gateway and Service Bridge.

Core redacts registered credentials from trace outputs, but saved run archives (`outputDir/<runtimeId>/`) still contain prompts, tool output, native sessions, and exported workspace files. Keep run directories in private local storage.

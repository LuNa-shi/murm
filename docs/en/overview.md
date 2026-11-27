---
title: murm Documentation
description: Build multi-agent systems with a TypeScript SDK for isolated Agents, coordination Services, observable Runs, and artifact collection.
section: GET STARTED
order: 0
---

`murm` is a TypeScript SDK for building multi-agent systems. You define the roles, shared state, work allocation, and completion rules in a **Harness**. The **Runtime** manages Agent sessions, isolated workspaces, Service access, execution records, and cleanup.

The same Runtime supports a lead delegating to children, workers claiming a task pool, or peers exchanging findings through a shared library. Changing the collaboration mechanism means changing your Harness and its Services. This makes it possible to develop and compare those mechanisms while keeping the execution infrastructure consistent.

## Start with a working Run

Follow the [Quickstart](quickstart.md) to prepare the host prerequisites, install `@luna-shi/murm` in one command, and run either a built-in CLI Harness or a self-contained TypeScript SDK handoff.

If you already have the infrastructure ready, choose your next step:

| What you want to do | Start here |
| --- | --- |
| See everything available in `v0.2.0` | [Latest (v0.2.0)](latest.md) · [Changelog](changelog.md) |
| Embed murm in your TypeScript application | [Use the SDK](sdk.md) |
| Understand what happens during a Run | [How murm Works](concepts.md) |
| Design your own collaboration mechanism | [Build Your Own Harness](build-your-harness.md) |
| Run or adapt an existing multi-agent system | [Harnesses](harnesses/index.md) |
| Trace component responsibilities and data flow | [System Architecture](architecture.md) |

## One package, explicit public entry points

GitHub Release distributes the CLI, TypeScript SDK, and built-in browser Trace Viewer (`murm trace`) in one `@luna-shi/murm` tarball.

Import all public values and types from `@luna-shi/murm`. Configure OpenSandbox with `createSandbox`, reference the matching prebuilt Worker image via `DEFAULT_WORKER_IMAGE`, and manage Agents, Services, files, and cleanup through `createRuntime`. Install the versioned GitHub Release asset. See the [SDK guide](sdk.md).

## Explore the collaboration mechanisms

The repository includes five Harnesses that make different coordination choices:

| Harness | How work is coordinated | What to study |
| --- | --- | --- |
| [Subagents](harnesses/subagents.md) | A root delegates to a tree of children, with context forking and mailbox delivery | Recursive decomposition, ownership, and user steering |
| [TaskPool](harnesses/taskpool.md) | Workers exclusively claim leased Tasks and publish Materials and workspace revisions | Durable work allocation and replacement of workers |
| [PeerMesh](harnesses/peermesh.md) | Peer engineers use a Board, Mattermost, and Gitea pull requests | Soft claims, direct discussion, and verified integration |
| [Substrate](harnesses/substrate.md) | Peers publish, search, read, and cite immutable artifacts | Collaboration through accumulated findings |
| [Lead-Worker](harnesses/lead-worker.md) | A lead supplies direction and workers return claims, changes, and feedback | Lead ownership and explicit feedback gates |

These examples retain their own domain rules and verification criteria. The [comparison](harnesses/index.md) explains what changes between them; the SDK provides the common execution controls.

## Find a specific contract

Use the [API reference](reference/api.md) for method signatures, input receipts, observation, file controls, Service calls, and configuration. Use [Run lifecycle](run-lifecycle.md) to understand when an operation is accepted, when execution settles, and when cleanup is complete. [Types and source map](reference/types.md) links those contracts to their implementation.

The Linux Controller connects to local or remote OpenSandbox through its API. It supports Pi and Codex executors with different capabilities. Run directories contain prompts, model and Service traces, native sessions, and exported files; keep them in private storage. The [architecture](architecture.md) explains the runtime and credential boundaries.

The website renders the English and Chinese guides directly from `docs/en/` and `docs/zh/`. The repository's [implementation manual](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/INDEX.md) covers the deeper runtime paths, generated protocol references, and prompt composition.

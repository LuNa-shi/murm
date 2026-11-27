---
title: Overview
description: Learn what murm solves, how the docs follow the six core building blocks, and where to jump in.
section: GET STARTED
order: 0
---

**`murm`** (`@luna-shi/murm`) is a local-first framework for building, isolating, and observing multi-agent systems.

It cleanly separates **how your agents collaborate** from **how they are isolated and run**:

- **You write the Harness** — deciding the roles, shared coordination Services, and orchestration logic.
- **murm provides the foundation** — isolated containers (Sandboxes), the run control plane (Runtime), the trusted Host Gateway, and the built-in browser Trace Viewer.

The TypeScript SDK, host `murm` CLI, in-sandbox `swarm` CLI, and `murm trace` all ship in one `@luna-shi/murm` package.

## How the docs are organized

The guide walks through the **six building blocks** from the homepage one by one, then puts them together in a real Swarm tutorial:

1. **Get Started**: [Quickstart](quickstart.md) (install and run your first swarm) → [Core Concepts](concepts.md) (the big picture in 2 minutes).
2. **Core Building Blocks**:
   - [Sandboxes](sandbox.md) — per-Agent containers, workspace quotas, and isolation defaults.
   - [Runtime](runtime.md) — creating a run, syncing files, subscribing to events, live updates, and clean shutdown.
   - [Agents & Profiles](agents.md) — role templates, persistent sessions, sending messages, interrupts, and safe retries.
   - [Host Gateway](gateway.md) — how Service Bridge and Model Gateway guard identity, schemas, and API keys.
   - [Services & Permissions](services.md) — why coordination uses host Services instead of local tools, wrapping your own classes or HTTP APIs, and static/dynamic permissions.
   - [Trace Viewer](trace-viewer.md) — interactive live swimlane demo right in the docs, plus launching `murm trace` locally or over SSH.
   - [Build a Swarm Harness](build-your-harness.md) — build a parallel multi-agent Research Swarm step by step.
3. **Built-in Harnesses**: [Choose a Harness](harnesses/index.md) — run or adapt `Subagents`, `TaskPool`, `PeerMesh`, `Substrate`, and `Lead-Worker`.
4. **Reference & Releases**: [SDK & API Reference](reference/api.md) · [CLI Reference](reference/cli.md) · [Types & Source Map](reference/types.md) · [Latest (v0.2.0)](latest.md) · [Changelog](changelog.md).

> Looking for internal implementation details or maintainer specs? See the repository's [Architecture Manual](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/INDEX.md).

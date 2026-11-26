---
title: Five Topologies Overview
description: How one murm Runtime powers five distinct multi-agent Harnesses — Subagents, TaskPool, PeerMesh, Substrate, and Lead-Worker — with zero Runtime changes.
section: BUILT-IN HARNESSES
order: 6
---

The five multi-agent systems in `murm` are not built-in "modes" inside the engine. They are five ordinary TypeScript **Harnesses** written against the exact same `@murm/core` Runtime API.

Changing how a swarm collaborates means swapping the **Services** you register and the **control loop** you run on the host — the Sandbox backend, Service Bridge, Model Gateway, and trace archive remain identical.

> **Repository locations**: `Subagents` lives at `examples/subagents/`, while `TaskPool` (`src/harnesses/taskpool/`), `PeerMesh` (`src/harnesses/peermesh/`), `Substrate` (`src/harnesses/substrate/`), and `Lead-Worker` (`src/harnesses/lead-worker/`) live under `src/harnesses/` with runnable examples under `examples/`.

## Side-by-side comparison

| Harness | Registered Services | Core Runtime Primitives | Host Control Loop | Deliverables & Verification |
| --- | --- | --- | --- | --- |
| **[Subagents](./subagents/)** | `collaboration` (6 ops: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`) | `spawn(forkFrom)`, `send(wakeIfIdle: false)`, `interrupt(discardedInputHashes)`, optional shared `workspace` | **Event + mailbox loop**: busy recipients receive immediate `steer`; idle recipients buffer until `wait_agent` or `followup_task` | Shared workspace files or message payloads returned to `/root` |
| **[TaskPool](./taskpool/)** | `task`, `material`, `workspace`, optional `judge` & `mission` | `writable: false` → `files.prepare` + `files.grant`, `modelAccessPolicy`, slot refill `stop`/`spawn` | **Dual event + heartbeat reconciliation**: `take` triggers file handoff; `settled` continues active executions; timer renews leases and replaces expired slots | Immutable Materials + verified merges into shared Workspace `main` |
| **[PeerMesh](./peermesh/)** | `peermesh-context` (soft Board), `message` (Mattermost), `gitea` + native `git` | `bindings`, `network.allow`, `secretEnv`, `steer(steeringMode: 'all')`, `collect(includeGit: true)` | **Per-peer serial router**: polls chat/PR events, injects Board context, steers DMs & Board updates mid-turn, runs `followUp` batches and idle nudges | Personal Git branches + host-verified PR merges into protected `main` |
| **[Substrate](./substrate/)** | SQLite `substrate` (`publish`, `search`, `visit`) | `spawn(files)`, `runInput` serial turns, `stop()` per peer | **Parallel fixed rounds**: zero queues and zero routing — `Promise.all` drives equal peers through `maxRounds` independent cycles with optional `onCycle` hooks | Content-addressed immutable records (`content:<sha256>`) + read audit log |
| **[Lead-Worker](./lead-worker/)** | SQLite `board` (direction, assignments, claims, feedback) + `gitea` | Fixed-team `spawn`, asymmetric role Profiles, `bindings`, `secretEnv`, `collect(includeGit: true)` | **Alternating staged orchestration**: lead publishes direction → workers claim & ship commits + feedback concurrently → lead revises direction → same workers run next round | Branch commits verified live against Gitea by commit SHA, path, byte length, SHA-256, and causal read gates |

## One conflict, five different policies

A quick way to see what belongs in a Harness (instead of the Runtime) is asking: **"What happens when two agents want the same piece of work?"**

- **TaskPool** enforces hard mutual exclusion inside the `task` Service using database leases and `fencing_version`. Only the winning Execution receives `files.grant()` write access and a valid `modelAccessPolicy` permit.
- **PeerMesh** treats Board `CLAIM` entries as advisory, overlapping intentions so peers coordinate splits in Mattermost chat and direct messages.
- **Lead-Worker** locks a single permanent `owner` in SQLite via `BEGIN IMMEDIATE` transactions and `expected_revision` optimistic concurrency checks — claims never expire or reassign.
- **Substrate** removes claiming entirely: equal peers explore concurrently and converge through immutable publishing and explicit citations.
- **Subagents** partitions work at delegation time through `spawn_agent`, and `/root` corrects drift mid-flight with `send_message` or `interrupt_agent`.

## Choose your starting point

| If you need... | Start with |
| --- | --- |
| Recursive delegation, context forking, interactive user steering, and mailbox buffering | **[Subagents](./subagents/)** |
| Long-running task queues, automatic worker turnover, lease guards, and versioned `main` | **[TaskPool](./taskpool/)** |
| Flat peer engineers collaborating via chat channels, soft boards, and Git pull requests | **[PeerMesh](./peermesh/)** |
| Open-ended parallel research or theorem proving around an immutable citation store | **[Substrate](./substrate/)** |
| Explicit lead direction with enforced feedback read gates and byte-verified Git commits | **[Lead-Worker](./lead-worker/)** |
| Minimal 2-agent reference before authoring a bespoke Harness | **[Build Your Own Harness](../build-your-harness/)** |

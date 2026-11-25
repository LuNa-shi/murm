---
title: Five Topologies Overview
description: How one Runtime powers five distinct multi-agent Programs — compared by registered Services, Runtime primitives, and host control loops.
section: BUILT-IN PROGRAMS
order: 5
---

In `murm`, the five built-in multi-agent systems are not hardcoded "modes" inside the engine. They are five ordinary TypeScript **Programs** built on the exact same Runtime API. Changing how agents collaborate means swapping the registered **Services** and the host **control loop** — the sandbox, Bridge, and trace archive remain untouched.

![One Runtime, Five Multi-Agent Topologies](../../../assets/images/five-programs-compare.jpg)

## Side-by-side comparison from a Program author's perspective

| Program | Registered Services | Key Runtime Primitives | Host Control Loop | Deliverables & Verification |
| --- | --- | --- | --- | --- |
| **[Subagents](./subagents/)** | `collaboration` (6 ops: spawn, message, followup, wait, interrupt, list) | `spawn(forkFrom)`, `send(wakeIfIdle: false)`, `interrupt(discardedInputHashes)`, shared `workspace` | **Event + mailbox loop**: listens for child `settled` and peer messages; busy targets get immediate `steer`, idle targets buffer until `wait_agent` or `followup_task` | Shared workspace files or message payloads |
| **[Flat](./flat/)** | `task`, `material`, `workspace`, `judge` | Read-only `writable: false`, `files.prepare` + `files.grant`, `modelAccessPolicy`, slot refill `stop`/`spawn` | **Reconciliation loop**: `take` triggers file handoff and write grant; `settled` continues unfinished executions via `followUp`; heartbeat renews leases and replaces expired workers | Immutable Materials + verified merges into shared `main` |
| **[Agensh](./agensh/)** | `message` (Mattermost), `gitea`, `agensh-context` (soft-claim Board) + native `git` | `bindings`, `network.allow`, `secretEnv`, `collect(includeGit: true)` | **Per-peer serial router**: ingests chat/PR events, injects current Board view, dispatches `followUp` batches into the existing session, triggers idle nudges | Personal Git branches + PRs merged after `createAgenshDelivery` checks |
| **[ScaleMAS](./scalemas/)** | SQLite `substrate` (`publish`, `search`, `visit`) | `spawn(files)`, `runInput` serial turn helper | **Parallel fixed rounds**: zero task queues and zero routing — `Promise.all` drives every equal peer through `maxRounds` independent exploration cycles | Content-addressed immutable records (`content:<sha256>`) + read audit table |
| **[Lead-helper](./lead-helper/)** | SQLite `board` (direction, assignment, transactional claims, feedback) + `gitea` | Fixed-team `spawn`, per-role `bindings` and `secretEnv` | **Alternating staged orchestration**: `lead` publishes direction → `helpers` claim concurrently, ship commits, and post feedback → `lead` revises direction → same `helpers` execute next round | Personal branch commits verified by commit SHA, path, SHA-256, and direction read gate |

## One conflict, five different policies

The quickest test of where coordination logic belongs is asking: **"What happens when two agents pick the same piece of work?"**

- **Flat** enforces hard mutual exclusion inside the `task` Service using database leases and `fencing_version` — only one execution receives write permission.
- **Agensh** treats `CLAIM` on its Board as an overlapping soft intention so peers negotiate splits in chat.
- **Lead-helper** locks a single permanent `owner` inside SQLite using `BEGIN IMMEDIATE` transactions and `expected_revision` optimistic locking.
- **ScaleMAS** drops claiming altogether — peers explore freely and converge through immutable publishing and explicit citations.
- **Subagents** partitions work at delegation time via `spawn_agent`, and `/root` corrects overlaps mid-flight using `send_message` or `interrupt_agent`.

## Pick your starting point

- Dynamic delegation, mid-flight user steering, and mailbox buffering → **[Subagents](./subagents/)**
- Long-running pools, worker turnover, lease guards, and versioned `main` → **[Flat](./flat/)**
- Peer engineers collaborating via chat channels, boards, and Git PRs → **[Agensh](./agensh/)**
- Open-ended parallel research around an immutable citation store → **[ScaleMAS](./scalemas/)**
- Staged lead-and-helper loops with causal read gates and Git verification → **[Lead-helper](./lead-helper/)**
